'use strict';

// 签发授权码（只给发行方使用，不随软件发布）。授权码格式见 src/services/license-service.cjs。
const crypto = require('node:crypto');

const PLAN_DAYS = { trial: 7, monthly: 31, quarterly: 92, yearly: 366, perpetual: null };
const DEVICE = /^MY-(?:[A-Z2-9]{5}-){3}[A-Z2-9]{5}$/u;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function newLicenseId(plan, now) {
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const letter = { trial: 'T', monthly: 'M', quarterly: 'Q', yearly: 'Y', perpetual: 'P' }[plan];
  return `${letter}${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * @param {{ privateKeyPem: string, kid: string, device: string, customer?: string, plan: string,
 *           start?: Date|number, days?: number, updatesYears?: number, id?: string }} input
 */
function issueLicense(input) {
  const plan = String(input.plan || '');
  if (!(plan in PLAN_DAYS)) throw new Error(`套餐只能是：${Object.keys(PLAN_DAYS).join(' / ')}`);
  const device = String(input.device || '').trim().toUpperCase();
  if (!DEVICE.test(device)) throw new Error('设备码格式不对，应形如 MY-ABCDE-FGHJK-LMNPQ-RSTUV');
  const customer = String(input.customer || '').trim();
  if (customer.length > 60) throw new Error('客户名称最多 60 个字');
  const issued = new Date(input.now ?? Date.now());
  const start = new Date(input.start ?? issued);
  if (start.getTime() < issued.getTime() - 60 * 1000) throw new Error('开始时间不能早于签发时间');
  let days = input.days === undefined || input.days === null || input.days === '' ? PLAN_DAYS[plan] : Number(input.days);
  if (plan !== 'perpetual') {
    const max = plan === 'trial' ? 7 : PLAN_DAYS[plan];
    if (!Number.isInteger(days) || days < 1 || days > max) throw new Error(`${plan} 的天数应在 1～${max} 之间`);
    // 有效期从开始时间算起；授权码里的“签发时间”就是开始时间，便于本机核对不超过套餐上限。
  }
  const iso = (date) => new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const payload = {
    v: 1,
    kid: String(input.kid || 'k1'),
    id: String(input.id || newLicenseId(plan, issued.getTime())),
    plan,
    customer,
    device,
    issued: iso(start),
    expires: plan === 'perpetual' ? null : iso(new Date(start.getTime() + days * 86400000)),
    ...(plan === 'perpetual' ? { updatesUntil: iso(new Date(start.getTime() + Math.round((Number(input.updatesYears) || 1) * 365.25 * 86400000))) } : {})
  };
  const segment = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const key = crypto.createPrivateKey(input.privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(`moyin-license-v1\n${segment}`, 'utf8'), key);
  return { code: `MY1.${segment}.${base64url(signature)}`, payload };
}

module.exports = { issueLicense, PLAN_DAYS };

'use strict';

// 墨隐授权。
// 授权码：'MY1.' + base64url(载荷 JSON) + '.' + base64url(Ed25519 签名)，签名对象为 'moyin-license-v1\n' + 载荷段原文。
// 程序里只有公钥（只能验证，不能签发）；私钥由发行方离线保管，用签发工具生成授权码。
// 载荷：v=1、kid（公钥编号）、id（授权编号）、plan、customer、device（设备码）、issued、expires（永久授权为 null）、
//       updatesUntil（仅永久授权：此日期前发布的版本可用）。
// 没有授权、到期、时间被往回调时，只停止“导出新的脱敏副本”；识别、文件仓库、逆脱敏、备份不受影响。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PREFIX = 'MY1.';
const SIGN_CONTEXT = 'moyin-license-v1\n';
// k1：日常签发；k2：私钥离线备用，k1 泄露时换用。
const PUBLIC_KEYS = Object.freeze({
  k1: 'GhP7al8fsPhvnIqGtKyf4Y1jfaN0F5BcgO6xqtu5AzE=',
  k2: 'hGLbzM3e+SU4zStz6ydCX9gZb9RAUuR5LiVWsbACTqY='
});
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DAY = 24 * 60 * 60 * 1000;
const PLANS = Object.freeze({
  trial: { label: '试用', maxDays: 7 },
  monthly: { label: '月付', maxDays: 31 + 7 },
  quarterly: { label: '季付', maxDays: 92 + 7 },
  yearly: { label: '年付', maxDays: 366 + 7 },
  perpetual: { label: '永久', maxDays: null }
});
// 电脑时间比见过的最晚时间早超过 2 小时，视为时间被往回调。
const CLOCK_TOLERANCE = 2 * 60 * 60 * 1000;
const CUSTOMER_MAX = 60;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) throw fail('LOCAL_LICENSE_INVALID');
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function base32(bytes) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

/** 设备码：由系统机器编号单向推算，形如 MY-ABCDE-FGHJK-LMNPQ-RSTUV。不含任何个人信息。 */
function deviceCode(machineId) {
  const id = String(machineId || '').trim().toLowerCase();
  if (!id) throw fail('LOCAL_LICENSE_DEVICE_UNAVAILABLE');
  const raw = base32(crypto.createHash('sha256').update(`moyin-device-v1|${id}`, 'utf8').digest()).slice(0, 20);
  return `MY-${raw.match(/.{5}/gu).join('-')}`;
}

function readMachineId() {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const output = execFileSync(path.join(root, 'System32', 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/u);
    if (!match) throw fail('LOCAL_LICENSE_DEVICE_UNAVAILABLE');
    return match[1];
  }
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch { /* 试下一个 */ }
  }
  if (process.platform === 'darwin') {
    const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/u);
    if (match) return match[1];
  }
  throw fail('LOCAL_LICENSE_DEVICE_UNAVAILABLE');
}

function isoTime(value, allowNull = false) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) throw fail('LOCAL_LICENSE_INVALID');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw fail('LOCAL_LICENSE_INVALID');
  return time;
}

/** 解析并验签。不检查设备和有效期（由调用方判断）。 */
function parseLicense(input, publicKeys = PUBLIC_KEYS) {
  const text = String(input || '').replace(/\s+/gu, '');
  if (!text.startsWith(PREFIX) || text.length > 4096) throw fail('LOCAL_LICENSE_INVALID');
  const parts = text.slice(PREFIX.length).split('.');
  if (parts.length !== 2) throw fail('LOCAL_LICENSE_INVALID');
  const [segment, signaturePart] = parts;
  let payload;
  try {
    payload = JSON.parse(fromBase64url(segment).toString('utf8'));
  } catch {
    throw fail('LOCAL_LICENSE_INVALID');
  }
  if (!payload || typeof payload !== 'object' || payload.v !== 1) throw fail('LOCAL_LICENSE_INVALID');
  const rawKey = publicKeys[payload.kid];
  if (!rawKey) throw fail('LOCAL_LICENSE_INVALID');
  const signature = fromBase64url(signaturePart);
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawKey, 'base64')]), format: 'der', type: 'spki' });
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(SIGN_CONTEXT + segment, 'utf8'), key, signature)) throw fail('LOCAL_LICENSE_INVALID');
  // 签名通过后再校验字段，防止发行方误签出不合规的码。
  const plan = PLANS[payload.plan];
  if (!plan) throw fail('LOCAL_LICENSE_INVALID');
  if (typeof payload.id !== 'string' || !/^[A-Za-z0-9-]{4,40}$/u.test(payload.id)) throw fail('LOCAL_LICENSE_INVALID');
  if (typeof payload.device !== 'string' || !/^MY-(?:[A-Z2-9]{5}-){3}[A-Z2-9]{5}$/u.test(payload.device)) throw fail('LOCAL_LICENSE_INVALID');
  if (typeof payload.customer !== 'string' || payload.customer.length > CUSTOMER_MAX) throw fail('LOCAL_LICENSE_INVALID');
  const issued = isoTime(payload.issued);
  const expires = isoTime(payload.expires, payload.plan === 'perpetual');
  const updatesUntil = payload.plan === 'perpetual' ? isoTime(payload.updatesUntil) : null;
  if (payload.plan === 'perpetual') {
    if (expires !== null) throw fail('LOCAL_LICENSE_INVALID');
  } else if (expires <= issued || expires - issued > plan.maxDays * DAY) {
    throw fail('LOCAL_LICENSE_INVALID');
  }
  return { text, payload, issued, expires, updatesUntil, plan: payload.plan, planLabel: plan.label };
}

/**
 * 授权存储与状态。依赖从参数传入，便于测试：
 * dir（保存目录）、now（时钟）、machineId（读机器编号）、buildTime（本版本发布时间，用于永久授权的升级期）、publicKeys。
 */
function createLicenseStore({ dir, now = Date.now, machineId = readMachineId, buildTime = 0, publicKeys = PUBLIC_KEYS } = {}) {
  if (!dir) throw fail('LOCAL_LICENSE_UNAVAILABLE');
  const file = path.join(dir, 'license.json');
  let device = null;
  const currentDevice = () => {
    if (!device) device = deviceCode(machineId());
    return device;
  };

  function readState() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function writeState(state) {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  }

  // 记下见过的最晚时间，并返回当前时间与是否被往回调。
  function observeClock(state) {
    const time = now();
    const maxSeen = Number(state.maxSeen) || 0;
    if (time > maxSeen) {
      state.maxSeen = time;
      try { writeState(state); } catch { /* 写不进去不影响判断 */ }
    }
    return { time, rollback: maxSeen - time > CLOCK_TOLERANCE };
  }

  function storedCodes(state) {
    const list = Array.isArray(state.codes) ? state.codes : [];
    return state.code && !list.includes(state.code) ? [state.code, ...list] : list;
  }

  function describe(license) {
    return {
      id: license.payload.id,
      plan: license.plan,
      planLabel: license.planLabel,
      customer: license.payload.customer,
      issued: license.payload.issued,
      expires: license.payload.expires,
      updatesUntil: license.payload.updatesUntil || null
    };
  }

  // 本机可以存多条授权码（续期码可以从当前授权到期那天开始生效）：选当前有效、到期最晚的一条。
  function status() {
    const state = readState();
    let deviceText = '';
    try { deviceText = currentDevice(); } catch { deviceText = ''; }
    const codes = storedCodes(state);
    const base = { device: deviceText, activated: codes.length > 0 };
    if (!deviceText) return { ...base, state: 'device', allowed: false };
    const clock = observeClock(state);
    if (!codes.length) return { ...base, state: 'none', allowed: false };
    const parsed = [];
    for (const code of codes) {
      try { parsed.push(parseLicense(code, publicKeys)); } catch { /* 损坏的跳过 */ }
    }
    if (!parsed.length) return { ...base, state: 'invalid', allowed: false };
    const mine = parsed.filter((license) => license.payload.device === deviceText);
    if (!mine.length) return { ...base, ...describe(parsed.at(-1)), state: 'machine', allowed: false };
    if (clock.rollback) return { ...base, ...describe(mine.at(-1)), state: 'clock', allowed: false };
    const end = (license) => (license.expires === null ? Infinity : license.expires);
    const usable = mine.filter((license) => !(license.updatesUntil !== null && buildTime && buildTime > license.updatesUntil + DAY));
    const active = usable.filter((license) => license.issued <= clock.time + CLOCK_TOLERANCE && clock.time < end(license))
      .sort((left, right) => end(right) - end(left))[0];
    if (active) {
      const daysLeft = active.expires === null ? null : Math.max(0, Math.ceil((active.expires - clock.time) / DAY));
      const next = usable.filter((license) => license !== active && license.issued > clock.time && end(license) > end(active))
        .sort((left, right) => left.issued - right.issued)[0];
      return { ...base, ...describe(active), state: 'valid', allowed: true, daysLeft, next: next ? describe(next) : null };
    }
    const pending = usable.filter((license) => license.issued > clock.time).sort((left, right) => left.issued - right.issued)[0];
    if (pending) return { ...base, ...describe(pending), state: 'pending', allowed: false };
    if (!usable.length) return { ...base, ...describe(mine.at(-1)), state: 'updates', allowed: false };
    const latest = [...usable].sort((left, right) => end(right) - end(left))[0];
    return { ...base, ...describe(latest), state: 'expired', allowed: false, daysLeft: 0 };
  }

  /** 导入授权码：加入本机授权列表（同一编号不重复），然后返回最新状态。 */
  function importLicense(text) {
    const license = parseLicense(text, publicKeys);
    if (license.payload.device !== currentDevice()) throw fail('LOCAL_LICENSE_MACHINE_MISMATCH');
    const time = now();
    if (license.expires !== null && time >= license.expires) throw fail('LOCAL_LICENSE_EXPIRED');
    const state = readState();
    const codes = storedCodes(state).filter((code) => {
      try {
        const item = parseLicense(code, publicKeys);
        // 去掉同编号的旧码和已经过期的码
        return item.payload.id !== license.payload.id && (item.expires === null || item.expires > time);
      } catch {
        return false;
      }
    });
    state.codes = [...codes, license.text].slice(-10);
    delete state.code;
    state.importedAt = new Date(time).toISOString();
    state.history = [...(Array.isArray(state.history) ? state.history : []), { id: license.payload.id, plan: license.plan, importedAt: state.importedAt }].slice(-50);
    writeState(state);
    return status();
  }

  /** 导出前调用：不允许时抛出带原因的错误。 */
  function assertCanExport() {
    const current = status();
    if (current.allowed) return current;
    const codes = {
      none: 'LOCAL_LICENSE_REQUIRED', invalid: 'LOCAL_LICENSE_INVALID', machine: 'LOCAL_LICENSE_MACHINE_MISMATCH',
      clock: 'LOCAL_LICENSE_CLOCK', expired: 'LOCAL_LICENSE_EXPIRED', updates: 'LOCAL_LICENSE_UPDATES_EXPIRED', device: 'LOCAL_LICENSE_DEVICE_UNAVAILABLE',
      pending: 'LOCAL_LICENSE_PENDING'
    };
    throw fail(codes[current.state] || 'LOCAL_LICENSE_REQUIRED');
  }

  return { status, importLicense, assertCanExport, deviceCode: currentDevice };
}

module.exports = { PREFIX, SIGN_CONTEXT, PUBLIC_KEYS, PLANS, CLOCK_TOLERANCE, parseLicense, deviceCode, readMachineId, createLicenseStore, base64url };

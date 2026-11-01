import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { parseLicense, deviceCode, createLicenseStore } = require('../src/services/license-service.cjs');
const { issueLicense } = require('../tools/license-issuer/issue-core.cjs');

// 测试用密钥对（不是正式密钥）
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const TEST_KEYS = { t1: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64') };
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' });
const DAY = 86400000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const MACHINE = 'a1b2c3d4-0000-1111-2222-333344445555';
const DEVICE = deviceCode(MACHINE);

function issue(options) {
  return issueLicense({ privateKeyPem: PEM, kid: 't1', device: DEVICE, customer: '测试建筑公司', now: T0, ...options }).code;
}

function store(clock, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyin-license-'));
  return { dir, store: createLicenseStore({ dir, now: () => clock.time, machineId: () => MACHINE, publicKeys: TEST_KEYS, ...extra }) };
}

test('设备码稳定、格式固定，不暴露机器编号', () => {
  assert.equal(deviceCode(MACHINE), DEVICE);
  assert.match(DEVICE, /^MY-(?:[A-Z2-9]{5}-){3}[A-Z2-9]{5}$/u);
  assert.notEqual(deviceCode('another-machine'), DEVICE);
  assert.ok(!DEVICE.includes('a1b2'));
});

test('签发的授权码能验证；改一个字或用别的密钥签发都不通过', () => {
  const code = issue({ plan: 'yearly' });
  const parsed = parseLicense(code, TEST_KEYS);
  assert.equal(parsed.plan, 'yearly');
  assert.equal(parsed.payload.customer, '测试建筑公司');
  const [head, payload, signature] = code.split('.');
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString());
  json.expires = '2099-01-01T00:00:00Z';
  const forged = `${head}.${Buffer.from(JSON.stringify(json)).toString('base64url')}.${signature}`;
  assert.throws(() => parseLicense(forged, TEST_KEYS), /LOCAL_LICENSE_INVALID/u);
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  const foreign = issueLicense({ privateKeyPem: other, kid: 't1', device: DEVICE, plan: 'yearly', now: T0 }).code;
  assert.throws(() => parseLicense(foreign, TEST_KEYS), /LOCAL_LICENSE_INVALID/u);
  assert.throws(() => parseLicense(code), /LOCAL_LICENSE_INVALID/u, '测试密钥签的码不能通过正式公钥');
});

test('五种套餐的有效期；签发工具拒绝超过套餐上限的天数', () => {
  const days = (plan) => {
    const parsed = parseLicense(issue({ plan }), TEST_KEYS);
    return parsed.expires === null ? null : Math.round((parsed.expires - parsed.issued) / DAY);
  };
  assert.deepEqual(['trial', 'monthly', 'quarterly', 'yearly', 'perpetual'].map(days), [7, 31, 92, 366, null]);
  assert.throws(() => issue({ plan: 'trial', days: 30 }), /1～7/u);
  assert.throws(() => issue({ plan: 'lifetime' }), /套餐/u);
  assert.throws(() => issueLicense({ privateKeyPem: PEM, kid: 't1', device: 'MY-123', plan: 'trial' }), /设备码/u);
});

test('首次未激活不能导出；激活后可以导出；到期后停止导出', () => {
  const clock = { time: T0 };
  const { store: licenses } = store(clock);
  assert.equal(licenses.status().state, 'none');
  assert.throws(() => licenses.assertCanExport(), /LOCAL_LICENSE_REQUIRED/u);
  const status = licenses.importLicense(issue({ plan: 'trial' }));
  assert.equal(status.state, 'valid');
  assert.equal(status.daysLeft, 7);
  assert.doesNotThrow(() => licenses.assertCanExport());
  clock.time = T0 + 7 * DAY + 1000;
  assert.equal(licenses.status().state, 'expired');
  assert.throws(() => licenses.assertCanExport(), /LOCAL_LICENSE_EXPIRED/u);
});

test('一码一机：别的电脑的授权码导入不了', () => {
  const clock = { time: T0 };
  const { store: licenses } = store(clock);
  const otherDevice = deviceCode('other-machine');
  const code = issueLicense({ privateKeyPem: PEM, kid: 't1', device: otherDevice, plan: 'yearly', now: T0 }).code;
  assert.throws(() => licenses.importLicense(code), /LOCAL_LICENSE_MACHINE_MISMATCH/u);
});

test('电脑时间被往回调时暂停导出，改回后恢复', () => {
  const clock = { time: T0 };
  const { store: licenses } = store(clock);
  licenses.importLicense(issue({ plan: 'monthly' }));
  clock.time = T0 + 20 * DAY;
  assert.equal(licenses.status().state, 'valid');
  clock.time = T0 + 2 * DAY;
  assert.equal(licenses.status().state, 'clock');
  assert.throws(() => licenses.assertCanExport(), /LOCAL_LICENSE_CLOCK/u);
  clock.time = T0 + 20 * DAY;
  assert.equal(licenses.status().state, 'valid');
});

test('续期码从当前授权到期日生效：导入后当前授权照常使用，到期后自动接上', () => {
  const clock = { time: T0 };
  const { store: licenses } = store(clock);
  licenses.importLicense(issue({ plan: 'monthly' }));
  clock.time = T0 + 25 * DAY;
  const renewal = issueLicense({ privateKeyPem: PEM, kid: 't1', device: DEVICE, plan: 'quarterly', now: clock.time, start: T0 + 31 * DAY }).code;
  const afterImport = licenses.importLicense(renewal);
  assert.equal(afterImport.state, 'valid');
  assert.equal(afterImport.plan, 'monthly');
  assert.equal(afterImport.next.plan, 'quarterly');
  clock.time = T0 + 40 * DAY;
  const later = licenses.status();
  assert.equal(later.state, 'valid');
  assert.equal(later.plan, 'quarterly');
  assert.equal(later.daysLeft, 83);
});

test('永久授权：免费升级期内发布的版本可用，之后发布的版本暂停导出', () => {
  const clock = { time: T0 };
  const code = issue({ plan: 'perpetual', updatesYears: 1 });
  const inside = store(clock, { buildTime: T0 + 100 * DAY }).store;
  assert.equal(inside.importLicense(code).state, 'valid');
  const outside = store(clock, { buildTime: T0 + 400 * DAY }).store;
  outside.importLicense(code);
  assert.equal(outside.status().state, 'updates');
  assert.throws(() => outside.assertCanExport(), /LOCAL_LICENSE_UPDATES_EXPIRED/u);
});

test('授权文件被改坏时提示重新导入；保存的文件里不含机器编号', () => {
  const clock = { time: T0 };
  const { dir, store: licenses } = store(clock);
  licenses.importLicense(issue({ plan: 'yearly' }));
  const file = path.join(dir, 'license.json');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(MACHINE));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.codes = saved.codes.map((code) => `${code.slice(0, -4)}AAAA`);
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(licenses.status().state, 'invalid');
});

test('正式公钥能验证正式私钥签的码（发布前自检，私钥不在仓库里时跳过）', (t) => {
  const keyFile = process.env.MOYIN_LICENSE_KEY;
  if (!keyFile || !fs.existsSync(keyFile)) {
    t.skip('未提供正式私钥');
    return;
  }
  const code = issueLicense({ privateKeyPem: fs.readFileSync(keyFile, 'utf8'), kid: path.basename(keyFile).slice(0, 2), device: DEVICE, plan: 'trial' }).code;
  assert.equal(parseLicense(code).plan, 'trial');
});

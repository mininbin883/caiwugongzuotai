#!/usr/bin/env node
'use strict';

// 墨隐授权签发工具（命令行）。用法：
//   node issue.cjs --key k1-private.pem --device MY-XXXXX-XXXXX-XXXXX-XXXXX --plan yearly --customer "某某建筑公司"
// 可选：--kid k1（默认）  --days 30（不超过套餐上限）  --start 2026-12-01  --updates-years 1（永久授权的免费升级年数）
//       --out 输出目录（默认当前目录）  --ledger 台账 CSV（默认 输出目录/墨隐授权台账.csv）
// 套餐：trial（7 天试用）/ monthly（月付）/ quarterly（季付）/ yearly（年付）/ perpetual（永久）

const fs = require('node:fs');
const path = require('node:path');
const { issueLicense } = require('./issue-core.cjs');

const PLAN_LABELS = { trial: '7天试用', monthly: '月付', quarterly: '季付', yearly: '年付', perpetual: '永久' };

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    out[key.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return out;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main() {
  const options = args(process.argv.slice(2));
  if (!options.key || !options.device || !options.plan) {
    process.stdout.write('用法：node issue.cjs --key k1-private.pem --device MY-XXXXX-XXXXX-XXXXX-XXXXX --plan trial|monthly|quarterly|yearly|perpetual --customer 客户名称\n');
    process.exitCode = 2;
    return;
  }
  const result = issueLicense({
    privateKeyPem: fs.readFileSync(options.key, 'utf8'),
    kid: options.kid || path.basename(options.key).match(/^(k\d+)/u)?.[1] || 'k1',
    device: options.device,
    customer: options.customer === true ? '' : options.customer,
    plan: options.plan,
    days: options.days,
    start: options.start ? new Date(`${options.start}T00:00:00+08:00`) : undefined,
    updatesYears: options['updates-years']
  });
  const p = result.payload;
  const outDir = path.resolve(options.out || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const safeCustomer = (p.customer || '客户').replace(/[\\/:*?"<>|]/gu, '_');
  const file = path.join(outDir, `墨隐授权码-${safeCustomer}-${PLAN_LABELS[p.plan]}-${p.id}.txt`);
  const body = [
    '墨隐授权码（打开墨隐 → 右上角授权状态 → 粘贴或“从文件导入”）',
    '',
    result.code,
    '',
    `授权编号：${p.id}`,
    `套餐：${PLAN_LABELS[p.plan]}`,
    `客户：${p.customer || '—'}`,
    `设备码：${p.device}`,
    `生效：${p.issued.slice(0, 10)}`,
    `到期：${p.expires ? p.expires.slice(0, 10) : '永久'}${p.updatesUntil ? `（免费升级至 ${p.updatesUntil.slice(0, 10)}）` : ''}`,
    ''
  ].join('\r\n');
  fs.writeFileSync(file, `﻿${body}`, 'utf8');
  const ledger = path.resolve(options.ledger || path.join(outDir, '墨隐授权台账.csv'));
  if (!fs.existsSync(ledger)) fs.writeFileSync(ledger, '﻿签发时间,授权编号,套餐,客户,设备码,生效,到期,免费升级至,公钥编号,授权码\r\n', 'utf8');
  fs.appendFileSync(ledger, `${[new Date().toISOString(), p.id, PLAN_LABELS[p.plan], p.customer, p.device, p.issued, p.expires || '永久', p.updatesUntil || '', p.kid, result.code].map(csvCell).join(',')}\r\n`, 'utf8');
  process.stdout.write(`${result.code}\n\n已保存：${file}\n已记入台账：${ledger}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`签发失败：${error.message}\n`);
  process.exitCode = 1;
}

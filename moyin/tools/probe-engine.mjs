import path from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('USAGE: node tools/probe-engine.mjs <engine.mjs>');
  process.exit(2);
}

const sample = '联系人张三，手机13812345678，邮箱alice@example.com，身份证11010519491231002X。';
const engine = await import(`${pathToFileURL(path.resolve(target)).href}?t=${Date.now()}`);
const result = engine.analyzeText(sample, { customTerms: ['张三'] });
console.log(`FILE=${path.basename(target)}`);
console.log(`INPUT=${sample}`);
console.log(`FINDINGS=${result.findings.length}`);
console.log(`OUTPUT=${result.redactedText}`);
const passed = result.findings.length === 4 && result.redactedText === '联系人张**，手机138****5678，邮箱a***@example.com，身份证110***********002X。';
console.log(`RESULT=${passed ? 'PASS' : 'FAIL'}`);
process.exit(passed ? 0 : 1);

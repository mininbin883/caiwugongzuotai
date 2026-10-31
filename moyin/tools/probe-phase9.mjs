#!/usr/bin/env node
import fs from 'node:fs';

const target = process.argv[2];
if (!target) {
  process.stderr.write('USAGE: node tools/probe-phase9.mjs <redaction-engine.mjs>\n');
  process.exit(2);
}

const source = fs.readFileSync(target, 'utf8');
const checks = [
  ['company-type', /company: '公司名称'/],
  ['person-type', /person: '姓名'/],
  ['uscc-type', /uscc: '统一社会信用代码'/],
  ['address-type', /address: '地址'/],
  ['uscc-validator', /function usccValid\(value\)/],
  ['typed-terms', /options\.typedTerms/],
  ['always-keep', /options\.alwaysKeepTerms/],
  ['protected-count', /protectedCount: protectedRanges\.length/]
];

const passed = checks.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
process.stdout.write(`PHASE9_PROBE checks=${passed.length}/${checks.length} branches=${passed.join(',') || 'none'}\n`);
process.exit(passed.length === checks.length ? 0 : 1);

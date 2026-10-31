'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node tools/probe-phase13.cjs <redaction-engine.mjs>');
  const absolute = path.resolve(input);
  const source = fs.readFileSync(absolute, 'utf8');
  const checks = [
    ['external-normalizer', /function normalizeExternalFindings\(text, values, enabledTypes\)/u.test(source)],
    ['external-findings-option', /options\.externalFindings/u.test(source)],
    ['rule-model-source', /source: finding\.source \|\| 'rule'/u.test(source)],
    ['confidence-field', /confidence: Number\.isFinite\(finding\.confidence\)/u.test(source)],
    ['review-required-field', /reviewRequired: Boolean\(finding\.reviewRequired\)/u.test(source)],
    ['model-count-field', /modelCount: normalized\.filter/u.test(source)],
    ['review-count-field', /reviewCount: normalized\.filter/u.test(source)],
    ['runtime-merge', false]
  ];
  try {
    const engine = await import(`${pathToFileURL(absolute).href}?probe=${Date.now()}`);
    const text = '王伟到达上海。';
    const result = engine.analyzeText(text, {
      style: 'label',
      externalFindings: [{ type: 'person', start: 0, end: 2, source: 'onnx', confidence: 0.91, enabled: true }]
    });
    checks[7][1] = result.findings.some((item) => item.source === 'onnx' && item.value === '王伟' && item.confidence === 0.91) && result.modelCount === 1;
  } catch {
    checks[7][1] = false;
  }
  for (const [name, passed] of checks) process.stdout.write(`CHECK ${name}=${passed ? 1 : 0}\n`);
  const passed = checks.filter(([, value]) => value).length;
  process.stdout.write(`PHASE13_PROBE ${passed}/${checks.length}\n`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});

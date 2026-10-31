#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const target = process.argv[2];
if (!target) {
  process.stderr.write('USAGE: node tools/probe-phase10.cjs <office-redaction-service.cjs>\n');
  process.exit(2);
}
const source = fs.readFileSync(target, 'utf8');
const checks = [
  ['token-pattern', /REVERSIBLE_TOKEN_PATTERN/],
  ['mapping-normalizer', /function normalizeReversibleMapping\(mapping\)/],
  ['token-finder', /function officeTokenFindings\(text, mapping\)/],
  ['missing-report', /missingTokens/],
  ['unknown-report', /unknownTokens/],
  ['roundtrip-function', /async function restoreReversibleOffice\(inputPath, mapping, outputPath\)/],
  ['exact-render-call', /renderRedactedOffice\(document\.session, report\.findings, outputPath\)/],
  ['roundtrip-export', /restoreReversibleOffice,/]
];
const passed = checks.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
process.stdout.write(`PHASE10_PROBE checks=${passed.length}/${checks.length} branches=${passed.join(',') || 'none'}\n`);
process.exit(passed.length === checks.length ? 0 : 1);


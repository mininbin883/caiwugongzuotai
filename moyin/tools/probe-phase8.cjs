#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const target = process.argv[2];
if (!target) {
  process.stderr.write('USAGE: node tools/probe-phase8.cjs <main.cjs>\n');
  process.exit(2);
}

const source = fs.readFileSync(target, 'utf8');
const checks = [
  ['promise-cache', /let reversibleEnginePromise = null;/],
  ['engine-loader', /function loadReversibleEngine\(\)/],
  ['engine-import', /import\('\.\/core\/reversible-token-engine\.mjs'\)/],
  ['vault-kind-forward', /kind: payload\?\.kind/],
  ['vault-mapping-forward', /mapping: payload\?\.mapping/],
  ['reversible-smoke', /async function runReversibleSmoke\(\)/],
  ['ready-branch', /if \(await runReversibleSmoke\(\)\) return;/],
  ['restore-capture', /commandValue\('ui-capture-section'\) === 'restore'/]
];

const passed = checks.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
process.stdout.write(`PHASE8_PROBE checks=${passed.length}/${checks.length} branches=${passed.join(',') || 'none'}\n`);
process.exit(passed.length === checks.length ? 0 : 1);

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
if (!input) {
  process.stderr.write('usage: node tools/probe-phase17.cjs <vault-service.cjs>\n');
  process.exit(2);
}
const source = fs.readFileSync(path.resolve(input), 'utf8');
const checks = [
  ['format-v3', /VAULT_VERSION\s*=\s*storage\.FORMAT_VERSION/u],
  ['chunk-storage', /storage\.createChunkVault/u],
  ['append-commit', /storage\.appendEntries/u],
  ['v2-migration', /migrateLegacyVault/u],
  ['atomic-replace', /atomicReplace/u],
  ['256mib-parity', /PARITY_VAULT_BYTES\s*=\s*storage\.PARITY_VAULT_BYTES/u],
  ['2gib-boundary', /MAX_VAULT_BYTES\s*=\s*storage\.MAX_VAULT_BYTES/u],
  ['lazy-entry-read', /async function readVaultEntry/u]
];
let passed = 0;
for (const [name, pattern] of checks) {
  const ok = pattern.test(source);
  if (ok) passed += 1;
  process.stdout.write(`CHECK ${name}=${ok ? 1 : 0}\n`);
}
process.stdout.write(`PHASE17_PROBE ${passed}/${checks.length}\n`);
process.exit(passed === checks.length ? 0 : 1);

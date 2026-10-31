#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
if (!input) {
  process.stderr.write('usage: node tools/probe-phase18.cjs <vault-service.cjs>\n');
  process.exit(2);
}
const source = fs.readFileSync(path.resolve(input), 'utf8');
const checks = [
  ['cursor-pagination', /function listVaultEntriesPage/u],
  ['page-size-bound', /Math\.min\(100, Math\.max\(1, requested\)\)/u],
  ['authenticated-delete', /async function deleteVaultEntry/u],
  ['delete-index-commit', /storage\.commitIndex\(context, next\)/u],
  ['atomic-compaction', /async function compactVault/u],
  ['key-preserving-rewrite', /storage\.createChunkVaultWithKey/u],
  ['reclaimable-stats', /reclaimableBytes/u],
  ['sequence-floor', /nextSequenceFloor:\s*context\.data\.nextSequence/u]
];
let passed = 0;
for (const [name, pattern] of checks) {
  const ok = pattern.test(source);
  if (ok) passed += 1;
  process.stdout.write(`CHECK ${name}=${ok ? 1 : 0}\n`);
}
process.stdout.write(`PHASE18_PROBE ${passed}/${checks.length}\n`);
process.exit(passed === checks.length ? 0 : 1);

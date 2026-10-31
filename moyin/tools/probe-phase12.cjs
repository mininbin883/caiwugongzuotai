#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  console.error('USAGE: node tools/probe-phase12.cjs <vault-service.cjs>');
  process.exit(2);
}
const source = fs.readFileSync(path.resolve(target), 'utf8');
const checks = [
  ['encrypted-backup-format', /VEILFORGE_ENCRYPTED_VAULT_BACKUP/u.test(source)],
  ['schema-migration', /VAULT_SCHEMA_VERSION\s*=\s*2/u.test(source) && /nextAvailableSequence/u.test(source)],
  ['automatic-file-number', /function\s+fileNumber\s*\(/u.test(source) && /MI-\$\{String\(sequence\)/u.test(source)],
  ['backup-export', /async\s+function\s+exportVaultBackup\s*\(/u.test(source)],
  ['backup-import', /async\s+function\s+importVaultBackup\s*\(/u.test(source)],
  ['conflict-policies', /\['reject',\s*'skip',\s*'rename'\]/u.test(source)],
  ['atomic-conflict-reject', /LOCAL_VAULT_IMPORT_CONFLICT/u.test(source) && /if\s*\(conflictPolicy\s*===\s*'reject'/u.test(source)],
  ['public-api-exports', /exportVaultBackup\s*,/u.test(source) && /importVaultBackup\s*,/u.test(source) && /entryFingerprint\s*,/u.test(source)],
];
for (const [name, pass] of checks) console.log(`CHECK ${name}=${pass ? 1 : 0}`);
const passed = checks.filter(([, pass]) => pass).length;
console.log(`PHASE12_PROBE ${passed}/${checks.length}`);
process.exit(passed === checks.length ? 0 : 1);

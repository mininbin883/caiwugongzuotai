'use strict';

const fs = require('node:fs');
const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node tools/probe-phase16.cjs <job-workspace-service.cjs>\n');
  process.exit(2);
}

const source = fs.readFileSync(file, 'utf8');
const checks = [
  ['stream-copy-hash', 'async function copyAndHash'],
  ['workspace-manifest', "format: 'VEILFORGE_JOB_WORKSPACE'"],
  ['disk-budget', 'budget.assertDiskSpace'],
  ['abort-signal', 'options.signal'],
  ['bounded-path', 'function assertChildPath'],
  ['orphan-recovery', 'async function recoverOrphanedWorkspaces'],
  ['plaintext-cleanup', 'async cleanup()'],
  ['runtime-export', 'createJobWorkspace,']
];

let passed = 0;
for (const [name, marker] of checks) {
  const ok = source.includes(marker);
  if (ok) passed += 1;
  process.stdout.write(`CHECK ${name}=${ok ? 1 : 0}\n`);
}
process.stdout.write(`PHASE16_PROBE ${passed}/${checks.length}\n`);
process.exit(passed === checks.length ? 0 : 1);

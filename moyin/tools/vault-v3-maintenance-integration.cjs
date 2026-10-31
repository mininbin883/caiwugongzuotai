#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { runVaultV3MaintenanceScenario } = require('../src/services/vault-v3-maintenance-smoke.cjs');

async function main() {
  const output = path.resolve(__dirname, '..', 'output', 'vault', 'phase18');
  const report = await runVaultV3MaintenanceScenario(output);
  const reportPath = path.join(output, 'phase18-vault-v3-maintenance-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`VAULT_V3_MAINTENANCE_${report.result} created=${report.created} deleted=${report.deleted} remaining=${report.remainingAfterAppend} pages=${report.pages.join('/')} reclaimed=${report.reclaimedBytes} numbered=${report.continuedFileNumber}\n`);
  process.stdout.write(`REPORT=${reportPath}\n`);
  if (report.result !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

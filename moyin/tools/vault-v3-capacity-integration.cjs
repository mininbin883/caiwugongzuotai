#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { runVaultV3CapacityScenario } = require('../src/services/vault-v3-capacity-smoke.cjs');

async function main() {
  const targetArgument = process.argv.find((value) => value.startsWith('--target-mib='));
  const targetMiB = targetArgument ? Number(targetArgument.slice('--target-mib='.length)) : 256;
  const output = path.resolve(__dirname, '..', 'output', 'vault', 'phase18');
  const report = await runVaultV3CapacityScenario(output, { targetMiB });
  const reportPath = path.join(output, targetMiB === 256
    ? 'phase18-vault-v3-capacity-report.json'
    : `phase18-vault-v3-longrun-${targetMiB}MiB-report.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`VAULT_V3_CAPACITY_${report.result} target=${report.targetMiB}MiB bytes=${report.vaultBytes} entries=${report.entryCount} peakRss=${Math.round(report.peakRssBytes / 1024 / 1024)}MiB encrypted=${report.plaintextAbsent ? 1 : 0} exceed=${report.exceedGate ? 1 : 0}\n`);
  process.stdout.write(`REPORT=${reportPath}\n`);
  if (report.result !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

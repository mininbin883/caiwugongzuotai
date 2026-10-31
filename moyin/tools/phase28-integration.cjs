'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createVault, addVaultEntry, listVaultEntriesPage, closeVault } = require('../src/services/vault-service.cjs');
const { recordVaultActivity } = require('../src/services/vault-explorer-service.cjs');
const { saveBatchRecordsToVault } = require('../src/services/batch-vault-service.cjs');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-phase28-'));
  const file = path.join(directory, 'phase28.miyin-vault');
  const context = await createVault(file, 'phase28-integration-password');
  try {
    await addVaultEntry(context, { name: '客户合同', kind: 'redacted-text', text: '客户：张*', findingCount: 1, findingTypes: ['person'] });
    await addVaultEntry(context, { name: '研发映射', kind: 'reversible-map', text: '[MI_ABCDEF12_001]', mapping: [{ token: '[MI_ABCDEF12_001]', value: '海川科技', type: 'organization', label: '公司名称', occurrences: 1 }], findingCount: 1, findingTypes: ['organization'] });
    const search = listVaultEntriesPage(context, { filters: { query: '合同' }, pageSize: 20 });
    const kind = listVaultEntriesPage(context, { filters: { kind: 'reversible-map' }, pageSize: 20 });
    const today = new Date().toISOString().slice(0, 10);
    const dates = listVaultEntriesPage(context, { filters: { dateFrom: today, dateTo: today }, pageSize: 20 });
    const batch = await saveBatchRecordsToVault([{
      id: 'batch-1', sourceName: '批量客户.txt', vaultText: '客户：李*', findingCount: 1, findingTypes: ['person']
    }], (entry) => addVaultEntry(context, entry));
    const history = recordVaultActivity([], { action: 'export', name: 'phase28-backup.miyin-backup', entries: 3, bytes: 4096, sha256: 'A'.repeat(64) }, new Date('2026-10-31T02:00:00.000Z'));
    const pass = search.filteredTotal === 1 && kind.filteredTotal === 1 && dates.filteredTotal === 2 && batch.saved === 1 && history.length === 1;
    process.stdout.write(`PHASE28_${pass ? 'PASS' : 'FAIL'} search=${search.filteredTotal} kind=${kind.filteredTotal} dates=${dates.filteredTotal} history=${history.length} batchAutoVault=${batch.saved}\n`);
    if (!pass) process.exitCode = 1;
  } finally {
    closeVault(context);
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`PHASE28_FAILED ${error?.stack || error}\n`);
  process.exitCode = 2;
});

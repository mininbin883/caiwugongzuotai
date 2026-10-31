#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  createVault,
  openVault,
  addVaultEntry,
  listVaultEntries,
  exportVaultBackup,
  importVaultBackup,
  closeVault
} = require('../src/services/vault-service.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output', 'vault', 'phase12');
const SOURCE_PASSWORD = 'Phase12-Source-Vault-Password!';
const TARGET_PASSWORD = 'Phase12-Target-Vault-Password!';
const BACKUP_PASSWORD = 'Phase12-Portable-Backup-Password!';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  await fs.mkdir(OUTPUT, { recursive: true });
  const runDirectory = await fs.mkdtemp(path.join(OUTPUT, 'run-'));
  const sourcePath = path.join(runDirectory, 'source.miyin-vault');
  const targetPath = path.join(runDirectory, 'target.miyin-vault');
  const restoredPath = path.join(runDirectory, 'restored.miyin-vault');
  const sourceBackup = path.join(runDirectory, 'source.miyin-backup');
  const mergedBackup = path.join(runDirectory, 'merged.miyin-backup');

  const source = await createVault(sourcePath, SOURCE_PASSWORD);
  await addVaultEntry(source, { name: '合同.txt', text: '来源敏感内容已脱敏', findingCount: 1, findingTypes: ['custom'] });
  await addVaultEntry(source, {
    kind: 'reversible-map',
    name: '联系人映射.txt',
    text: '联系人 [MI_C0FFEE12_001]',
    mapping: [{ token: '[MI_C0FFEE12_001]', value: '张三', type: 'person', label: '姓名', occurrences: 1 }],
    findingCount: 1,
    findingTypes: ['person']
  });
  const exported = await exportVaultBackup(source, sourceBackup, BACKUP_PASSWORD);
  closeVault(source);

  const sourceBackupBytes = await fs.readFile(sourceBackup);
  const sourceBackupText = sourceBackupBytes.toString('utf8');
  const encrypted = !sourceBackupText.includes('来源敏感内容已脱敏') &&
    !sourceBackupText.includes('张三') && !sourceBackupText.includes('[MI_C0FFEE12_001]');

  const target = await createVault(targetPath, TARGET_PASSWORD);
  await addVaultEntry(target, { name: '合同.txt', text: '目标仓库现有记录', findingCount: 1, findingTypes: ['custom'] });
  let rejectAtomic = false;
  try {
    await importVaultBackup(target, sourceBackup, BACKUP_PASSWORD, 'reject');
  } catch (error) {
    rejectAtomic = error?.message === 'LOCAL_VAULT_IMPORT_CONFLICT' && listVaultEntries(target).length === 1;
  }
  const merged = await importVaultBackup(target, sourceBackup, BACKUP_PASSWORD, 'rename');
  const duplicate = await importVaultBackup(target, sourceBackup, BACKUP_PASSWORD, 'skip');
  await addVaultEntry(target, { name: '导入后新增.txt', text: '自动编号继续', findingCount: 1, findingTypes: ['custom'] });
  const targetEntries = listVaultEntries(target);
  const numbering = targetEntries.map((entry) => entry.fileNumber);
  const mergedExport = await exportVaultBackup(target, mergedBackup, BACKUP_PASSWORD);
  closeVault(target);

  const restored = await createVault(restoredPath, TARGET_PASSWORD);
  const restoredImport = await importVaultBackup(restored, mergedBackup, BACKUP_PASSWORD, 'reject');
  const restoredEntries = listVaultEntries(restored);
  closeVault(restored);
  const reopened = await openVault(targetPath, TARGET_PASSWORD);
  const reopenedEntries = listVaultEntries(reopened);
  closeVault(reopened);

  const pass = encrypted && rejectAtomic && exported.entries === 2 && merged.imported === 2 && merged.renamed === 1 &&
    duplicate.imported === 0 && duplicate.skipped === 2 && numbering.join(',') === 'MI-000001,MI-000002,MI-000003,MI-000004' &&
    mergedExport.entries === 4 && restoredImport.imported === 4 && restoredEntries.length === 4 && reopenedEntries.length === 4;
  const report = {
    format: 'VEILFORGE_VAULT_MIGRATION_REPORT',
    result: pass ? 'PASS' : 'FAIL',
    runDirectory,
    source: { entries: exported.entries, backupSha256: sha256(sourceBackupBytes), encrypted },
    rejectAtomic,
    merge: { imported: merged.imported, skipped: merged.skipped, renamed: merged.renamed, conflicts: merged.conflicts.length },
    duplicate: { imported: duplicate.imported, skipped: duplicate.skipped, conflicts: duplicate.conflicts.length },
    numbering,
    migration: { exported: mergedExport.entries, imported: restoredImport.imported, restored: restoredEntries.length, reopened: reopenedEntries.length }
  };
  const reportPath = path.join(OUTPUT, 'phase12-vault-migration-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`VAULT_MIGRATION_${report.result} source=${exported.entries} imported=${merged.imported} renamed=${merged.renamed} skipped=${duplicate.skipped} numbered=${numbering.length} encrypted=${encrypted ? 1 : 0}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

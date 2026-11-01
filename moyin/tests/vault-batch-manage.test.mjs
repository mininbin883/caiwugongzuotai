import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const vault = require('../src/services/vault-service.cjs');
const PASSWORD = 'Batch-Manage-2026!';

async function seed(count) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moyin-batch-manage-'));
  const context = await vault.createVault(path.join(directory, 'v.miyin-vault'), PASSWORD);
  const saved = [];
  for (let index = 0; index < count; index += 1) {
    saved.push(await vault.addVaultEntry(context, {
      kind: 'reversible-map', name: index % 2 ? `批次 · ${index}` : `合同${index}.docx`, text: `[MI_ABCDEF12_00${index}]`,
      mapping: [{ token: `[MI_ABCDEF12_00${index}]`, value: `示例${index}`, type: 'person', occurrences: 1 }], findingCount: 1, findingTypes: ['person']
    }));
  }
  return { directory, context, saved };
}

test('批量删除：一次删除多条，其余记录保留', async () => {
  const { directory, context, saved } = await seed(5);
  const result = await vault.deleteVaultEntries(context, [saved[0].id, saved[2].id, saved[4].id]);
  assert.equal(result.deleted, 3);
  assert.deepEqual(result.deletedFileNumbers.sort(), [saved[0].fileNumber, saved[2].fileNumber, saved[4].fileNumber].sort());
  const page = vault.listVaultEntriesPage(context, { pageSize: 100 });
  assert.deepEqual(page.entries.map((entry) => entry.id).sort(), [saved[1].id, saved[3].id].sort());
  await assert.rejects(vault.deleteVaultEntries(context, []), /LOCAL_VAULT_ENTRY_NOT_FOUND/u);
  await fs.rm(directory, { recursive: true, force: true });
});

test('全选筛选结果：返回所有符合条件的记录编号', async () => {
  const { directory, context } = await seed(6);
  const all = vault.listVaultEntryIds(context, {});
  assert.equal(all.length, 6);
  const batches = vault.listVaultEntryIds(context, { query: '批次' });
  assert.equal(batches.length, 3);
  await fs.rm(directory, { recursive: true, force: true });
});

test('导出所选记录的备份：备份里只有所选记录', async () => {
  const { directory, context, saved } = await seed(4);
  const backupPath = path.join(directory, 'selected.miyin-backup');
  const backup = await vault.exportVaultBackup(context, backupPath, 'Backup-Selected-2026!', { entryIds: [saved[1].id, saved[3].id] });
  assert.equal(backup.records, 2);
  const target = await vault.createVault(path.join(directory, 'target.miyin-vault'), PASSWORD);
  const report = await vault.importVaultBackup(target, backupPath, 'Backup-Selected-2026!', 'rename');
  assert.equal(report.imported, 2);
  const names = vault.listVaultEntriesPage(target, { pageSize: 100 }).entries.map((entry) => entry.name).sort();
  assert.deepEqual(names, [saved[1].name, saved[3].name].sort());
  await fs.rm(directory, { recursive: true, force: true });
});

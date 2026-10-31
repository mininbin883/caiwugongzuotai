'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createVault,
  openVault,
  addVaultEntry,
  listVaultEntries,
  listVaultEntriesPage,
  readVaultEntry,
  deleteVaultEntry,
  compactVault,
  vaultStatistics,
  closeVault
} = require('./vault-service.cjs');

const PASSWORD = 'Phase18-Vault-Maintenance-Password!';
const ENTRY_COUNT = 60;
const DELETE_COUNT = 20;
const ENTRY_TEXT_BYTES = 256 * 1024;

async function runVaultV3MaintenanceScenario(outputDirectory) {
  const startedAt = Date.now();
  const output = path.resolve(outputDirectory);
  await fs.mkdir(output, { recursive: true });
  const vaultPath = path.join(output, 'phase18-maintenance.miyin-vault');
  await fs.rm(vaultPath, { force: true });
  const filler = 'M'.repeat(ENTRY_TEXT_BYTES - 64);
  let context;
  try {
    context = await createVault(vaultPath, PASSWORD);
    for (let index = 0; index < ENTRY_COUNT; index += 1) {
      await addVaultEntry(context, {
        name: `维护记录-${String(index + 1).padStart(3, '0')}.txt`,
        text: `PHASE18_MAINTAIN_${String(index).padStart(3, '0')}_${filler}`,
        findingCount: 1,
        findingTypes: ['maintenance']
      });
    }
    const firstPage = listVaultEntriesPage(context, { pageSize: 20 });
    const secondPage = listVaultEntriesPage(context, { pageSize: 20, cursor: firstPage.nextCursor });
    const thirdPage = listVaultEntriesPage(context, { pageSize: 20, cursor: secondPage.nextCursor });
    const beforeDelete = vaultStatistics(context);
    const targets = listVaultEntries(context).slice(0, DELETE_COUNT);
    for (const entry of targets) await deleteVaultEntry(context, entry.id);
    let deletedRejected = false;
    try {
      await readVaultEntry(context, targets[0].id);
    } catch (error) {
      deletedRejected = error?.message === 'LOCAL_VAULT_ENTRY_NOT_FOUND';
    }
    const afterDelete = vaultStatistics(context);
    const compaction = await compactVault(context);
    const added = await addVaultEntry(context, {
      name: '压缩后新增.txt',
      text: '压缩完成后编号继续递增',
      findingCount: 1,
      findingTypes: ['maintenance']
    });
    const kept = listVaultEntries(context)[0];
    const keptText = (await readVaultEntry(context, kept.id)).text;
    closeVault(context);
    context = null;

    const reopened = await openVault(vaultPath, PASSWORD);
    const reopenedEntries = listVaultEntries(reopened);
    const reopenedPage = listVaultEntriesPage(reopened, { pageSize: 20 });
    closeVault(reopened);
    const pass = firstPage.entries.length === 20 && secondPage.entries.length === 20 && thirdPage.entries.length === 20 &&
      firstPage.entries[0].sequence === 60 && thirdPage.entries.at(-1).sequence === 1 &&
      deletedRejected && afterDelete.reclaimableBytes > beforeDelete.reclaimableBytes &&
      compaction.reclaimedBytes > DELETE_COUNT * ENTRY_TEXT_BYTES && compaction.after.fileBytes < compaction.before.fileBytes &&
      added.fileNumber === 'MI-000061' && keptText.startsWith('PHASE18_MAINTAIN_020_') &&
      reopenedEntries.length === 41 && reopenedPage.entries.length === 20 && reopenedPage.hasMore;
    return {
      format: 'VEILFORGE_VAULT_V3_MAINTENANCE_REPORT',
      result: pass ? 'PASS' : 'FAIL',
      version: 3,
      created: ENTRY_COUNT,
      deleted: DELETE_COUNT,
      remainingAfterAppend: reopenedEntries.length,
      pages: [firstPage.entries.length, secondPage.entries.length, thirdPage.entries.length],
      descending: firstPage.entries[0].sequence === 60 && thirdPage.entries.at(-1).sequence === 1,
      deletedRejected,
      beforeDeleteBytes: beforeDelete.fileBytes,
      afterDeleteBytes: afterDelete.fileBytes,
      reclaimableBeforeCompact: compaction.before.reclaimableBytes,
      compactedBytes: compaction.after.fileBytes,
      reclaimedBytes: compaction.reclaimedBytes,
      continuedFileNumber: added.fileNumber,
      reopenedPageEntries: reopenedPage.entries.length,
      reopenedHasMore: reopenedPage.hasMore,
      milliseconds: Date.now() - startedAt
    };
  } finally {
    if (context) closeVault(context);
    await fs.rm(vaultPath, { force: true }).catch(() => {});
  }
}

module.exports = { runVaultV3MaintenanceScenario };

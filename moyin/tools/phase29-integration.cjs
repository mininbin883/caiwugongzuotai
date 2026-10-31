'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createVault,
  openVault,
  addVaultEntryWithAttachments,
  listVaultEntries,
  exportVaultAttachment,
  exportVaultBackup,
  vaultStatistics,
  closeVault
} = require('../src/services/vault-service.cjs');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-phase29-'));
  const vaultPath = path.join(directory, 'phase29.miyin-vault');
  const backupPath = path.join(directory, 'phase29.miyin-backup');
  const originalPath = path.join(directory, 'source.docx');
  const redactedOnePath = path.join(directory, 'redacted-one.docx');
  const redactedTwoPath = path.join(directory, 'redacted-two.docx');
  const exportedPath = path.join(directory, 'roundtrip.docx');
  const original = Buffer.from('PK\u0003\u0004PHASE29-ORIGINAL-FILE', 'binary');
  await fs.writeFile(originalPath, original);
  await fs.writeFile(redactedOnePath, Buffer.from('PK\u0003\u0004PHASE29-REDACTED-ONE', 'binary'));
  await fs.writeFile(redactedTwoPath, Buffer.from('PK\u0003\u0004PHASE29-REDACTED-TWO', 'binary'));
  let context = await createVault(vaultPath, 'phase29-integration-password');
  try {
    const first = await addVaultEntryWithAttachments(context, { name: '一号合同', text: '一号脱敏文本', findingCount: 1 }, [
      { path: originalPath, role: 'original' }, { path: redactedOnePath, role: 'redacted-copy' }
    ]);
    const second = await addVaultEntryWithAttachments(context, { name: '二号合同', text: '二号脱敏文本', findingCount: 1 }, [
      { path: originalPath, role: 'original' }, { path: redactedTwoPath, role: 'redacted-copy' }
    ]);
    const entries = listVaultEntries(context);
    await exportVaultAttachment(context, entries[0].id, entries[0].attachments[0].blobId, exportedPath);
    const exact = Buffer.compare(await fs.readFile(exportedPath), original) === 0;
    const stats = vaultStatistics(context);
    const backup = await exportVaultBackup(context, backupPath, 'phase29-backup-password');
    closeVault(context);
    context = null;
    const reopened = await openVault(vaultPath, 'phase29-integration-password');
    const reopenOk = reopened.data.schemaVersion === 4 && listVaultEntries(reopened).length === 2;
    closeVault(reopened);
    const pass = first.attachmentResult.files === 2 && second.attachmentResult.deduplicated === 1 &&
      stats.entries === 2 && stats.attachmentReferences === 4 && stats.fileBlobs === 3 &&
      exact && backup.entries === 5 && reopenOk;
    process.stdout.write(`PHASE29_${pass ? 'PASS' : 'FAIL'} entries=${stats.entries} attachments=${stats.attachmentReferences} blobs=${stats.fileBlobs} dedup=${stats.deduplicatedReferences} exportExact=${exact ? 1 : 0} backup=${backup.entries === 5 ? 1 : 0} reopen=${reopenOk ? 1 : 0}\n`);
    if (!pass) process.exitCode = 1;
  } finally {
    if (context) closeVault(context);
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`PHASE29_FAILED ${error?.stack || error}\n`);
  process.exitCode = 2;
});

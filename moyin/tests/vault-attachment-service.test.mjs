import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createVault,
  openVault,
  addVaultEntryWithAttachments,
  listVaultEntries,
  exportVaultAttachment,
  deleteVaultEntry,
  compactVault,
  vaultStatistics,
  exportVaultBackup,
  closeVault
} = require('../src/services/vault-service.cjs');

const PASSWORD = 'Phase29-Attachment-Vault-Password!';
const BACKUP_PASSWORD = 'Phase29-Attachment-Backup-Password!';

test('vault v4 encrypts original-format attachments, deduplicates content and exports exact bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-attachment-'));
  const vaultPath = path.join(directory, 'attachments.miyin-vault');
  const backupPath = path.join(directory, 'attachments.miyin-backup');
  const originalPath = path.join(directory, 'original.docx');
  const copyOnePath = path.join(directory, 'copy-one.docx');
  const copyTwoPath = path.join(directory, 'copy-two.docx');
  const exportedPath = path.join(directory, 'exported.docx');
  const originalBytes = Buffer.from('PK\u0003\u0004phase29-original-office-bytes', 'binary');
  try {
    await fs.writeFile(originalPath, originalBytes);
    await fs.writeFile(copyOnePath, Buffer.from('PK\u0003\u0004phase29-redacted-one', 'binary'));
    await fs.writeFile(copyTwoPath, Buffer.from('PK\u0003\u0004phase29-redacted-two', 'binary'));
    const context = await createVault(vaultPath, PASSWORD);
    const first = await addVaultEntryWithAttachments(context, {
      name: '第一份合同', text: '第一份脱敏文本', findingCount: 2, findingTypes: ['name', 'mobile']
    }, [
      { path: originalPath, role: 'original' },
      { path: copyOnePath, role: 'redacted-copy' }
    ]);
    const second = await addVaultEntryWithAttachments(context, {
      name: '第二份合同', text: '第二份脱敏文本', findingCount: 1, findingTypes: ['name']
    }, [
      { path: originalPath, role: 'original' },
      { path: copyTwoPath, role: 'redacted-copy' }
    ]);

    assert.deepEqual(first.attachmentResult, { files: 2, newBlobs: 2, deduplicated: 0 });
    assert.deepEqual(second.attachmentResult, { files: 2, newBlobs: 1, deduplicated: 1 });
    const entries = listVaultEntries(context);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].attachments.length, 2);
    assert.equal(entries[0].attachments[0].blobId, entries[1].attachments[0].blobId);
    const stats = vaultStatistics(context);
    assert.equal(stats.entries, 2);
    assert.equal(stats.fileBlobs, 3);
    assert.equal(stats.attachmentReferences, 4);
    assert.equal(stats.deduplicatedReferences, 1);

    const exported = await exportVaultAttachment(context, entries[0].id, entries[0].attachments[0].blobId, exportedPath);
    assert.equal(exported.bytes, originalBytes.length);
    assert.deepEqual(await fs.readFile(exportedPath), originalBytes);

    const backup = await exportVaultBackup(context, backupPath, BACKUP_PASSWORD);
    assert.equal(backup.entries, 5);
    const deletion = await deleteVaultEntry(context, entries[0].id);
    assert.equal(deletion.orphanedBlobs, 1);
    assert.equal(vaultStatistics(context).fileBlobs, 2);
    await compactVault(context);
    closeVault(context);

    const reopened = await openVault(vaultPath, PASSWORD);
    assert.equal(reopened.data.schemaVersion, 4);
    assert.equal(listVaultEntries(reopened).length, 1);
    assert.equal(vaultStatistics(reopened).fileBlobs, 2);
    closeVault(reopened);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

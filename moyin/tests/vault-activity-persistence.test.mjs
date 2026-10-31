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
  listVaultActivity,
  appendVaultActivity,
  compactVault,
  rotateVaultPassword,
  exportVaultBackup,
  importVaultBackup,
  closeVault
} = require('../src/services/vault-service.cjs');

const PASSWORD = 'Phase30-Persistent-History-Password!';
const ROTATED = 'Phase30-Rotated-History-Password!';
const BACKUP_PASSWORD = 'Phase30-Backup-History-Password!';

test('authenticated activity history survives reopen, compaction and password rotation without paths or passwords', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-phase30-history-'));
  const vaultPath = path.join(directory, 'history.miyin-vault');
  try {
    let context = await createVault(vaultPath, PASSWORD);
    await appendVaultActivity(context, {
      action: 'export',
      name: 'C:\\Users\\Operator\\Documents\\客户资料-备份.miyin-backup',
      entries: 7,
      bytes: 4096,
      sha256: 'A'.repeat(64),
      path: 'C:\\Users\\Operator\\Documents',
      password: 'must-never-persist'
    }, new Date('2026-10-31T08:00:00.000Z'));
    assert.equal(listVaultActivity(context)[0].name, '客户资料-备份.miyin-backup');
    assert.equal(Object.hasOwn(listVaultActivity(context)[0], 'path'), false);
    assert.equal(Object.hasOwn(listVaultActivity(context)[0], 'password'), false);
    closeVault(context);

    const raw = await fs.readFile(vaultPath);
    assert.equal(raw.includes(Buffer.from('客户资料-备份.miyin-backup')), false);
    assert.equal(raw.includes(Buffer.from('must-never-persist')), false);
    context = await openVault(vaultPath, PASSWORD);
    assert.equal(listVaultActivity(context).length, 1);
    assert.equal(listVaultActivity(context)[0].entries, 7);
    await compactVault(context);
    assert.equal(listVaultActivity(context)[0].name, '客户资料-备份.miyin-backup');
    await rotateVaultPassword(context, ROTATED);
    closeVault(context);

    await assert.rejects(() => openVault(vaultPath, PASSWORD), /LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID/u);
    context = await openVault(vaultPath, ROTATED);
    assert.equal(listVaultActivity(context)[0].sha256, 'A'.repeat(64));
    closeVault(context);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('encrypted backup carries prior history and import merges it with local history', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-phase30-backup-history-'));
  const sourcePath = path.join(directory, 'source.miyin-vault');
  const targetPath = path.join(directory, 'target.miyin-vault');
  const backupPath = path.join(directory, 'source.miyin-backup');
  try {
    const source = await createVault(sourcePath, PASSWORD);
    await appendVaultActivity(source, { action: 'export', name: '/private/archive/source-one.miyin-backup', entries: 2, bytes: 2048, sha256: 'B'.repeat(64) }, new Date('2026-10-31T08:10:00.000Z'));
    await exportVaultBackup(source, backupPath, BACKUP_PASSWORD);
    closeVault(source);

    const target = await createVault(targetPath, ROTATED);
    await appendVaultActivity(target, { action: 'import', name: 'local-before.miyin-backup', imported: 1 }, new Date('2026-10-31T08:20:00.000Z'));
    const imported = await importVaultBackup(target, backupPath, BACKUP_PASSWORD, 'rename');
    assert.equal(imported.imported, 0);
    const history = listVaultActivity(target);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((item) => item.name), ['local-before.miyin-backup', 'source-one.miyin-backup']);
    closeVault(target);

    const reopened = await openVault(targetPath, ROTATED);
    assert.deepEqual(listVaultActivity(reopened).map((item) => item.action), ['import', 'export']);
    closeVault(reopened);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

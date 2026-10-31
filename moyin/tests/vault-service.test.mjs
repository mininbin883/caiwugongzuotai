import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  VAULT_FORMAT,
  VAULT_BACKUP_FORMAT,
  createVault,
  openVault,
  addVaultEntry,
  listVaultEntries,
  listVaultEntriesPage,
  readVaultEntry,
  deleteVaultEntry,
  compactVault,
  vaultStatistics,
  exportVaultBackup,
  importVaultBackup,
  rotateVaultPassword,
  closeVault,
  validatePayload,
  VAULT_VERSION,
  MAX_VAULT_BYTES,
  PARITY_VAULT_BYTES,
  createLegacyVault,
  assertVaultGrowth,
  isV3Vault
} = require('../src/services/vault-service.cjs');

const OLD_PASSWORD = 'Strong-Local-Passphrase-2026!';
const NEW_PASSWORD = 'Rotated-Local-Passphrase-2027!';
const BACKUP_PASSWORD = 'Portable-Backup-Passphrase-2028!';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-vault-'));
  return {
    directory,
    file: path.join(directory, 'test.miyin-vault'),
    tampered: path.join(directory, 'tampered.miyin-vault'),
    backup: path.join(directory, 'snapshot.miyin-backup'),
    target: path.join(directory, 'target.miyin-vault')
  };
}

async function cleanup({ directory, file, tampered, backup, target }) {
  await fs.rm(file, { force: true });
  await fs.rm(tampered, { force: true });
  await fs.rm(backup, { force: true });
  await fs.rm(target, { force: true });
  await fs.rmdir(directory);
}

test('AES-256-GCM vault encrypts entries and reopens with the correct password', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    await addVaultEntry(context, {
      name: '客户资料-脱敏.txt',
      text: '客户：张*\n手机：138****5678',
      findingCount: 2,
      findingTypes: ['custom', 'mobile']
    });
    closeVault(context);

    const raw = await fs.readFile(paths.file);
    assert.equal(await isV3Vault(paths.file), true);
    assert.equal(VAULT_VERSION, 3);
    assert.equal(raw.includes(Buffer.from('138****5678')), false);

    const reopened = await openVault(paths.file, OLD_PASSWORD);
    const entries = listVaultEntries(reopened);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].audit.findingCount, 2);
    assert.equal((await readVaultEntry(reopened, entries[0].id)).text, '客户：张*\n手机：138****5678');
    closeVault(reopened);
  } finally {
    await cleanup(paths);
  }
});

test('wrong password and authenticated-ciphertext tampering are rejected', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    closeVault(context);
    await assert.rejects(() => openVault(paths.file, 'Incorrect-Password-For-Vault!'), /LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID/);

    const payload = await fs.readFile(paths.file);
    const headerLength = payload.readUInt32BE(8);
    payload[12 + headerLength + 50] ^= 0x01;
    await fs.writeFile(paths.tampered, payload);
    await assert.rejects(() => openVault(paths.tampered, OLD_PASSWORD), /LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID/);
  } finally {
    await cleanup(paths);
  }
});

test('password rotation invalidates the previous password and preserves entries', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    await addVaultEntry(context, { name: '结果.txt', text: '已脱敏内容', findingCount: 1, findingTypes: ['custom'] });
    await rotateVaultPassword(context, NEW_PASSWORD);
    closeVault(context);

    await assert.rejects(() => openVault(paths.file, OLD_PASSWORD), /LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID/);
    const reopened = await openVault(paths.file, NEW_PASSWORD);
    assert.equal(listVaultEntries(reopened).length, 1);
    assert.equal((await readVaultEntry(reopened, listVaultEntries(reopened)[0].id)).text, '已脱敏内容');
    closeVault(reopened);
  } finally {
    await cleanup(paths);
  }
});

test('reversible token mappings stay encrypted and restore after reopening', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    await addVaultEntry(context, {
      kind: 'reversible-map',
      name: '合同 · 可逆副本',
      text: '联系人 [MI_A1B2C3D4_001]',
      mapping: [{
        token: '[MI_A1B2C3D4_001]',
        value: '张三',
        type: 'custom',
        label: '姓名',
        occurrences: 1
      }],
      findingCount: 1,
      findingTypes: ['custom']
    });
    closeVault(context);
    const raw = await fs.readFile(paths.file, 'utf8');
    assert.equal(raw.includes('张三'), false);
    assert.equal(raw.includes('[MI_A1B2C3D4_001]'), false);
    const reopened = await openVault(paths.file, OLD_PASSWORD);
    const listed = listVaultEntries(reopened);
    assert.equal(listed[0].kind, 'reversible-map');
    assert.equal(listed[0].audit.tokenCount, 1);
    const entry = await readVaultEntry(reopened, listed[0].id);
    assert.equal(entry.mapping[0].value, '张三');
    closeVault(reopened);
  } finally {
    await cleanup(paths);
  }
});

test('vault entries receive stable automatic file numbers across reopen', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    await addVaultEntry(context, { name: '第一份.txt', text: '内容一', findingCount: 1, findingTypes: ['custom'] });
    await addVaultEntry(context, { name: '第二份.txt', text: '内容二', findingCount: 1, findingTypes: ['custom'] });
    assert.deepEqual(listVaultEntries(context).map((entry) => entry.fileNumber), ['MI-000001', 'MI-000002']);
    closeVault(context);

    const reopened = await openVault(paths.file, OLD_PASSWORD);
    assert.deepEqual(listVaultEntries(reopened).map((entry) => entry.sequence), [1, 2]);
    await addVaultEntry(reopened, { name: '第三份.txt', text: '内容三', findingCount: 1, findingTypes: ['custom'] });
    assert.equal(listVaultEntries(reopened)[2].fileNumber, 'MI-000003');
    closeVault(reopened);
  } finally {
    await cleanup(paths);
  }
});

test('encrypted backup import rejects atomically, then renames conflicts and skips duplicates', async () => {
  const paths = await fixture();
  try {
    const source = await createVault(paths.file, OLD_PASSWORD);
    await addVaultEntry(source, { name: '合同.txt', text: '来源仓库内容', findingCount: 1, findingTypes: ['custom'] });
    await addVaultEntry(source, {
      kind: 'reversible-map',
      name: '映射.txt',
      text: '联系人 [MI_A1B2C3D4_001]',
      mapping: [{ token: '[MI_A1B2C3D4_001]', value: '张三', type: 'person', label: '姓名', occurrences: 1 }],
      findingCount: 1,
      findingTypes: ['person']
    });
    const exported = await exportVaultBackup(source, paths.backup, BACKUP_PASSWORD);
    assert.equal(exported.entries, 2);
    closeVault(source);

    const rawBackup = await fs.readFile(paths.backup);
    assert.equal(await isV3Vault(paths.backup), true);
    assert.equal(rawBackup.includes(Buffer.from('来源仓库内容')), false);
    assert.equal(rawBackup.includes(Buffer.from('张三')), false);
    assert.equal(rawBackup.includes(Buffer.from('[MI_A1B2C3D4_001]')), false);

    const target = await createVault(paths.target, NEW_PASSWORD);
    await addVaultEntry(target, { name: '合同.txt', text: '目标仓库现有内容', findingCount: 1, findingTypes: ['custom'] });
    await assert.rejects(
      () => importVaultBackup(target, paths.backup, BACKUP_PASSWORD, 'reject'),
      /LOCAL_VAULT_IMPORT_CONFLICT/
    );
    assert.equal(listVaultEntries(target).length, 1);

    const merged = await importVaultBackup(target, paths.backup, BACKUP_PASSWORD, 'rename');
    assert.equal(merged.imported, 2);
    assert.equal(merged.renamed, 1);
    assert.equal(merged.conflicts.length, 1);
    assert.deepEqual(merged.entries.map((entry) => entry.fileNumber), ['MI-000001', 'MI-000002', 'MI-000003']);
    assert.equal(merged.entries[1].name, '合同.txt (导入 2)');

    const duplicate = await importVaultBackup(target, paths.backup, BACKUP_PASSWORD, 'skip');
    assert.equal(duplicate.imported, 0);
    assert.equal(duplicate.skipped, 2);
    assert.equal(duplicate.conflicts.every((item) => item.kind === 'duplicate'), true);
    closeVault(target);
  } finally {
    await cleanup(paths);
  }
});

test('legacy payloads without sequence fields migrate deterministically in memory', () => {
  const now = new Date().toISOString();
  const legacy = validatePayload({
    format: 'VEILFORGE_VAULT_PAYLOAD',
    version: 1,
    createdAt: now,
    updatedAt: now,
    entries: [{
      id: 'legacy-entry',
      name: '旧记录',
      kind: 'redacted-text',
      createdAt: now,
      text: '旧版内容',
      mapping: [],
      audit: { findingCount: 1, findingTypes: ['custom'], tokenCount: 0 }
    }]
  });
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.entries[0].sequence, 1);
  assert.equal(legacy.entries[0].fileNumber, 'MI-000001');
  assert.equal(legacy.nextSequence, 2);
});

test('legacy v2 file migrates atomically to v3 chunk storage on open', async () => {
  const paths = await fixture();
  try {
    await createLegacyVault(paths.file, OLD_PASSWORD, [{
      name: '旧版记录.txt',
      text: '旧版仓库迁移内容',
      findingCount: 1,
      findingTypes: ['custom']
    }]);
    assert.equal(await isV3Vault(paths.file), false);
    const context = await openVault(paths.file, OLD_PASSWORD);
    assert.deepEqual(context.migration, { fromVersion: 2, toVersion: 4, entries: 1 });
    assert.equal((await readVaultEntry(context, listVaultEntries(context)[0].id)).text, '旧版仓库迁移内容');
    closeVault(context);
    assert.equal(await isV3Vault(paths.file), true);
  } finally {
    await cleanup(paths);
  }
});

test('an interrupted append tail is truncated to the last authenticated commit', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    await addVaultEntry(context, { name: '已提交.txt', text: '事务前内容', findingCount: 1, findingTypes: ['custom'] });
    closeVault(context);
    const committedBytes = (await fs.stat(paths.file)).size;
    await fs.appendFile(paths.file, Buffer.alloc(8192, 0xa5));
    assert.equal((await fs.stat(paths.file)).size, committedBytes + 8192);
    const recovered = await openVault(paths.file, OLD_PASSWORD);
    assert.equal(recovered.recoveredBytes, 8192);
    assert.equal((await fs.stat(paths.file)).size, committedBytes);
    assert.equal((await readVaultEntry(recovered, listVaultEntries(recovered)[0].id)).text, '事务前内容');
    closeVault(recovered);
  } finally {
    await cleanup(paths);
  }
});

test('vault capacity policy exposes 256 MiB parity and rejects growth beyond 2 GiB', () => {
  assert.equal(PARITY_VAULT_BYTES, 256 * 1024 * 1024);
  assert.equal(MAX_VAULT_BYTES, 2 * 1024 * 1024 * 1024);
  assert.equal(assertVaultGrowth(MAX_VAULT_BYTES - 4096, 4096), MAX_VAULT_BYTES);
  assert.throws(() => assertVaultGrowth(MAX_VAULT_BYTES - 4096, 4097), /LOCAL_VAULT_TOO_LARGE/);
});

test('vault entry pagination is stable, descending and bounded', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    for (let index = 0; index < 45; index += 1) {
      await addVaultEntry(context, {
        name: `分页-${index + 1}.txt`,
        text: `分页内容-${index + 1}`,
        findingCount: 1,
        findingTypes: ['custom']
      });
    }
    const first = listVaultEntriesPage(context, { pageSize: 20 });
    const second = listVaultEntriesPage(context, { pageSize: 20, cursor: first.nextCursor });
    const third = listVaultEntriesPage(context, { pageSize: 20, cursor: second.nextCursor });
    assert.equal(first.total, 45);
    assert.deepEqual(first.entries.map((entry) => entry.sequence), Array.from({ length: 20 }, (_, index) => 45 - index));
    assert.deepEqual(second.entries.map((entry) => entry.sequence), Array.from({ length: 20 }, (_, index) => 25 - index));
    assert.deepEqual(third.entries.map((entry) => entry.sequence), [5, 4, 3, 2, 1]);
    assert.equal(third.hasMore, false);
    assert.throws(() => listVaultEntriesPage(context, { cursor: -1 }), /LOCAL_VAULT_CURSOR_INVALID/);
    closeVault(context);
  } finally {
    await cleanup(paths);
  }
});

test('delete commits a tombstone view and compaction reclaims encrypted chunks without reusing numbers', async () => {
  const paths = await fixture();
  try {
    const context = await createVault(paths.file, OLD_PASSWORD);
    await addVaultEntry(context, {
      name: '待删除.txt',
      text: `DELETE_SECRET_${'D'.repeat(2 * 1024 * 1024)}`,
      findingCount: 1,
      findingTypes: ['custom']
    });
    await addVaultEntry(context, {
      name: '保留.txt',
      text: `KEEP_SECRET_${'K'.repeat(2 * 1024 * 1024)}`,
      findingCount: 1,
      findingTypes: ['custom']
    });
    const target = listVaultEntries(context).find((entry) => entry.sequence === 1);
    const beforeDelete = vaultStatistics(context);
    const deletion = await deleteVaultEntry(context, target.id);
    assert.equal(deletion.deletedFileNumber, 'MI-000001');
    assert.equal(listVaultEntries(context).length, 1);
    await assert.rejects(() => readVaultEntry(context, target.id), /LOCAL_VAULT_ENTRY_NOT_FOUND/);
    const afterDelete = vaultStatistics(context);
    assert.ok(afterDelete.reclaimableBytes > beforeDelete.reclaimableBytes + 2 * 1024 * 1024);

    const compaction = await compactVault(context);
    assert.ok(compaction.reclaimedBytes > 2 * 1024 * 1024);
    assert.ok(compaction.after.fileBytes < compaction.before.fileBytes);
    assert.equal((await readVaultEntry(context, listVaultEntries(context)[0].id)).text.startsWith('KEEP_SECRET_'), true);
    const third = await addVaultEntry(context, {
      name: '压缩后新增.txt',
      text: '编号不能复用',
      findingCount: 1,
      findingTypes: ['custom']
    });
    assert.equal(third.fileNumber, 'MI-000003');
    closeVault(context);

    const reopened = await openVault(paths.file, OLD_PASSWORD);
    assert.deepEqual(listVaultEntries(reopened).map((entry) => entry.fileNumber), ['MI-000002', 'MI-000003']);
    assert.equal((await fs.readFile(paths.file)).includes(Buffer.from('DELETE_SECRET_')), false);
    closeVault(reopened);
  } finally {
    await cleanup(paths);
  }
});

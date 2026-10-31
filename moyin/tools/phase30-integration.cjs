'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createVault, openVault, appendVaultActivity, listVaultActivity, compactVault,
  rotateVaultPassword, exportVaultBackup, importVaultBackup, closeVault
} = require('../src/services/vault-service.cjs');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-phase30-'));
  const sourcePath = path.join(directory, 'phase30-source.miyin-vault');
  const targetPath = path.join(directory, 'phase30-target.miyin-vault');
  const backupPath = path.join(directory, 'phase30-source.miyin-backup');
  const password = 'phase30-source-password';
  const rotated = 'phase30-rotated-password';
  const backupPassword = 'phase30-backup-password';
  try {
    let source = await createVault(sourcePath, password);
    await appendVaultActivity(source, {
      action: 'export', name: 'C:\\private\\客户资料.miyin-backup', entries: 4, bytes: 8192,
      sha256: 'D'.repeat(64), path: 'C:\\private', password: 'must-not-persist'
    }, new Date('2026-10-31T08:30:00.000Z'));
    closeVault(source);

    source = await openVault(sourcePath, password);
    const reopen = listVaultActivity(source).length === 1;
    await compactVault(source);
    const compact = listVaultActivity(source)[0]?.name === '客户资料.miyin-backup';
    await rotateVaultPassword(source, rotated);
    const rotate = listVaultActivity(source)[0]?.sha256 === 'D'.repeat(64);
    await exportVaultBackup(source, backupPath, backupPassword);
    closeVault(source);

    const target = await createVault(targetPath, 'phase30-target-password');
    await appendVaultActivity(target, { action: 'import', name: '本地历史.miyin-backup', imported: 1 }, new Date('2026-10-31T08:40:00.000Z'));
    await importVaultBackup(target, backupPath, backupPassword, 'rename');
    await appendVaultActivity(target, { action: 'import', name: backupPath, imported: 0, skipped: 0, renamed: 0 }, new Date('2026-10-31T08:50:00.000Z'));
    const history = listVaultActivity(target);
    closeVault(target);

    const raw = await fs.readFile(targetPath);
    const privateDataAbsent = !raw.includes(Buffer.from('C:\\private')) && !raw.includes(Buffer.from('must-not-persist')) && !raw.includes(Buffer.from('客户资料.miyin-backup'));
    const backupMerge = history.length === 3 && history.some((item) => item.name === '客户资料.miyin-backup');
    const pass = reopen && compact && rotate && backupMerge && privateDataAbsent;
    process.stdout.write(`PHASE30_${pass ? 'PASS' : 'FAIL'} history=${history.length} reopen=${reopen ? 1 : 0} compact=${compact ? 1 : 0} rotate=${rotate ? 1 : 0} backupMerge=${backupMerge ? 1 : 0} private=${privateDataAbsent ? 1 : 0}\n`);
    if (!pass) process.exitCode = 1;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`PHASE30_FAILED ${error?.stack || error}\n`);
  process.exitCode = 2;
});

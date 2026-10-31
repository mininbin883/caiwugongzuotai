'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createVault, openVault, appendVaultActivity, listVaultActivity,
  listVaultEntriesPage, vaultStatistics, closeVault
} = require('../src/services/vault-service.cjs');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase30/ui-persistent-history.png');
let directory;
let vaultPath;
let context;
let openCount = 0;

function state() {
  const page = listVaultEntriesPage(context, { pageSize: 20 });
  return {
    canceled: false, token: 'phase30-vault-token', name: path.basename(vaultPath), timeoutMinutes: 5,
    entries: page.entries,
    page: { total: page.total, filteredTotal: page.filteredTotal, pageSize: page.pageSize, nextCursor: page.nextCursor, hasMore: page.hasMore, filters: page.filters },
    backupHistory: listVaultActivity(context), stats: vaultStatistics(context)
  };
}

ipcMain.handle('veilforge:vault-open', async () => {
  if (context) closeVault(context);
  context = await openVault(vaultPath, 'phase30-ui-password');
  openCount += 1;
  return state();
});
ipcMain.handle('veilforge:vault-list', () => state());
ipcMain.handle('veilforge:vault-lock', () => { if (context) closeVault(context); context = null; return { locked: true }; });
ipcMain.handle('veilforge:batch-list', () => []);
ipcMain.handle('veilforge:ner-bundled', () => ({ loaded: false, reason: 'UI_PROBE' }));
ipcMain.handle('veilforge:ocr-backend-state', () => ({ backend: 'tesseract', name: 'Tesseract.js' }));

let windowRef;
app.whenReady().then(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-phase30-ui-'));
  vaultPath = path.join(directory, '持久化历史.miyin-vault');
  const seeded = await createVault(vaultPath, 'phase30-ui-password');
  await appendVaultActivity(seeded, { action: 'export', name: '每日备份.miyin-backup', entries: 6, bytes: 16384, sha256: 'E'.repeat(64) }, new Date('2026-10-31T08:00:00.000Z'));
  await appendVaultActivity(seeded, { action: 'import', name: '迁移备份.miyin-backup', imported: 2, skipped: 1, renamed: 1 }, new Date('2026-10-31T08:10:00.000Z'));
  closeVault(seeded);

  windowRef = new BrowserWindow({
    width: 1500, height: 1000, show: false, backgroundColor: '#f3f1eb',
    webPreferences: { preload: path.resolve('src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'), { hash: 'vault' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  windowRef.show();
  const result = await windowRef.webContents.executeJavaScript(`(async () => {
    const pause = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));
    const open = async () => {
      document.getElementById('vaultOpenButton').click(); await pause(40);
      document.getElementById('vaultPassword').value = 'phase30-ui-password';
      document.getElementById('vaultPasswordForm').requestSubmit(); await pause(220);
    };
    await open();
    const first = document.getElementById('vaultBackupHistory').textContent;
    const persistentLabel = document.querySelector('.vault-backup-history-panel small').textContent.includes('认证加密持久化');
    document.getElementById('vaultLockButton').click(); await pause(100);
    await open();
    const second = document.getElementById('vaultBackupHistory').textContent;
    document.querySelector('.sidebar').scrollTop = document.querySelector('.sidebar').scrollHeight;
    await pause(120);
    return { first, second, persistentLabel };
  })()`);
  const image = await windowRef.webContents.capturePage();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, image.toPNG());
  const firstOk = result.first.includes('每日备份') && result.first.includes('迁移备份');
  const reopenOk = result.second.includes('每日备份') && result.second.includes('迁移备份') && openCount === 2;
  const pass = firstOk && reopenOk && result.persistentLabel;
  process.stdout.write(`PHASE30_UI_${pass ? 'PASS' : 'FAIL'} history=2 reopen=${reopenOk ? 1 : 0} label=${result.persistentLabel ? 1 : 0} screenshot=${outputPath}\n`);
  windowRef.destroy();
  if (context) closeVault(context);
  await fs.rm(directory, { recursive: true, force: true });
  app.exit(pass ? 0 : 1);
}).catch(async (error) => {
  process.stderr.write(`PHASE30_UI_FAILED ${error?.stack || error}\n`);
  if (context) closeVault(context);
  if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  app.exit(2);
});

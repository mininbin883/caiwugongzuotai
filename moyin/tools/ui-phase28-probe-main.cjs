'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { filterVaultEntries } = require('../src/services/vault-explorer-service.cjs');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase28/ui-vault-explorer.png');
let batchAutoReceived = false;

const entries = [
  { id: 'entry-1', sequence: 1, fileNumber: 'MI-000001', name: '客户合同 · 脱敏', kind: 'redacted-text', createdAt: '2026-10-31T01:00:00.000Z', characters: 18, audit: { findingCount: 2, findingTypes: ['person', 'phone'], tokenCount: 0 } },
  { id: 'entry-2', sequence: 2, fileNumber: 'MI-000002', name: '研发映射 · 可逆副本', kind: 'reversible-map', createdAt: '2026-10-31T01:10:00.000Z', characters: 22, audit: { findingCount: 1, findingTypes: ['organization'], tokenCount: 1 } },
  { id: 'entry-3', sequence: 3, fileNumber: 'MI-000003', name: '历史地址清单', kind: 'redacted-text', createdAt: '2026-09-15T03:00:00.000Z', characters: 30, audit: { findingCount: 3, findingTypes: ['address'], tokenCount: 0 } }
];
const history = [{ id: 'history-1', action: 'export', at: '2026-10-31T02:00:00.000Z', name: '客户资料-备份.miyin-backup', entries: 3, bytes: 8192, sha256: 'A'.repeat(64), imported: 0, skipped: 0, renamed: 0 }];

function page(filters = {}) {
  const filtered = filterVaultEntries(entries, filters);
  return {
    entries: [...filtered.entries].sort((a, b) => b.sequence - a.sequence),
    total: entries.length,
    filteredTotal: filtered.entries.length,
    pageSize: 20,
    nextCursor: null,
    hasMore: false,
    filters: filtered.filters,
    backupHistory: history,
    stats: { entries: entries.length, fileBytes: 8192, reclaimableBytes: 0 }
  };
}

function vaultState() {
  const value = page();
  return {
    canceled: false,
    token: 'phase28-vault-token',
    name: '仓库检索测试.miyin-vault',
    timeoutMinutes: 5,
    entries: value.entries,
    page: { total: value.total, filteredTotal: value.filteredTotal, pageSize: 20, nextCursor: null, hasMore: false, filters: value.filters },
    backupHistory: history,
    stats: value.stats
  };
}

ipcMain.handle('veilforge:batch-list', () => [{ id: 'batch-1', name: '批量客户.txt', status: 'done', progress: 100, createdAt: '2026-10-31T01:00:00.000Z', updatedAt: '2026-10-31T01:01:00.000Z', result: { extension: '.txt', sourceBytes: 30, characters: 20, kind: 'text' } }]);
ipcMain.handle('veilforge:batch-export', (_event, options) => {
  batchAutoReceived = options?.autoVault === true && options?.vaultToken === 'phase28-vault-token';
  return { canceled: false, total: 1, exported: 1, failed: 0, outputs: [], errors: [], vaultSave: { requested: 1, saved: batchAutoReceived ? 1 : 0, failed: 0 }, vaultState: batchAutoReceived ? vaultState() : null };
});
ipcMain.handle('veilforge:vault-open', () => vaultState());
ipcMain.handle('veilforge:vault-list', (_event, options) => page(options?.filters));
ipcMain.handle('veilforge:ner-bundled', () => ({ loaded: false, reason: 'UI_PROBE' }));
ipcMain.handle('veilforge:ocr-backend-state', () => ({ backend: 'tesseract', name: 'Tesseract.js' }));

let windowRef;
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: false,
    backgroundColor: '#f3f1eb',
    webPreferences: { preload: path.resolve('src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'), { hash: 'vault' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const result = await windowRef.webContents.executeJavaScript(`(async () => {
    const pause = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));
    document.getElementById('vaultOpenButton').click();
    await pause(50);
    document.getElementById('vaultPassword').value = 'phase28-test-password';
    document.getElementById('vaultPasswordForm').requestSubmit();
    await pause();
    const opened = document.getElementById('vaultStatus').textContent === '已解锁';
    const historyVisible = document.getElementById('vaultBackupHistory').textContent.includes('客户资料-备份');

    const search = document.getElementById('vaultSearchInput');
    search.value = '合同';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await pause(300);
    const searchCount = document.querySelectorAll('#vaultEntryList .vault-entry-row').length;

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const kind = document.getElementById('vaultKindFilter');
    kind.value = 'reversible-map';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    await pause(300);
    const kindCount = document.querySelectorAll('#vaultEntryList .vault-entry-row').length;

    kind.value = 'all';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('vaultDateFrom').value = '2026-10-31';
    document.getElementById('vaultDateTo').value = '2026-10-31';
    document.getElementById('vaultDateFrom').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('vaultDateTo').dispatchEvent(new Event('change', { bubbles: true }));
    await pause(300);
    const dateCount = document.querySelectorAll('#vaultEntryList .vault-entry-row').length;

    document.querySelector('[data-module="batch"]').click();
    await pause(80);
    document.getElementById('batchAutoVault').click();
    document.getElementById('batchExportButton').click();
    await pause(250);
    const batchAuto = document.getElementById('toast').textContent.includes('自动入库 1 个');

    document.querySelector('[data-module="vault"]').click();
    document.getElementById('vaultFilterClearButton').click();
    await pause(250);
    document.getElementById('vaultSearchInput').scrollIntoView({ block: 'center' });
    return { opened, historyVisible, searchCount, kindCount, dateCount, batchAuto };
  })()`);
  const image = await windowRef.webContents.capturePage();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, image.toPNG());
  const pass = result.opened && result.historyVisible && result.searchCount === 1 && result.kindCount === 1 && result.dateCount === 2 && result.batchAuto && batchAutoReceived;
  process.stdout.write(`PHASE28_UI_${pass ? 'PASS' : 'FAIL'} search=${result.searchCount} kind=${result.kindCount} dates=${result.dateCount} history=${result.historyVisible ? 1 : 0} batchAutoVault=${batchAutoReceived ? 1 : 0} screenshot=${outputPath}\n`);
  windowRef.destroy();
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`PHASE28_UI_FAILED ${error?.stack || error}\n`);
  app.exit(2);
});

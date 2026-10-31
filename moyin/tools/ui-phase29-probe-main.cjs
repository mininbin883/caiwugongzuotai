'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase29/ui-vault-attachments.png');
let bundleFiles = 0;
let exportAttachment = 0;

const attachments = [
  { blobId: `blob-${'A'.repeat(64)}`, role: 'original', name: '客户合同.docx', bytes: 1200, sha256: 'A'.repeat(64) },
  { blobId: `blob-${'B'.repeat(64)}`, role: 'redacted-copy', name: '客户合同-脱敏.docx', bytes: 900, sha256: 'B'.repeat(64) }
];
const entry = { id: 'entry-phase29', sequence: 1, fileNumber: 'MI-000001', name: '客户合同 · 脱敏', kind: 'redacted-text', createdAt: '2026-10-31T03:00:00.000Z', characters: 18, audit: { findingCount: 2, findingTypes: ['person', 'phone'], tokenCount: 0 }, attachments };

function state(entries = []) {
  return {
    canceled: false,
    token: 'phase29-vault-token',
    name: '原件闭环仓库.miyin-vault',
    timeoutMinutes: 5,
    entries,
    page: { total: entries.length, filteredTotal: entries.length, pageSize: 20, nextCursor: null, hasMore: false, filters: { query: '', kind: 'all', dateFrom: '', dateTo: '' } },
    backupHistory: [],
    stats: { entries: entries.length, fileBlobs: entries.length ? 2 : 0, attachmentReferences: entries.length ? 2 : 0, attachmentBytes: 2100, deduplicatedReferences: 0, fileBytes: 4096, reclaimableBytes: 0 }
  };
}

ipcMain.handle('veilforge:vault-open', () => state());
ipcMain.handle('veilforge:vault-list', () => state([entry]));
ipcMain.handle('veilforge:batch-list', () => []);
ipcMain.handle('veilforge:export', () => ({ canceled: false, path: 'C:/probe/客户合同-脱敏.txt', bytes: 88, vaultAttachmentToken: 'phase29-attachment-token', vaultAttachmentFiles: 2 }));
ipcMain.handle('veilforge:vault-save', (_event, payload) => {
  bundleFiles = payload?.attachmentToken === 'phase29-attachment-token' ? 2 : 0;
  return { ...state([entry]), attachmentResult: { files: bundleFiles, newBlobs: 2, deduplicated: 0 } };
});
ipcMain.handle('veilforge:vault-export-attachment', () => {
  exportAttachment += 1;
  return { canceled: false, path: 'C:/probe/客户合同.docx', bytes: 1200, sha256: 'A'.repeat(64), role: 'original' };
});
ipcMain.handle('veilforge:ner-bundled', () => ({ loaded: false, reason: 'UI_PROBE' }));
ipcMain.handle('veilforge:ocr-backend-state', () => ({ backend: 'tesseract', name: 'Tesseract.js' }));

let windowRef;
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({
    width: 1500, height: 1000, show: false, backgroundColor: '#f3f1eb',
    webPreferences: { preload: path.resolve('src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'), { hash: 'vault' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  windowRef.show();
  const result = await windowRef.webContents.executeJavaScript(`(async () => {
    const pause = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));
    document.getElementById('vaultOpenButton').click();
    await pause(50);
    document.getElementById('vaultPassword').value = 'phase29-test-password';
    document.getElementById('vaultPasswordForm').requestSubmit();
    await pause();
    document.getElementById('demoButton').click();
    await pause(80);
    document.getElementById('exportTextButton').click();
    await pause();
    const bundleEnabled = !document.getElementById('vaultBundleSaveButton').disabled;
    document.getElementById('vaultBundleSaveButton').click();
    await pause(240);
    const attachmentButtons = [...document.querySelectorAll('.vault-attachment-badge')];
    const detailVisible = document.getElementById('vaultEntryList').textContent.includes('2 个加密附件');
    attachmentButtons[0]?.click();
    await pause(100);
    document.querySelector('[data-module="vault"]').click();
    document.getElementById('vaultEntryList').scrollIntoView({ block: 'center' });
    document.querySelector('.sidebar').scrollTop = document.querySelector('.sidebar').scrollHeight;
    await pause(160);
    return { bundleEnabled, attachmentButtons: attachmentButtons.length, detailVisible };
  })()`);
  const image = await windowRef.webContents.capturePage();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, image.toPNG());
  const pass = result.bundleEnabled && bundleFiles === 2 && result.attachmentButtons === 2 && result.detailVisible && exportAttachment === 1;
  process.stdout.write(`PHASE29_UI_${pass ? 'PASS' : 'FAIL'} bundle=${bundleFiles} entryAttachments=${result.attachmentButtons} detail=${result.detailVisible ? 1 : 0} exportAttachment=${exportAttachment} screenshot=${outputPath}\n`);
  windowRef.destroy();
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`PHASE29_UI_FAILED ${error?.stack || error}\n`);
  app.exit(2);
});

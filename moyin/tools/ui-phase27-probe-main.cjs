'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase27/ui-quick-entry.png');
let saveCount = 0;

const vaultState = () => ({
  canceled: false,
  token: 'phase27-vault-token',
  name: '快捷入口测试.miyin-vault',
  timeoutMinutes: 5,
  entries: saveCount ? [{ id: 'entry-1', fileNumber: 'MI-000001', name: '粘贴文字.txt · 脱敏', kind: 'redacted-text', characters: 18, audit: { findingCount: 2 } }] : [],
  page: { total: saveCount, pageSize: 20, nextCursor: null, hasMore: false },
  stats: { fileBytes: 4096, reclaimableBytes: 0 }
});

ipcMain.handle('veilforge:batch-list', () => []);
ipcMain.handle('veilforge:ner-bundled', () => ({ loaded: false, reason: 'UI_PROBE' }));
ipcMain.handle('veilforge:ocr-backend-state', () => ({ backend: 'rapidocr-ppocrv6', modelPack: { id: 'rapidocr-ppocrv6-small-v1' }, runtimePack: { id: 'rapidocr-python-win-x64-v1', pythonVersion: '3.13.15' } }));
ipcMain.handle('veilforge:pick-image-for-text', () => ({
  name: '扫描联系表.png',
  extension: '.png',
  sourceBytes: 2048,
  characters: 31,
  text: '客户：张三\n手机：13812345678\n邮箱：alice@example.com',
  quickEntry: 'image-to-text'
}));
ipcMain.handle('veilforge:vault-open', () => vaultState());
ipcMain.handle('veilforge:vault-save', () => { saveCount += 1; return vaultState(); });
ipcMain.handle('veilforge:export', (_event, payload) => ({ canceled: false, path: `C:/probe/${payload.fileNameHint || '脱敏结果.txt'}`, bytes: Buffer.byteLength(payload.text || '', 'utf8') }));

let windowRef;
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    backgroundColor: '#f3f1eb',
    webPreferences: { preload: path.resolve('src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'), { hash: 'redact' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const initialImage = await windowRef.webContents.capturePage();
  const result = await windowRef.webContents.executeJavaScript(`(async () => {
    const pause = (ms = 70) => new Promise((resolve) => setTimeout(resolve, ms));
    const quickButtons = ['pasteTextButton', 'imageToTextButton'].filter((id) => document.getElementById(id)).length;

    document.getElementById('pasteTextButton').click();
    document.getElementById('pasteTextName').value = '会议纪要';
    document.getElementById('pasteTextInput').value = '联系人：张三\\n手机：13812345678';
    document.getElementById('pasteTextInput').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('pasteTextForm').requestSubmit();
    await pause();
    const pasteLoaded = document.getElementById('documentName').textContent === '会议纪要.txt'
      && document.getElementById('sourceEditor').value.includes('13812345678')
      && !document.getElementById('pasteTextDialog').open;

    document.querySelector('[data-module="vault"]').click();
    document.getElementById('vaultOpenButton').click();
    await pause();
    document.getElementById('vaultPassword').value = 'phase27-test-password';
    document.getElementById('vaultPasswordForm').requestSubmit();
    await pause(120);
    const vaultOpen = document.getElementById('vaultStatus').textContent === '已解锁';
    document.getElementById('vaultAutoSave').click();
    const autoEnabled = document.getElementById('vaultAutoSave').checked && !document.getElementById('vaultAutoSave').disabled;

    document.querySelector('[data-module="redact"]').click();
    document.getElementById('exportTextButton').click();
    await pause(150);
    const autoSaved = document.getElementById('toast').textContent.includes('已自动写入加密仓库');

    document.getElementById('imageToTextButton').click();
    await pause(100);
    const imageLoaded = document.getElementById('documentName').textContent === '扫描联系表.png'
      && !document.getElementById('exportOcrTextButton').classList.contains('hidden');
    document.getElementById('exportOcrTextButton').click();
    await pause(100);
    const imageExported = document.getElementById('toast').textContent.includes('识别文本已导出');

    document.getElementById('resetButton').click();
    await pause();
    return {
      quickButtons,
      pasteLoaded,
      counter: document.getElementById('pasteTextCounter').textContent,
      vaultOpen,
      autoEnabled,
      autoSaved,
      imageLoaded,
      imageExported,
      quickVisible: ['pasteTextButton', 'imageToTextButton'].every((id) => !document.getElementById(id).classList.contains('hidden'))
    };
  })()`);
  result.saveCount = saveCount;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, initialImage.toPNG());
  const pass = result.quickButtons === 2 && result.pasteLoaded && result.vaultOpen && result.autoEnabled && result.autoSaved
    && result.imageLoaded && result.imageExported && result.saveCount === 1 && result.quickVisible;
  process.stdout.write(`PHASE27_UI_${pass ? 'PASS' : 'FAIL'} paste=${result.pasteLoaded ? 1 : 0} imageTxt=${result.imageLoaded && result.imageExported ? 1 : 0} autoVault=${result.autoSaved ? result.saveCount : 0} quickButtons=${result.quickButtons} screenshot=${outputPath}\n`);
  windowRef.destroy();
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`PHASE27_UI_FAILED ${error?.stack || error}\n`);
  app.exit(2);
});

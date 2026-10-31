'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase31/office-long-tail.png');
const report = {
  schema: 'VEILFORGE_OFFICE_LONG_TAIL_V1',
  detectedFeatures: ['pivotTables', 'externalLinks', 'definedNames', 'dataValidation', 'conditionalFormatting', 'smartArt', 'embeddedObjects', 'relationships'],
  degradationCount: 5,
};

ipcMain.handle('veilforge:pick-document', async () => ({
  name: 'phase31-complex.xlsx', extension: '.xlsx', sourceBytes: 4096, characters: 24,
  text: '姓名：张三\n手机号：13812345678', office: { token: 'phase31-office', kind: 'xlsx' }, officeLongTailReport: report
}));
ipcMain.handle('veilforge:batch-list', () => []);
ipcMain.handle('veilforge:ner-bundled', () => ({ loaded: false, reason: 'UI_PROBE' }));
ipcMain.handle('veilforge:ocr-backend-state', () => ({ backend: 'tesseract', name: 'Tesseract.js' }));

app.whenReady().then(async () => {
  const windowRef = new BrowserWindow({
    width: 1500, height: 1000, show: false, backgroundColor: '#f3f1eb',
    webPreferences: { preload: path.resolve('src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await windowRef.webContents.executeJavaScript(`(async () => {
    document.getElementById('openButton').click();
    await new Promise((resolve) => setTimeout(resolve, 260));
    return { meta: document.getElementById('documentMeta').textContent, name: document.getElementById('documentName').textContent };
  })()`);
  const image = await windowRef.webContents.capturePage();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, image.toPNG());
  const pass = result.name === 'phase31-complex.xlsx' && result.meta.includes('长尾 8 项') && result.meta.includes('降级 5 项');
  process.stdout.write(`PHASE31_UI_${pass ? 'PASS' : 'FAIL'} detected=8 degraded=5 label=${pass ? 1 : 0} screenshot=${outputPath}\n`);
  windowRef.destroy();
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`PHASE31_UI_FAILED ${error?.stack || error}\n`);
  app.exit(2);
});

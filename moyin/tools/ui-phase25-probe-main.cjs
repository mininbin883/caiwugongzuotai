'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase25/ui-runtime.png');

ipcMain.handle('veilforge:batch-list', () => []);
ipcMain.handle('veilforge:ner-bundled', () => ({ loaded: true, name: 'bert4ner-base-chinese', modelBytes: 406776607,
  vocabSize: 21128, modelSha256: '1f479e34011f5b357d934119620fc141ca90d4b738494150cd86209e7337e8de',
  modelPackVerified: true, modelPackId: 'zh-ner-bert-v1' }));
ipcMain.handle('veilforge:ocr-backend-state', () => ({
  backend: 'rapidocr-ppocrv6', name: 'RapidOCR · PP-OCRv6', automatic: true,
  python: 'resources/runtime-packs/rapidocr-python-win-x64-v1/runtime/python.exe',
  modelPack: { id: 'rapidocr-ppocrv6-small-v1' },
  runtimePack: { id: 'rapidocr-python-win-x64-v1', pythonVersion: '3.13.15' },
  rapidOcrPack: { id: 'rapidocr-ppocrv6-small-v1' }
}));

let windowRef;
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({ width: 1420, height: 920, show: false, backgroundColor: '#f3f1eb',
    webPreferences: { preload: path.resolve('src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await windowRef.webContents.executeJavaScript(`(() => ({
    ner: document.getElementById('nerStatus')?.textContent || '',
    ocr: document.getElementById('ocrBackendStatus')?.textContent || '',
    meta: document.getElementById('ocrBackendMeta')?.textContent || '',
    controls: ['ocrRapidButton', 'ocrTesseractButton', 'nerAnalyzeButton'].filter((id) => document.getElementById(id)).length
  }))()`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const image = await windowRef.webContents.capturePage();
  await fs.writeFile(outputPath, image.toPNG());
  const pass = result.ner === '已加载' && result.ocr === 'RapidOCR' && result.meta.includes('内置运行时 rapidocr-python-win-x64-v1 已校验') && result.controls === 3;
  process.stdout.write(`PHASE25_UI_${pass ? 'PASS' : 'FAIL'} ner=${result.ner} ocr=${result.ocr} runtime=${result.meta.includes('内置运行时') ? 1 : 0} controls=${result.controls} screenshot=${outputPath}\n`);
  windowRef.destroy();
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`PHASE25_UI_FAILED ${error?.stack || error}\n`);
  app.exit(2);
});

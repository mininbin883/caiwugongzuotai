'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase24/ui-alignment.png');

ipcMain.handle('veilforge:batch-list', () => []);
ipcMain.handle('veilforge:ner-bundled', () => ({
  loaded: true,
  name: 'bert4ner-base-chinese',
  modelBytes: 406776607,
  vocabSize: 21128,
  modelSha256: '1f479e34011f5b357d934119620fc141ca90d4b738494150cd86209e7337e8de',
  modelPackVerified: true,
  modelPackId: 'zh-ner-bert-v1'
}));
ipcMain.handle('veilforge:ocr-backend-state', () => ({
  backend: 'tesseract',
  name: 'Tesseract.js',
  rapidOcrPack: {
    id: 'rapidocr-ppocrv6-small-v1',
    name: 'PP-OCRv6 Small',
    version: '1.0.0',
    manifestSha256: 'a585326043d4a4c85a8df2fca46be66c10b9e89777055b263f574f38ecb1682b'
  }
}));

let windowRef;
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({
    width: 1420,
    height: 920,
    show: false,
    backgroundColor: '#f3f1eb',
    webPreferences: {
      preload: path.resolve('src/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await windowRef.webContents.executeJavaScript(`(() => {
    const sidebar = document.querySelector('.sidebar');
    const target = document.getElementById('nerStatus');
    if (sidebar && target) sidebar.scrollTop = sidebar.scrollHeight;
    return {
      ner: document.getElementById('nerStatus')?.textContent || '',
      nerMeta: document.getElementById('nerMeta')?.textContent || '',
      ocr: document.getElementById('ocrBackendStatus')?.textContent || '',
      ocrMeta: document.getElementById('ocrBackendMeta')?.textContent || '',
      controls: ['ocrRapidButton', 'ocrTesseractButton', 'nerAnalyzeButton'].filter((id) => document.getElementById(id)).length
    };
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const image = await windowRef.webContents.capturePage();
  await fs.writeFile(outputPath, image.toPNG());
  const pass = result.ner === '已加载' && result.nerMeta.includes('固定哈希已校验') && result.nerMeta.includes('zh-ner-bert-v1') &&
    result.ocr === 'Tesseract' && result.ocrMeta.includes('rapidocr-ppocrv6-small-v1') && result.controls === 3;
  process.stdout.write(`PHASE24_UI_${pass ? 'PASS' : 'FAIL'} ner=${result.ner} ocr=${result.ocr} controls=${result.controls} screenshot=${outputPath}\n`);
  windowRef.destroy();
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`PHASE24_UI_FAILED ${error?.stack || error}\n`);
  app.exit(2);
});

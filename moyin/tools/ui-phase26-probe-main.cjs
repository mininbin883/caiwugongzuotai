'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const outputArg = process.argv.find((value) => value.startsWith('--out='));
const outputPath = path.resolve(outputArg?.slice(6) || 'output/phase26/ui-navigation.png');

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
  backend: 'rapidocr-ppocrv6',
  name: 'RapidOCR · PP-OCRv6',
  automatic: true,
  python: 'resources/runtime-packs/rapidocr-python-win-x64-v1/runtime/python.exe',
  modelPack: { id: 'rapidocr-ppocrv6-small-v1' },
  runtimePack: { id: 'rapidocr-python-win-x64-v1', pythonVersion: '3.13.15' },
  rapidOcrPack: { id: 'rapidocr-ppocrv6-small-v1' }
}));

let windowRef;
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    backgroundColor: '#f3f1eb',
    webPreferences: {
      preload: path.resolve('src/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await windowRef.loadFile(path.resolve('src/renderer/index.html'), { hash: 'redact' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const result = await windowRef.webContents.executeJavaScript(`(async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
    const ids = ['redact', 'batch', 'vault', 'restore', 'protect'];
    const states = [];
    for (const id of ids) {
      document.querySelector('[data-module="' + id + '"]').click();
      await pause();
      states.push({
        id,
        active: document.body.dataset.activeModule,
        hash: location.hash,
        activeCount: document.querySelectorAll('.module-nav-item.active').length,
        overviewHidden: document.getElementById('moduleOverview').classList.contains('hidden'),
        visibleSideSections: [...document.querySelectorAll('[data-module-section]')].filter((node) => !node.classList.contains('module-hidden')).length,
        visibleRedactViews: [...document.querySelectorAll('[data-redact-view]')].filter((node) => !node.classList.contains('module-hidden')).length
      });
    }
    const protect = document.querySelector('[data-module="protect"]');
    protect.focus();
    protect.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await pause();
    const wrapped = document.body.dataset.activeModule;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', ctrlKey: true, bubbles: true }));
    await pause();
    return {
      states,
      wrapped,
      shortcut: document.body.dataset.activeModule,
      navButtons: document.querySelectorAll('[data-module]').length,
      checklist: document.querySelectorAll('#moduleChecklist li').length,
      sideSteps: document.querySelectorAll('#moduleSideSteps li').length,
      title: document.getElementById('moduleOverviewTitle').textContent,
      primary: document.getElementById('modulePrimaryAction').textContent,
      batchCount: document.getElementById('batchNavCount').textContent,
      vaultState: document.getElementById('vaultNavState').textContent,
      protectCount: document.getElementById('protectNavState').textContent
    };
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const image = await windowRef.webContents.capturePage();
  await fs.writeFile(outputPath, image.toPNG());
  const routesPass = result.states.every((item) => item.id === item.active && item.hash === `#${item.id}` && item.activeCount === 1);
  const redactPass = result.states[0].overviewHidden && result.states[0].visibleRedactViews > 0;
  const specialistPass = result.states.slice(1).every((item) => !item.overviewHidden && item.visibleRedactViews === 0 && item.visibleSideSections >= 1);
  const pass = routesPass && redactPass && specialistPass && result.wrapped === 'redact' && result.shortcut === 'protect'
    && result.navButtons === 5 && result.checklist === 3 && result.sideSteps === 3
    && result.title.includes('所有识别规则') && result.primary.includes('自定义词');
  process.stdout.write(`PHASE26_UI_${pass ? 'PASS' : 'FAIL'} routes=${routesPass ? 5 : 0}/5 wrapped=${result.wrapped} shortcut=${result.shortcut} checklist=${result.checklist} sidebar=${result.sideSteps} badges=${result.batchCount}/${result.vaultState}/${result.protectCount} screenshot=${outputPath}\n`);
  windowRef.destroy();
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`PHASE26_UI_FAILED ${error?.stack || error}\n`);
  app.exit(2);
});

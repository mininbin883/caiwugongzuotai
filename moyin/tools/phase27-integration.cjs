'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { recognizeImageBuffer } = require('../src/services/ocr-service.cjs');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

async function main() {
  const quick = await import(pathToFileURL(path.join(root, 'src/core/quick-entry-controller.mjs')).href);
  const html = read('src/renderer/index.html');
  const css = read('src/renderer/styles.css');
  const renderer = read('src/renderer/renderer.mjs');
  const mainSource = read('src/main.cjs');
  const preload = read('src/preload.cjs');

  const pastedInput = '客户：张三\n手机：13812345678';
  const pasted = quick.createPastedDocument(pastedInput, '客户说明');
  if (pasted.name !== '客户说明.txt' || pasted.characters !== pastedInput.length || pasted.quickEntry !== 'pasted-text') throw new Error('PASTE_DOCUMENT_INVALID');
  if (!html.includes('id="pasteTextDialog"') || !renderer.includes('openPasteTextDialog')) throw new Error('PASTE_UI_MISSING');
  if (!mainSource.includes('chooseImageForText') || !mainSource.includes('LOCAL_IMAGE_TO_TEXT_TYPE_UNSUPPORTED') || !preload.includes('pickImageForText')) throw new Error('IMAGE_TO_TEXT_IPC_MISSING');
  if (!html.includes('id="exportOcrTextButton"') || !renderer.includes('exportRecognizedText')) throw new Error('IMAGE_TO_TEXT_EXPORT_MISSING');
  if (!html.includes('id="vaultAutoSave"') || !css.includes('.vault-auto-save')) throw new Error('AUTO_VAULT_UI_MISSING');
  const ready = quick.autoVaultDecision({ enabled: true, vault: { token: 'session' }, exportResult: { canceled: false }, sourceText: 'x' });
  const locked = quick.autoVaultDecision({ enabled: true, vault: null, exportResult: { canceled: false }, sourceText: 'x' });
  if (!ready.shouldSave || locked.shouldSave || locked.reason !== 'VAULT_LOCKED') throw new Error('AUTO_VAULT_DECISION_INVALID');
  if (!renderer.includes('saveCurrentToVault') || !renderer.includes('已自动写入加密仓库')) throw new Error('AUTO_VAULT_EXPORT_FLOW_MISSING');
  if (!html.includes('aria-label="三步脱敏闭环"') || !renderer.includes("renderWorkflowProgress('review')")) throw new Error('WORKFLOW_REGRESSION');

  const imagePath = path.join(root, 'output', 'ocr', 'phase14', 'lowres-skew.png');
  const ocr = await recognizeImageBuffer(await fsp.readFile(imagePath), { name: path.basename(imagePath), extension: '.png', backend: 'rapidocr' });
  const expectedText = ['客户：张三', '手机：13812345678', '邮箱：alice@example.com', '身份证：11010519491231002X'];
  if (!expectedText.every((value) => ocr.text.includes(value))) throw new Error(`IMAGE_TO_TEXT_CONTENT_MISMATCH:${ocr.text}`);
  const textPath = path.join(root, 'output', 'phase27', 'image-to-text.txt');
  await fsp.mkdir(path.dirname(textPath), { recursive: true });
  await fsp.writeFile(textPath, ocr.text, 'utf8');
  const reopened = await fsp.readFile(textPath, 'utf8');
  if (reopened !== ocr.text) throw new Error('IMAGE_TO_TEXT_ROUNDTRIP_MISMATCH');

  process.stdout.write(`PHASE27_PASS paste=${pasted.characters}chars imageToTxt=${ocr.text.length}chars/${ocr.words.length}words autoVault=opt-in lockedGuard=${locked.reason} workflow=preserved output=${textPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`PHASE27_FAIL ${error?.stack || error}\n`);
  process.exitCode = 1;
});

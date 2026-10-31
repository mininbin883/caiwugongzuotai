'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
const read = (name) => {
  try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return ''; }
};
const exists = (name) => fs.existsSync(path.join(root, name));

let packageJson = {};
try { packageJson = JSON.parse(read('package.json')); } catch {}

const main = read('src/main.cjs');
const preload = read('src/preload.cjs');
const renderer = read('src/renderer/renderer.mjs');
const html = read('src/renderer/index.html');
const modelPackService = read('src/services/model-pack-service.cjs');
const rapidService = read('src/services/rapidocr-service.cjs');
const ocrService = read('src/services/ocr-service.cjs');
const nerService = read('src/services/ner-service.cjs');

const checks = [
  ['package-2.4-and-resources', packageJson.version === '2.4.0' && packageJson.scripts?.['test:phase24'] && JSON.stringify(packageJson.build?.extraResources || []).includes('model-packs')],
  ['strict-model-pack-service', modelPackService.includes('VEILFORGE_MODEL_PACK_V1') && modelPackService.includes('MODEL_PACK_HASH_MISMATCH') && modelPackService.includes('findFirstModelPack')],
  ['bundled-ner-pack', exists('model-packs/zh-ner-bert-v1/model.onnx') && exists('model-packs/zh-ner-bert-v1/manifest.json') && read('model-packs/zh-ner-bert-v1/manifest.json').includes('1f479e34011f5b357d934119620fc141ca90d4b738494150cd86209e7337e8de')],
  ['bundled-ocr-pack', exists('model-packs/rapidocr-ppocrv6-small-v1/PP-OCRv6_det_small.onnx') && exists('model-packs/rapidocr-ppocrv6-small-v1/manifest.json') && read('model-packs/rapidocr-ppocrv6-small-v1/manifest.json').includes('6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884')],
  ['ner-auto-load-and-verification', main.includes('loadBundledNerModel') && main.includes("findFirstModelPack('ner')") && nerService.includes('modelPackVerified') && main.includes('appWindows.add(win)')],
  ['rapidocr-bridge-and-service', exists('tools/rapidocr-bridge.py') && rapidService.includes('recognizeWithRapidOcr') && rapidService.includes('shell: false') && rapidService.includes('MAX_STDOUT_BYTES')],
  ['explicit-ocr-backends', ocrService.includes("['tesseract', 'rapidocr']") && ocrService.includes('recognizeWithRapidOcr') && ocrService.includes("segmentationMode: 'rapidocr-det-rec'")],
  ['preload-and-renderer-controls', preload.includes('loadBundledNer') && preload.includes('selectRapidOcrPython') && renderer.includes('initializeBundledNer') && renderer.includes('initializeOcrBackend') && html.includes('ocrRapidButton')],
  ['phase24-regressions', exists('tests/model-pack.test.mjs') && exists('tests/rapidocr-service.test.mjs') && exists('tools/phase24-integration.cjs')],
  ['comparison-and-recovery', read('ORIGINAL_COMPARISON_PHASE24.md').includes('墨隐 2.4.0') && read('RECOVERY-CT.md').includes('phase24')]
];

for (const [name, pass] of checks) process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name}\n`);
const passed = checks.filter(([, pass]) => pass).length;
process.stdout.write(`PHASE24_PROBE ${passed}/${checks.length} root=${root}\n`);
process.exit(passed === checks.length ? 0 : 3);

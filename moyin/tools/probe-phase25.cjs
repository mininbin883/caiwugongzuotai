'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '.');
const read = (name) => { try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return ''; } };
const exists = (name) => fs.existsSync(path.join(root, name));
let pkg = {};
try { pkg = JSON.parse(read('package.json')); } catch {}
let benchmark = {};
try { benchmark = JSON.parse(read('output/phase25/ocr-benchmark.json')); } catch {}

const runtimeManifest = read('runtime-packs/rapidocr-python-win-x64-v1/manifest.json');
const runtimeService = read('src/services/runtime-pack-service.cjs');
const rapidService = read('src/services/rapidocr-service.cjs');
const ocrService = read('src/services/ocr-service.cjs');
const main = read('src/main.cjs');
const renderer = read('src/renderer/renderer.mjs');

const checks = [
  ['package-2.5-runtime-resource', pkg.version === '2.5.0' && pkg.scripts?.['test:phase25'] && pkg.scripts?.['benchmark:ocr'] && JSON.stringify(pkg.build?.extraResources || []).includes('runtime-packs')],
  ['runtime-pack-fixed-tree', exists('runtime-packs/rapidocr-python-win-x64-v1/runtime/python.exe') && runtimeManifest.includes('VEILFORGE_RUNTIME_PACK_V1') && runtimeManifest.includes('"files": [')],
  ['runtime-pack-strict-verifier', runtimeService.includes('LOCAL_RUNTIME_PACK_HASH_MISMATCH') && runtimeService.includes('findBundledRuntimePack') && runtimeService.includes('SBOM.json')],
  ['rapidocr-bundled-discovery', rapidService.includes('findBundledRuntimePack') && rapidService.includes('PYTHONPATH') && rapidService.includes('runtimePack')],
  ['automatic-backend', main.includes("VEILFORGE_OCR_BACKEND || 'auto'") && main.includes('automatic: true') && ocrService.includes("['auto', 'tesseract', 'rapidocr']")],
  ['runtime-ui-state', renderer.includes('内置运行时') && renderer.includes('runtimePack?.pythonVersion') && read('src/renderer/index.html').includes('正在校验内置 Python')],
  ['line-aware-word-spacing', rapidService.includes('lineRecords') && ocrService.includes('separateDetection') && ocrService.includes('sourceCursors')],
  ['phase25-regressions', exists('tests/runtime-pack.test.mjs') && exists('tools/phase25-integration.cjs') && exists('tools/ocr-benchmark.cjs') && exists('tools/ui-phase25-probe-main.cjs')],
  ['ocr-benchmark-zero', benchmark.aggregates?.rapidocr?.failures === 0 && benchmark.aggregates?.rapidocr?.cer === 0 && benchmark.aggregates?.rapidocr?.wer === 0],
  ['comparison-and-recovery', read('ORIGINAL_COMPARISON_PHASE25.md').includes('墨隐 2.5.0') && read('RECOVERY-CT.md').includes('phase25')]
];
for (const [name, pass] of checks) process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name}\n`);
const passed = checks.filter(([, pass]) => pass).length;
process.stdout.write(`PHASE25_PROBE ${passed}/${checks.length} root=${root}\n`);
process.exit(passed === checks.length ? 0 : 3);

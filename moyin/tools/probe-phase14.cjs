'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadFresh(absolute) {
  delete require.cache[absolute];
  return require(absolute);
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node tools/probe-phase14.cjs <ocr-service.cjs>');
  const absolute = path.resolve(input);
  const source = fs.readFileSync(absolute, 'utf8');
  const checks = [
    ['low-resolution-plan', /MIN_OCR_SHORT_EDGE/u.test(source) && /function enhancementScale/u.test(source)],
    ['preprocess-pipeline', /async function prepareOcrImage/u.test(source)],
    ['orientation-detection', /orientationDegrees/u.test(source) && /rotateAuto/u.test(source)],
    ['table-segmentation', /function detectTableRegions/u.test(source)],
    ['correction-queue', /function buildCorrectionQueue/u.test(source)],
    ['manual-correction', /function applyOcrCorrections/u.test(source)],
    ['segmentation-retry', /PSM\.SPARSE_TEXT/u.test(source) && /recognitionPasses/u.test(source)],
    ['runtime-helpers', false]
  ];
  try {
    const service = loadFresh(absolute);
    const words = [
      { text: '姓名', confidence: 98, start: 0, end: 2, bbox: { x0: 10, y0: 10, x1: 50, y1: 35 } },
      { text: '张二', confidence: 50, start: 2, end: 4, bbox: { x0: 100, y0: 10, x1: 140, y1: 35 } },
      { text: '电话', confidence: 98, start: 5, end: 7, bbox: { x0: 10, y0: 50, x1: 50, y1: 75 } },
      { text: '1380', confidence: 98, start: 7, end: 11, bbox: { x0: 100, y0: 50, x1: 160, y1: 75 } }
    ];
    const queue = service.buildCorrectionQueue?.(words, 72);
    const corrected = service.applyOcrCorrections?.(words, [{ wordIndex: 1, text: '张三' }]);
    const tables = service.detectTableRegions?.(words, 200, 100);
    checks[7][1] = service.enhancementScale?.(600, 300) === 3 && queue?.length === 1 &&
      corrected?.changed === 1 && corrected?.text.includes('张三') && tables?.length === 1;
  } catch {
    checks[7][1] = false;
  }
  for (const [name, passed] of checks) process.stdout.write(`CHECK ${name}=${passed ? 1 : 0}\n`);
  const passed = checks.filter(([, value]) => value).length;
  process.stdout.write(`PHASE14_PROBE ${passed}/${checks.length}\n`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
}

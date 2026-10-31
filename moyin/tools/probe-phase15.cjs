'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node tools/probe-phase15.cjs <ocr-service.cjs>');
  const absolute = path.resolve(input);
  const source = fs.readFileSync(absolute, 'utf8');
  delete require.cache[absolute];
  let service = {};
  try { service = require(absolute); } catch {}
  const checks = [
    ['column-detection', /function detectDocumentColumns/u.test(source)],
    ['layout-order', /function orderWordsForLayout/u.test(source)],
    ['grid-line-detection', /async function detectTableGrid/u.test(source)],
    ['merged-cell-recovery', /function recoverMergedGridCells/u.test(source)],
    ['grid-metadata', /gridTables/u.test(source) && /gridCellId/u.test(source)],
    ['reading-order-field', /readingOrder/u.test(source)],
    ['bounded-grid-analysis', /GRID_ANALYSIS_MAX_EDGE/u.test(source) && /GRID_DARK_THRESHOLD/u.test(source)],
    ['runtime-layout', false]
  ];
  try {
    const words = [];
    for (let index = 0; index < 4; index += 1) {
      words.push({ text: `L${index}`, confidence: 99, bbox: { x0: 20, y0: 20 + index * 50, x1: 80, y1: 40 + index * 50 } });
      words.push({ text: `R${index}`, confidence: 99, bbox: { x0: 320, y0: 45 + index * 50, x1: 380, y1: 65 + index * 50 } });
    }
    const columns = service.detectDocumentColumns?.(words, 500, 240);
    const ordered = service.rebuildMappedWords?.(words, 0, { width: 500, height: 240 });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><rect width="320" height="220" fill="white"/><g stroke="black" stroke-width="3"><path d="M10 10H310M10 75H310M10 140H310M10 205H310"/><path d="M10 10V205M310 10V205M110 75V205M210 75V205"/></g></svg>');
    const grid = await service.detectTableGrid?.(await sharp(svg).png().toBuffer());
    checks[7][1] = columns?.length === 2 && ordered?.readingOrder === 'columns-left-to-right' &&
      grid?.[0]?.rows === 3 && grid?.[0]?.columns === 3 && grid?.[0]?.mergedCells >= 1;
  } catch {
    checks[7][1] = false;
  }
  for (const [name, passed] of checks) process.stdout.write(`CHECK ${name}=${passed ? 1 : 0}\n`);
  const passed = checks.filter(([, value]) => value).length;
  process.stdout.write(`PHASE15_PROBE ${passed}/${checks.length}\n`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});

'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const sharp = require('sharp');
const {
  recognizeImageBuffer,
  prepareOcrImage,
  detectTableGrid,
  detectDocumentColumns,
  rebuildMappedWords,
  terminateWorker
} = require('../src/services/ocr-service.cjs');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function columnWords() {
  const words = [];
  for (let index = 0; index < 4; index += 1) {
    words.push({ text: `左${index + 1}`, confidence: 99, bbox: { x0: 25, y0: 25 + index * 55, x1: 100, y1: 48 + index * 55 } });
    words.push({ text: `右${index + 1}`, confidence: 99, bbox: { x0: 340, y0: 53 + index * 55, x1: 415, y1: 76 + index * 55 } });
  }
  return words;
}

async function writeFixture(directory, name, buffer) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, buffer);
  return { name, path: filePath, bytes: buffer.length, sha256: sha256(buffer) };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const sourcePath = path.resolve(process.argv[2] || path.join(root, 'ocr-fixture.png'));
  const directory = path.resolve(process.argv[3] || path.join(root, 'output', 'ocr', 'phase15', 'corpus'));
  await fs.mkdir(directory, { recursive: true });
  const source = await fs.readFile(sourcePath);
  const skew = await sharp(source).resize({ width: 700 }).rotate(3, { background: '#ffffff' }).png().toBuffer();
  const lowContrast = await sharp(source).resize({ width: 420 }).greyscale().linear(0.16, 205).png().toBuffer();
  const gridSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">
    <rect width="640" height="420" fill="white"/>
    <g stroke="#111" stroke-width="5">
      <path d="M20 20H620M20 140H620M20 270H620M20 400H620"/>
      <path d="M20 20V400M620 20V400M220 140V400M420 140V400"/>
    </g>
    <g font-family="Arial,sans-serif" fill="#111" font-size="34">
      <text x="205" y="92">MERGED HEADER</text><text x="70" y="215">A1</text><text x="270" y="215">B1</text><text x="470" y="215">C1</text>
      <text x="70" y="345">A2</text><text x="270" y="345">B2</text><text x="470" y="345">C2</text>
    </g>
  </svg>`);
  const grid = await sharp(gridSvg).png().toBuffer();
  const columnsSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="520" height="300"><rect width="520" height="300" fill="white"/>
    <g font-family="Arial,sans-serif" fill="#111" font-size="24"><text x="25" y="40">LEFT 1</text><text x="25" y="95">LEFT 2</text><text x="25" y="150">LEFT 3</text><text x="25" y="205">LEFT 4</text>
    <text x="340" y="68">RIGHT 1</text><text x="340" y="123">RIGHT 2</text><text x="340" y="178">RIGHT 3</text><text x="340" y="233">RIGHT 4</text></g></svg>`);
  const columnsImage = await sharp(columnsSvg).png().toBuffer();
  const files = [];
  files.push(await writeFixture(directory, '01-lowres-skew.png', skew));
  files.push(await writeFixture(directory, '02-low-contrast.png', lowContrast));
  files.push(await writeFixture(directory, '03-merged-grid.png', grid));
  files.push(await writeFixture(directory, '04-two-column.png', columnsImage));

  const skewOcr = await recognizeImageBuffer(skew, { name: '01-lowres-skew.png', extension: '.png' });
  const enhanced = await prepareOcrImage(lowContrast);
  const gridTables = await detectTableGrid(grid);
  const words = columnWords();
  const columns = detectDocumentColumns(words, 520, 300);
  const ordered = rebuildMappedWords(words, 0, { width: 520, height: 300 });
  const table = gridTables[0];
  const checks = {
    orientation: skewOcr.orientationDetected && Math.abs(skewOcr.orientationDegrees) >= 1,
    lowResolution: skewOcr.enhancement.upscaled,
    lowContrast: enhanced.enhancement.contrastEnhanced,
    grid: table?.rows === 3 && table?.columns === 3,
    mergedHeader: table?.cells.some((cell) => cell.columnSpan === 3 && cell.merged),
    columns: columns.length === 2,
    readingOrder: ordered.readingOrder === 'columns-left-to-right' && ordered.text.indexOf('左4') < ordered.text.indexOf('右1'),
    manifestHashes: files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))
  };
  const passed = Object.values(checks).every(Boolean);
  const report = {
    format: 'VEILFORGE_OCR_LAYOUT_REGRESSION', version: 1, result: passed ? 'PASS' : 'FAIL', checks, files,
    orientationDegrees: skewOcr.orientationDegrees,
    enhancement: { lowResolution: skewOcr.enhancement, lowContrast: enhanced.enhancement },
    gridTable: table,
    columns,
    readingOrder: ordered.readingOrder,
    orderedText: ordered.text
  };
  const reportPath = path.join(path.dirname(directory), 'phase15-ocr-layout-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({ format: 'VEILFORGE_OCR_CORPUS', version: 1, files }, null, 2)}\n`, 'utf8');
  process.stdout.write(`OCR_LAYOUT_${report.result} corpus=${files.length} grid=${table?.rows || 0}x${table?.columns || 0} merged=${table?.mergedCells || 0} columns=${columns.length} order=${ordered.readingOrder} enhanced=${enhanced.enhancement.contrastEnhanced ? 1 : 0}\n`);
  process.stdout.write(`REPORT=${reportPath}\n`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`OCR_LAYOUT_ERROR ${error?.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => terminateWorker().catch(() => {}));

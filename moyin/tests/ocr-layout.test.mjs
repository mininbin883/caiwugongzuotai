import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  flattenWords,
  findBoxesForFindings,
  detectTableRegions,
  buildCorrectionQueue,
  applyOcrCorrections,
  enhancementScale,
  detectDocumentColumns,
  rebuildMappedWords,
  detectTableGrid,
  recoverMergedGridCells
} = require('../src/services/ocr-service.cjs');
const sharp = require('sharp');

test('OCR 单词坐标映射为连续文本偏移', () => {
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: '手', confidence: 98, bbox: { x0: 10, y0: 10, x1: 30, y1: 40 } },
    { text: '机', confidence: 97, bbox: { x0: 32, y0: 10, x1: 52, y1: 40 } },
    { text: ':', confidence: 96, bbox: { x0: 54, y0: 10, x1: 60, y1: 40 } },
    { text: '13812345678', confidence: 99, bbox: { x0: 70, y0: 10, x1: 260, y1: 40 } }
  ] }] }] }];
  const result = flattenWords(blocks);
  assert.equal(result.text, '手机:13812345678');
  assert.equal(result.words[3].start, 3);
  assert.equal(result.words[3].end, 14);
});

test('命中区间转换为不可恢复涂黑框', () => {
  const words = [
    { start: 0, end: 2, bbox: { x0: 10, y0: 10, x1: 50, y1: 40 } },
    { start: 2, end: 13, bbox: { x0: 60, y0: 10, x1: 260, y1: 40 } }
  ];
  const boxes = findBoxesForFindings(words, [{ start: 2, end: 13, enabled: true }], 300, 100);
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].left < 60);
  assert.ok(boxes[0].width > 200);
});

test('取消的命中不会生成涂黑框', () => {
  const words = [{ start: 0, end: 11, bbox: { x0: 10, y0: 10, x1: 210, y1: 40 } }];
  assert.deepEqual(findBoxesForFindings(words, [{ start: 0, end: 11, enabled: false }], 300, 100), []);
});

test('表格区域按稳定列锚点分段并标记单词', () => {
  const words = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      words.push({
        text: `R${row}C${column}`,
        confidence: 96,
        start: words.length * 4,
        end: words.length * 4 + 4,
        bbox: { x0: 20 + column * 150, y0: 20 + row * 45, x1: 100 + column * 150, y1: 50 + row * 45 }
      });
    }
  }
  const regions = detectTableRegions(words, 500, 180);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].rows, 3);
  assert.equal(regions[0].columns, 3);
});

test('低置信度队列应用人工校正后重建偏移', () => {
  const words = [
    { text: '客户', confidence: 98, start: 0, end: 2, lineIndex: 0, bbox: { x0: 10, y0: 10, x1: 60, y1: 40 } },
    { text: '张二', confidence: 51, start: 2, end: 4, lineIndex: 0, bbox: { x0: 70, y0: 10, x1: 120, y1: 40 } },
    { text: '电话', confidence: 95, start: 5, end: 7, lineIndex: 1, bbox: { x0: 10, y0: 55, x1: 60, y1: 85 } }
  ];
  const queue = buildCorrectionQueue(words, 72);
  assert.deepEqual(queue.map((item) => item.wordIndex), [1]);
  const corrected = applyOcrCorrections(words, [{ wordIndex: 1, text: '张三' }]);
  assert.equal(corrected.text, '客户张三\n电话');
  assert.equal(corrected.words[1].text, '张三');
  assert.equal(corrected.words[1].confidence, 100);
  assert.equal(corrected.words[2].start, 5);
  assert.equal(corrected.changed, 1);
});

test('低分辨率增强比例受短边目标和像素预算约束', () => {
  assert.equal(enhancementScale(1400, 1000), 1);
  assert.equal(enhancementScale(600, 300), 3);
  assert.ok(enhancementScale(20000, 500) < 3);
});

test('双栏文字按左栏到底再进入右栏的阅读顺序重建', () => {
  const words = [];
  for (let index = 0; index < 4; index += 1) {
    words.push({ text: `左${index + 1}`, confidence: 99, bbox: { x0: 20, y0: 20 + index * 50, x1: 90, y1: 40 + index * 50 } });
    words.push({ text: `右${index + 1}`, confidence: 99, bbox: { x0: 320, y0: 45 + index * 50, x1: 390, y1: 65 + index * 50 } });
  }
  const columns = detectDocumentColumns(words, 500, 240);
  assert.equal(columns.length, 2);
  const mapped = rebuildMappedWords(words, 0, { width: 500, height: 240 });
  assert.equal(mapped.readingOrder, 'columns-left-to-right');
  assert.equal(mapped.text, '左1\n左2\n左3\n左4\n右1\n右2\n右3\n右4');
});

test('两行对齐双栏在宽装订线下仍按栏重建', () => {
  const words = [
    { text: '左客户', confidence: 99, bbox: { x0: 40, y0: 40, x1: 180, y1: 80 } },
    { text: '张三', confidence: 99, bbox: { x0: 200, y0: 40, x1: 280, y1: 80 } },
    { text: '左手机', confidence: 99, bbox: { x0: 40, y0: 130, x1: 180, y1: 170 } },
    { text: '13812345678', confidence: 99, bbox: { x0: 200, y0: 130, x1: 450, y1: 170 } },
    { text: '右邮箱', confidence: 99, bbox: { x0: 760, y0: 40, x1: 900, y1: 80 } },
    { text: 'alice@example.com', confidence: 99, bbox: { x0: 920, y0: 40, x1: 1250, y1: 80 } },
    { text: '右证件', confidence: 99, bbox: { x0: 760, y0: 130, x1: 900, y1: 170 } },
    { text: '11010519491231002X', confidence: 99, bbox: { x0: 920, y0: 130, x1: 1320, y1: 170 } }
  ];
  const columns = detectDocumentColumns(words, 1500, 240);
  assert.equal(columns.length, 2);
  const mapped = rebuildMappedWords(words, 0, { width: 1500, height: 240 });
  assert.equal(mapped.readingOrder, 'columns-left-to-right');
  assert.match(mapped.text, /alice@example\.com/u);
  assert.ok(mapped.text.indexOf('13812345678') < mapped.text.indexOf('右邮箱'));
});

test('网格线检测恢复缺失内隔线对应的合并表头', async () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220">
    <rect width="320" height="220" fill="white"/>
    <g stroke="black" stroke-width="3">
      <path d="M10 10H310M10 75H310M10 140H310M10 205H310"/>
      <path d="M10 10V205M310 10V205M110 75V205M210 75V205"/>
    </g>
  </svg>`);
  const image = await sharp(svg).png().toBuffer();
  const tables = await detectTableGrid(image);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows, 3);
  assert.equal(tables[0].columns, 3);
  assert.ok(tables[0].mergedCells >= 1);
  assert.ok(tables[0].cells.some((cell) => cell.columnSpan === 3 && cell.rowSpan === 1));
});

test('合并单元格恢复在完整网格上保持每格独立', () => {
  const width = 21;
  const height = 21;
  const raw = Buffer.alloc(width * height, 255);
  for (const x of [0, 10, 20]) for (let y = 0; y < height; y += 1) raw[y * width + x] = 0;
  for (const y of [0, 10, 20]) for (let x = 0; x < width; x += 1) raw[y * width + x] = 0;
  const cells = recoverMergedGridCells([0, 10, 20], [0, 10, 20], raw, width);
  assert.equal(cells.length, 4);
  assert.ok(cells.every((cell) => !cell.merged));
});

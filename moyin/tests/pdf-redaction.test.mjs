import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const {
  renderScale,
  nativePageText,
  pdfFindingPlacements,
  inspectPdfDocument,
  inspectPdfBytes,
  MAX_PDF_PAGES,
  MAX_PDF_BYTES
} = require('../src/services/pdf-redaction-service.cjs');

test('PDF limits are bounded for offline processing', () => {
  assert.equal(MAX_PDF_PAGES, 300);
  assert.equal(MAX_PDF_BYTES, 100 * 1024 * 1024);
});

test('renderScale keeps ordinary pages at 2x', () => {
  const page = { getViewport: () => ({ width: 595, height: 842 }) };
  assert.equal(renderScale(page), 2);
});

test('renderScale clamps oversized pages to the pixel budget', () => {
  const page = { getViewport: () => ({ width: 6000, height: 6000 }) };
  const scale = renderScale(page);
  assert.ok(scale >= 1);
  assert.ok(scale < 2);
});

test('native PDF text maps item coordinates into global offsets', () => {
  const viewport = {
    width: 400,
    height: 600,
    convertToViewportRectangle: ([x0, y0, x1, y1]) => [x0 * 2, 600 - y1 * 2, x1 * 2, 600 - y0 * 2]
  };
  const result = nativePageText([
    { str: '联系人：', width: 40, height: 10, transform: [10, 0, 0, 10, 20, 250] },
    { str: '张三', width: 20, height: 10, transform: [10, 0, 0, 10, 70, 250], hasEOL: true }
  ], viewport, 100);
  assert.equal(result.text, '联系人： 张三');
  assert.deepEqual(result.words.map(({ text, start, end }) => ({ text, start, end })), [
    { text: '联系人：', start: 100, end: 104 },
    { text: '张三', start: 105, end: 107 }
  ]);
  assert.deepEqual(result.words[1].bbox, { x0: 140, y0: 80, x1: 180, y1: 100 });
});

test('PDF token placement unions all words belonging to one finding', () => {
  const page = {
    width: 500,
    height: 700,
    words: [
      { start: 10, end: 12, bbox: { x0: 100, y0: 200, x1: 130, y1: 220 } },
      { start: 12, end: 15, bbox: { x0: 132, y0: 200, x1: 180, y1: 220 } }
    ]
  };
  const placements = pdfFindingPlacements(page, [{ start: 10, end: 15, replacement: '[MI_A1B2C3D4_001]', type: 'custom' }]);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].token, '[MI_A1B2C3D4_001]');
  assert.ok(placements[0].left < 100 && placements[0].width > 80);
});

test('PDF feature inspection inventories forms, widgets, fonts and rotations', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([300, 400]);
  page.drawText('Feature inventory', { x: 20, y: 360, size: 12, font });
  const form = document.getForm();
  const field = form.createTextField('InventoryField');
  field.setText('value');
  field.addToPage(page, { x: 20, y: 300, width: 120, height: 24, font });
  const features = inspectPdfDocument(document);
  assert.equal(features.pages, 1);
  assert.equal(features.formFields, 1);
  assert.equal(features.widgets, 1);
  assert.equal(features.annotations, 1);
  assert.ok(features.fontResources >= 1);
  assert.deepEqual(features.rotations, [0]);
  assert.equal(features.signatureState, 'not-present');
});

test('PDF feature inspection inventories right-angle rotation and CropBox geometry', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([720, 540]);
  page.setCropBox(60, 40, 600, 440);
  page.setRotation(degrees(90));
  const features = inspectPdfDocument(document);
  assert.deepEqual(features.rotations, [90]);
  assert.equal(features.rotatedPages, 1);
  assert.equal(features.croppedPages, 1);
  assert.deepEqual(features.cropBoxes[0], { x: 60, y: 40, width: 600, height: 440 });
  assert.deepEqual(features.mediaBoxes[0], { x: 0, y: 0, width: 720, height: 540 });
});

test('PDF byte diagnostics identify encryption, XFA and PDF/A declarations without parsing', () => {
  const bytes = Buffer.from('%PDF-1.7\n/Encrypt 9 0 R\n/XFA 10 0 R\n<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>\n%%EOF');
  const result = inspectPdfBytes(bytes);
  assert.equal(result.pdfVersion, '1.7');
  assert.equal(result.encrypted, true);
  assert.equal(result.encryptionState, 'encrypted-password-required');
  assert.equal(result.xfaMarker, true);
  assert.equal(result.pdfaDeclared, true);
  assert.equal(result.pdfaPart, '2');
  assert.equal(result.pdfaConformance, 'B');
});

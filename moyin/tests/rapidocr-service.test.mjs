import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeResult } = require('../src/services/rapidocr-service.cjs');
const { rebuildMappedWords, requestedOcrBackend } = require('../src/services/ocr-service.cjs');

test('RapidOCR result normalizes confidence and polygon coordinates', () => {
  const result = normalizeResult({
    format: 'VEILFORGE_RAPIDOCR_RESULT_V1',
    width: 320,
    height: 120,
    lines: [{ text: '13800138000' }],
    words: [{ text: '13800138000', confidence: 0.987, box: [[10, 20], [180, 20], [180, 48], [10, 48]] }]
  });
  assert.equal(result.words[0].confidence, 98.7);
  assert.deepEqual(result.words[0].bbox, { x0: 10, y0: 20, x1: 180, y1: 48 });
});

test('geometric spacing keeps adjacent OCR characters contiguous', () => {
  const words = [...'13800138000'].map((text, index) => ({
    text,
    confidence: 99,
    bbox: { x0: index * 10, y0: 10, x1: index * 10 + 9, y1: 30 }
  }));
  const mapped = rebuildMappedWords(words, 0, { width: 200, height: 50, geometricSpacing: true });
  assert.equal(mapped.text, '13800138000');
});

test('OCR backend selection is explicit and rejects unknown values', () => {
  assert.equal(requestedOcrBackend({}), 'auto');
  assert.equal(requestedOcrBackend({ backend: 'rapidocr' }), 'rapidocr');
  assert.equal(requestedOcrBackend({ backend: 'tesseract' }), 'tesseract');
  assert.throws(() => requestedOcrBackend({ backend: 'fallback' }), /LOCAL_OCR_BACKEND_INVALID/u);
});

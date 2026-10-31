'use strict';

const path = require('node:path');
const sharp = require('sharp');
const { recognizeImage, renderRedactedImage, findBoxesForFindings } = require('../src/services/ocr-service.cjs');

(async () => {
  const fixture = path.resolve(process.argv[2] || 'ocr-fixture.png');
  const output = path.resolve(process.argv[3] || 'ocr-redacted.png');
  const ocr = await recognizeImage(fixture);
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const result = analyzeText(ocr.text, { customTerms: ['张三'] });
  const boxes = findBoxesForFindings(ocr.words, result.findings, ocr.width, ocr.height);
  const rendered = await renderRedactedImage(ocr, result.findings, output);
  const outputMeta = await sharp(output).metadata();

  console.log(`INPUT=${fixture}`);
  console.log(`OCR_TEXT=${ocr.text.replace(/\n/g, '\\n')}`);
  console.log(`OCR_CONFIDENCE=${ocr.confidence}`);
  console.log(`WORDS=${ocr.words.length}`);
  console.log(`FINDINGS=${result.findings.length}`);
  console.log(`TYPES=${result.findings.map((item) => item.type).join(',')}`);
  console.log(`REDACTION_BOXES=${boxes.length}`);
  console.log(`OUTPUT=${output}`);
  console.log(`OUTPUT_DIMENSIONS=${outputMeta.width}x${outputMeta.height}`);

  const expected = ['person', 'mobile', 'email', 'idcard'];
  const passed = expected.every((type) => result.findings.some((item) => item.type === type))
    && boxes.length >= 4
    && rendered.width === ocr.width
    && rendered.height === ocr.height;
  console.log(`RESULT=${passed ? 'PASS' : 'FAIL'}`);
  process.exit(passed ? 0 : 1);
})().catch((error) => {
  console.error(`RESULT=ERROR ${error?.stack || error}`);
  process.exit(2);
});

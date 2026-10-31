'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const {
  recognizeImageBuffer,
  applyOcrCorrections,
  findBoxesForFindings,
  renderRedactedBuffer,
  terminateWorker
} = require('../src/services/ocr-service.cjs');

async function main() {
  const sourcePath = path.resolve(process.argv[2] || 'ocr-fixture.png');
  const outputDirectory = path.resolve(process.argv[3] || path.join('output', 'ocr', 'phase14'));
  await fs.mkdir(outputDirectory, { recursive: true });
  const lowResolutionPath = path.join(outputDirectory, 'lowres-skew.png');
  const redactedPath = path.join(outputDirectory, 'lowres-skew-redacted.png');
  const reportPath = path.join(outputDirectory, 'phase14-ocr-quality-report.json');
  const lowResolution = await sharp(sourcePath)
    .resize({ width: 700 })
    .rotate(3, { background: '#ffffff' })
    .png()
    .toBuffer();
  await fs.writeFile(lowResolutionPath, lowResolution);
  const ocr = await recognizeImageBuffer(lowResolution, {
    name: path.basename(lowResolutionPath),
    extension: '.png',
    sourceBytes: lowResolution.length
  });
  const reviewItem = ocr.corrections.find((item) => item.text.includes('邮')) || ocr.corrections[0];
  if (!reviewItem) throw new Error('OCR_REVIEW_ITEM_MISSING');
  const corrected = applyOcrCorrections(ocr.words, [{ wordIndex: reviewItem.wordIndex, text: reviewItem.text === '篮' ? '箱' : '邮箱' }]);
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const analysis = analyzeText(corrected.text, { typedTerms: { person: ['张三'] } });
  const session = { ...ocr, text: corrected.text, words: corrected.words };
  const boxes = findBoxesForFindings(session.words, analysis.findings, session.width, session.height);
  const rendered = await renderRedactedBuffer(session, analysis.findings);
  await fs.writeFile(redactedPath, rendered.buffer);
  const expectedTypes = ['person', 'mobile', 'email', 'idcard'];
  const checks = {
    orientationDetected: ocr.orientationDetected && Math.abs(ocr.orientationDegrees) >= 1,
    lowResolutionEnhanced: ocr.enhancement.upscaled && ocr.enhancement.scale > 1,
    tableOrFormRegion: ocr.tableRegions.length >= 1,
    manualReviewQueued: ocr.corrections.length >= 1,
    correctionApplied: corrected.changed === 1 && corrected.text.includes('邮箱:alice@example.com'),
    sensitiveTypes: expectedTypes.every((type) => analysis.findings.some((item) => item.type === type)),
    redactionCoordinates: boxes.length >= 4 && rendered.boxes === boxes.length,
    dimensionsPreserved: rendered.width === ocr.width && rendered.height === ocr.height
  };
  const passed = Object.values(checks).every(Boolean);
  const report = {
    format: 'VEILFORGE_OCR_QUALITY_INTEGRATION',
    result: passed ? 'PASS' : 'FAIL',
    checks,
    sourcePath,
    lowResolutionPath,
    redactedPath,
    textBefore: ocr.text,
    textAfter: corrected.text,
    confidence: ocr.confidence,
    orientationDegrees: ocr.orientationDegrees,
    enhancement: ocr.enhancement,
    segmentationMode: ocr.segmentationMode,
    recognitionPasses: ocr.recognitionPasses,
    tableRegions: ocr.tableRegions,
    queuedCorrections: ocr.corrections,
    changed: corrected.changed,
    findings: analysis.findings.map(({ type, value, start, end }) => ({ type, value, start, end })),
    boxes: boxes.length,
    dimensions: `${ocr.width}x${ocr.height}`
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`OCR_QUALITY_${report.result} orientation=${ocr.orientationDegrees} upscale=${ocr.enhancement.scale} tables=${ocr.tableRegions.length} review=${ocr.corrections.length} corrected=${corrected.changed} findings=${analysis.findings.length} boxes=${boxes.length}\n`);
  process.stdout.write(`REPORT=${reportPath}\n`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`OCR_QUALITY_ERROR ${error?.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => terminateWorker().catch(() => {}));

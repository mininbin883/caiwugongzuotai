'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { recognizePdf, renderRedactedPdf } = require('../src/services/pdf-redaction-service.cjs');
const { terminateWorker } = require('../src/services/ocr-service.cjs');

async function main() {
  const input = path.resolve(process.argv[2] || 'output/pdf/phase3-sensitive-fixture.pdf');
  const output = path.resolve(process.argv[3] || 'output/pdf/phase3-redacted.pdf');
  const reportPath = path.resolve(process.argv[4] || 'output/pdf/phase3-integration.json');
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const session = await recognizePdf(input);
  const result = analyzeText(session.text, { customTerms: ['张三', '李四'] });
  const rendered = await renderRedactedPdf(session, result.findings, output);
  const report = {
    result: 'PASS',
    input,
    output,
    pageCount: session.pageCount,
    confidence: session.confidence,
    text: session.text,
    words: session.pages.reduce((sum, page) => sum + page.words.length, 0),
    findings: result.findings.map(({ type, value, start, end }) => ({ type, value, start, end })),
    boxes: rendered.boxes,
    bytes: rendered.bytes
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_INTEGRATION_OK pages=${report.pageCount} findings=${report.findings.length} boxes=${report.boxes} bytes=${report.bytes}\n`);
  if (report.pageCount !== 2 || report.findings.length < 8 || report.boxes < 8) process.exitCode = 1;
  await terminateWorker();
}

main().catch(async (error) => {
  process.stderr.write(`PDF_INTEGRATION_FAILED ${error?.stack || error}\n`);
  await terminateWorker().catch(() => {});
  process.exitCode = 1;
});

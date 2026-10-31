'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const {
  recognizePdf,
  renderTokenizedPdf,
  restoreReversiblePdf
} = require('../src/services/pdf-redaction-service.cjs');
const { terminateWorker } = require('../src/services/ocr-service.cjs');

function replacementFindings(findings, assignments) {
  const byRange = new Map(findings.map((finding) => [`${finding.start}:${finding.end}`, finding]));
  return assignments.map((assignment) => ({
    ...byRange.get(`${assignment.start}:${assignment.end}`),
    replacement: assignment.token,
    enabled: true
  }));
}

async function createScanFixture(sourcePath, outputPath) {
  const source = await recognizePdf(sourcePath);
  const pdf = await PDFDocument.create();
  for (const sourcePage of source.pages) {
    const embedded = await pdf.embedPng(sourcePage.image);
    const page = pdf.addPage([sourcePage.pdfWidth, sourcePage.pdfHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: sourcePage.pdfWidth, height: sourcePage.pdfHeight });
  }
  await fs.writeFile(outputPath, await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
  return { pages: source.pages.length };
}

async function roundTrip(inputPath, directory, name, nonce) {
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const { tokenizeFindings } = await import('../src/core/reversible-token-engine.mjs');
  const source = await recognizePdf(inputPath);
  const analysis = analyzeText(source.text, { customTerms: ['张三', '李四'] });
  const reversible = tokenizeFindings(source.text, analysis.findings, { nonce });
  const tokenizedPath = path.join(directory, `${name}-tokenized.pdf`);
  const restoredPath = path.join(directory, `${name}-restored.pdf`);
  const tokenized = await renderTokenizedPdf(source, replacementFindings(analysis.findings, reversible.assignments), tokenizedPath);
  const coordinateRaw = await fs.readFile(tokenized.coordinatePath, 'utf8');
  const textRaw = await fs.readFile(tokenized.textPath, 'utf8');
  const sensitiveAbsentFromSidecars = reversible.mapping.every((entry) => !coordinateRaw.includes(entry.value) && !textRaw.includes(entry.value));
  const reopened = await recognizePdf(tokenizedPath);
  const tokensExtracted = reversible.mapping.every((entry) => reopened.text.includes(entry.token));
  const sensitiveAbsentFromPdfText = reversible.mapping.every((entry) => !reopened.text.includes(entry.value));
  const restored = await restoreReversiblePdf(tokenizedPath, reversible.mapping, restoredPath, tokenized.coordinatePath);
  const restoredStat = await fs.stat(restoredPath);
  return {
    name,
    sourceMode: source.sourceMode,
    pageCount: source.pageCount,
    findings: analysis.findings.length,
    tokens: reversible.mapping.length,
    occurrences: reversible.occurrenceCount,
    coordinates: tokenized.coordinates,
    scanPages: tokenized.scanPages,
    tokensExtracted,
    sensitiveAbsentFromSidecars,
    sensitiveAbsentFromPdfText,
    restoredOccurrences: restored.restoredOccurrences,
    restoredCoordinates: restored.restoredCoordinates,
    complete: restored.complete,
    coordinateSidecarUsed: restored.coordinateSidecarUsed,
    visualRestoration: restored.visualRestoration,
    restoredBytes: restoredStat.size,
    missing: restored.missingTokens.length,
    unknown: restored.unknownTokens.length,
    repeated: restored.repeatedTokens.length
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'output', 'pdf', 'phase11');
  await fs.mkdir(directory, { recursive: true });
  const nativeInput = path.join(root, 'output', 'pdf', 'phase3-sensitive-fixture.pdf');
  const scanInput = path.join(directory, 'phase11-scan-sensitive.pdf');
  await createScanFixture(nativeInput, scanInput);
  const native = await roundTrip(nativeInput, directory, 'native', 'D0C0B011');
  const scan = await roundTrip(scanInput, directory, 'scan', 'A1B2C311');
  const pass = native.sourceMode === 'native' && native.findings >= 8 && scan.sourceMode === 'ocr' && scan.findings >= 4 && scan.scanPages === scan.pageCount &&
    [native, scan].every((item) => item.tokens > 0 && item.coordinates === item.occurrences &&
      item.tokensExtracted && item.sensitiveAbsentFromSidecars && item.sensitiveAbsentFromPdfText &&
      item.restoredOccurrences === item.occurrences && item.restoredCoordinates === item.occurrences &&
      item.complete && item.coordinateSidecarUsed && item.visualRestoration && item.restoredBytes > 0 &&
      item.missing === 0 && item.unknown === 0 && item.repeated === 0);
  const report = { format: 'VEILFORGE_PDF_REVERSIBLE_ROUNDTRIP', result: pass ? 'PASS' : 'FAIL', native, scan };
  await fs.writeFile(path.join(directory, 'phase11-pdf-reversible-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_REVERSIBLE_${report.result} native=${native.restoredOccurrences}/${native.occurrences} scan=${scan.restoredOccurrences}/${scan.occurrences} coords=${native.coordinates + scan.coordinates} sidecars=${native.sensitiveAbsentFromSidecars && scan.sensitiveAbsentFromSidecars ? 1 : 0}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`PDF_REVERSIBLE_ERROR ${error?.stack || error}\n`);
  process.exitCode = 2;
}).finally(async () => {
  await terminateWorker().catch(() => {});
});


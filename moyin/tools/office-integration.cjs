'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');
const { extractOfficeDocument, renderRedactedOffice } = require('../src/services/office-redaction-service.cjs');

async function processOne(input, output, customTerms) {
  const extracted = await extractOfficeDocument(input);
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const analysis = analyzeText(extracted.text, { customTerms });
  const rendered = await renderRedactedOffice(extracted.session, analysis.findings, output);
  const reopened = await extractOfficeDocument(output);
  const residual = analyzeText(reopened.text, { customTerms }).findings;
  return {
    input,
    output,
    sourceText: extracted.text,
    outputText: reopened.text,
    findings: analysis.findings.map(({ type, value, replacement }) => ({ type, value, replacement })),
    residual: residual.map(({ type, value }) => ({ type, value })),
    ...rendered
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const sourceDocx = path.join(root, 'output', 'office', 'phase5-sensitive.docx');
  const sourceXlsx = path.join(root, 'output', 'office', 'phase5-sensitive.xlsx');
  const outputDocx = path.join(root, 'output', 'office', 'phase5-redacted.docx');
  const outputXlsx = path.join(root, 'output', 'office', 'phase5-redacted.xlsx');
  const reportPath = path.join(root, 'output', 'office', 'phase5-integration.json');

  const docx = await processOne(sourceDocx, outputDocx, ['张三', '李四']);
  const xlsx = await processOne(sourceXlsx, outputXlsx, ['张三', '李四']);

  const sourceBook = XLSX.read(await fs.readFile(sourceXlsx), { type: 'buffer', cellFormula: true });
  const outputBook = XLSX.read(await fs.readFile(outputXlsx), { type: 'buffer', cellFormula: true });
  const formulas = ['G4', 'G5', 'G6'].map((address) => ({
    address,
    source: sourceBook.Sheets['客户清单'][address]?.f || '',
    output: outputBook.Sheets['客户清单'][address]?.f || ''
  }));
  const formulaPreserved = formulas.every((item) => item.source && item.source === item.output);
  const pass = docx.findings.length >= 7 && xlsx.findings.length >= 8 && !docx.residual.length && !xlsx.residual.length && formulaPreserved;
  const report = { result: pass ? 'PASS' : 'FAIL', docx, xlsx, formulaPreserved, formulas };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`OFFICE_INTEGRATION_${report.result} docxFindings=${docx.findings.length} docxUnits=${docx.changedUnits} xlsxFindings=${xlsx.findings.length} xlsxUnits=${xlsx.changedUnits} formulas=${formulaPreserved ? 1 : 0}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`OFFICE_INTEGRATION_FAILED ${error?.stack || error}\n`);
  process.exitCode = 1;
});

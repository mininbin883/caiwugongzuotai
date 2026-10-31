'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const iconv = require('iconv-lite');
const {
  extractCsvDocument,
  renderRedactedCsv
} = require('../src/services/csv-redaction-service.cjs');

function encodeFixture(text, encoding, bom) {
  const payload = encoding === 'utf8' ? Buffer.from(text, 'utf8') : iconv.encode(text, encoding);
  return bom?.length ? Buffer.concat([Buffer.from(bom), payload]) : payload;
}

async function runRoundtrip(directory, fixture, nonce) {
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const { tokenizeFindings, restoreTokens } = await import('../src/core/reversible-token-engine.mjs');
  const inputPath = path.join(directory, `${fixture.name}-source.csv`);
  const tokenizedPath = path.join(directory, `${fixture.name}-tokenized.csv`);
  const restoredPath = path.join(directory, `${fixture.name}-restored.csv`);
  const inputBytes = encodeFixture(fixture.text, fixture.encoding, fixture.bom);
  await fs.writeFile(inputPath, inputBytes);
  const source = await extractCsvDocument(inputPath);
  const analysis = analyzeText(source.text, { customTerms: ['张三'] });
  const tokenized = tokenizeFindings(source.text, analysis.findings, { nonce });
  const rendered = await renderRedactedCsv(source.session, tokenized.tokenizedText, tokenizedPath, { sanitizeFormulas: false });
  const reopened = await extractCsvDocument(tokenizedPath);
  const residual = analyzeText(reopened.text, { customTerms: ['张三'] }).findings.length;
  const restore = restoreTokens(reopened.text, tokenized.mapping, { mode: 'rewrite' });
  await renderRedactedCsv(reopened.session, restore.restoredText, restoredPath, { sanitizeFormulas: false });
  const restoredBytes = await fs.readFile(restoredPath);
  return {
    name: fixture.name,
    encoding: source.metadata.encoding,
    bom: source.metadata.bom,
    delimiterName: source.metadata.delimiterName,
    lineEndingName: source.metadata.lineEndingName,
    rows: source.metadata.rows,
    columns: source.metadata.columns,
    findings: analysis.findings.length,
    tokens: tokenized.mapping.length,
    occurrences: tokenized.occurrenceCount,
    restoredOccurrences: restore.restoredCount,
    residual,
    exactBytes: Buffer.compare(inputBytes, restoredBytes) === 0,
    complete: restore.complete,
    tokenizedBytes: rendered.bytes
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'output', 'csv', 'phase23');
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  const fixtures = [
    {
      name: 'utf8-bom-comma-crlf', encoding: 'utf8', bom: [0xef, 0xbb, 0xbf],
      text: '姓名,电话,邮箱\r\n张三,13800138000,zhangsan@example.com\r\n'
    },
    {
      name: 'gb18030-semicolon-crlf', encoding: 'gb18030', bom: [],
      text: '姓名;电话;邮箱\r\n张三;13800138000;zhangsan@example.com\r\n'
    },
    {
      name: 'utf16le-tab-lf', encoding: 'utf16le', bom: [0xff, 0xfe],
      text: '姓名\t电话\t邮箱\n张三\t13800138000\tzhangsan@example.com\n'
    }
  ];
  const rounds = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    rounds.push(await runRoundtrip(directory, fixtures[index], `C5A23${String(index + 1).padStart(3, '0')}`));
  }

  const formulaInput = path.join(directory, 'formula-source.csv');
  const formulaOutput = path.join(directory, 'formula-safe.csv');
  await fs.writeFile(formulaInput, '姓名,备注\r\n张三,"=HYPERLINK(""https://example.invalid"",""打开"")"\r\n', 'utf8');
  const formula = await extractCsvDocument(formulaInput);
  const formulaRendered = await renderRedactedCsv(formula.session, formula.text.replace('张三', '张*'), formulaOutput);
  const formulaReopened = await extractCsvDocument(formulaOutput);
  const formulaSafe = formulaRendered.formulaCellsEscaped === 1 && formulaReopened.text.includes('"\'=HYPERLINK');

  const pass = rounds.every((item) => item.findings >= 3 && item.tokens >= 3 && item.occurrences === item.restoredOccurrences &&
    item.residual === 0 && item.exactBytes && item.complete) && formulaSafe;
  const report = {
    format: 'VEILFORGE_CSV_SAME_FORMAT_REVERSIBLE',
    result: pass ? 'PASS' : 'FAIL',
    rounds,
    formulaSafety: {
      escaped: formulaRendered.formulaCellsEscaped,
      structure: `${formulaReopened.metadata.rows}x${formulaReopened.metadata.columns}`,
      safe: formulaSafe
    }
  };
  const reportPath = path.join(directory, 'phase23-csv-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`CSV_PHASE23_${report.result} formats=${rounds.length} exact=${rounds.filter((item) => item.exactBytes).length}/${rounds.length} tokens=${rounds.reduce((sum, item) => sum + item.occurrences, 0)} formulas=${formulaRendered.formulaCellsEscaped}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`CSV_PHASE23_ERROR ${error?.stack || error}\n`);
  process.exitCode = 2;
});

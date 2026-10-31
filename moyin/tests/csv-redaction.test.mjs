import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');
const {
  decodeCsvBuffer,
  inspectCsvText,
  sanitizeFormulaCells,
  extractCsvDocument,
  renderRedactedCsv
} = require('../src/services/csv-redaction-service.cjs');

test('CSV inspection preserves quoted newlines and detects semicolon dialect', () => {
  const text = '\ufeffname;note\r\n张三;"第一行\r\n第二行"\r\n';
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.slice(1), 'utf8')]);
  const decoded = decodeCsvBuffer(bytes);
  const inspected = inspectCsvText(decoded.text);
  assert.equal(decoded.encoding, 'utf8');
  assert.equal(decoded.bom.length, 3);
  assert.equal(inspected.delimiter, ';');
  assert.equal(inspected.lineEnding, '\r\n');
  assert.deepEqual(inspected.rowFieldCounts, [2, 2]);
});

test('CSV formula protection escapes executable cells without changing structure', () => {
  const source = 'name,note\r\n张三,"=HYPERLINK(""https://example.invalid"",""x"")"\r\n李四,-42\r\n';
  const before = inspectCsvText(source);
  const result = sanitizeFormulaCells(source, before.delimiter);
  const after = inspectCsvText(result.text, before.delimiter);
  assert.equal(result.escaped, 1);
  assert.match(result.text, /"'=HYPERLINK/u);
  assert.match(result.text, /,-42\r\n/u);
  assert.deepEqual(after.rowFieldCounts, before.rowFieldCounts);
});

test('GB18030 CSV roundtrip keeps encoding, CRLF, delimiter and blocks formulas', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-csv-'));
  try {
    const inputPath = path.join(directory, '客户.csv');
    const outputPath = path.join(directory, '客户-脱敏.csv');
    const source = '姓名;电话;备注\r\n张三;13800138000;"=CMD()"\r\n';
    await fs.writeFile(inputPath, iconv.encode(source, 'gb18030'));
    const document = await extractCsvDocument(inputPath);
    assert.equal(document.metadata.encoding, 'gb18030');
    assert.equal(document.metadata.delimiter, ';');
    assert.equal(document.metadata.lineEnding, '\r\n');
    const rendered = await renderRedactedCsv(document.session, document.text.replace('13800138000', '138****8000'), outputPath);
    const reopened = await extractCsvDocument(outputPath);
    assert.equal(rendered.formulaCellsEscaped, 1);
    assert.equal(reopened.metadata.encoding, 'gb18030');
    assert.equal(reopened.metadata.delimiter, ';');
    assert.equal(reopened.metadata.lineEnding, '\r\n');
    assert.match(reopened.text, /138\*\*\*\*8000/u);
    assert.match(reopened.text, /"'=CMD\(\)"/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('CSV renderer rejects row or column mutations before writing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-csv-guard-'));
  try {
    const inputPath = path.join(directory, 'input.csv');
    const outputPath = path.join(directory, 'output.csv');
    await fs.writeFile(inputPath, '\ufeff姓名,电话\n张三,13800138000\n', 'utf8');
    const document = await extractCsvDocument(inputPath);
    await assert.rejects(
      () => renderRedactedCsv(document.session, `${document.text},extra`, outputPath),
      /LOCAL_CSV_STRUCTURE_CHANGED/u
    );
    await assert.rejects(() => fs.access(outputPath));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('reversible CSV tokens restore byte-identical UTF-8 BOM source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-csv-reversible-'));
  try {
    const inputPath = path.join(directory, 'source.csv');
    const tokenizedPath = path.join(directory, 'tokenized.csv');
    const restoredPath = path.join(directory, 'restored.csv');
    const sourceText = '姓名,电话\r\n张三,13800138000\r\n';
    const sourceBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sourceText, 'utf8')]);
    await fs.writeFile(inputPath, sourceBytes);
    const source = await extractCsvDocument(inputPath);
    const { tokenizeFindings, restoreTokens } = await import('../src/core/reversible-token-engine.mjs');
    const findings = [
      { type: 'person', label: '姓名', start: source.text.indexOf('张三'), end: source.text.indexOf('张三') + 2, enabled: true },
      { type: 'mobile', label: '手机号', start: source.text.indexOf('13800138000'), end: source.text.indexOf('13800138000') + 11, enabled: true }
    ];
    const tokens = tokenizeFindings(source.text, findings, { nonce: 'C5A23001' });
    await renderRedactedCsv(source.session, tokens.tokenizedText, tokenizedPath, { sanitizeFormulas: false });
    const tokenized = await extractCsvDocument(tokenizedPath);
    const restored = restoreTokens(tokenized.text, tokens.mapping, { mode: 'rewrite' });
    await renderRedactedCsv(tokenized.session, restored.restoredText, restoredPath, { sanitizeFormulas: false });
    assert.equal(restored.complete, true);
    assert.equal(restored.restoredCount, 2);
    assert.deepEqual(await fs.readFile(restoredPath), sourceBytes);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

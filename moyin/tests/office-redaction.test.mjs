import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseWordPart, applyMappedFindings, patchWorksheetXml, officeTokenFindings, normalizeReversibleMapping } = require('../src/services/office-redaction-service.cjs');

test('DOCX text mapping keeps split-run offsets', () => {
  const parsed = parseWordPart('<w:p><w:r><w:t>客户：张</w:t></w:r><w:r><w:t>三</w:t></w:r></w:p>');
  assert.equal(parsed.text, '客户：张三');
  assert.deepEqual(parsed.nodes.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 0, end: 4, text: '客户：张' },
    { start: 4, end: 5, text: '三' }
  ]);
});

test('cross-run redaction writes the replacement once and clears later segments', () => {
  const finding = { start: 3, end: 5, replacement: '**' };
  const first = applyMappedFindings('客户：张', { start: 0, end: 4 }, [finding]);
  const second = applyMappedFindings('三', { start: 4, end: 5 }, [finding]);
  assert.equal(first.text, '客户：**');
  assert.equal(second.text, '');
});

test('XLSX cell patch preserves style attributes and converts only the selected cell', () => {
  const source = '<worksheet><sheetData><row r="4"><c r="B4" s="2" t="s"><v>0</v></c><c r="C4" s="3"><v>13812345678</v></c></row></sheetData></worksheet>';
  const patched = patchWorksheetXml(source, new Map([['C4', '138****5678']]));
  assert.equal(patched.changed, 1);
  assert.match(patched.xml, /<c r="B4" s="2" t="s"><v>0<\/v><\/c>/);
  assert.match(patched.xml, /<c r="C4" s="3" t="inlineStr"><is><t xml:space="preserve">138\*\*\*\*5678<\/t><\/is><\/c>/);
});

test('Office reversible mapping restores known tokens and reports missing or unknown tokens', () => {
  const mapping = [
    { token: '[MI_A1B2C3D4_001]', value: '张三', type: 'person', label: '姓名', occurrences: 1 },
    { token: '[MI_A1B2C3D4_002]', value: '北京星河科技有限公司', type: 'company', label: '公司名称', occurrences: 1 }
  ];
  const report = officeTokenFindings('联系人：[MI_A1B2C3D4_001]；未知：[MI_FFFFFFFF_999]', mapping);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].replacement, '张三');
  assert.deepEqual(report.missingTokens, ['[MI_A1B2C3D4_002]']);
  assert.deepEqual(report.unknownTokens, ['[MI_FFFFFFFF_999]']);
  assert.equal(report.complete, false);
});

test('Office reversible mapping rejects duplicate or malformed tokens', () => {
  assert.throws(() => normalizeReversibleMapping([
    { token: '[MI_A1B2C3D4_001]', value: '张三' },
    { token: '[MI_A1B2C3D4_001]', value: '李四' }
  ]), /LOCAL_OFFICE_REVERSIBLE_MAPPING_INVALID/);
  assert.throws(() => normalizeReversibleMapping([{ token: '[TOKEN]', value: '张三' }]), /LOCAL_OFFICE_REVERSIBLE_MAPPING_INVALID/);
});

test('数字格里乱码的货币符号（如“å52,500.00”）在提取时去掉', async () => {
  const XLSX = (await import('xlsx')).default;
  const os = await import('node:os');
  const pathModule = await import('node:path');
  const fsModule = await import('node:fs/promises');
  const { extractOfficeDocument } = (await import('../src/services/office-redaction-service.cjs')).default;
  const sheet = XLSX.utils.aoa_to_sheet([['科目名称', '期初借方'], ['示例', 52500]]);
  sheet.B2.z = '"å"#,##0.00';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '余额表');
  const directory = await fsModule.mkdtemp(pathModule.join(os.tmpdir(), 'moyin-garbled-'));
  const file = pathModule.join(directory, 'garbled.xlsx');
  XLSX.writeFile(book, file);
  const document = await extractOfficeDocument(file);
  assert.ok(document.text.includes('52,500.00'));
  assert.ok(!document.text.includes('å'));
  await fsModule.rm(directory, { recursive: true, force: true });
});

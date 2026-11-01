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

test('旧版 .xls 先转为 .xlsx 再按原格式处理，乱码货币格式被清理', async () => {
  const XLSX = (await import('xlsx')).default;
  const os = await import('node:os');
  const pathModule = await import('node:path');
  const fsModule = await import('node:fs/promises');
  const { convertXlsToXlsx, extractOfficeDocument } = (await import('../src/services/office-redaction-service.cjs')).default;
  const sheet = XLSX.utils.aoa_to_sheet([['科目代码', '科目名称', '期初借方'], ['1221', '其他应收款', 0], ['1221.001', '示例人', 52500]]);
  sheet.C3.z = '"å"#,##0.00';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '科目余额表');
  const directory = await fsModule.mkdtemp(pathModule.join(os.tmpdir(), 'moyin-xls-'));
  const input = pathModule.join(directory, 'ledger.xls');
  const output = pathModule.join(directory, 'converted.xlsx');
  XLSX.writeFile(book, input, { bookType: 'biff8' });
  await convertXlsToXlsx(input, output);
  const document = await extractOfficeDocument(output);
  assert.ok(document.text.includes('1221.001\t示例人\t52,500.00'));
  assert.ok(!document.text.includes('å'));
  assert.equal(document.session.kind, 'xlsx');
  await fsModule.rm(directory, { recursive: true, force: true });
});

test('工作表名称中的敏感信息：导出改名（含公式引用），文档属性清空，逆脱敏改回', async () => {
  const XLSX = (await import('xlsx')).default;
  const JSZip = (await import('jszip')).default;
  const os = await import('node:os');
  const pathModule = await import('node:path');
  const fsModule = await import('node:fs/promises');
  const office = (await import('../src/services/office-redaction-service.cjs')).default;
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const { tokenizeFindings } = await import('../src/core/reversible-token-engine.mjs');
  const directory = await fsModule.mkdtemp(pathModule.join(os.tmpdir(), 'moyin-sheetname-'));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['项目', '金额'], ['营业收入', 1000]]), '潍坊星河建材有限公司');
  const summary = XLSX.utils.aoa_to_sheet([['汇总', '联系人'], [null, '张三']]);
  summary.A2 = { t: 'n', f: "'潍坊星河建材有限公司'!B2", v: 1000 };
  XLSX.utils.book_append_sheet(book, summary, '汇总');
  book.Props = { Author: '张三', Company: '潍坊星河建材有限公司', Title: '星河年报' };
  const input = pathModule.join(directory, 'in.xlsx');
  XLSX.writeFile(book, input);
  const document = await office.extractOfficeDocument(input);
  const analysis = analyzeText(document.text);
  const tokenized = tokenizeFindings(document.text, analysis.findings, { nonce: 'ABCDEF12' });
  const byRange = new Map(tokenized.assignments.map((item) => [`${item.start}:${item.end}`, item.token]));
  const findings = analysis.findings.map((item) => ({ ...item, replacement: byRange.get(`${item.start}:${item.end}`) }));
  const output = pathModule.join(directory, 'out.xlsx');
  const rendered = await office.renderRedactedOffice(document.session, findings, output);
  assert.equal(rendered.renamedSheets, 1);
  const copy = XLSX.readFile(output, { cellFormula: true });
  const token = tokenized.mapping.find((entry) => entry.value === '潍坊星河建材有限公司').token.slice(1, -1);
  assert.deepEqual(copy.SheetNames, [token, '汇总']);
  assert.equal(copy.Sheets['汇总'].A2.f, `'${token}'!B2`);
  const zip = await JSZip.loadAsync(await fsModule.readFile(output));
  const props = `${await zip.file('docProps/core.xml')?.async('string') || ''}${await zip.file('docProps/app.xml')?.async('string') || ''}`;
  assert.ok(!props.includes('星河') && !props.includes('张三'));
  const restoredPath = pathModule.join(directory, 'restored.xlsx');
  await office.restoreReversibleOffice(output, tokenized.mapping, restoredPath);
  const restored = XLSX.readFile(restoredPath, { cellFormula: true });
  assert.deepEqual(restored.SheetNames, ['潍坊星河建材有限公司', '汇总']);
  assert.equal(restored.Sheets['汇总'].A2.f, "'潍坊星河建材有限公司'!B2");
  assert.equal(restored.Sheets['汇总'].B2.v, '张三');
  await fsModule.rm(directory, { recursive: true, force: true });
});

test('自闭合的空单元格（WPS 常见 <c r="Q6" s="2"/>）后面的单元格可以正常改写', async () => {
  const office = (await import('../src/services/office-redaction-service.cjs')).default;
  const xml = '<sheetData><row r="6"><c r="P6" s="2" t="s"><v>1</v></c><c r="Q6" s="2"/><c r="R6" s="2" t="s"><v>2</v></c><c r="S6" s="2"><v>3</v></c></row></sheetData>';
  const patched = office.patchWorksheetXml(xml, new Map([['R6', '[MI_ABCDEF12_001]']]));
  assert.equal(patched.changed, 1);
  assert.ok(patched.xml.includes('<c r="Q6" s="2"/>'));
  assert.ok(patched.xml.includes('<c r="R6" s="2" t="inlineStr"><is><t xml:space="preserve">[MI_ABCDEF12_001]</t></is></c>'));
  assert.ok(patched.xml.includes('<c r="S6" s="2"><v>3</v></c>'));
  assert.ok(patched.xml.includes('<c r="P6" s="2" t="s"><v>1</v></c>'));
});

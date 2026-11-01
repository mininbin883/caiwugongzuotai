import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const JSZip = require('jszip');
const office = require('../src/services/office-redaction-service.cjs');
const { sweepPairsFromFindings } = require('../src/services/office-package-sweep.cjs');
const { shortNameFindings } = require('../src/services/batch-reversible-service.cjs');
const { listRestorableFiles } = require('../src/services/restore-folder-service.cjs');
const { analyzeText } = await import('../src/core/redaction-engine.mjs');
const { tokenizeFindings } = await import('../src/core/reversible-token-engine.mjs');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moyin-sweep-'));
}

function tokenized(text) {
  const analysis = analyzeText(text, {});
  const enabled = analysis.findings.filter((item) => item.enabled !== false);
  const result = tokenizeFindings(text, enabled, { nonce: 'ABCDEF12' });
  const byRange = new Map(result.assignments.map((item) => [`${item.start}:${item.end}`, item.token]));
  return {
    findings: enabled.filter((item) => byRange.has(`${item.start}:${item.end}`)).map((item) => ({ ...item, replacement: byRange.get(`${item.start}:${item.end}`) })),
    mapping: result.mapping
  };
}

async function allXml(file) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  let text = '';
  for (const name of Object.keys(zip.files)) if (/\.(xml|rels|vml)$/u.test(name)) text += await zip.file(name).async('string');
  return text.replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));
}

test('Excel 副本：共享字符串表里的原文被清掉，公式的计算结果也被替换，逆脱敏后还原', async () => {
  const dir = await tempDir();
  const sheet = XLSX.utils.aoa_to_sheet([['姓名', '手机号', '引用'], ['张三丰', '13812345678', ''], ['李四光', '13912345678', '']]);
  sheet.C2 = { t: 's', v: '张三丰', f: 'A2' };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '往来');
  const input = path.join(dir, 'in.xlsx');
  await fs.writeFile(input, XLSX.write(book, { type: 'buffer', bookType: 'xlsx', bookSST: true }));
  const doc = await office.extractOfficeDocument(input);
  assert.match(doc.text, /张三丰\t13812345678\t张三丰/u, '公式单元格的文字结果参与识别');
  const { findings, mapping } = tokenized(doc.text);
  const output = path.join(dir, 'out.xlsx');
  const rendered = await office.renderRedactedOffice(doc.session, findings, output);
  assert.ok(rendered.clearedStrings >= 4);
  const xml = await allXml(output);
  for (const value of ['张三丰', '李四光', '13812345678', '13912345678']) assert.ok(!xml.includes(value), `副本里不应再有 ${value}`);
  assert.match(xml, /<f>A2<\/f><v>\[MI_ABCDEF12_\w+\]<\/v>/u, '公式保留，只改计算结果');
  const back = path.join(dir, 'back.xlsx');
  const restored = await office.restoreReversibleOffice(output, mapping, back);
  assert.equal(restored.complete, true);
  assert.equal((await office.extractOfficeDocument(back)).text, doc.text);
});

test('Excel 副本：批注里的原文和批注作者被处理；Word 副本：修订删除的文字被识别，修订人清空', async () => {
  const dir = await tempDir();
  const sheet = XLSX.utils.aoa_to_sheet([['姓名', '手机号'], ['张三丰', '13812345678']]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'S');
  const input = path.join(dir, 'c.xlsx');
  await fs.writeFile(input, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  // 手工加一个批注部件
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  zip.file('xl/comments1.xml', '<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>王审计员</author></authors><commentList><comment ref="B2" authorId="0"><text><t>联系人张三丰 13812345678</t></text></comment></commentList></comments>');
  await fs.writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const doc = await office.extractOfficeDocument(input);
  const { findings } = tokenized(doc.text);
  const output = path.join(dir, 'c-out.xlsx');
  await office.renderRedactedOffice(doc.session, findings, output);
  const xml = await allXml(output);
  assert.ok(!xml.includes('张三丰') && !xml.includes('13812345678') && !xml.includes('王审计员'));

  const docx = new JSZip();
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>联系人张三丰，手机13812345678。</w:t></w:r></w:p><w:p><w:del w:id="1" w:author="修订人赵六"><w:r><w:delText>旧号码13912345678</w:delText></w:r></w:del></w:p></w:body></w:document>');
  const docxInput = path.join(dir, 'd.docx');
  await fs.writeFile(docxInput, await docx.generateAsync({ type: 'nodebuffer' }));
  const wordDoc = await office.extractOfficeDocument(docxInput);
  assert.match(wordDoc.text, /旧号码13912345678/u);
  const word = tokenized(wordDoc.text);
  const wordOut = path.join(dir, 'd-out.docx');
  await office.renderRedactedOffice(wordDoc.session, word.findings, wordOut);
  const wordXml = await allXml(wordOut);
  for (const value of ['张三丰', '13812345678', '13912345678', '修订人赵六']) assert.ok(!wordXml.includes(value), `Word 副本里不应再有 ${value}`);
});

test('整包替换：两个字的原文只整段替换；被假名包含的原文不替换；取消勾选的原文不替换', () => {
  const pairs = sweepPairsFromFindings([
    { value: '张凯', replacement: '马己子', enabled: true },
    { value: '甘肃省兰州市', replacement: '甘肃省兰州市地址Q001', enabled: true },
    { value: '李四光', replacement: '[MI_ABCDEF12_001]', enabled: true },
    { value: '王五六', replacement: '[MI_ABCDEF12_002]', enabled: true },
    { value: '王五六', replacement: '[MI_ABCDEF12_002]', enabled: false },
    { value: '2021', replacement: '[MI_ABCDEF12_003]', enabled: true }
  ]);
  assert.deepEqual(pairs.map((pair) => [pair.from, pair.wholeOnly]), [['李四光', false], ['张凯', true]]);
});

test('批次里已认出的两个字人名：整格或跟在“名称：”后才补上，不撞进更长的词', () => {
  const text = '销方\t张凯\t备注\n代开企业名称:周云\r\n张凯明\t代开企业名称:周云飞\t张凯工作室';
  const added = shortNameFindings(text, new Set(['张凯', '周云']), []);
  assert.deepEqual(added.map((item) => [item.value, text.slice(item.start, item.end), item.start]), [['张凯', '张凯', 3], ['周云', '周云', 16]]);
});

test('标签后紧跟非姓氏的字（如“项目经理部项目”）不当成人名', () => {
  const names = (text) => analyzeText(text).findings.filter((item) => item.type === 'person').map((item) => item.value);
  assert.deepEqual(names('施工总承包项目经理部项目   项目地址：甘肃'), []);
  assert.deepEqual(names('项目经理张三丰，'), ['张三丰']);
  assert.deepEqual(names('联系人：令狐冲'), ['令狐冲']);
});

test('文件夹逆脱敏：超出层级的文件夹会列进“未处理”，不会悄悄漏掉', async () => {
  const dir = await tempDir();
  const deep = path.join(dir, 'a', 'b', 'c', 'd');
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(dir, 'top.md'), 'x');
  await fs.writeFile(path.join(deep, 'deep.md'), 'x');
  const listed = await listRestorableFiles(dir);
  assert.deepEqual(listed.files.map((item) => item.rel), ['top.md']);
  assert.ok(listed.skipped.some((item) => item.includes('层级太深')));
});

test('假名紧挨在一起时都能换回；真实号码里恰好包含假名数字的不误换', async () => {
  const { restorePseudonyms } = await import('../src/core/pseudonym-engine.mjs');
  const mapping = [
    { form: 'pseudonym', type: 'address', token: '片区地址Q013', value: '片区兰州万达城G1901-9号1206室' },
    { form: 'pseudonym', type: 'mobile', token: '19900000013', value: '18609487273' }
  ];
  const result = restorePseudonyms('电话：片区地址Q01319900000013；另 119900000013', mapping);
  assert.equal(result.text, '电话：片区兰州万达城G1901-9号1206室18609487273；另 119900000013');
  assert.equal(result.count, 2);
});

test('零件号里的“250.2.3.1”不当成 IP 地址', () => {
  const values = analyzeText('件号 M250.2.3.1A；服务器 192.168.10.8。').findings.map((item) => item.value);
  assert.deepEqual(values, ['192.168.10.8']);
});

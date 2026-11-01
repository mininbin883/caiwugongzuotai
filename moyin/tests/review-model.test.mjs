import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';
import { buildTableModel, groupByColumn, groupByType, wholeColumnFindings, createColumnLocator, findColumn, columnLetter } from '../src/core/review-model.mjs';

const TEXT = [
  '【工作表：铁路电子客票】',
  '序号\t销方名称\t开票人\t旅客姓名\t出行车次',
  '1\t示例铁路有限公司\t赵小青\t钱多多\tD8104',
  '2\t示例铁路有限公司\t赵小青\t钱多多\tG2976',
  '3\t示例客运有限公司\t孙不二\t钱多多\tD3852',
  '',
  '备注：联系人：李四，手机 13812345678。'
].join('\n');

test('列字母', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(columnLetter), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
});

test('建出表格结构：工作表、表头、列和格子位置', () => {
  const model = buildTableModel(TEXT);
  assert.equal(model.tables.length, 1);
  const table = model.tables[0];
  assert.equal(table.sheet, '铁路电子客票');
  assert.deepEqual(table.columns.map((column) => `${column.letter}:${column.header}`), ['A:序号', 'B:销方名称', 'C:开票人', 'D:旅客姓名', 'E:出行车次']);
  const cell = table.columns[4].cells[0];
  assert.equal(TEXT.slice(cell.start, cell.end), 'D8104');
});

test('按列分组：每列的处数、不同值、来源；表格以外单独列出', () => {
  const findings = analyzeText(TEXT).findings.map((item) => ({ ...item, enabled: true }));
  const grouped = groupByColumn(buildTableModel(TEXT), findings);
  const columns = grouped.sheets[0].columns;
  const issuer = columns.find((column) => column.header === '开票人');
  assert.equal(issuer.count, 3);
  assert.deepEqual(issuer.values.map((value) => [value.value, value.count]), [['赵小青', 2], ['孙不二', 1]]);
  assert.ok(issuer.sources.includes('按表头'));
  const trains = columns.find((column) => column.header === '出行车次');
  assert.equal(trains.count, 0);
  assert.ok(grouped.outsideCount >= 2);
});

test('整列隐藏：为每个非空格子生成手动候选，识别后覆盖整列', () => {
  const model = buildTableModel(TEXT);
  const locate = createColumnLocator(model);
  const trainsKey = model.tables[0].columns[4];
  const key = locate(trainsKey.cells[0].start);
  const column = findColumn(model, key);
  const extra = wholeColumnFindings(column, 'custom');
  assert.equal(extra.length, 3);
  const result = analyzeText(TEXT, { externalFindings: extra });
  const hidden = result.findings.filter((item) => item.hint?.startsWith('整列隐藏'));
  assert.deepEqual(hidden.map((item) => item.value), ['D8104', 'G2976', 'D3852']);
  assert.ok(!result.redactedText.includes('D8104'));
});

test('逐条分组：按类型再按值合并', () => {
  const findings = analyzeText(TEXT).findings.map((item) => ({ ...item, enabled: true }));
  const types = groupByType(findings, { person: '姓名' });
  const persons = types.find((group) => group.type === 'person');
  assert.equal(persons.label, '姓名');
  const money = persons.values.find((value) => value.value === '钱多多');
  assert.equal(money.count, 3);
});

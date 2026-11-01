import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';

const LEDGER = [
  '科目编码\t科目名称\t币别\t期初借方\t期初贷方',
  '2241.055.01\t赵一鸣\t人民币\t0.00\t52,500.00',
  '2241.055.02\t钱二多\t人民币\t0.00\t52,500.00',
  '2241.055.03\t孙小三\t人民币\t0.00\t262,500.00',
  '2241.055.04\t李四\t人民币\t0.00\t52,500.00',
  '2241.060\t示例果业开发有限公司\t人民币\t34,893.00\t0.00',
  '2241.062\t示例置业\t人民币\t0.00\t4,000,000.00',
  '6602.01\t管理费用\t人民币\t0.00\t0.00',
  '2202.01\t应付账款\t人民币\t0.00\t0.00',
  '5401.02\t费用化支出\t人民币\t0.00\t0.00',
  '1002.01\t银行存款\t人民币\t0.00\t0.00',
  '6601.03\t工资\t人民币\t0.00\t0.00'
].join('\n');

const of = (result, type) => result.findings.filter((item) => item.type === type);

test('科目余额表：表头“科目名称”认不出时，按内容推断出列里的人名', () => {
  const result = analyzeText(LEDGER);
  const persons = of(result, 'person').map((item) => item.value);
  assert.deepEqual(persons, ['赵一鸣', '钱二多', '孙小三', '李四']);
  assert.match(of(result, 'person')[0].hint, /按内容推断：科目名称/);
});

test('科目、费用类词语不会被当成人名', () => {
  const persons = of(analyzeText(LEDGER), 'person').map((item) => item.value);
  for (const word of ['管理费用', '应付账款', '费用化支出', '银行存款', '工资']) assert.ok(!persons.includes(word), word);
});

test('同一列里不带“公司”后缀的单位名称也列出并标为需核对', () => {
  const companies = of(analyzeText(LEDGER), 'company');
  const placeholder = companies.find((item) => item.value === '示例置业');
  assert.ok(placeholder);
  assert.equal(placeholder.reviewRequired, true);
  assert.ok(companies.some((item) => item.value === '示例果业开发有限公司'));
});

test('人名少于 3 个或占比太低的列不做推断', () => {
  const text = ['编码\t名称', '1\t管理费用', '2\t应付账款', '3\t王五', '4\t银行存款', '5\t其他应收款', '6\t固定资产', '7\t无形资产', '8\t短期借款', '9\t实收资本'].join('\n');
  assert.equal(of(analyzeText(text), 'person').length, 0);
});

test('混合列（人名占比不到六成）中的人名标为需核对', () => {
  const rows = ['编码\t名称'];
  ['张一', '王二', '刘三'].forEach((name, index) => rows.push(`${index}\t${name}`));
  ['管理费用', '应付账款', '银行存款', '固定资产'].forEach((word, index) => rows.push(`${index + 10}\t${word}`));
  const persons = of(analyzeText(rows.join('\n')), 'person');
  assert.equal(persons.length, 3);
  assert.ok(persons.every((item) => item.reviewRequired));
});

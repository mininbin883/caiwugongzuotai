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

const HIERARCHY = [
  '科目代码\t科目名称\t币别\t期初借方余额\t期初贷方余额',
  '1001\t库存现金\t人民币\t27,862.91\t0.00',
  '1122\t应收账款\t人民币\t0.00\t0.00',
  '1122.001\t示例交通局\t人民币\t0.00\t0.00',
  '1122.009\t示例投资公司.2号3号桥\t人民币\t0.00\t0.00',
  '1122.020\t青禾绿化\t人民币\t0.00\t0.00',
  '1123\t预付账款\t人民币\t0.00\t0.00',
  '1123.002\t利昌路\t人民币\t0.00\t0.00',
  '1123.002.001\t曹一民\t人民币\t0.00\t0.00',
  '1221\t其他应收款\t人民币\t0.00\t0.00',
  '1221.001\t杜一国\t人民币\t0.00\t0.00',
  '1221.010\t吴二华保证金\t人民币\t0.00\t0.00',
  '1221.013\t郎三考核\t人民币\t0.00\t0.00',
  '1221.112\t夏七个人借款\t人民币\t0.00\t0.00',
  '1221.014\t牛四桂（禁用）\t人民币\t0.00\t0.00',
  '1221.015\t王五镇\t人民币\t0.00\t0.00',
  '1221.016\t车队\t人民币\t0.00\t0.00',
  '1221.017\t拌合站\t人民币\t0.00\t0.00',
  '1403\t原材料\t人民币\t0.00\t0.00',
  '1403.02.001\t石粉\t人民币\t0.00\t0.00',
  '1403.02.002\t石灰\t人民币\t0.00\t0.00',
  '4001\t实收资本\t人民币\t0.00\t0.00',
  '4001.02\t职工持股\t人民币\t0.00\t0.00',
  '4001.02.001\t高六函\t人民币\t0.00\t0.00',
  '6602\t管理费用\t人民币\t0.00\t0.00',
  '6602.01\t差旅费\t人民币\t0.00\t0.00'
].join('\n');

test('科目余额表：往来科目下各级明细中的人名（含后缀、括号写法）都能识别', () => {
  const result = analyzeText(HIERARCHY);
  const persons = of(result, 'person').map((item) => item.value);
  for (const name of ['夏七', '曹一民', '杜一国', '吴二华', '郎三', '牛四桂', '王五镇', '高六函']) assert.ok(persons.includes(name), name);
  assert.equal(result.findings.find((item) => item.value === '杜一国').hint, '往来明细：其他应收款');
  assert.equal(result.findings.find((item) => item.value === '王五镇').reviewRequired, true);
});

test('科目余额表：项目名、材料、车队等不当作人名；单位与简称列出', () => {
  const result = analyzeText(HIERARCHY);
  const persons = of(result, 'person').map((item) => item.value);
  for (const word of ['利昌路', '车队', '拌合站', '石粉', '石灰', '差旅费', '职工持股']) assert.ok(!persons.includes(word), word);
  const companies = of(result, 'company').map((item) => item.value);
  assert.ok(companies.includes('示例投资公司'));
  assert.ok(companies.includes('示例交通局'));
  assert.ok(companies.includes('青禾绿化'));
});

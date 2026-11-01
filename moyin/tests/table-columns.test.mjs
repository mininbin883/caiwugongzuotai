import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';

const SHEET = [
  '【工作表：发票汇总】',
  '序号\t数电发票号码\t销方名称\t购买方名称\t单位\t数量\t单价\t税收分类编码\t开票人\t备注',
  '1\t25000000000000000001\t示例区东湖小吃店（个体工商户）\t示例市星河工程有限公司\t千克(公斤)\t27\t7.8831124702684\t1060512040000000000\t赵小青\t收款人:钱多多 复核人:孙不二',
  '2\t25000000000000000002\t示例区南街加油站\t示例市星河工程有限公司\t项\t1\t100\t3040602990000000000\tfB000007(周一鸣)\t收款人:微信 复核人:微信',
  '3\t25000000000000000003\t示例区北站茶行\t示例市星河工程有限公司\t\t\t\t3070401000000000000\t系统\t'
].join('\n');

const values = (result, type) => result.findings.filter((item) => item.type === type).map((item) => item.value);

test('按表头识别人名列：开票人一列的名字，以及“工号(姓名)”写法', () => {
  const result = analyzeText(SHEET);
  const persons = values(result, 'person');
  assert.ok(persons.includes('赵小青'));
  assert.ok(persons.includes('周一鸣'));
  assert.ok(!persons.includes('系统'));
  assert.equal(result.findings.find((item) => item.value === '赵小青').hint, '表格列：开票人');
});

test('备注里的 收款人/复核人 标签可以识别，“微信”这类付款方式不当作人名', () => {
  const persons = values(analyzeText(SHEET), 'person');
  assert.ok(persons.includes('钱多多'));
  assert.ok(persons.includes('孙不二'));
  assert.ok(!persons.includes('微信'));
});

test('按表头识别单位名称列：没有“公司”后缀的个体户、加油站也能认出', () => {
  const companies = values(analyzeText(SHEET), 'company');
  assert.ok(companies.includes('示例区东湖小吃店（个体工商户）'));
  assert.ok(companies.includes('示例区南街加油站'));
  assert.ok(companies.includes('示例区北站茶行'));
  // “单位”列是计量单位，不是单位名称
  assert.ok(!companies.includes('千克(公斤)'));
});

test('税收分类编码、单价中的长数字不再被当成电话、手机号或银行卡号', () => {
  const result = analyzeText(SHEET);
  assert.deepEqual(values(result, 'landline'), []);
  assert.deepEqual(values(result, 'mobile'), []);
  assert.deepEqual(values(result, 'bankcard'), []);
});

test('固定电话：带区号直接识别；不带区号需要前文有“电话/传真”', () => {
  assert.deepEqual(values(analyzeText('办公室 0536-8586669'), 'landline'), ['0536-8586669']);
  assert.deepEqual(values(analyzeText('电话：8586669'), 'landline'), ['8586669']);
  assert.deepEqual(values(analyzeText('金额 8586669 元'), 'landline'), []);
});

test('首字不是常见姓氏的表格人名标为需核对', () => {
  const result = analyzeText('姓名\t部门\n财务部\t综合\n张三\t综合');
  const rows = result.findings.filter((item) => item.type === 'person');
  assert.deepEqual(rows.map((item) => [item.value, item.reviewRequired]), [['财务部', true], ['张三', false]]);
});

test('可以关闭表格列识别', () => {
  assert.deepEqual(values(analyzeText(SHEET, { tableColumns: false }), 'person').includes('赵小青'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPE_LABELS, analyzeText, applyFindings, validators } from '../src/core/redaction-engine.mjs';

test('识别并遮罩常见敏感信息', () => {
  const input = '联系人张三，手机13812345678，邮箱 alice@example.com，身份证11010519491231002X。';
  const result = analyzeText(input, { customTerms: ['张三'] });
  assert.deepEqual(result.findings.map((item) => item.type), ['person', 'mobile', 'email', 'idcard']);
  assert.equal(result.redactedText, '联系人张*，手机138****5678，邮箱 a***@example.com，身份证110***********002X。');
});

test('识别中文公司、姓名、统一社会信用代码与地址', () => {
  const input = '甲方：北京星河科技有限公司；联系人：张三；统一社会信用代码：91310000677833266F；地址：北京市朝阳区建国路88号。';
  const result = analyzeText(input, { style: 'label' });
  assert.deepEqual(result.findings.map((item) => item.type), ['company', 'person', 'uscc', 'address']);
  assert.equal(result.redactedText, '甲方：[公司名称]；联系人：[姓名]；统一社会信用代码：[统一社会信用代码]；地址：[地址]。');
});

test('类型化隐藏词覆盖规则盲区，总是保留词阻止替换', () => {
  const input = '供应商：星环数据；联系人：李四；内部项目朱雀计划。';
  const result = analyzeText(input, {
    style: 'label',
    typedTerms: { company: ['星环数据'], custom: ['朱雀计划'] },
    alwaysKeepTerms: ['李四']
  });
  assert.deepEqual(result.findings.map((item) => [item.type, item.value]), [['company', '星环数据'], ['custom', '朱雀计划']]);
  assert.equal(result.protectedCount, 1);
  assert.equal(result.redactedText, '供应商：[公司名称]；联系人：李四；内部项目[自定义词]。');
});

test('禁用语义类型后不产生对应命中', () => {
  const enabledTypes = Object.keys(TYPE_LABELS).filter((type) => !['company', 'person', 'uscc', 'address'].includes(type));
  const result = analyzeText('公司：北京星河科技有限公司；联系人：张三；代码91310000677833266F；地址：北京市朝阳区建国路88号。', { enabledTypes });
  assert.equal(result.findings.length, 0);
});

test('表头和字段名不会被误识别为姓名或地址', () => {
  const result = analyzeText('【工作表：客户清单】\n编号\t姓名\t手机号\n项目地址\n192.***.***.***');
  assert.deepEqual(result.findings, []);
});

test('标签模式生成可审计替换', () => {
  const input = '请联系13812345678或alice@example.com';
  const result = analyzeText(input, { style: 'label' });
  assert.equal(result.redactedText, '请联系[手机号]或[电子邮箱]');
});

test('单项取消后保留原值', () => {
  const input = '手机13812345678，邮箱alice@example.com';
  const result = analyzeText(input);
  result.findings.find((item) => item.type === 'mobile').enabled = false;
  assert.equal(applyFindings(input, result.findings), '手机13812345678，邮箱a***@example.com');
});

test('身份证校验位与日期必须有效', () => {
  assert.equal(validators.idCardValid('11010519491231002X'), true);
  assert.equal(validators.idCardValid('11010519491331002X'), false);
  assert.equal(validators.idCardValid('110105194912310021'), false);
});

test('银行卡只接受 Luhn 有效号码', () => {
  assert.equal(validators.luhnValid('4532015112830366'), true);
  assert.equal(validators.luhnValid('4532015112830367'), false);
  const result = analyzeText('卡号4532 0151 1283 0366，随机1234 5678 9012 3456');
  assert.equal(result.findings.filter((item) => item.type === 'bankcard').length, 1);
});

test('统一社会信用代码必须通过校验位', () => {
  assert.equal(validators.usccValid('91310000677833266F'), true);
  assert.equal(validators.usccValid('91310000677833266A'), false);
  const result = analyzeText('有效91310000677833266F，无效91310000677833266A');
  assert.deepEqual(result.findings.filter((item) => item.type === 'uscc').map((item) => item.value), ['91310000677833266F']);
});

test('重叠号码仅保留高优先级结果', () => {
  const result = analyzeText('11010519491231002X');
  assert.deepEqual(result.findings.map((item) => item.type), ['idcard']);
});

test('ONNX 外部实体与规则合并并保留置信度复核状态', () => {
  const input = '王伟前往上海分部';
  const result = analyzeText(input, {
    style: 'label',
    externalFindings: [
      { type: 'person', start: 0, end: 2, confidence: 0.93, source: 'onnx', enabled: true },
      { type: 'address', start: 4, end: 6, confidence: 0.66, source: 'onnx', enabled: false, reviewRequired: true }
    ]
  });
  assert.equal(result.modelCount, 2);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.findings[0].source, 'onnx');
  assert.equal(result.findings[0].confidence, 0.93);
  assert.equal(result.findings[1].reviewRequired, true);
  assert.equal(result.findings[1].enabled, false);
  assert.equal(result.redactedText, '[姓名]前往上海分部');
});

test('规则命中优先于重叠模型实体，保留词同时约束模型结果', () => {
  const input = '联系人：张三；审核人：李四';
  const result = analyzeText(input, {
    alwaysKeepTerms: ['李四'],
    externalFindings: [
      { type: 'person', start: 4, end: 6, confidence: 0.99, source: 'onnx', enabled: true },
      { type: 'person', start: 11, end: 13, confidence: 0.99, source: 'onnx', enabled: true }
    ]
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].value, '张三');
  assert.equal(result.findings[0].source, 'rule');
  assert.equal(result.protectedCount, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';
import { auditBeforeExport, auditItemToFinding } from '../src/core/export-audit.mjs';

test('通过校验位但未隐藏的身份证号、银行卡号会被列出且只露前后四位', () => {
  const text = '身份证11010519491231002X，卡号：6222 0212 3456 7890 128。';
  const audit = auditBeforeExport(text, []);
  assert.deepEqual(audit.items.map((item) => [item.kind, item.masked]), [
    ['idcard', '1101**********002X'],
    ['bankcard', '6222***********0128']
  ]);
  assert.equal(audit.summary, '还有 1 个身份证号、1 个银行卡号没有隐藏');
});

test('已隐藏的号码不提示；取消勾选与关闭类型分别说明原因', () => {
  const text = '身份证11010519491231002X';
  const analysis = analyzeText(text);
  assert.equal(auditBeforeExport(text, analysis.findings).total, 0);
  const unchecked = analysis.findings.map((item) => ({ ...item, enabled: false }));
  assert.equal(auditBeforeExport(text, unchecked).items[0].reason, 'unchecked');
  assert.equal(auditBeforeExport(text, [], { enabledTypes: ['person'] }).items[0].reason, 'type-disabled');
});

test('校验位不成立或缺少卡号语境的数字不提示', () => {
  assert.equal(auditBeforeExport('订单号 110105194912310021，流水 4111111111111111').total, 0);
  assert.equal(auditBeforeExport('卡号 4111111111111111').total, 1);
});

test('已隐藏值在别处的未隐藏副本会被列出，并可转成候选', () => {
  const text = '客户：赵敏。赵敏，请回电。';
  const findings = [{ type: 'person', value: '赵敏', start: 3, end: 5, enabled: true }];
  const audit = auditBeforeExport(text, findings);
  assert.equal(audit.counts['same-value'], 1);
  const finding = auditItemToFinding(text, audit.items[0], '姓名');
  assert.deepEqual([finding.value, finding.start, finding.end], ['赵敏', 6, 8]);
  // 两字值紧挨其他汉字时不提示
  assert.equal(auditBeforeExport('客户：赵敏。赵敏华到场。', findings).total, 0);
});

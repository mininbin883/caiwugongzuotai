import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';

const manual = (text, value, type = 'custom', from = 0) => {
  const start = text.indexOf(value, from);
  return { type, start, end: start + value.length, confidence: 1, source: 'manual' };
};

test('手动补选规则认不出的文字', () => {
  const text = '本项目代号青鸾，由星环负责。';
  const result = analyzeText(text, { externalFindings: [manual(text, '青鸾'), manual(text, '星环', 'company')] });
  assert.deepEqual(result.findings.map((item) => [item.type, item.value, item.source, item.hint]), [
    ['custom', '青鸾', 'manual', '手动补选'],
    ['company', '星环', 'manual', '手动补选']
  ]);
  assert.equal(result.redactedText.includes('青鸾'), false);
});

test('手动补选覆盖与之重叠的自动识别结果（例如把识别过短的公司名补全）', () => {
  const text = '甲方：北京星河科技有限公司深圳分公司。';
  const auto = analyzeText(text).findings.find((item) => item.type === 'company');
  assert.ok(auto);
  const result = analyzeText(text, { externalFindings: [manual(text, '北京星河科技有限公司深圳分公司', 'company')] });
  const companies = result.findings.filter((item) => item.type === 'company');
  assert.deepEqual(companies.map((item) => [item.value, item.source]), [['北京星河科技有限公司深圳分公司', 'manual']]);
});

test('该类自动识别关闭、或词在“总是保留”里时，手动补选仍然生效', () => {
  const text = '联系人：张三。';
  const external = [manual(text, '张三', 'person')];
  assert.equal(analyzeText(text, { enabledTypes: ['mobile'], externalFindings: external }).findings.length, 1);
  assert.equal(analyzeText(text, { alwaysKeepTerms: ['张三'], externalFindings: external }).findings.length, 1);
  assert.equal(analyzeText(text, { alwaysKeepTerms: ['张三'] }).findings.length, 0);
});

test('只隐藏这一处：同一个词的其他位置不受影响', () => {
  const text = '青鸾计划。青鸾计划。';
  const result = analyzeText(text, { externalFindings: [manual(text, '青鸾计划', 'custom', 5)] });
  assert.deepEqual(result.findings.map((item) => item.start), [5]);
});

test('全文隐藏：写入类型化隐藏词后所有位置都隐藏', () => {
  const text = '青鸾计划。青鸾计划。';
  const result = analyzeText(text, { typedTerms: { custom: ['青鸾计划'] } });
  assert.deepEqual(result.findings.map((item) => item.start), [0, 5]);
});

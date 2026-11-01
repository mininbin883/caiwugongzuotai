import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as engine from '../src/core/redaction-engine.mjs';
import * as reversible from '../src/core/reversible-token-engine.mjs';

const require = createRequire(import.meta.url);
const { prepareReversibleBatch, batchAiPrompt } = require('../src/services/batch-reversible-service.cjs');

const jobs = [
  { id: 'a', result: { name: '星河工程有限公司2023年科目余额表.xlsx', text: '科目代码\t科目名称\t余额\n1001\t库存现金\t100\n1221\t其他应收款\t0\n1221.001\t赵一鸣\t5000\n1221.002\t钱二多\t300\n2202\t应付账款\t0\n2202.001\t示例材料有限公司\t1000' } },
  { id: 'b', result: { name: '星河工程有限公司2024年序时账.xlsx', text: '凭证\t摘要\t金额\n记-1\t支付示例材料有限公司货款\t1000\n记-2\t联系人：赵一鸣 报销差旅费\t500' } }
];

test('整批共用一套代号：同一对象在不同文件里是同一个代号', () => {
  const batch = prepareReversibleBatch(jobs, {}, engine, reversible);
  const token = (value) => batch.mapping.find((entry) => entry.value === value)?.token;
  assert.ok(token('示例材料有限公司'));
  assert.ok(token('赵一鸣'));
  const first = batch.prepared.get('a').redactedText;
  const second = batch.prepared.get('b').redactedText;
  for (const value of ['示例材料有限公司', '赵一鸣']) {
    assert.ok(first.includes(token(value)), `${value} 在文件 1`);
    assert.ok(second.includes(token(value)), `${value} 在文件 2`);
    assert.ok(!first.includes(value) && !second.includes(value));
  }
});

test('文件名中的公司名换成同一批代号，合并文本按文件分节', () => {
  const batch = prepareReversibleBatch(jobs, {}, engine, reversible);
  for (const job of batch.safeJobs) assert.ok(!job.result.name.includes('星河工程有限公司'), job.result.name);
  assert.match(batch.safeJobs[0].result.name, /^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]2023年科目余额表\.xlsx$/u);
  assert.match(batch.text, /【文件 1\/2：/u);
  assert.match(batch.text, /【文件 2\/2：/u);
});

test('一份引用多个文件代号的报告，用批次对照表一次换回', () => {
  const batch = prepareReversibleBatch(jobs, {}, engine, reversible);
  const token = (value) => batch.mapping.find((entry) => entry.value === value).token;
  const report = `批次 MI-000123：${token('赵一鸣')} 在两年间与 ${token('示例材料有限公司')} 有往来，${token('钱二多')} 余额较小。`;
  const restored = reversible.restoreTokens(report, batch.mapping, { mode: 'analysis' });
  assert.equal(restored.restoredText, '批次 MI-000123：赵一鸣 在两年间与 示例材料有限公司 有往来，钱二多 余额较小。');
  assert.equal(restored.requiresReview, false);
});

test('批次版“给 AI 的要求”说明编号与跨文件一致性，不含真实值', () => {
  const batch = prepareReversibleBatch(jobs, {}, engine, reversible);
  const prompt = batchAiPrompt('MI-000123', 2, batch.mapping);
  assert.match(prompt, /批次编号「MI-000123」/u);
  assert.match(prompt, /同一个代号在这批所有文件里都指同一个对象/u);
  for (const entry of batch.mapping) assert.equal(prompt.includes(entry.value), false, entry.value);
});

test('批处理沿用保护设置：关闭的类型不识别', () => {
  const batch = prepareReversibleBatch(jobs, { enabledTypes: ['company'] }, engine, reversible);
  assert.ok(batch.mapping.every((entry) => entry.type === 'company'));
});

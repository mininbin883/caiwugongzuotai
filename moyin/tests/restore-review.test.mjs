import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';
import { tokenizeFindings } from '../src/core/reversible-token-engine.mjs';
import { parseChineseNumber, reviewRestoration, summarizeReview } from '../src/core/restore-review.mjs';

const SOURCE = '甲方：北京星河科技有限公司。乙方：上海云帆数据有限公司。北京星河科技有限公司应于2026年3月1日前向上海云帆数据有限公司支付人民币100万元。联系人：张伟，电话13812345678。逾期未付款的，按每日0.05%支付违约金。';

function prepare() {
  const analysis = analyzeText(SOURCE);
  return tokenizeFindings(SOURCE, analysis.findings, { nonce: 'ABCDEF12' });
}

test('原样返回时核对通过', () => {
  const tokenized = prepare();
  const review = reviewRestoration({ sentText: tokenized.tokenizedText, returnedText: tokenized.tokenizedText, mapping: tokenized.mapping });
  assert.equal(review.requiresReview, false);
  assert.equal(review.stats.unchanged, review.stats.sourceSentences);
  assert.equal(summarizeReview(review), '');
});

test('金额换算写法相同不算变化；日期、角色顺序、否定词变化会被列出', () => {
  const tokenized = prepare();
  const [a, b] = tokenized.mapping;
  const returned = tokenized.tokenizedText
    .replace(`${a.token}应于2026年3月1日前向${b.token}支付人民币100万元`, `${b.token}应于2026年4月1日前向${a.token}支付人民币1,000,000元`)
    .replace('逾期未付款的', '逾期付款的');
  const review = reviewRestoration({ sentText: tokenized.tokenizedText, returnedText: returned, mapping: tokenized.mapping });
  assert.equal(review.requiresReview, true);
  const kinds = review.changes.flatMap((change) => change.diffs.map((diff) => diff.kind));
  assert.ok(kinds.includes('date'));
  assert.ok(kinds.includes('role-order'));
  assert.ok(kinds.includes('negation'));
  assert.ok(!kinds.includes('amount'));
});

test('金额被改动会被列出', () => {
  const tokenized = prepare();
  const returned = tokenized.tokenizedText.replace('100万元', '120万元');
  const review = reviewRestoration({ sentText: tokenized.tokenizedText, returnedText: returned, mapping: tokenized.mapping });
  const amount = review.changes.flatMap((change) => change.diffs).find((diff) => diff.kind === 'amount');
  assert.deepEqual([amount.before, amount.after], [['CNY:1000000'], ['CNY:1200000']]);
});

test('AI 直接写出原文（含号码加空格的写法）与新写内容、残缺代号', () => {
  const tokenized = prepare();
  const returned = `${tokenized.tokenizedText}\n总结：请联系 138 1234 5678 跟进北京星河科技有限公司的付款。MI_ABCDEF12_003 需要确认。`;
  const review = reviewRestoration({ sentText: tokenized.tokenizedText, returnedText: returned, mapping: tokenized.mapping });
  const leaked = review.leakedOriginals.map((item) => item.value).sort();
  assert.deepEqual(leaked, ['13812345678', '北京星河科技有限公司']);
  assert.equal(review.newContent.length >= 1, true);
  assert.equal(review.damagedTokens.length, 1);
  assert.equal(review.damagedTokens[0].suggestion, '[MI_ABCDEF12_003]');
});

test('发出的副本里本来就露着的原文不算 AI 写出', () => {
  const sent = '[MI_ABCDEF12_001] 与张伟会面。';
  const mapping = [{ token: '[MI_ABCDEF12_001]', value: '张伟', type: 'person', label: '姓名', occurrences: 1 }];
  const review = reviewRestoration({ sentText: sent, returnedText: sent, mapping });
  assert.equal(review.leakedOriginals.length, 0);
});

test('其他文件的代号单独列出', () => {
  const tokenized = prepare();
  const returned = `${tokenized.tokenizedText}另见[MI_11112222_001]。`;
  const review = reviewRestoration({ sentText: tokenized.tokenizedText, returnedText: returned, mapping: tokenized.mapping });
  assert.equal(review.foreignTokens.length, 1);
});

test('中文大写金额解析', () => {
  assert.equal(parseChineseNumber('壹佰万'), 1000000);
  assert.equal(parseChineseNumber('三千五百'), 3500);
  assert.equal(parseChineseNumber('十二'), 12);
});

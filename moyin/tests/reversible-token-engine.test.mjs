import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreTokens, tokenizeFindings } from '../src/core/reversible-token-engine.mjs';

test('opaque tokens preserve repeated relationships and restore exact source text', () => {
  const text = '甲方电话 13800138000，复核电话 13800138000，邮箱 a@example.com。';
  const first = text.indexOf('13800138000');
  const second = text.lastIndexOf('13800138000');
  const email = text.indexOf('a@example.com');
  const tokenized = tokenizeFindings(text, [
    { type: 'mobile', label: '手机号', start: first, end: first + 11, enabled: true },
    { type: 'mobile', label: '手机号', start: second, end: second + 11, enabled: true },
    { type: 'email', label: '邮箱', start: email, end: email + 13, enabled: true }
  ], { nonce: 'A1B2C3D4' });
  assert.equal(tokenized.mapping.length, 2);
  assert.equal(tokenized.mapping[0].occurrences, 2);
  assert.equal(tokenized.tokenizedText.includes('13800138000'), false);
  assert.equal(tokenized.tokenizedText.split(tokenized.mapping[0].token).length - 1, 2);
  const restored = restoreTokens(tokenized.tokenizedText, tokenized.mapping, { mode: 'rewrite' });
  assert.equal(restored.restoredText, text);
  assert.equal(restored.restoredCount, 3);
  assert.equal(restored.complete, true);
});

test('analysis mode tolerates omitted known tokens while rewrite mode reports them', () => {
  const text = '电话 13800138000，邮箱 a@example.com';
  const mobile = text.indexOf('13800138000');
  const email = text.indexOf('a@example.com');
  const tokenized = tokenizeFindings(text, [
    { type: 'mobile', label: '手机号', start: mobile, end: mobile + 11 },
    { type: 'email', label: '邮箱', start: email, end: email + 13 }
  ], { nonce: '11223344' });
  const partial = `摘要仅保留 ${tokenized.mapping[0].token}`;
  assert.equal(restoreTokens(partial, tokenized.mapping, { mode: 'analysis' }).complete, true);
  const rewrite = restoreTokens(partial, tokenized.mapping, { mode: 'rewrite' });
  assert.equal(rewrite.complete, false);
  assert.equal(rewrite.missing.length, 1);
});

test('unknown token-like values are never silently accepted', () => {
  const result = restoreTokens('未知 [MI_DEADBEEF_999]', [], { mode: 'analysis' });
  assert.deepEqual(result.unknownTokens, ['[MI_DEADBEEF_999]']);
  assert.equal(result.requiresReview, true);
});

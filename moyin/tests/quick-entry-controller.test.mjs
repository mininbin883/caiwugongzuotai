import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASTED_TEXT_LIMIT_BYTES,
  QUICK_ENTRY_SCHEMA,
  autoVaultDecision,
  createPastedDocument
} from '../src/core/quick-entry-controller.mjs';

test('phase27 quick-entry schema is stable', () => {
  assert.equal(QUICK_ENTRY_SCHEMA, 'VEILFORGE_QUICK_ENTRY_V1');
  assert.equal(PASTED_TEXT_LIMIT_BYTES, 100 * 1024 * 1024);
});

test('pasted text preserves content and measures UTF-8 bytes', () => {
  const result = createPastedDocument('张三\r\nAlice', '临时/说明');
  assert.equal(result.text, '张三\r\nAlice');
  assert.equal(result.characters, 9);
  assert.equal(result.sourceBytes, new TextEncoder().encode(result.text).byteLength);
  assert.equal(result.name, '临时 说明.txt');
  assert.equal(result.quickEntry, 'pasted-text');
});

test('pasted text removes a leading BOM but keeps all other whitespace', () => {
  const result = createPastedDocument('\uFEFF  第一行\n第二行  ', '备注.txt');
  assert.equal(result.text, '  第一行\n第二行  ');
  assert.equal(result.name, '备注.txt');
});

test('empty or invalid pasted content is rejected', () => {
  assert.throws(() => createPastedDocument(' \r\n '), /LOCAL_PASTED_TEXT_EMPTY/u);
  assert.throws(() => createPastedDocument(null), /LOCAL_PASTED_TEXT_INVALID/u);
});

test('automatic vault save requires a completed export and unlocked vault', () => {
  assert.deepEqual(autoVaultDecision({ enabled: true, vault: null, exportResult: { canceled: false }, sourceText: 'x' }), { shouldSave: false, reason: 'VAULT_LOCKED' });
  assert.deepEqual(autoVaultDecision({ enabled: true, vault: { token: 't' }, exportResult: { canceled: true }, sourceText: 'x' }), { shouldSave: false, reason: 'EXPORT_NOT_COMPLETED' });
  assert.deepEqual(autoVaultDecision({ enabled: true, vault: { token: 't' }, exportResult: { canceled: false }, sourceText: 'x' }), { shouldSave: true, reason: 'READY' });
});

test('automatic vault save stays opt-in and excludes restore sessions', () => {
  assert.equal(autoVaultDecision({ enabled: false }).reason, 'DISABLED');
  assert.equal(autoVaultDecision({ enabled: true, vault: { token: 't' }, exportResult: { canceled: false }, sourceText: 'x', restoreEntry: { id: 'r' } }).reason, 'RESTORE_SESSION');
});

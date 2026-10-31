import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VEILFORGE_BATCH_VAULT_V1, saveBatchRecordsToVault } = require('../src/services/batch-vault-service.cjs');

test('batch vault schema is stable', () => {
  assert.equal(VEILFORGE_BATCH_VAULT_V1, 'VEILFORGE_BATCH_VAULT_V1');
});

test('only completed export records are converted into encrypted-vault payloads', async () => {
  const received = [];
  const result = await saveBatchRecordsToVault([{
    id: 'job-1', sourceName: '客户.csv', vaultText: '姓名,电话\n张*,138****8000', findingCount: 2, findingTypes: ['person', 'phone']
  }], async (entry) => { received.push(entry); return { id: 'vault-1' }; });
  assert.deepEqual({ saved: result.saved, failed: result.failed }, { saved: 1, failed: 0 });
  assert.equal(received[0].kind, 'redacted-text');
  assert.equal(received[0].name, '客户.csv · 批量脱敏');
  assert.deepEqual(received[0].findingTypes, ['person', 'phone']);
});

test('batch vault reports per-record failures without discarding successful entries', async () => {
  const result = await saveBatchRecordsToVault([
    { id: 'empty', sourceName: '空.txt', vaultText: '' },
    { id: 'ok', sourceName: '完成.txt', vaultText: '已脱敏', findingCount: 1 }
  ], async () => ({ id: 'saved' }));
  assert.deepEqual({ requested: result.requested, saved: result.saved, failed: result.failed }, { requested: 2, saved: 1, failed: 1 });
  assert.equal(result.errors[0].error, 'LOCAL_BATCH_VAULT_TEXT_EMPTY');
});

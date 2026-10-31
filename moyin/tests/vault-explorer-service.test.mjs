import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VEILFORGE_VAULT_EXPLORER_V1, filterVaultEntries, normalizeVaultFilters, recordVaultActivity, sanitizeActivityHistory } = require('../src/services/vault-explorer-service.cjs');

const entries = [
  { id: 'a', fileNumber: 'MI-000001', name: '客户合同', kind: 'redacted-text', createdAt: '2026-10-31T01:00:00.000Z', audit: { findingTypes: ['person', 'phone'] } },
  { id: 'b', fileNumber: 'MI-000002', name: '研发映射', kind: 'reversible-map', createdAt: '2026-09-02T02:00:00.000Z', audit: { findingTypes: ['organization'] } },
  { id: 'c', fileNumber: 'MI-000003', name: '地址清单', kind: 'redacted-text', createdAt: '2026-10-20T03:00:00.000Z', audit: { findingTypes: ['address'] } }
];

test('vault explorer schema and defaults are stable', () => {
  assert.equal(VEILFORGE_VAULT_EXPLORER_V1, 'VEILFORGE_VAULT_EXPLORER_V1');
  assert.deepEqual(normalizeVaultFilters(), { query: '', kind: 'all', dateFrom: '', dateTo: '' });
});

test('vault entries filter by name, file number and finding type', () => {
  assert.deepEqual(filterVaultEntries(entries, { query: '合同' }).entries.map((item) => item.id), ['a']);
  assert.deepEqual(filterVaultEntries(entries, { query: 'MI-000002' }).entries.map((item) => item.id), ['b']);
  assert.deepEqual(filterVaultEntries(entries, { query: 'address' }).entries.map((item) => item.id), ['c']);
});

test('vault entries combine kind and inclusive UTC date filters', () => {
  const value = filterVaultEntries(entries, { kind: 'redacted-text', dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  assert.deepEqual(value.entries.map((item) => item.id), ['a', 'c']);
});

test('invalid kind and reversed date range are rejected', () => {
  assert.throws(() => normalizeVaultFilters({ kind: 'binary' }), /LOCAL_VAULT_FILTER_KIND_INVALID/u);
  assert.throws(() => normalizeVaultFilters({ dateFrom: '2026-11-01', dateTo: '2026-10-01' }), /LOCAL_VAULT_FILTER_DATE_RANGE_INVALID/u);
});

test('backup activity is newest-first, bounded and contains operation results', () => {
  let history = [];
  for (let index = 0; index < 25; index += 1) {
    history = recordVaultActivity(history, { action: index % 2 ? 'import' : 'export', name: `backup-${index}`, entries: index, imported: index }, new Date(`2026-10-${String((index % 20) + 1).padStart(2, '0')}T00:00:00.000Z`));
  }
  assert.equal(history.length, 20);
  assert.equal(history[0].name, 'backup-24');
  assert.equal(history[0].action, 'export');
  assert.equal(history[1].imported, 23);
});

test('persistent activity strips directories, credentials and undeclared fields', () => {
  const history = recordVaultActivity([], {
    action: 'export', name: 'C:\\secret\\客户资料.miyin-backup', entries: 3,
    path: 'C:\\secret', password: 'never-store-this', sha256: 'c'.repeat(64)
  }, new Date('2026-10-31T08:00:00.000Z'));
  assert.equal(history[0].name, '客户资料.miyin-backup');
  assert.equal(history[0].sha256, 'C'.repeat(64));
  assert.equal(Object.hasOwn(history[0], 'path'), false);
  assert.equal(Object.hasOwn(history[0], 'password'), false);
  assert.deepEqual(sanitizeActivityHistory([{ ...history[0], password: 'injected' }]), []);
});

'use strict';

const path = require('node:path');

const VEILFORGE_VAULT_EXPLORER_V1 = 'VEILFORGE_VAULT_EXPLORER_V1';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ALLOWED_KINDS = new Set(['all', 'redacted-text', 'reversible-map']);
const MAX_QUERY_LENGTH = 120;
const MAX_ACTIVITY = 20;
const FORBIDDEN_ACTIVITY_FIELDS = new Set(['path', 'filePath', 'sourcePath', 'destinationPath', 'password', 'secret', 'token']);

function normalizeDate(value, field) {
  const date = String(value || '').trim();
  if (!date) return '';
  if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new Error(`LOCAL_VAULT_FILTER_${field}_INVALID`);
  }
  return date;
}

function normalizeVaultFilters(value = {}) {
  const query = String(value?.query || '').trim().slice(0, MAX_QUERY_LENGTH);
  const kind = String(value?.kind || 'all');
  if (!ALLOWED_KINDS.has(kind)) throw new Error('LOCAL_VAULT_FILTER_KIND_INVALID');
  const dateFrom = normalizeDate(value?.dateFrom, 'DATE_FROM');
  const dateTo = normalizeDate(value?.dateTo, 'DATE_TO');
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('LOCAL_VAULT_FILTER_DATE_RANGE_INVALID');
  return { query, kind, dateFrom, dateTo };
}

function filterVaultEntries(entries, value = {}) {
  const filters = normalizeVaultFilters(value);
  const needle = filters.query.toLocaleLowerCase('zh-CN');
  const from = filters.dateFrom ? Date.parse(`${filters.dateFrom}T00:00:00.000Z`) : Number.NEGATIVE_INFINITY;
  const to = filters.dateTo ? Date.parse(`${filters.dateTo}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
  const filtered = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (filters.kind !== 'all' && entry?.kind !== filters.kind) return false;
    const createdAt = Date.parse(String(entry?.createdAt || ''));
    if (!Number.isFinite(createdAt) || createdAt < from || createdAt > to) return false;
    if (!needle) return true;
    const haystack = [
      entry?.fileNumber,
      entry?.name,
      entry?.kind,
      ...(Array.isArray(entry?.audit?.findingTypes) ? entry.audit.findingTypes : [])
    ].map((item) => String(item || '')).join('\n').toLocaleLowerCase('zh-CN');
    return haystack.includes(needle);
  });
  return { filters, entries: filtered };
}

function sanitizeActivityName(value, fallback = '加密备份') {
  const normalized = String(value || '').replace(/\\/gu, '/');
  return path.basename(normalized).replace(/[\u0000-\u001f]/gu, '').slice(0, 240) || fallback;
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function sanitizeVaultActivity(event, now = new Date()) {
  const action = event?.action === 'import' ? 'import' : event?.action === 'export' ? 'export' : '';
  if (!action) throw new Error('LOCAL_VAULT_ACTIVITY_INVALID');
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : new Date(now).toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error('LOCAL_VAULT_ACTIVITY_INVALID');
  const name = sanitizeActivityName(event?.name, action === 'export' ? '加密备份' : '导入备份');
  const sha256 = String(event?.sha256 || '').toUpperCase();
  return {
    id: `${at}:${action}:${name.slice(0, 120)}`,
    action,
    at,
    name,
    entries: nonNegativeInteger(event?.entries),
    bytes: nonNegativeInteger(event?.bytes),
    sha256: /^[A-F0-9]{64}$/u.test(sha256) ? sha256 : '',
    imported: nonNegativeInteger(event?.imported),
    skipped: nonNegativeInteger(event?.skipped),
    renamed: nonNegativeInteger(event?.renamed)
  };
}

function sanitizeActivityHistory(history) {
  if (!Array.isArray(history)) return [];
  const unique = new Map();
  for (const value of history) {
    if (!value || typeof value !== 'object' || [...FORBIDDEN_ACTIVITY_FIELDS].some((field) => Object.hasOwn(value, field))) continue;
    try {
      const item = sanitizeVaultActivity(value, new Date(value.at));
      if (!unique.has(item.id)) unique.set(item.id, item);
    } catch {}
  }
  return [...unique.values()].slice(0, MAX_ACTIVITY);
}

function recordVaultActivity(history, event, now = new Date()) {
  return sanitizeActivityHistory([sanitizeVaultActivity(event, now), ...sanitizeActivityHistory(history)]);
}

function mergeVaultActivity(current, imported) {
  return sanitizeActivityHistory([...sanitizeActivityHistory(current), ...sanitizeActivityHistory(imported)]);
}

module.exports = {
  VEILFORGE_VAULT_EXPLORER_V1,
  MAX_ACTIVITY,
  sanitizeActivityName,
  sanitizeVaultActivity,
  sanitizeActivityHistory,
  mergeVaultActivity,
  normalizeVaultFilters,
  filterVaultEntries,
  recordVaultActivity
};

export const QUICK_ENTRY_SCHEMA = 'VEILFORGE_QUICK_ENTRY_V1';
export const PASTED_TEXT_LIMIT_BYTES = 100 * 1024 * 1024;

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function safeTextName(value) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80) || '粘贴文字';
  return normalized.toLowerCase().endsWith('.txt') ? normalized : `${normalized}.txt`;
}

export function createPastedDocument(text, name = '粘贴文字') {
  if (typeof text !== 'string') throw new Error('LOCAL_PASTED_TEXT_INVALID');
  const value = text.replace(/^\uFEFF/u, '');
  if (!value.trim()) throw new Error('LOCAL_PASTED_TEXT_EMPTY');
  const sourceBytes = utf8Bytes(value);
  if (sourceBytes > PASTED_TEXT_LIMIT_BYTES) throw new Error('LOCAL_PASTED_TEXT_TOO_LARGE');
  return Object.freeze({
    name: safeTextName(name),
    extension: '.txt',
    sourceBytes,
    characters: value.length,
    text: value,
    quickEntry: 'pasted-text'
  });
}

export function autoVaultDecision({ enabled, vault, exportResult, sourceText, restoreEntry } = {}) {
  if (!enabled) return Object.freeze({ shouldSave: false, reason: 'DISABLED' });
  if (!exportResult || exportResult.canceled) return Object.freeze({ shouldSave: false, reason: 'EXPORT_NOT_COMPLETED' });
  if (!vault?.token) return Object.freeze({ shouldSave: false, reason: 'VAULT_LOCKED' });
  if (!String(sourceText || '').length) return Object.freeze({ shouldSave: false, reason: 'EMPTY_SOURCE' });
  if (restoreEntry) return Object.freeze({ shouldSave: false, reason: 'RESTORE_SESSION' });
  return Object.freeze({ shouldSave: true, reason: 'READY' });
}

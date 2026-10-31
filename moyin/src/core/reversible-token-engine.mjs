const TOKEN_PATTERN = /^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]$/u;
const TOKEN_SCAN_PATTERN = /\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]/gu;

export function createTokenNonce() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function normalizedFindings(findings, textLength) {
  return (Array.isArray(findings) ? findings : [])
    .filter((finding) => finding?.enabled !== false && Number.isInteger(finding?.start) && Number.isInteger(finding?.end) &&
      finding.start >= 0 && finding.end > finding.start && finding.end <= textLength)
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

export function tokenizeFindings(text, findings, options = {}) {
  const source = String(text || '');
  const nonce = String(options.nonce || createTokenNonce()).toUpperCase();
  if (!/^[A-F0-9]{8}$/u.test(nonce)) throw new Error('REVERSIBLE_NONCE_INVALID');
  const active = normalizedFindings(findings, source.length);
  const mappingByKey = new Map();
  const mapping = [];
  const replacements = [];

  for (const finding of active) {
    const value = source.slice(finding.start, finding.end);
    const key = `${finding.type || 'custom'}\u0000${value}`;
    let entry = mappingByKey.get(key);
    if (!entry) {
      let token;
      do {
        token = `[MI_${nonce}_${(mapping.length + 1).toString(36).toUpperCase().padStart(3, '0')}]`;
      } while (source.includes(token));
      entry = {
        token,
        value,
        type: String(finding.type || 'custom'),
        label: String(finding.label || finding.type || '自定义'),
        occurrences: 0
      };
      mappingByKey.set(key, entry);
      mapping.push(entry);
    }
    entry.occurrences += 1;
    replacements.push({ start: finding.start, end: finding.end, token: entry.token });
  }

  let tokenizedText = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    tokenizedText = `${tokenizedText.slice(0, replacement.start)}${replacement.token}${tokenizedText.slice(replacement.end)}`;
  }
  return {
    nonce,
    tokenizedText,
    mapping,
    assignments: replacements.slice().sort((left, right) => left.start - right.start),
    occurrenceCount: replacements.length
  };
}

function countToken(text, token) {
  return text.split(token).length - 1;
}

export function restoreTokens(input, mapping, options = {}) {
  const source = String(input || '');
  const mode = options.mode === 'rewrite' ? 'rewrite' : 'analysis';
  const entries = Array.isArray(mapping) ? mapping : [];
  const known = new Set();
  const missing = [];
  const repeated = [];
  let restoredText = source;
  let restoredCount = 0;

  for (const entry of entries) {
    const token = String(entry?.token || '');
    const value = String(entry?.value ?? '');
    if (!TOKEN_PATTERN.test(token) || known.has(token)) throw new Error('REVERSIBLE_MAPPING_INVALID');
    known.add(token);
    const count = countToken(source, token);
    if (!count) missing.push({ token, type: String(entry.type || 'custom'), label: String(entry.label || entry.type || '自定义') });
    if (count > Number(entry.occurrences || 1)) repeated.push({ token, expected: Number(entry.occurrences || 1), actual: count });
    if (count) {
      restoredText = restoredText.split(token).join(value);
      restoredCount += count;
    }
  }

  const unknownTokens = [...new Set(source.match(TOKEN_SCAN_PATTERN) || [])].filter((token) => !known.has(token));
  const requiresReview = unknownTokens.length > 0 || (mode === 'rewrite' && missing.length > 0);
  return {
    mode,
    restoredText,
    restoredCount,
    missing,
    repeated,
    unknownTokens,
    requiresReview,
    complete: !requiresReview
  };
}

export const reversibleTokenFormat = Object.freeze({ pattern: TOKEN_PATTERN.source, prefix: '[MI_' });

import { restorePseudonyms } from './pseudonym-engine.mjs';
const TOKEN_PATTERN = /^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]$/u;
const TOKEN_SCAN_PATTERN = /\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]/gu;
export const COPY_NAME_PATTERN = /MI-\d{6}-\d{2,3}-([^\s\t\n|]+?)-脱敏副本(?=\.[A-Za-z0-9]{2,5}\b)/gu;

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
  let existingTokens = null;
  let serial = 0;
  const mapping = [];
  const replacements = [];

  for (const finding of active) {
    const value = source.slice(finding.start, finding.end);
    const key = `${finding.type || 'custom'}\u0000${value}`;
    let entry = mappingByKey.get(key);
    if (!entry) {
      let token;
      // 原文里已有的代号形字符串只扫描一次，避免每个映射都全文查找。
      existingTokens ||= new Set(source.match(TOKEN_SCAN_PATTERN) || []);
      // 原实现在冲突时会反复生成同一个代号而死循环；这里跳到下一个编号。
      do {
        serial += 1;
        token = `[MI_${nonce}_${serial.toString(36).toUpperCase().padStart(3, '0')}]`;
      } while (existingTokens.has(token));
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

  // 一次拼接；存在重叠时沿用逐个替换（起点靠后的先替换）。
  replacements.sort((left, right) => left.start - right.start || left.end - right.end);
  let tokenizedText;
  if (replacements.some((item, index) => index > 0 && item.start < replacements[index - 1].end)) {
    tokenizedText = source;
    for (const replacement of replacements.slice().reverse()) {
      tokenizedText = `${tokenizedText.slice(0, replacement.start)}${replacement.token}${tokenizedText.slice(replacement.end)}`;
    }
  } else {
    const parts = [];
    let cursor = 0;
    for (const replacement of replacements) {
      parts.push(source.slice(cursor, replacement.start), replacement.token);
      cursor = replacement.end;
    }
    parts.push(source.slice(cursor));
    tokenizedText = parts.join('');
  }
  return {
    nonce,
    tokenizedText,
    mapping,
    assignments: replacements.slice().sort((left, right) => left.start - right.start),
    occurrenceCount: replacements.length
  };
}

export function restoreTokens(input, mapping, options = {}) {
  const source = String(input || '');
  const mode = options.mode === 'rewrite' ? 'rewrite' : 'analysis';
  const entries = Array.isArray(mapping) ? mapping : [];
  const known = new Map();
  const missing = [];
  const repeated = [];

  // 单次扫描统计每个代号出现次数，再单次替换；不会把换回的原文再当作代号处理。
  const counts = new Map();
  for (const match of source.matchAll(TOKEN_SCAN_PATTERN)) counts.set(match[0], (counts.get(match[0]) || 0) + 1);

  let restoredCount = 0;
  // 税务筛查模式的假名（form: 'pseudonym'）按字面换回；方括号代号照原逻辑处理。
  const pseudonymEntries = entries.filter((entry) => entry?.form === 'pseudonym');
  for (const entry of entries) {
    if (entry?.form === 'pseudonym') continue;
    const token = String(entry?.token || '');
    const value = String(entry?.value ?? '');
    if (!TOKEN_PATTERN.test(token) || known.has(token)) throw new Error('REVERSIBLE_MAPPING_INVALID');
    known.set(token, value);
    const count = counts.get(token) || 0;
    if (!count) missing.push({ token, type: String(entry.type || 'custom'), label: String(entry.label || entry.type || '自定义') });
    if (count > Number(entry.occurrences || 1)) repeated.push({ token, expected: Number(entry.occurrences || 1), actual: count });
    restoredCount += count;
  }
  // 批次副本的文件名（MI-000200-01-名称-脱敏副本.xlsx）换回原文件名；名称里的代号、假名随后一并换回。
  let restoredText = source.replace(COPY_NAME_PATTERN, (_match, stem) => stem);
  restoredText = restoredText.replace(TOKEN_SCAN_PATTERN, (token) => (known.has(token) ? known.get(token) : token));
  if (pseudonymEntries.length) {
    const pseudo = restorePseudonyms(restoredText, pseudonymEntries);
    restoredText = pseudo.text;
    restoredCount += pseudo.count;
    for (const entry of pseudonymEntries) {
      if (!pseudo.counts.get(entry.token)) missing.push({ token: entry.token, type: String(entry.type || 'custom'), label: String(entry.label || entry.type || '自定义') });
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

/**
 * 批次共用的代号生成器：同一批文件中，同一类型、同一取值的信息始终得到同一个代号，
 * 让 AI 能把不同文件（不同年度、不同报表）里的同一对象对应起来。最后得到一份合并的对照表。
 */
export function createSharedTokenizer(options = {}) {
  const nonce = String(options.nonce || createTokenNonce()).toUpperCase();
  if (!/^[A-F0-9]{8}$/u.test(nonce)) throw new Error('REVERSIBLE_NONCE_INVALID');
  const byKey = new Map();
  const mapping = [];
  const reserved = new Set();
  let serial = 0;
  const nextToken = () => {
    let token;
    do {
      serial += 1;
      token = `[MI_${nonce}_${serial.toString(36).toUpperCase().padStart(3, '0')}]`;
    } while (reserved.has(token));
    return token;
  };
  return {
    nonce,
    tokenize(text, findings) {
      const source = String(text || '');
      for (const token of source.match(TOKEN_SCAN_PATTERN) || []) reserved.add(token);
      const active = normalizedFindings(findings, source.length);
      const assignments = [];
      for (const finding of active) {
        const value = source.slice(finding.start, finding.end);
        const key = `${finding.type || 'custom'}\u0000${value}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { token: nextToken(), value, type: String(finding.type || 'custom'), label: String(finding.label || finding.type || '自定义'), occurrences: 0 };
          byKey.set(key, entry);
          mapping.push(entry);
        }
        entry.occurrences += 1;
        assignments.push({ start: finding.start, end: finding.end, token: entry.token });
      }
      assignments.sort((left, right) => left.start - right.start || left.end - right.end);
      const parts = [];
      let cursor = 0;
      for (const item of assignments) {
        if (item.start < cursor) continue;
        parts.push(source.slice(cursor, item.start), item.token);
        cursor = item.end;
      }
      parts.push(source.slice(cursor));
      return { tokenizedText: parts.join(''), assignments };
    },
    mapping: () => mapping.map((entry) => ({ ...entry })),
    size: () => mapping.length
  };
}

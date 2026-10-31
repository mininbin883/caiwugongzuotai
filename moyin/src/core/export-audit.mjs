// 导出前的残留检查：不拦导出，只列出“通过校验位但没有隐藏”的号码，以及已隐藏值在别处的未隐藏副本。
import { validators } from './redaction-engine.mjs';
import { CoverageMask } from './secret-name-rules.mjs';

const BANK_CONTEXT = /(?:卡号|银行卡|信用卡|借记卡|储蓄卡|账号|帐号|账户|帐户|开户行|收款账|付款账|card)[^\n]{0,12}$/iu;

function maskDigits(value) {
  const compact = value.replace(/[\s-]/gu, '');
  if (compact.length <= 8) return `${compact.slice(0, 2)}****`;
  return `${compact.slice(0, 4)}${'*'.repeat(compact.length - 8)}${compact.slice(-4)}`;
}

function maskGeneric(value) {
  const chars = [...value];
  if (chars.length <= 2) return `${chars[0] || ''}*`;
  if (chars.length <= 6) return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars.at(-1)}`;
  return `${chars.slice(0, 2).join('')}${'*'.repeat(Math.min(8, chars.length - 4))}${chars.slice(-2).join('')}`;
}

function overlappingFinding(sortedFindings, start, end) {
  // sortedFindings 按起点排序；二分定位后向两侧少量检查。
  let low = 0;
  let high = sortedFindings.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sortedFindings[middle].start < end) low = middle + 1; else high = middle;
  }
  for (let index = low - 1; index >= 0 && index >= low - 64; index -= 1) {
    const finding = sortedFindings[index];
    if (finding.start < end && start < finding.end) return finding;
  }
  return null;
}

function reasonFor(finding, type, enabledTypes) {
  if (enabledTypes && !enabledTypes.has(type)) return 'type-disabled';
  if (finding && finding.enabled === false) return 'unchecked';
  return 'not-detected';
}

const REASON_LABELS = Object.freeze({
  'type-disabled': '该类识别已关闭',
  unchecked: '已取消勾选',
  'not-detected': '未被识别'
});

/**
 * @param {string} text 原文
 * @param {Array} findings 当前候选（含 enabled 状态）
 * @param {{ enabledTypes?: Iterable<string> }} options
 */
export function auditBeforeExport(input, findings = [], options = {}) {
  const text = String(input || '');
  const list = (Array.isArray(findings) ? findings : []).slice().sort((left, right) => left.start - right.start);
  const enabled = list.filter((finding) => finding.enabled !== false);
  const mask = new CoverageMask(text.length);
  for (const finding of enabled) mask.mark(finding.start, finding.end);
  const coveredBy = (_ranges, start, end) => mask.covers(start, end);
  const enabledTypes = options.enabledTypes ? new Set(options.enabledTypes) : null;
  const items = [];
  const push = (kind, type, start, end, masked, finding) => {
    const reason = reasonFor(finding, type, enabledTypes);
    items.push({ kind, type, start, end, masked, reason, reasonLabel: REASON_LABELS[reason], fixable: reason !== 'type-disabled' });
  };

  // 1. 校验位成立的身份证号。
  for (const match of text.matchAll(/(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!validators.idCardValid(match[0]) || coveredBy(enabled, start, end)) continue;
    push('idcard', 'idcard', start, end, maskDigits(match[0]), overlappingFinding(list, start, end));
  }

  // 2. Luhn 成立、且以 62 开头或前面写着卡号/账户的银行卡号；支持 4-4-4-4 分组。
  for (const match of text.matchAll(/(?<![0-9A-Za-z])\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?(?![0-9A-Za-z])/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    const compact = match[0].replace(/[ -]/gu, '');
    if (compact.length < 16 || compact.length > 19 || !validators.luhnValid(compact)) continue;
    if (validators.idCardValid(compact)) continue;
    if (!compact.startsWith('62') && !BANK_CONTEXT.test(text.slice(Math.max(0, start - 24), start))) continue;
    if (coveredBy(enabled, start, end)) continue;
    push('bankcard', 'bankcard', start, end, maskDigits(match[0]), overlappingFinding(list, start, end));
  }

  // 3. 已隐藏值在别处的未隐藏副本（任何类型）。按前两个字符建索引，单次扫描全文。
  const buckets = new Map();
  for (const finding of enabled) {
    const value = String(finding.value || '');
    if (value.length < 2 || value.includes('\n')) continue;
    const key = value.slice(0, 4);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    if (!bucket.some((item) => item.value === value)) bucket.push({ type: finding.type, value });
  }
  for (const bucket of buckets.values()) bucket.sort((left, right) => right.value.length - left.value.length);
  for (let index = 0; index < text.length - 1; index += 1) {
    // 值至少 2 个字符；按 4/3/2 字符前缀依次查找（长值优先）。
    const b4 = buckets.get(text.slice(index, index + 4));
    const b3 = buckets.get(text.slice(index, index + 3));
    const b2 = buckets.get(text.slice(index, index + 2));
    if (!b4 && !b3 && !b2) continue;
    const bucket = [...(b4 || []), ...(b3 || []), ...(b2 || [])];
    for (const { type, value } of bucket) {
      if (!text.startsWith(value, index)) continue;
      const end = index + value.length;
      if (mask.overlaps(index, end)) break;
      // 两个汉字的值紧挨其他汉字时多半是词的一部分，不提示；字母数字值不能是更长串的一部分。
      if (/^\p{Script=Han}{2}$/u.test(value) &&
          (/\p{Script=Han}/u.test(text[index - 1] || '') || /\p{Script=Han}/u.test(text[end] || ''))) continue;
      if (/^[A-Za-z0-9]/u.test(value) && /[A-Za-z0-9]/u.test(text[index - 1] || '')) continue;
      if (/[A-Za-z0-9]$/u.test(value) && /[A-Za-z0-9]/u.test(text[end] || '')) continue;
      items.push({
        kind: 'same-value', type, start: index, end,
        masked: type === 'idcard' || type === 'bankcard' ? maskDigits(value) : maskGeneric(value),
        reason: 'same-value', reasonLabel: '相同的值在此处没有隐藏', fixable: true
      });
      index = end - 1;
      break;
    }
  }

  items.sort((left, right) => left.start - right.start);
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start || item.end !== items[index - 1].end);
  const counts = {};
  for (const item of unique) counts[item.kind] = (counts[item.kind] || 0) + 1;
  return {
    items: unique,
    counts,
    total: unique.length,
    summary: unique.length ? summarize(counts) : ''
  };
}

function summarize(counts) {
  const parts = [];
  if (counts.idcard) parts.push(`${counts.idcard} 个身份证号`);
  if (counts.bankcard) parts.push(`${counts.bankcard} 个银行卡号`);
  if (counts['same-value']) parts.push(`${counts['same-value']} 处相同的值`);
  return `还有 ${parts.join('、')}没有隐藏`;
}

/** 把检查项转成可直接加入候选列表的发现（“隐藏这一处”）。 */
export function auditItemToFinding(text, item, label) {
  const value = String(text).slice(item.start, item.end);
  return {
    id: `${item.type}-${item.start}-${item.end}-audit`,
    type: item.type,
    value,
    start: item.start,
    end: item.end,
    label: label || item.type,
    source: 'audit',
    confidence: 1,
    reviewRequired: false,
    enabled: true
  };
}

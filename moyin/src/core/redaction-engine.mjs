import { collectSecrets, collectSpacedNames, collectRepeatedValues } from './secret-name-rules.mjs';

export const TYPE_LABELS = Object.freeze({
  company: '公司名称',
  person: '姓名',
  mobile: '手机号',
  landline: '固定电话',
  idcard: '身份证号',
  uscc: '统一社会信用代码',
  email: '电子邮箱',
  bankcard: '银行卡号',
  address: '地址',
  ipv4: 'IPv4 地址',
  secret: '密码/密钥',
  custom: '自定义词'
});

const DEFAULT_TYPES = Object.freeze(Object.keys(TYPE_LABELS));

function luhnValid(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 16 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function idCardValid(value) {
  if (!/^\d{17}[\dXx]$/.test(value)) return false;
  const region = Number(value.slice(0, 6));
  if (region < 110000 || region > 830000) return false;
  const year = Number(value.slice(6, 10));
  const month = Number(value.slice(10, 12));
  const day = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = '10X98765432';
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return checks[sum % 11] === value[17].toUpperCase();
}

function ipv4Valid(value) {
  return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255 && String(Number(part)) === part);
}

const USCC_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

function usccValid(value) {
  const normalized = String(value || '').toUpperCase();
  if (!/^[0-9ABCDEFGHJKLMNPQRTUWXY]{18}$/.test(normalized)) return false;
  const sum = USCC_WEIGHTS.reduce((total, weight, index) => total + USCC_ALPHABET.indexOf(normalized[index]) * weight, 0);
  return USCC_ALPHABET[(31 - (sum % 31)) % 31] === normalized[17];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskValue(type, value, style) {
  if (style === 'label') return `[${TYPE_LABELS[type]}]`;
  switch (type) {
    case 'company': return `${value.slice(0, 2)}${'*'.repeat(Math.max(3, value.length - 2))}`;
    case 'person': return `${value.slice(0, 1)}${'*'.repeat(Math.max(1, value.length - 1))}`;
    case 'mobile': {
      const prefix = value.match(/^\+?86[- ]?/)?.[0] || '';
      const local = value.slice(prefix.length);
      return `${prefix}${local.slice(0, 3)}****${local.slice(-4)}`;
    }
    case 'idcard': return `${value.slice(0, 3)}***********${value.slice(-4)}`;
    case 'uscc': return `${value.slice(0, 2)}************${value.slice(-4)}`;
    case 'email': {
      const [local, domain] = value.split('@');
      return `${local.slice(0, 1)}***@${domain}`;
    }
    case 'bankcard': {
      const digits = value.replace(/\D/g, '');
      return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
    }
    case 'ipv4': return value.split('.').map((part, index) => index === 0 ? part : '***').join('.');
    case 'secret': return '*'.repeat(Math.min(12, Math.max(6, value.length)));
    case 'landline': return `${value.slice(0, 4)}****${value.slice(-2)}`;
    case 'address': {
      const visiblePrefix = Math.min(6, Math.max(2, Math.floor(value.length / 2)));
      return `${value.slice(0, visiblePrefix)}${'*'.repeat(Math.max(3, value.length - visiblePrefix - 2))}${value.slice(-2)}`;
    }
    default: return `${value.slice(0, 1)}${'*'.repeat(Math.max(2, value.length - 1))}`;
  }
}

function collectRegex(text, type, regex, validator = () => true) {
  const results = [];
  for (const match of text.matchAll(regex)) {
    const value = match[0];
    if (validator(value)) results.push({ type, value, start: match.index, end: match.index + value.length });
  }
  return results;
}

function collectGroupRegex(text, type, regex, group = 1, validator = () => true) {
  const results = [];
  for (const match of text.matchAll(regex)) {
    const value = match[group];
    if (!value || !validator(value)) continue;
    const relativeStart = match[0].lastIndexOf(value);
    const start = match.index + relativeStart;
    results.push({ type, value, start, end: start + value.length });
  }
  return results;
}

function normalizeTerms(values, minimumLength = 2) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((term) => String(term).trim())
    .filter((term) => term.length >= minimumLength))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'zh-CN'));
}

function collectLiteralTerms(text, type, terms) {
  const results = [];
  for (const term of normalizeTerms(terms)) {
    results.push(...collectRegex(text, type, new RegExp(escapeRegExp(term), 'gu')));
  }
  return results;
}

function protectedIntervals(text, terms) {
  return collectLiteralTerms(text, 'keep', terms).map(({ start, end }) => ({ start, end }));
}

function outsideProtected(findings, protectedRanges) {
  if (!protectedRanges.length) return findings;
  // 先合并重叠的保护区间，保证终点单调递增，二分查找才成立。
  const ranges = [];
  for (const range of protectedRanges.slice().sort((left, right) => left.start - right.start)) {
    const last = ranges[ranges.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else ranges.push({ start: range.start, end: range.end });
  }
  return findings.filter((finding) => {
    // 二分查找第一个终点大于候选起点的保护区间。
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ranges[middle].end <= finding.start) low = middle + 1; else high = middle;
    }
    for (let index = low; index < ranges.length && ranges[index].start < finding.end; index += 1) {
      if (finding.start < ranges[index].end) return false;
    }
    return true;
  });
}

function normalizeExternalFindings(text, values, enabledTypes) {
  if (!Array.isArray(values)) return [];
  const results = [];
  for (const item of values) {
    const type = String(item?.type || '');
    const start = Number(item?.start);
    const end = Number(item?.end);
    const confidence = Number(item?.confidence);
    if (!enabledTypes.has(type) || !TYPE_LABELS[type] || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end <= start || end > text.length || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    results.push({
      type,
      value: text.slice(start, end),
      start,
      end,
      source: item?.source === 'onnx' ? 'onnx' : 'external',
      confidence,
      reviewRequired: Boolean(item?.reviewRequired),
      enabled: item?.enabled !== false
    });
  }
  return results;
}

function removeOverlaps(findings) {
  const priority = { secret: 110, uscc: 100, idcard: 90, bankcard: 80, mobile: 70, landline: 60, email: 50, ipv4: 45, company: 40, person: 35, address: 30, custom: 20 };
  const sorted = findings.slice().sort((a, b) => a.start - b.start || (priority[b.type] - priority[a.type]) || (b.end - b.start) - (a.end - a.start));
  // 按起点排序后，只需与已接受候选的最大终点比较即可判断重叠（线性复杂度）。
  const accepted = [];
  let maxEnd = -1;
  for (const finding of sorted) {
    if (finding.start >= maxEnd) {
      accepted.push(finding);
      maxEnd = finding.end;
    }
  }
  return accepted.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function applyFindings(text, findings) {
  // 一次拼接，避免每个候选都复制整段正文（候选多时是平方复杂度）。重叠候选沿用原逻辑：起点靠后的先替换。
  const source = String(text || '');
  const active = findings.filter((item) => item.enabled !== false).slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const hasOverlap = active.some((item, index) => index > 0 && item.start < active[index - 1].end);
  if (hasOverlap) {
    let output = source;
    for (const finding of active.slice().reverse()) output = `${output.slice(0, finding.start)}${finding.replacement}${output.slice(finding.end)}`;
    return output;
  }
  const parts = [];
  let cursor = 0;
  for (const finding of active) {
    parts.push(source.slice(cursor, finding.start), finding.replacement);
    cursor = finding.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

export function analyzeText(input, options = {}) {
  const text = String(input || '');
  const enabledTypes = new Set(Array.isArray(options.enabledTypes) ? options.enabledTypes : DEFAULT_TYPES);
  const style = options.style === 'label' ? 'label' : 'mask';
  const findings = [];

  if (enabledTypes.has('company')) {
    findings.push(...collectRegex(text, 'company', /(?<![\p{Script=Han}A-Z0-9])(?:[\p{Script=Han}A-Z0-9（）()·&]{2,48})(?:有限责任公司|股份有限公司|有限公司|集团公司|集团|事务所|研究院|中心|公司)(?![\p{Script=Han}])/gu));
  }
  if (enabledTypes.has('person')) {
    findings.push(...collectGroupRegex(text, 'person', /(?:法定代表人|项目负责人|联系人|负责人|经办人|收件人|项目经理|审核人|申请人|法人)[：: ]*([\p{Script=Han}·]{2,4})(?![\p{Script=Han}·])/gu));
    findings.push(...collectGroupRegex(text, 'person', /(?:姓名|客户)[：:][ \t]*([\p{Script=Han}·]{2,4})(?![\p{Script=Han}·])/gu));
    findings.push(...collectGroupRegex(text, 'person', /(?<![\p{Script=Han}·])([\p{Script=Han}·]{2,4})(?:先生|女士|律师|教授|博士)(?![\p{Script=Han}·])/gu));
  }

  if (enabledTypes.has('person')) findings.push(...collectSpacedNames(text));
  if (enabledTypes.has('secret')) findings.push(...collectSecrets(text));

  if (enabledTypes.has('email')) findings.push(...collectRegex(text, 'email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu));
  if (enabledTypes.has('idcard')) findings.push(...collectRegex(text, 'idcard', /(?<!\d)\d{17}[\dXx](?!\d)/gu, idCardValid));
  if (enabledTypes.has('uscc')) findings.push(...collectRegex(text, 'uscc', /(?<![0-9A-Z])[0-9ABCDEFGHJKLMNPQRTUWXY]{18}(?![0-9A-Z])/giu, usccValid));
  if (enabledTypes.has('mobile')) findings.push(...collectRegex(text, 'mobile', /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu));
  if (enabledTypes.has('bankcard')) findings.push(...collectRegex(text, 'bankcard', /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/gu, luhnValid));
  if (enabledTypes.has('ipv4')) findings.push(...collectRegex(text, 'ipv4', /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/gu, ipv4Valid));
  if (enabledTypes.has('landline')) findings.push(...collectRegex(text, 'landline', /(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/gu));
  if (enabledTypes.has('address')) {
    findings.push(...collectGroupRegex(text, 'address', /(?:注册地址|办公地址|联系地址|通讯地址|收货地址|家庭住址|地址|住址)[：:][ \t]*([^\s，,；;。\n]{6,80})/gu));
  }

  const typedTerms = options.typedTerms && typeof options.typedTerms === 'object' ? options.typedTerms : {};
  for (const type of Object.keys(TYPE_LABELS)) {
    if (type !== 'custom' && enabledTypes.has(type)) findings.push(...collectLiteralTerms(text, type, typedTerms[type]));
  }

  if (enabledTypes.has('custom')) {
    findings.push(...collectLiteralTerms(text, 'custom', [...(options.customTerms || []), ...(typedTerms.custom || [])]));
  }

  findings.push(...normalizeExternalFindings(text, options.externalFindings, enabledTypes));
  if (options.propagateRepeats !== false) findings.push(...collectRepeatedValues(text, findings));

  const protectedRanges = protectedIntervals(text, options.alwaysKeepTerms);
  const normalized = removeOverlaps(outsideProtected(findings, protectedRanges)).map((finding, index) => ({
    id: `${finding.type}-${finding.start}-${finding.end}-${index}`,
    ...finding,
    label: TYPE_LABELS[finding.type],
    replacement: maskValue(finding.type, finding.value, style),
    source: finding.source || 'rule',
    confidence: Number.isFinite(finding.confidence) ? finding.confidence : 1,
    reviewRequired: Boolean(finding.reviewRequired),
    ...(finding.hint ? { hint: finding.hint } : {}),
    enabled: finding.enabled !== false
  }));
  const counts = {};
  for (const finding of normalized) counts[finding.type] = (counts[finding.type] || 0) + 1;
  return {
    text,
    findings: normalized,
    counts,
    protectedCount: protectedRanges.length,
    modelCount: normalized.filter((item) => item.source === 'onnx').length,
    reviewCount: normalized.filter((item) => item.reviewRequired).length,
    redactedText: applyFindings(text, normalized)
  };
}

export const validators = Object.freeze({ luhnValid, idCardValid, ipv4Valid, usccValid });

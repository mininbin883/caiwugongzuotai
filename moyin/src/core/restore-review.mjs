// 逆脱敏核对单：比较“发给 AI 的代号副本”与“AI 返回的内容”，列出需要人工确认的地方。
// 本模块只读不改：不替换任何文字，不猜测残缺代号，不判断 AI 的分析是否正确。

const TOKEN_SCAN = /\[MI_([A-F0-9]{8})_([0-9A-Z]{3,6})\]/gu;
const DAMAGED_TOKEN = /\[?MI[_\s-]?([A-F0-9]{8})[_\s-]?([0-9A-Z]{3,6})?\]?/gu;
const SENTENCE_SPLIT = /[^。！？!?；;\n]+[。！？!?；;]?/gu;
const MAX_SENTENCES = 60000;
const SIMILAR = 0.55;

// ---------- 事实抽取 ----------

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const CN_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_BIG = { 万: 1e4, 亿: 1e8 };

export function parseChineseNumber(text) {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of String(text)) {
    if (char in CN_DIGITS) digit = CN_DIGITS[char];
    else if (char in CN_UNITS) { section += (digit || 1) * CN_UNITS[char]; digit = 0; }
    else if (char in CN_BIG) { total += (section + digit) * CN_BIG[char]; section = 0; digit = 0; }
    else return null;
  }
  return total + section + digit;
}

const MULTIPLIER = { 万亿: 1e12, 亿: 1e8, 千万: 1e7, 百万: 1e6, 万: 1e4, 千: 1e3, k: 1e3, K: 1e3, m: 1e6, M: 1e6 };
const CURRENCY = '(?:元|圆|人民币|美元|港元|港币|欧元|日元|英镑|USD|RMB|CNY|HKD|EUR)';
const AMOUNT = new RegExp(
  `(?<cur>[￥¥$€£])?\\s*(?<num>\\d[\\d,，]*(?:\\.\\d+)?)\\s*(?<mul>万亿|亿|千万|百万|万|千|[kKmM])?\\s*(?<unit>${CURRENCY})|` +
  `(?<cur2>[￥¥$€£]|人民币|RMB|CNY|USD)\\s*(?<num2>\\d[\\d,，]*(?:\\.\\d+)?)\\s*(?<mul2>万亿|亿|千万|百万|万)?|` +
  `(?<cn>[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]{2,})\\s*${CURRENCY}`,
  'gu'
);
const DATE = /(?<y>\d{4})\s*(?:年|[-/.])\s*(?<m>\d{1,2})\s*(?:月|[-/.])\s*(?:(?<d>\d{1,2})\s*日?)?|(?<m2>\d{1,2})\s*月\s*(?<d2>\d{1,2})\s*[日号]/gu;
const PERCENT = /(?<num>\d+(?:\.\d+)?)\s*[%％]|百分之(?<cn>[零一二两三四五六七八九十百点]+)/gu;
const QUANTITY = /(?<num>\d[\d,]*(?:\.\d+)?)\s*(?<unit>个月|个|台|件|份|人|名|次|天|日|周|年|吨|公斤|千克|克|平方米|㎡|平米|米|公里|小时|分钟|家|项|套|张|笔|批|箱|页|股|手)/gu;

function toNumber(raw) {
  return Number(String(raw).replace(/[,，\s]/gu, ''));
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function maskTokens(text) {
  return text.replace(TOKEN_SCAN, (token) => ' '.repeat(token.length));
}

function extractFacts(sentence) {
  const text = maskTokens(sentence);
  const amounts = [];
  const consumed = [];
  for (const match of text.matchAll(AMOUNT)) {
    const g = match.groups;
    let value = null;
    if (g.num) value = toNumber(g.num) * (MULTIPLIER[g.mul] || 1);
    else if (g.num2) value = toNumber(g.num2) * (MULTIPLIER[g.mul2] || 1);
    else if (g.cn) value = parseChineseNumber(g.cn);
    if (value === null || Number.isNaN(value)) continue;
    const currency = /美元|USD|\$/u.test(match[0]) ? 'USD' : /欧元|EUR|€/u.test(match[0]) ? 'EUR' : /港/u.test(match[0]) ? 'HKD' : 'CNY';
    amounts.push(`${currency}:${round(value)}`);
    consumed.push([match.index, match.index + match[0].length]);
  }
  const dates = [];
  for (const match of text.matchAll(DATE)) {
    const g = match.groups;
    dates.push(g.y ? `${Number(g.y)}-${Number(g.m)}${g.d ? `-${Number(g.d)}` : ''}` : `*-${Number(g.m2)}-${Number(g.d2)}`);
    consumed.push([match.index, match.index + match[0].length]);
  }
  const percents = [];
  for (const match of text.matchAll(PERCENT)) {
    const value = match.groups.num ? Number(match.groups.num) : parseChineseNumber(String(match.groups.cn).split('点')[0]);
    if (value !== null) percents.push(String(round(value)));
    consumed.push([match.index, match.index + match[0].length]);
  }
  const quantities = [];
  for (const match of text.matchAll(QUANTITY)) {
    const start = match.index;
    if (consumed.some(([from, to]) => start >= from && start < to)) continue;
    quantities.push(`${round(toNumber(match.groups.num))}${match.groups.unit.replace('个月', '月')}`);
  }
  const tokens = [...sentence.matchAll(TOKEN_SCAN)].map((match) => match[0]);
  const negations = (text.match(/不得|不再|不予|不可|不能|不会|不|未|无|非|否|没有|禁止|拒绝|取消/gu) || []).length;
  const status = [...new Set(text.match(/已支付|未支付|已付款|未付款|已付|未付|已到账|未到账|已结清|未结清|已退还|未退还|已签署|未签署|已完成|未完成|已逾期|未逾期|应付|应收|预付|退款|违约/gu) || [])].sort();
  const direction = [...new Set(text.match(/支付给|付给|收取|收到|退还|退回|转给|转入|转出|借给|借入|借出|赔偿|罚款|收款|付款/gu) || [])].sort();
  return { amounts: amounts.sort(), dates: dates.sort(), percents: percents.sort(), quantities: quantities.sort(), tokens, negations, status, direction };
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMultiset(left, right) {
  return sameList(left.slice().sort(), right.slice().sort());
}

function compareFacts(before, after) {
  const changes = [];
  if (!sameList(before.amounts, after.amounts)) changes.push({ kind: 'amount', label: '金额', before: before.amounts, after: after.amounts });
  if (!sameList(before.dates, after.dates)) changes.push({ kind: 'date', label: '日期', before: before.dates, after: after.dates });
  if (!sameList(before.percents, after.percents)) changes.push({ kind: 'percent', label: '比例', before: before.percents, after: after.percents });
  if (!sameList(before.quantities, after.quantities)) changes.push({ kind: 'quantity', label: '数量', before: before.quantities, after: after.quantities });
  if (!sameMultiset(before.tokens, after.tokens)) {
    changes.push({ kind: 'identity', label: '身份代号', before: before.tokens, after: after.tokens });
  } else if (before.tokens.length > 1 && !sameList(before.tokens, after.tokens)) {
    // 代号集合不变但先后顺序变了：可能是“甲向乙付款”被写成“乙向甲付款”。
    changes.push({ kind: 'role-order', label: '身份角色顺序', before: before.tokens, after: after.tokens });
  }
  if (before.negations !== after.negations) changes.push({ kind: 'negation', label: '否定/条件', before: [String(before.negations)], after: [String(after.negations)] });
  if (!sameList(before.status, after.status)) changes.push({ kind: 'status', label: '付款状态', before: before.status, after: after.status });
  if (!sameList(before.direction, after.direction)) changes.push({ kind: 'direction', label: '付款方向', before: before.direction, after: after.direction });
  return changes;
}

// ---------- 句子对齐 ----------

function splitSentences(text, limit = MAX_SENTENCES) {
  const sentences = [];
  for (const match of text.matchAll(SENTENCE_SPLIT)) {
    const raw = match[0];
    const trimmedStart = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body) continue;
    sentences.push({ text: body, start: match.index + trimmedStart, end: match.index + trimmedStart + body.length, key: normalizeKey(body) });
    if (sentences.length >= limit) break;
  }
  return sentences;
}

function tokenGlyph(token) {
  let hash = 0;
  for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return String.fromCharCode(0xe000 + (hash % 6000));
}

function normalizeKey(text) {
  // 每个代号压成一个私用区字符（避免代号里的共同前缀抬高相似度），再去掉空白与常见标点。
  return text
    .replace(TOKEN_SCAN, tokenGlyph)
    .replace(/\s+/gu, '')
    .replace(/[，,、。！？!?；;：:“”"'‘’（）()《》【】\[\]]/gu, '');
}

function bigrams(key) {
  const chars = [...key];
  const result = new Map();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = chars[index] + chars[index + 1];
    result.set(gram, (result.get(gram) || 0) + 1);
  }
  if (chars.length === 1) result.set(chars[0], 1);
  return result;
}

function dice(left, right) {
  let overlap = 0;
  let total = 0;
  for (const [gram, count] of left) { total += count; if (right.has(gram)) overlap += Math.min(count, right.get(gram)); }
  for (const count of right.values()) total += count;
  return total ? (2 * overlap) / total : 0;
}

function buildIndex(sentences) {
  const index = new Map();
  sentences.forEach((sentence, id) => {
    sentence.grams = bigrams(sentence.key);
    for (const gram of sentence.grams.keys()) {
      let list = index.get(gram);
      if (!list) index.set(gram, (list = []));
      list.push(id);
    }
  });
  return index;
}

function bestMatch(sentence, sources, index) {
  const grams = bigrams(sentence.key);
  const votes = new Map();
  for (const gram of grams.keys()) {
    const list = index.get(gram);
    if (!list || list.length > 400) continue; // 过于常见的二元组没有区分度
    for (const id of list) votes.set(id, (votes.get(id) || 0) + 1);
  }
  let best = null;
  const candidates = [...votes.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12);
  for (const [id] of candidates) {
    const score = dice(grams, sources[id].grams);
    if (!best || score > best.score) best = { id, score };
  }
  return best;
}

// ---------- AI 直接写出的原文 ----------
// 先把正文“压紧”（去掉空白和横线，代号换成边界符），再用前缀索引单次扫描所有映射值，复杂度与正文长度线性相关。
// 因此汉字中间的空格、换行，号码中间的空格或横线都不影响比对。

const SQUEEZE = /[\s\u3000\u00A0\-－—]/u;
const BOUNDARY = '\u0000';
const HAN_CHAR = /\p{Script=Han}/u;
const ALNUM = /[0-9A-Za-z]/u;

function squeeze(text) {
  // 记录每个保留字符在原文中的位置，便于“定位”回到原文坐标。
  const chars = [];
  const offsets = [];
  let sourceIndex = 0;
  const tokenRanges = [...text.matchAll(TOKEN_SCAN)].map((match) => [match.index, match.index + match[0].length]);
  let tokenCursor = 0;
  while (sourceIndex < text.length) {
    const range = tokenRanges[tokenCursor];
    if (range && sourceIndex === range[0]) {
      chars.push(BOUNDARY);
      offsets.push(sourceIndex);
      sourceIndex = range[1];
      tokenCursor += 1;
      continue;
    }
    const char = text[sourceIndex];
    if (!SQUEEZE.test(char)) {
      chars.push(char);
      offsets.push(sourceIndex);
    }
    sourceIndex += 1;
  }
  offsets.push(text.length);
  return { text: chars.join(''), offsets };
}

function squeezeValue(value) {
  return [...String(value)].filter((char) => !SQUEEZE.test(char)).join('');
}

function boundaryOk(text, start, end, value, type) {
  const before = text[start - 1] || '';
  const after = text[end] || '';
  if (['mobile', 'landline', 'idcard', 'bankcard', 'uscc'].includes(type)) return !ALNUM.test(before) && !ALNUM.test(after);
  // 两个字的名字紧挨其他汉字时不算（多半是词的一部分）。
  if (/^\p{Script=Han}{1,2}$/u.test(value) && (HAN_CHAR.test(before) || HAN_CHAR.test(after))) return false;
  if (ALNUM.test(value[0]) && ALNUM.test(before)) return false;
  if (ALNUM.test(value.at(-1)) && ALNUM.test(after)) return false;
  return true;
}

function scanValues(squeezed, index) {
  const hits = new Map();
  const text = squeezed.text;
  for (let position = 0; position < text.length - 1; position += 1) {
    const bucket = index.get(text.slice(position, position + 2));
    if (!bucket) continue;
    for (const item of bucket) {
      if (!text.startsWith(item.value, position)) continue;
      const end = position + item.value.length;
      if (!boundaryOk(text, position, end, item.value, item.type)) continue;
      let list = hits.get(item.id);
      if (!list) hits.set(item.id, (list = []));
      list.push({ start: squeezed.offsets[position], end: squeezed.offsets[end - 1] + 1 });
      break;
    }
  }
  return hits;
}

function findOriginals(sentText, returnedText, mapping) {
  const index = new Map();
  mapping.forEach((entry, id) => {
    const value = squeezeValue(entry.value || '');
    if (value.length < 2 || value.length > 200 || value.includes(BOUNDARY)) return;
    if (['mobile', 'landline', 'idcard', 'bankcard', 'uscc'].includes(entry.type) && value.length < 6) return;
    const key = value.slice(0, 2);
    let bucket = index.get(key);
    if (!bucket) index.set(key, (bucket = []));
    bucket.push({ id, value, type: String(entry.type || '') });
  });
  for (const bucket of index.values()) bucket.sort((left, right) => right.value.length - left.value.length);

  const sentHits = scanValues(squeeze(sentText), index);
  const returnedHits = scanValues(squeeze(returnedText), index);
  const leaked = [];
  for (const [id, positions] of returnedHits) {
    const sentCount = sentHits.get(id)?.length || 0;
    // 发出去的副本里本来就露着的不算 AI 写出的。
    if (positions.length <= sentCount) continue;
    const entry = mapping[id];
    leaked.push({ token: entry.token, type: entry.type, label: entry.label || entry.type, value: entry.value, count: positions.length - sentCount, positions });
  }
  return leaked.sort((left, right) => left.positions[0].start - right.positions[0].start);
}

// ---------- 残缺与外来代号 ----------

function findTokenProblems(returnedText, mapping) {
  const known = new Map(mapping.map((entry) => [entry.token, entry]));
  const nonces = new Set(mapping.map((entry) => String(entry.token).slice(4, 12)));
  const intact = [];
  const foreign = [];
  const unknown = [];
  for (const match of returnedText.matchAll(TOKEN_SCAN)) {
    intact.push([match.index, match.index + match[0].length]);
    if (known.has(match[0])) continue;
    (nonces.has(match[1]) ? unknown : foreign).push({ token: match[0], start: match.index, end: match.index + match[0].length });
  }
  const damaged = [];
  for (const match of returnedText.matchAll(DAMAGED_TOKEN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (intact.some(([from, to]) => start >= from && end <= to)) continue;
    if (!/MI/u.test(match[0]) || match[0].length < 11) continue;
    const candidate = match[2] ? `[MI_${match[1]}_${match[2]}]` : null;
    // 只给出建议，不自动换回。
    damaged.push({ text: match[0], start, end, suggestion: candidate && known.has(candidate) ? candidate : null });
  }
  return { foreign, unknown, damaged };
}

// ---------- 主入口 ----------

/**
 * @param {{ sentText: string, returnedText: string, mapping: Array<{token:string,value:string,type?:string,label?:string}> }} input
 */
export function reviewRestoration({ sentText, returnedText, mapping } = {}) {
  const sent = String(sentText || '');
  const returned = String(returnedText || '');
  const entries = Array.isArray(mapping) ? mapping : [];

  const sources = splitSentences(sent);
  const index = buildIndex(sources);
  const sourceKeys = new Map(sources.map((sentence, id) => [sentence.key, id]));
  const targets = splitSentences(returned);

  const changes = [];
  const newContent = [];
  const reworded = [];
  let unchanged = 0;
  const matchedSources = new Set();

  for (const target of targets) {
    if (sourceKeys.has(target.key)) { unchanged += 1; matchedSources.add(sourceKeys.get(target.key)); continue; }
    const best = bestMatch(target, sources, index);
    if (!best || best.score < SIMILAR) {
      if ([...target.key].length >= 6 || extractFacts(target.text).amounts.length) {
        newContent.push({ text: target.text, start: target.start, end: target.end });
      }
      continue;
    }
    matchedSources.add(best.id);
    const source = sources[best.id];
    const diffs = compareFacts(extractFacts(source.text), extractFacts(target.text));
    if (diffs.length) {
      changes.push({ sourceText: source.text, returnedText: target.text, start: target.start, end: target.end, similarity: round(best.score), diffs });
    } else {
      reworded.push({ sourceText: source.text, returnedText: target.text, start: target.start, end: target.end, similarity: round(best.score) });
    }
  }

  const leakedOriginals = findOriginals(sent, returned, entries);
  const tokenProblems = findTokenProblems(returned, entries);
  const changeKinds = {};
  for (const change of changes) for (const diff of change.diffs) changeKinds[diff.kind] = (changeKinds[diff.kind] || 0) + 1;

  const requiresReview = changes.length > 0 || leakedOriginals.length > 0 ||
    tokenProblems.damaged.length > 0 || tokenProblems.foreign.length > 0 || tokenProblems.unknown.length > 0;
  return {
    stats: {
      sourceSentences: sources.length,
      returnedSentences: targets.length,
      unchanged,
      reworded: reworded.length,
      changed: changes.length,
      newContent: newContent.length,
      omittedSentences: Math.max(0, sources.length - matchedSources.size),
      truncated: sources.length >= MAX_SENTENCES || targets.length >= MAX_SENTENCES
    },
    changes,
    changeKinds,
    reworded,
    newContent,
    leakedOriginals,
    damagedTokens: tokenProblems.damaged,
    foreignTokens: tokenProblems.foreign,
    unknownTokens: tokenProblems.unknown,
    requiresReview
  };
}

export function summarizeReview(review) {
  const parts = [];
  if (review.changes.length) parts.push(`事实变化 ${review.changes.length} 句`);
  if (review.leakedOriginals.length) parts.push(`AI 直接写出原文 ${review.leakedOriginals.reduce((sum, item) => sum + item.count, 0)} 处`);
  if (review.damagedTokens.length) parts.push(`残缺代号 ${review.damagedTokens.length} 个`);
  if (review.foreignTokens.length) parts.push(`其他文件的代号 ${review.foreignTokens.length} 个`);
  if (review.newContent.length) parts.push(`AI 新写的内容 ${review.newContent.length} 句`);
  if (review.reworded.length) parts.push(`改写措辞 ${review.reworded.length} 句`);
  return parts.join(' · ');
}

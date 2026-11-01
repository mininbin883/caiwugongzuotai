'use strict';

// 整个 Office 文件包的兜底处理。
// 正文/单元格之外，批注、页眉页脚、修订记录、图表缓存、超链接、共享字符串表等部件里也可能有原文。
// 导出副本时：把本次已认出的原文在所有 XML 部件里逐个换掉，清空作者信息，清理没人引用的共享字符串，
// 最后整包检查一遍，仍有原文就中止导出。逆脱敏时：把代号/假名在所有部件里换回。

const XML_PART = /\.(xml|rels|vml)$/iu;
const NUMERIC_NODE = /^\s*-?[\d.]+(?:E[+-]?\d+)?\s*$/iu;

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const encodeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodeAttribute = (value) => encodeText(value).replace(/"/g, '&quot;');

/**
 * 由已启用的识别结果生成“原文 → 替换”对。
 * 跳过：太短的英文数字（如年份）；被某个替换内容包含的原文（假名里保留了地区等真实片段，换了会把假名弄坏）。
 * 两个字的原文（多为人名）只在整段文字恰好等于它时替换，避免撞进“王宏伟”这类更长的词。
 */
function sweepPairsFromFindings(findings) {
  const byValue = new Map();
  // 用户取消勾选过的原文（某一处不隐藏）不做全包替换，尊重用户的选择。
  const kept = new Set((findings || []).filter((finding) => finding?.enabled === false).map((finding) => String(finding.value ?? '').trim()));
  for (const finding of findings || []) {
    if (finding?.enabled === false || typeof finding?.replacement !== 'string') continue;
    const value = String(finding.value ?? '').trim();
    if (!value || kept.has(value) || value === finding.replacement || value.includes('\n')) continue;
    if (/^[\x20-\x7e]+$/u.test(value) ? value.length < 5 : value.length < 2) continue;
    if (!byValue.has(value)) byValue.set(value, finding.replacement);
  }
  const replacements = [...new Set(byValue.values())];
  const pairs = [];
  for (const [value, replacement] of byValue) {
    if (replacements.some((item) => item.includes(value))) continue;
    pairs.push({ from: value, to: replacement, wholeOnly: value.length <= 2 });
  }
  return pairs.sort((left, right) => right.from.length - left.from.length);
}

// bounded：逆脱敏时使用。以字母数字开头/结尾的假名两侧不能紧挨字母数字，避免把恰好包含假名数字的真实号码改掉。
function compile(pairs, { bounded = false } = {}) {
  const partial = pairs.filter((pair) => !pair.wholeOnly);
  const whole = new Map(pairs.filter((pair) => pair.wholeOnly).map((pair) => [pair.from, pair.to]));
  const lookup = new Map(partial.map((pair) => [pair.from, pair.to]));
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const piece = (value) => {
    if (!bounded) return escape(value);
    const before = /^[0-9A-Za-z]/u.test(value) ? '(?<![0-9A-Za-z])' : '';
    const after = /[0-9A-Za-z]$/u.test(value) ? '(?![0-9A-Za-z])' : '';
    return `${before}${escape(value)}${after}`;
  };
  const regex = partial.length ? new RegExp(partial.map((pair) => piece(pair.from)).join('|'), 'gu') : null;
  return { regex, lookup, whole };
}

function replaceText(text, compiled) {
  if (NUMERIC_NODE.test(text)) return text;
  const trimmed = text.trim();
  if (compiled.whole.has(trimmed)) return text.replace(trimmed, compiled.whole.get(trimmed));
  if (!compiled.regex) return text;
  return text.replace(compiled.regex, (match) => compiled.lookup.get(match) ?? match);
}

function sweepXml(xml, compiled, { rels = false } = {}) {
  let count = 0;
  // 标签之间的文字
  let output = xml.replace(/>([^<]+)</g, (full, encoded) => {
    const text = decodeXml(encoded);
    const replaced = replaceText(text, compiled);
    if (replaced === text) return full;
    count += 1;
    return `>${encodeText(replaced)}<`;
  });
  // 属性值（批注作者、超链接显示文字、关系目标里的邮箱等）
  output = output.replace(/(\s[\w:.-]+=)"([^"]*)"/g, (full, name, encoded) => {
    if (!encoded) return full;
    const text = decodeXml(encoded);
    let replaced = replaceText(text, compiled);
    if (replaced === text) return full;
    if (rels && /Target=$/u.test(name)) {
      // 关系目标是 URI：替换内容按 URI 编码，避免方括号让 Office 认为链接无效。
      replaced = text;
      for (const [from, to] of compiled.lookup) replaced = replaced.split(from).join(encodeURIComponent(to));
      if (compiled.whole.has(text.trim())) replaced = encodeURIComponent(compiled.whole.get(text.trim()));
    }
    count += 1;
    return `${name}"${encodeAttribute(replaced)}"`;
  });
  return { xml: output, count };
}

/** 在整个文件包里替换。返回改动的处数。 */
async function sweepPackage(zip, pairs, options = {}) {
  if (!pairs.length) return 0;
  const compiled = compile(pairs, options);
  let total = 0;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !XML_PART.test(name)) continue;
    const xml = await zip.file(name).async('string');
    const result = sweepXml(xml, compiled, { rels: name.endsWith('.rels') });
    if (result.count) {
      zip.file(name, result.xml);
      total += result.count;
    }
  }
  return total;
}

/** 整包检查：返回仍含原文的部件与原文（只报告前 20 处）。 */
async function residualScan(zip, pairs) {
  if (!pairs.length) return [];
  const compiled = compile(pairs);
  const hits = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !XML_PART.test(name)) continue;
    const xml = await zip.file(name).async('string');
    const check = (text) => {
      if (hits.length >= 20 || NUMERIC_NODE.test(text)) return;
      const trimmed = text.trim();
      if (compiled.whole.has(trimmed)) hits.push({ part: name, value: trimmed });
      else if (compiled.regex) {
        compiled.regex.lastIndex = 0;
        const match = compiled.regex.exec(text);
        if (match) hits.push({ part: name, value: match[0] });
      }
    };
    for (const match of xml.matchAll(/>([^<]+)</g)) check(decodeXml(match[1]));
    for (const match of xml.matchAll(/\s[\w:.-]+="([^"]+)"/g)) check(decodeXml(match[1]));
    if (hits.length >= 20) break;
  }
  return hits;
}

/** 共享字符串表：单元格改写后不再被引用的旧字符串清空（保留条目数量与顺序，其他单元格的编号不变）。 */
async function cleanSharedStrings(zip) {
  const sstName = Object.keys(zip.files).find((name) => /^xl\/sharedStrings\.xml$/iu.test(name));
  if (!sstName) return 0;
  const used = new Set();
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/(worksheets|chartsheets)\/[^/]+\.xml$/iu.test(name)) continue;
    const xml = await zip.file(name).async('string');
    for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g)) {
      if (!/\st=(['"])s\1/u.test(match[1]) || !match[2]) continue;
      const value = match[2].match(/<(?:[A-Za-z_][\w.-]*:)?v>\s*(\d+)\s*</u);
      if (value) used.add(Number(value[1]));
    }
  }
  const xml = await zip.file(sstName).async('string');
  let index = -1;
  let cleared = 0;
  const output = xml.replace(/<((?:[A-Za-z_][\w.-]*:)?)si\b[^>]*?(?:\/>|>[\s\S]*?<\/\1si>)/g, (full, prefix) => {
    index += 1;
    if (used.has(index) || /^<[^>]*\/>$/u.test(full)) return full;
    cleared += 1;
    return `<${prefix}si><${prefix}t></${prefix}t></${prefix}si>`;
  });
  if (cleared) zip.file(sstName, output);
  return cleared;
}

/** 清空修订人、批注作者等姓名。 */
async function scrubAuthors(zip) {
  let changed = 0;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !XML_PART.test(name)) continue;
    let xml = await zip.file(name).async('string');
    const before = xml;
    if (name.startsWith('word/')) {
      xml = xml.replace(/(\s(?:w|w15):(?:author|initials|userId|providerId)=)"[^"]*"/g, '$1""');
    } else if (name.startsWith('xl/')) {
      xml = xml.replace(/<((?:[A-Za-z_][\w.-]*:)?)author>[^<]*<\/\1author>/g, '<$1author></$1author>');
      if (/^xl\/persons\//iu.test(name)) xml = xml.replace(/(\s(?:displayName|userId|providerId)=)"[^"]*"/g, '$1""');
    }
    if (xml !== before) {
      zip.file(name, xml);
      changed += 1;
    }
  }
  return changed;
}

module.exports = { sweepPairsFromFindings, sweepPackage, residualScan, cleanSharedStrings, scrubAuthors, sweepXml, compile };

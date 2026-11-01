'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { inspectOfficeLongTail } = require('./office-long-tail-service.cjs');
const { sweepPairsFromFindings, sweepPackage, residualScan, cleanSharedStrings, scrubAuthors } = require('./office-package-sweep.cjs');

const OFFICE_EXTENSIONS = Object.freeze(['.docx', '.xlsx']);
const MAX_OFFICE_BYTES = 100 * 1024 * 1024;
const MAX_OFFICE_TEXT = 16 * 1024 * 1024;
const REVERSIBLE_TOKEN_PATTERN = /^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]$/u;
const REVERSIBLE_TOKEN_SCAN = /\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]/gu;

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attributeValue(attributes, name) {
  const match = String(attributes || '').match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}=(['"])([\\s\\S]*?)\\1`));
  return match ? decodeXml(match[2]) : '';
}

function wordPartLabel(partName) {
  if (partName === 'word/document.xml') return '正文';
  if (/\/header\d+\.xml$/i.test(partName)) return `页眉 ${partName.match(/\d+/)?.[0] || ''}`.trim();
  if (/\/footer\d+\.xml$/i.test(partName)) return `页脚 ${partName.match(/\d+/)?.[0] || ''}`.trim();
  if (partName.endsWith('/footnotes.xml')) return '脚注';
  if (partName.endsWith('/endnotes.xml')) return '尾注';
  if (partName.endsWith('/comments.xml')) return '批注';
  return partName;
}

function parseWordPart(xml) {
  const nodes = [];
  let text = '';
  // 修订里被删除的文字（w:delText）仍保存在文件中，同样要识别。
  const tokenPattern = /<w:(t|delText)\b[^>]*>[\s\S]*?<\/w:\1>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>|<\/w:p>/gi;
  for (const match of xml.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^<w:(?:t|delText)\b/i.test(token)) {
      const openEnd = token.indexOf('>') + 1;
      const closeStart = token.lastIndexOf('</w:');
      const value = decodeXml(token.slice(openEnd, closeStart));
      const start = text.length;
      text += value;
      nodes.push({
        start,
        end: text.length,
        text: value,
        contentStart: match.index + openEnd,
        contentEnd: match.index + closeStart
      });
    } else if (/^<w:tab\b/i.test(token)) {
      text += '\t';
    } else if (/^<w:br\b/i.test(token)) {
      text += '\n';
    } else if (text && !text.endsWith('\n')) {
      text += '\n';
    }
  }
  return { text: text.replace(/\n+$/u, ''), nodes };
}

function activeFindings(findings) {
  return (findings || [])
    .filter((finding) => finding.enabled !== false && Number.isInteger(finding.start) && Number.isInteger(finding.end) &&
      finding.end > finding.start && typeof finding.replacement === 'string')
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function normalizeReversibleMapping(mapping) {
  if (!Array.isArray(mapping) || !mapping.length || mapping.length > 100000) throw new Error('LOCAL_OFFICE_REVERSIBLE_MAPPING_INVALID');
  const seen = new Set();
  return mapping.map((entry) => {
    const token = String(entry?.token || '');
    const value = String(entry?.value ?? '');
    const occurrences = Number(entry?.occurrences || 1);
    const pseudonym = entry?.form === 'pseudonym';
    const tokenValid = pseudonym ? token.length >= 2 && token.length <= 120 : REVERSIBLE_TOKEN_PATTERN.test(token);
    if (!tokenValid || seen.has(token) || !value || value.length > 100000 ||
      !Number.isSafeInteger(occurrences) || occurrences < 1 || occurrences > 100000) {
      throw new Error('LOCAL_OFFICE_REVERSIBLE_MAPPING_INVALID');
    }
    seen.add(token);
    return { token, value, occurrences, type: String(entry?.type || 'custom'), label: String(entry?.label || entry?.type || '自定义'), form: pseudonym ? 'pseudonym' : 'token' };
  });
}

// 在文字里找假名。以字母数字开头/结尾的假名，两侧不能紧挨着字母数字（避免撞进更长的号码），
// 但两个假名紧挨在一起时（如“…地址Q013”后紧跟手机号假名）彼此算作边界，两个都要换回。
function findPseudonymMatches(text, tokens) {
  if (!tokens.length || !text) return [];
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp([...tokens].sort((left, right) => right.length - left.length).map(escape).join('|'), 'gu');
  const raw = [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length, token: match[0] }));
  const alnum = (char) => /[0-9A-Za-z]/u.test(char || '');
  return raw.filter((match, index) => {
    const leftOk = !alnum(match.token[0]) || !alnum(text[match.start - 1]) || raw[index - 1]?.end === match.start;
    const rightOk = !alnum(match.token.at(-1)) || !alnum(text[match.end]) || raw[index + 1]?.start === match.end;
    return leftOk && rightOk;
  });
}

// 假名表：单位的 Q 编号单独出现时也换回全称。
function pseudonymPattern(entries) {
  const byToken = new Map();
  for (const entry of entries) if (entry.form === 'pseudonym') byToken.set(entry.token, entry);
  for (const entry of entries) {
    if (entry.form !== 'pseudonym' || entry.type !== 'company') continue;
    const code = entry.token.match(/Q\d{3,}/u)?.[0];
    if (code && !byToken.has(code)) byToken.set(code, entry);
  }
  if (!byToken.size) return null;
  return { tokens: [...byToken.keys()], byToken };
}

function officeTokenFindings(text, mapping) {
  const source = String(text || '');
  const entries = normalizeReversibleMapping(mapping);
  const byToken = new Map(entries.map((entry) => [entry.token, entry]));
  const actualCounts = new Map();
  const unknownTokens = new Set();
  const findings = [];
  for (const match of source.matchAll(REVERSIBLE_TOKEN_SCAN)) {
    const token = match[0];
    const entry = byToken.get(token);
    if (!entry) {
      unknownTokens.add(token);
      continue;
    }
    actualCounts.set(token, (actualCounts.get(token) || 0) + 1);
    findings.push({
      type: entry.type,
      label: entry.label,
      value: token,
      start: match.index,
      end: match.index + token.length,
      replacement: entry.value,
      enabled: true
    });
  }
  // 工作表名称里的代号没有方括号（工作表名不允许 [ ]）：已知代号的裸写形式也换回。
  for (const match of source.matchAll(/(?<![\[A-Za-z0-9_])MI_[A-F0-9]{8}_[0-9A-Z]{3,6}(?![\]A-Za-z0-9_])/gu)) {
    const entry = byToken.get(`[${match[0]}]`);
    if (!entry) continue;
    actualCounts.set(entry.token, (actualCounts.get(entry.token) || 0) + 1);
    findings.push({ type: entry.type, label: entry.label, value: match[0], start: match.index, end: match.index + match[0].length, replacement: entry.value, enabled: true });
  }
  const pseudo = pseudonymPattern(entries);
  // 批次副本的文件名（MI-000200-01-名称-脱敏副本.xlsx）换回原文件名；名称中的代号、假名一并换回。
  const restoreInline = (value) => {
    let output = value.replace(REVERSIBLE_TOKEN_SCAN, (token) => byToken.get(token)?.value ?? token);
    if (pseudo) {
      let rebuilt = '';
      let cursor = 0;
      for (const match of findPseudonymMatches(output, pseudo.tokens)) {
        rebuilt += output.slice(cursor, match.start) + pseudo.byToken.get(match.token).value;
        cursor = match.end;
      }
      output = rebuilt + output.slice(cursor);
    }
    return output;
  };
  const copyNames = [];
  for (const match of source.matchAll(/MI-\d{6}-\d{2,3}-([^\s\t\n|]+?)-脱敏副本(?=\.[A-Za-z0-9]{2,5}\b)/gu)) {
    copyNames.push({ type: 'custom', label: '文件名', value: match[0], start: match.index, end: match.index + match[0].length, replacement: restoreInline(match[1]), enabled: true });
  }
  if (copyNames.length) {
    const nameMask = new Uint8Array(source.length + 1);
    for (const name of copyNames) nameMask.fill(1, name.start, name.end);
    const inside = (item) => nameMask.subarray(item.start, item.end).includes(1);
    for (let index = findings.length - 1; index >= 0; index -= 1) if (inside(findings[index])) findings.splice(index, 1);
    findings.push(...copyNames);
  }
  if (pseudo) {
    // 覆盖掩码：线性判断重叠（大表有上万处时，逐一比较会非常慢）。
    const covered = new Uint8Array(source.length + 1);
    for (const item of findings) covered.fill(1, item.start, item.end);
    for (const match of findPseudonymMatches(source, pseudo.tokens)) {
      const { start, end } = match;
      if (covered.subarray(start, end).includes(1)) continue;
      const entry = pseudo.byToken.get(match.token);
      actualCounts.set(entry.token, (actualCounts.get(entry.token) || 0) + 1);
      findings.push({ type: entry.type, label: entry.label, value: match.token, start, end, replacement: entry.value, enabled: true });
    }
    findings.sort((left, right) => left.start - right.start);
  }
  const missingTokens = entries.filter((entry) => !actualCounts.has(entry.token)).map((entry) => entry.token);
  const repeatedTokens = entries
    .filter((entry) => (actualCounts.get(entry.token) || 0) > entry.occurrences)
    .map((entry) => ({ token: entry.token, expected: entry.occurrences, actual: actualCounts.get(entry.token) }));
  return {
    findings,
    knownTokens: entries.length,
    restoredOccurrences: findings.length,
    missingTokens,
    repeatedTokens,
    unknownTokens: [...unknownTokens],
    complete: missingTokens.length === 0 && unknownTokens.size === 0
  };
}

function applyMappedFindings(text, mapping, findings) {
  const modifications = [];
  for (const finding of findings) {
    if (finding.start >= mapping.end || mapping.start >= finding.end) continue;
    const localStart = Math.max(finding.start, mapping.start) - mapping.start;
    const localEnd = Math.min(finding.end, mapping.end) - mapping.start;
    const isFirstSegment = mapping.start <= finding.start;
    modifications.push({
      start: localStart,
      end: localEnd,
      replacement: isFirstSegment ? finding.replacement : '',
      finding
    });
  }
  let output = text;
  for (const modification of modifications.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, modification.start)}${modification.replacement}${output.slice(modification.end)}`;
  }
  return { text: output, modifications };
}

async function extractDocx(zip, sourceBytes, filePath, longTailReport = null) {
  const names = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
    .sort((a, b) => {
      if (a === 'word/document.xml') return -1;
      if (b === 'word/document.xml') return 1;
      return a.localeCompare(b);
    });
  if (!names.includes('word/document.xml')) throw new Error('LOCAL_DOCX_FORMAT_INVALID');

  let text = '';
  const parts = [];
  for (const name of names) {
    const xml = await zip.file(name)?.async('string');
    if (!xml) continue;
    if (text) text += '\n\f\n';
    text += `【${wordPartLabel(name)}】\n`;
    const base = text.length;
    const parsed = parseWordPart(xml);
    text += parsed.text;
    parts.push({
      name,
      nodes: parsed.nodes.map((node) => ({ ...node, start: node.start + base, end: node.end + base }))
    });
  }
  if (!text.trim()) throw new Error('LOCAL_DOCUMENT_EMPTY');
  if (text.length > MAX_OFFICE_TEXT) throw new Error('LOCAL_OFFICE_TEXT_TOO_LARGE');
  return {
    name: path.basename(filePath),
    extension: '.docx',
    sourceBytes,
    characters: text.length,
    text,
    session: { kind: 'docx', sourceName: path.basename(filePath), sourcePath: path.resolve(filePath), parts, longTailReport },
    longTailReport
  };
}

function workbookSheetParts(zip) {
  const workbookXml = zip.file('xl/workbook.xml');
  const relationshipsXml = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relationshipsXml) throw new Error('LOCAL_XLSX_FORMAT_INVALID');
  return Promise.all([workbookXml.async('string'), relationshipsXml.async('string')]).then(([workbook, relationships]) => {
    const targets = new Map();
    for (const relation of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const id = attributeValue(relation[1], 'Id');
      const target = attributeValue(relation[1], 'Target');
      if (id && target) {
        const normalized = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
        targets.set(id, normalized);
      }
    }
    const sheets = [];
    for (const sheet of workbook.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?\s*>/gi)) {
      const name = attributeValue(sheet[1], 'name');
      const id = attributeValue(sheet[1], 'r:id');
      const partName = targets.get(id);
      if (name && partName) sheets.push({ name, partName });
    }
    return sheets;
  });
}

function cellDisplayValue(cell) {
  if (!cell) return null;
  // 公式单元格：文字结果（上次计算保存的值）也要识别，例如 =A2 引用了一个人名；数字结果不处理。
  if (cell.f) return cell.t === 's' && typeof cell.v === 'string' && cell.v ? cell.v : null;
  if (cell.v === undefined || cell.v === null) return null;
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString();
  // 部分财务软件导出的货币格式里，货币符号被写成了乱码（如“å52,500.00”）。数字格只保留正常的数字显示。
  if (cell.t === 'n' && typeof cell.w === 'string' && /[\u00C0-\u024F]/u.test(cell.w)) {
    return cell.w.replace(/[\u00C0-\u024F]+/gu, '').trim() || String(cell.v);
  }
  return String(cell.w ?? cell.v);
}

async function extractXlsx(zip, sourceBytes, filePath, originalBytes, longTailReport = null) {
  const workbook = XLSX.read(originalBytes, { type: 'buffer', cellStyles: true, cellDates: true, cellFormula: true, cellText: true });
  const sheetParts = await workbookSheetParts(zip);
  const partBySheet = new Map(sheetParts.map((item) => [item.name, item.partName]));
  let text = '';
  const cells = [];
  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const partName = partBySheet.get(sheetName);
    if (!sheet || !partName) continue;
    if (text) text += '\n\f\n';
    // 记下工作表名称在文字中的位置：名称里的敏感信息导出时要改写工作表名。
    sheets.push({ sheetName, partName, start: text.length + '【工作表：'.length, end: text.length + '【工作表：'.length + sheetName.length });
    text += `【工作表：${sheetName}】\n`;
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        if (column > range.s.c) text += '\t';
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const value = cellDisplayValue(sheet[address]);
        if (value === null) continue;
        const start = text.length;
        text += value;
        cells.push({ sheetName, partName, address, start, end: text.length, text: value });
      }
      if (row < range.e.r) text += '\n';
    }
  }
  if (!text.trim()) throw new Error('LOCAL_DOCUMENT_EMPTY');
  if (text.length > MAX_OFFICE_TEXT) throw new Error('LOCAL_OFFICE_TEXT_TOO_LARGE');
  return {
    name: path.basename(filePath),
    extension: '.xlsx',
    sourceBytes,
    characters: text.length,
    text,
    session: { kind: 'xlsx', sourceName: path.basename(filePath), sourcePath: path.resolve(filePath), cells, sheets, longTailReport },
    longTailReport
  };
}

// 旧版 .xls 先在本机工作目录里转成 .xlsx，再走 Excel 原格式处理；数据、公式与多工作表保留，单元格样式可能简化。
async function convertXlsToXlsx(inputPath, outputPath) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) throw new Error('LOCAL_PATH_INVALID');
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw new Error('LOCAL_PATH_INVALID');
  const bytes = await fs.readFile(inputPath);
  const workbook = XLSX.read(bytes, { type: 'buffer', cellNF: true, cellFormula: true, cellDates: false });
  for (const name of workbook.SheetNames) {
    for (const [address, cell] of Object.entries(workbook.Sheets[name])) {
      if (address[0] === '!' || !cell || typeof cell.z !== 'string') continue;
      // 去掉格式里乱码的货币符号（如 "å"#,##0.00），避免副本里继续显示乱码。
      if (/[\u00C0-\u024F]/u.test(cell.z)) {
        cell.z = cell.z.replace(/"[\u00C0-\u024F]+"/gu, '').replace(/[\u00C0-\u024F]+/gu, '');
        delete cell.w;
      }
    }
  }
  const output = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  await fs.writeFile(outputPath, output);
  return { outputPath, sheets: workbook.SheetNames.length };
}

async function extractOfficeDocument(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_PATH_INVALID');
  const extension = path.extname(filePath).toLowerCase();
  if (!OFFICE_EXTENSIONS.includes(extension)) throw new Error('LOCAL_OFFICE_TYPE_UNSUPPORTED');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > MAX_OFFICE_BYTES) throw new Error('LOCAL_OFFICE_TOO_LARGE');
  const bytes = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const longTailReport = await inspectOfficeLongTail(zip, extension);
  return extension === '.docx'
    ? extractDocx(zip, stat.size, filePath, longTailReport)
    : extractXlsx(zip, stat.size, filePath, bytes, longTailReport);
}

// 文件包收尾：导出副本时整包替换、清空作者与属性并做残留检查；逆脱敏时整包换回、保留文档属性。
async function finishPackage(zip, findings, options = {}) {
  const pairs = sweepPairsFromFindings([...(findings || []), ...(options.sweepFindings || [])]);
  if (options.restore) {
    // 超链接目标里的代号是按 URI 编码写入的，一并换回。
    for (const pair of [...pairs]) if (pair.from.startsWith('[MI_')) pairs.push({ ...pair, from: encodeURIComponent(pair.from) });
    pairs.sort((left, right) => right.from.length - left.from.length);
  }
  const swept = await sweepPackage(zip, pairs, { bounded: Boolean(options.restore) });
  if (options.restore) return { swept, residual: [] };
  await scrubAuthors(zip);
  await scrubDocumentProperties(zip);
  const residual = await residualScan(zip, pairs);
  if (residual.length) {
    const error = new Error(`LOCAL_EXPORT_RESIDUAL_FOUND:${residual.map((item) => item.part).slice(0, 3).join(',')}`);
    error.residual = residual;
    throw error;
  }
  return { swept, residual };
}

async function renderDocx(session, findings, options = {}) {
  if (typeof session?.sourcePath !== 'string' || !path.isAbsolute(session.sourcePath)) throw new Error('LOCAL_OFFICE_SESSION_INVALID');
  const zip = await JSZip.loadAsync(await fs.readFile(session.sourcePath), { checkCRC32: true });
  const enabled = activeFindings(findings);
  const applied = new Set();
  let changedNodes = 0;
  for (const part of session.parts) {
    let xml = await zip.file(part.name)?.async('string');
    if (!xml) throw new Error('LOCAL_DOCX_FORMAT_INVALID');
    const replacements = [];
    for (const node of part.nodes) {
      const result = applyMappedFindings(node.text, node, enabled);
      if (!result.modifications.length) continue;
      changedNodes += 1;
      for (const modification of result.modifications) applied.add(modification.finding);
      replacements.push({ start: node.contentStart, end: node.contentEnd, text: encodeXml(result.text) });
    }
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      xml = `${xml.slice(0, replacement.start)}${replacement.text}${xml.slice(replacement.end)}`;
    }
    if (replacements.length) zip.file(part.name, xml);
  }
  if (!applied.size) throw new Error('LOCAL_OFFICE_NO_REDACTIONS');
  const finished = await finishPackage(zip, findings, options);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, redactions: applied.size, changedUnits: changedNodes, sweptUnits: finished.swept };
}

function patchWorksheetXml(xml, replacements) {
  let changed = 0;
  // 空单元格常写成自闭合形式 <c r="Q6" s="2"/>（WPS 导出很常见）：必须单独识别，
  // 否则会把它和后一个单元格当成一个，后一个单元格就找不到了。
  const output = xml.replace(/<([A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/gi, (full, prefix = '', attributes) => {
    const address = attributeValue(attributes, 'r');
    if (!replacements.has(address)) return full;
    let updatedAttributes = attributes.replace(/\s+t=(['"])[\s\S]*?\1/i, '');
    updatedAttributes = updatedAttributes.trimEnd();
    changed += 1;
    // 公式单元格：保留公式，只改保存的计算结果。
    const formula = (full.match(new RegExp(`<${prefix}f\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${prefix}f>)`, 'i')) || [])[0];
    if (formula) return `<${prefix}c${updatedAttributes} t="str">${formula}<${prefix}v>${encodeXml(replacements.get(address))}</${prefix}v></${prefix}c>`;
    return `<${prefix}c${updatedAttributes} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${encodeXml(replacements.get(address))}</${prefix}t></${prefix}is></${prefix}c>`;
  });
  return { xml: output, changed };
}

// ---------- 工作表名称与文档属性 ----------
const SHEET_NAME_INVALID = /[\[\]:*?/\\]/gu;
const BARE_TOKEN = /\[(MI_[A-F0-9]{8}_[0-9A-Z]{3,6})\]/gu;

function xmlEscapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 工作表名称中的候选：按名称内的位置应用替换；方括号代号去掉方括号（工作表名不允许 [ ]），
// 其他不允许的字符换成下划线，长度不超过 31，并保证不与其他工作表重名。
function planSheetRenames(sheets, findings) {
  const renames = new Map();
  const applied = new Set();
  const used = new Set((sheets || []).map((sheet) => sheet.sheetName));
  for (const sheet of sheets || []) {
    const inside = findings
      .filter((finding) => finding.start >= sheet.start && finding.end <= sheet.end)
      .sort((left, right) => right.start - left.start);
    if (!inside.length) continue;
    let name = sheet.sheetName;
    for (const finding of inside) {
      const from = finding.start - sheet.start;
      const to = finding.end - sheet.start;
      const replacement = String(finding.replacement ?? '').replace(BARE_TOKEN, '$1');
      name = `${name.slice(0, from)}${replacement}${name.slice(to)}`;
      applied.add(finding);
    }
    name = name.replace(SHEET_NAME_INVALID, '_').slice(0, 31) || 'Sheet';
    used.delete(sheet.sheetName);
    let candidate = name;
    for (let counter = 2; used.has(candidate); counter += 1) candidate = `${name.slice(0, 31 - String(counter).length - 2)}(${counter})`;
    used.add(candidate);
    if (candidate !== sheet.sheetName) renames.set(sheet.sheetName, candidate);
  }
  return { renames, applied };
}

function renameSheetReferences(text, renames) {
  let output = text;
  for (const [oldName, newName] of renames) {
    const quotedOld = `'${oldName.replace(/'/g, "''")}'!`;
    const quotedNew = `'${newName.replace(/'/g, "''")}'!`;
    output = output.split(quotedOld).join(quotedNew);
    if (/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(oldName)) {
      output = output.replace(new RegExp(`(^|[^\\p{L}\\p{N}_.'!])${escapeRegex(oldName)}!`, 'gu'), (_match, before) => `${before}${quotedNew}`);
    }
  }
  return output;
}

async function applySheetRenames(zip, renames) {
  if (!renames.size) return;
  const workbookPath = 'xl/workbook.xml';
  let workbook = await zip.file(workbookPath)?.async('string');
  if (workbook) {
    workbook = workbook.replace(/<([A-Za-z_][\w.-]*:)?sheet\b([^>]*?)\bname="([^"]*)"/gu, (full, prefix = '', before, encoded) => {
      const current = decodeXml(encoded);
      return renames.has(current) ? `<${prefix}sheet${before}name="${xmlEscapeAttr(renames.get(current))}"` : full;
    });
    workbook = workbook.replace(/(<([A-Za-z_][\w.-]*:)?definedName\b[^>]*>)([\s\S]*?)(<\/\2?definedName>)/gu, (_full, open, _prefix, body, close) => `${open}${encodeXml(renameSheetReferences(decodeXml(body), renames))}${close}`);
    zip.file(workbookPath, workbook);
  }
  // 公式、图表引用中的工作表名
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/(worksheets|charts|pivotTables|pivotCache)\/.+\.xml$/iu.test(name)) continue;
    const xml = await zip.file(name).async('string');
    const patched = xml.replace(/(<([A-Za-z_][\w.-]*:)?f\b[^>]*>)([\s\S]*?)(<\/\2?f>)/gu, (_full, open, _prefix, body, close) => `${open}${encodeXml(renameSheetReferences(decodeXml(body), renames))}${close}`);
    if (patched !== xml) zip.file(name, patched);
  }
  // docProps/app.xml 里列出的工作表名称
  const appPath = 'docProps/app.xml';
  const app = await zip.file(appPath)?.async('string');
  if (app) {
    const patched = app.replace(/<vt:lpstr>([^<]*)<\/vt:lpstr>/gu, (full, encoded) => {
      const current = decodeXml(encoded);
      return renames.has(current) ? `<vt:lpstr>${encodeXml(renames.get(current))}</vt:lpstr>` : full;
    });
    zip.file(appPath, patched);
  }
}

// 导出副本时清空文档属性里的作者、公司等（这些常含企业名称，随文件一起外发）。
async function scrubDocumentProperties(zip) {
  const corePath = 'docProps/core.xml';
  const core = await zip.file(corePath)?.async('string');
  if (core) {
    const cleaned = core.replace(/<((?:dc|cp):(?:creator|lastModifiedBy|title|subject|description|keywords|category))(\s[^>]*)?>[\s\S]*?<\/\1>/gu, '<$1$2></$1>');
    zip.file(corePath, cleaned);
  }
  const appPath = 'docProps/app.xml';
  const app = await zip.file(appPath)?.async('string');
  if (app) {
    const cleaned = app.replace(/<(Company|Manager|HyperlinkBase)>[\s\S]*?<\/\1>/gu, '<$1></$1>');
    zip.file(appPath, cleaned);
  }
}

async function renderXlsx(session, findings, options = {}) {
  if (typeof session?.sourcePath !== 'string' || !path.isAbsolute(session.sourcePath)) throw new Error('LOCAL_OFFICE_SESSION_INVALID');
  const zip = await JSZip.loadAsync(await fs.readFile(session.sourcePath), { checkCRC32: true });
  const enabled = activeFindings(findings);
  const applied = new Set();
  const byPart = new Map();
  for (const cell of session.cells) {
    const result = applyMappedFindings(cell.text, cell, enabled);
    if (!result.modifications.length) continue;
    for (const modification of result.modifications) applied.add(modification.finding);
    if (!byPart.has(cell.partName)) byPart.set(cell.partName, new Map());
    byPart.get(cell.partName).set(cell.address, result.text);
  }
  const sheetPlan = planSheetRenames(session.sheets, enabled);
  for (const finding of sheetPlan.applied) applied.add(finding);
  if (!applied.size) throw new Error('LOCAL_OFFICE_NO_REDACTIONS');
  let changedCells = 0;
  for (const [partName, replacements] of byPart) {
    const source = await zip.file(partName)?.async('string');
    if (!source) throw new Error('LOCAL_XLSX_FORMAT_INVALID');
    const patched = patchWorksheetXml(source, replacements);
    if (patched.changed !== replacements.size) throw new Error('LOCAL_XLSX_CELL_MAP_INVALID');
    changedCells += patched.changed;
    zip.file(partName, patched.xml);
  }
  await applySheetRenames(zip, sheetPlan.renames);
  // 共享字符串表里不再被引用的旧文字（改写前的原文）清空。
  const clearedStrings = await cleanSharedStrings(zip);
  const finished = await finishPackage(zip, findings, options);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, redactions: applied.size, changedUnits: changedCells, renamedSheets: sheetPlan.renames.size, clearedStrings, sweptUnits: finished.swept };
}

async function renderRedactedOffice(session, findings, outputPath, options = {}) {
  if (!session || !OFFICE_EXTENSIONS.includes(`.${session.kind}`)) throw new Error('LOCAL_OFFICE_SESSION_INVALID');
  const rendered = session.kind === 'docx' ? await renderDocx(session, findings, options) : await renderXlsx(session, findings, options);
  await fs.writeFile(outputPath, rendered.buffer);
  return {
    bytes: rendered.buffer.length,
    redactions: rendered.redactions,
    changedUnits: rendered.changedUnits,
    renamedSheets: rendered.renamedSheets || 0,
    clearedStrings: rendered.clearedStrings || 0,
    sweptUnits: rendered.sweptUnits || 0,
    longTailReport: session.longTailReport || null
  };
}

async function restoreReversibleOffice(inputPath, mapping, outputPath) {
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw new Error('LOCAL_PATH_INVALID');
  const document = await extractOfficeDocument(inputPath);
  const report = officeTokenFindings(document.text, mapping);
  if (!report.findings.length) throw new Error('LOCAL_OFFICE_REVERSIBLE_TOKENS_NOT_FOUND');
  const rendered = await renderRedactedOffice(document.session, report.findings, outputPath, { restore: true });
  return {
    sourceName: document.name,
    kind: document.session.kind,
    ...rendered,
    knownTokens: report.knownTokens,
    restoredOccurrences: report.restoredOccurrences,
    missingTokens: report.missingTokens,
    repeatedTokens: report.repeatedTokens,
    unknownTokens: report.unknownTokens,
    complete: report.complete
  };
}

module.exports = {
  convertXlsToXlsx,
  OFFICE_EXTENSIONS,
  MAX_OFFICE_BYTES,
  extractOfficeDocument,
  renderRedactedOffice,
  restoreReversibleOffice,
  officeTokenFindings,
  normalizeReversibleMapping,
  parseWordPart,
  applyMappedFindings,
  patchWorksheetXml,
  inspectOfficeLongTail,
  decodeXml,
  encodeXml
};

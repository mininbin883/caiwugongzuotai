'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { inspectOfficeLongTail } = require('./office-long-tail-service.cjs');

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
  const tokenPattern = /<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>|<\/w:p>/gi;
  for (const match of xml.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^<w:t\b/i.test(token)) {
      const openEnd = token.indexOf('>') + 1;
      const closeStart = token.toLowerCase().lastIndexOf('</w:t>');
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
  if (!Array.isArray(mapping) || !mapping.length || mapping.length > 10000) throw new Error('LOCAL_OFFICE_REVERSIBLE_MAPPING_INVALID');
  const seen = new Set();
  return mapping.map((entry) => {
    const token = String(entry?.token || '');
    const value = String(entry?.value ?? '');
    const occurrences = Number(entry?.occurrences || 1);
    if (!REVERSIBLE_TOKEN_PATTERN.test(token) || seen.has(token) || !value || value.length > 100000 ||
      !Number.isSafeInteger(occurrences) || occurrences < 1 || occurrences > 100000) {
      throw new Error('LOCAL_OFFICE_REVERSIBLE_MAPPING_INVALID');
    }
    seen.add(token);
    return { token, value, occurrences, type: String(entry?.type || 'custom'), label: String(entry?.label || entry?.type || '自定义') };
  });
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
  if (!cell || cell.f) return null;
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
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const partName = partBySheet.get(sheetName);
    if (!sheet || !partName) continue;
    if (text) text += '\n\f\n';
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
    session: { kind: 'xlsx', sourceName: path.basename(filePath), sourcePath: path.resolve(filePath), cells, longTailReport },
    longTailReport
  };
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

async function renderDocx(session, findings) {
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
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, redactions: applied.size, changedUnits: changedNodes };
}

function patchWorksheetXml(xml, replacements) {
  let changed = 0;
  const output = xml.replace(/<([A-Za-z_][\w.-]*:)?c\b([^>]*)>([\s\S]*?)<\/\1c>/gi, (full, prefix = '', attributes) => {
    const address = attributeValue(attributes, 'r');
    if (!replacements.has(address)) return full;
    let updatedAttributes = attributes.replace(/\s+t=(['"])[\s\S]*?\1/i, '');
    updatedAttributes = updatedAttributes.trimEnd();
    changed += 1;
    return `<${prefix}c${updatedAttributes} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${encodeXml(replacements.get(address))}</${prefix}t></${prefix}is></${prefix}c>`;
  });
  return { xml: output, changed };
}

async function renderXlsx(session, findings) {
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
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, redactions: applied.size, changedUnits: changedCells };
}

async function renderRedactedOffice(session, findings, outputPath) {
  if (!session || !OFFICE_EXTENSIONS.includes(`.${session.kind}`)) throw new Error('LOCAL_OFFICE_SESSION_INVALID');
  const rendered = session.kind === 'docx' ? await renderDocx(session, findings) : await renderXlsx(session, findings);
  await fs.writeFile(outputPath, rendered.buffer);
  return {
    bytes: rendered.buffer.length,
    redactions: rendered.redactions,
    changedUnits: rendered.changedUnits,
    longTailReport: session.longTailReport || null
  };
}

async function restoreReversibleOffice(inputPath, mapping, outputPath) {
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw new Error('LOCAL_PATH_INVALID');
  const document = await extractOfficeDocument(inputPath);
  const report = officeTokenFindings(document.text, mapping);
  if (!report.findings.length) throw new Error('LOCAL_OFFICE_REVERSIBLE_TOKENS_NOT_FOUND');
  const rendered = await renderRedactedOffice(document.session, report.findings, outputPath);
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

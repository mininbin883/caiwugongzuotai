'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const iconv = require('iconv-lite');

const MAX_CSV_BYTES = 100 * 1024 * 1024;
const DELIMITERS = [',', ';', '\t', '|'];

function detectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf8', bom: Buffer.from([0xef, 0xbb, 0xbf]), offset: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf16le', bom: Buffer.from([0xff, 0xfe]), offset: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf16-be', bom: Buffer.from([0xfe, 0xff]), offset: 2 };
  }
  const utf8 = bytes.toString('utf8');
  const replacementRatio = (utf8.match(/\uFFFD/gu) || []).length / Math.max(1, utf8.length);
  return { encoding: replacementRatio < 0.002 ? 'utf8' : 'gb18030', bom: Buffer.alloc(0), offset: 0 };
}

function decodeCsvBuffer(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const detected = detectEncoding(buffer);
  const payload = buffer.subarray(detected.offset);
  const text = detected.encoding === 'utf8' ? payload.toString('utf8') : iconv.decode(payload, detected.encoding);
  return { text, encoding: detected.encoding, bom: detected.bom };
}

function lineEndingOf(text) {
  const crlf = (text.match(/\r\n/gu) || []).length;
  const lf = (text.match(/(?<!\r)\n/gu) || []).length;
  const cr = (text.match(/\r(?!\n)/gu) || []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return '\r\n';
  if (lf >= cr && lf > 0) return '\n';
  if (cr > 0) return '\r';
  return '';
}

function scanCsvFields(text, delimiter, quote = '"') {
  const source = String(text || '');
  const rows = [];
  let row = [];
  let fieldStart = 0;
  let inQuotes = false;
  let index = 0;
  const pushField = (end) => row.push({ start: fieldStart, end, raw: source.slice(fieldStart, end) });
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const character = source[index];
    if (character === quote) {
      if (inQuotes && source[index + 1] === quote) index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && character === delimiter) {
      pushField(index);
      fieldStart = index + 1;
    } else if (!inQuotes && (character === '\r' || character === '\n')) {
      pushField(index);
      pushRow();
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      fieldStart = index + 1;
    }
    index += 1;
  }
  if (fieldStart < source.length || row.length || (!rows.length && source.length)) {
    pushField(source.length);
    pushRow();
  }
  return rows;
}

function meaningfulCounts(rows) {
  return rows
    .filter((row) => row.some((field) => field.raw.length > 0))
    .map((row) => row.length);
}

function detectDelimiter(text) {
  let best = { delimiter: ',', score: -1 };
  for (const delimiter of DELIMITERS) {
    const counts = meaningfulCounts(scanCsvFields(text, delimiter)).slice(0, 40);
    const frequencies = new Map();
    for (const count of counts) frequencies.set(count, (frequencies.get(count) || 0) + 1);
    const [mode = 1, frequency = 0] = [...frequencies].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [];
    const score = mode > 1 ? frequency * 1000 + mode * 10 + counts.length : counts.length;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function formulaOffset(raw, quote = '"') {
  let offset = raw.startsWith(quote) ? 1 : 0;
  while (raw[offset] === ' ' || raw[offset] === '\t') offset += 1;
  const marker = raw[offset];
  const next = raw[offset + 1] || '';
  if (marker === '=' || marker === '@') return offset;
  if ((marker === '+' || marker === '-') && !/[0-9.]/u.test(next)) return offset;
  return -1;
}

function inspectCsvText(text, delimiter = detectDelimiter(text)) {
  const rows = scanCsvFields(text, delimiter);
  const rowFieldCounts = meaningfulCounts(rows);
  let formulaCells = 0;
  for (const row of rows) {
    for (const field of row) if (formulaOffset(field.raw) >= 0) formulaCells += 1;
  }
  return {
    delimiter,
    lineEnding: lineEndingOf(text),
    rows: rowFieldCounts.length,
    columns: rowFieldCounts.length ? Math.max(...rowFieldCounts) : 0,
    rowFieldCounts,
    formulaCells
  };
}

function sanitizeFormulaCells(text, delimiter) {
  const rows = scanCsvFields(text, delimiter);
  const inserts = [];
  for (const row of rows) {
    for (const field of row) {
      const offset = formulaOffset(field.raw);
      if (offset >= 0) inserts.push(field.start + offset);
    }
  }
  let output = String(text || '');
  for (const index of inserts.sort((left, right) => right - left)) {
    output = `${output.slice(0, index)}'${output.slice(index)}`;
  }
  return { text: output, escaped: inserts.length };
}

function delimiterName(delimiter) {
  return delimiter === '\t' ? 'TAB' : delimiter === ';' ? '分号' : delimiter === '|' ? '竖线' : '逗号';
}

function lineEndingName(lineEnding) {
  return lineEnding === '\r\n' ? 'CRLF' : lineEnding === '\r' ? 'CR' : lineEnding === '\n' ? 'LF' : 'NONE';
}

function sameStructure(left, right) {
  return left.delimiter === right.delimiter && left.lineEnding === right.lineEnding && left.rowFieldCounts.length === right.rowFieldCounts.length &&
    left.rowFieldCounts.every((count, index) => count === right.rowFieldCounts[index]);
}

function encodeCsvText(text, session) {
  const payload = session.encoding === 'utf8' ? Buffer.from(text, 'utf8') : iconv.encode(text, session.encoding);
  return session.bom?.length ? Buffer.concat([session.bom, payload]) : payload;
}

async function extractCsvDocument(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_CSV_PATH_INVALID');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('LOCAL_CSV_NOT_A_FILE');
  if (stat.size > MAX_CSV_BYTES) throw new Error('LOCAL_CSV_TOO_LARGE');
  const bytes = await fs.readFile(filePath);
  const decoded = decodeCsvBuffer(bytes);
  if (!decoded.text.trim()) throw new Error('LOCAL_CSV_EMPTY');
  const inspection = inspectCsvText(decoded.text);
  const session = {
    kind: 'csv',
    sourceName: path.basename(filePath),
    sourcePath: path.resolve(filePath),
    sourceBytes: stat.size,
    encoding: decoded.encoding,
    bom: decoded.bom,
    delimiter: inspection.delimiter,
    lineEnding: inspection.lineEnding,
    inspection
  };
  return {
    name: session.sourceName,
    extension: '.csv',
    sourceBytes: stat.size,
    characters: decoded.text.length,
    text: decoded.text,
    session,
    metadata: {
      encoding: session.encoding,
      bom: session.bom.length > 0,
      delimiter: session.delimiter,
      delimiterName: delimiterName(session.delimiter),
      lineEnding: session.lineEnding,
      lineEndingName: lineEndingName(session.lineEnding),
      rows: inspection.rows,
      columns: inspection.columns,
      formulaCells: inspection.formulaCells
    }
  };
}

async function renderRedactedCsv(session, text, outputPath, options = {}) {
  if (!session || session.kind !== 'csv') throw new Error('LOCAL_CSV_SESSION_INVALID');
  if (typeof text !== 'string') throw new Error('LOCAL_CSV_TEXT_INVALID');
  const inspection = inspectCsvText(text, session.delimiter);
  if (!sameStructure(session.inspection, inspection)) throw new Error('LOCAL_CSV_STRUCTURE_CHANGED');
  const protectedOutput = options.sanitizeFormulas === false
    ? { text, escaped: 0 }
    : sanitizeFormulaCells(text, session.delimiter);
  const bytes = encodeCsvText(protectedOutput.text, session);
  if (bytes.length > MAX_CSV_BYTES) throw new Error('LOCAL_CSV_TOO_LARGE');
  await fs.writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  return {
    bytes: bytes.length,
    characters: protectedOutput.text.length,
    encoding: session.encoding,
    bomPreserved: session.bom.length > 0,
    delimiter: session.delimiter,
    delimiterName: delimiterName(session.delimiter),
    lineEnding: session.lineEnding,
    lineEndingName: lineEndingName(session.lineEnding),
    rows: inspection.rows,
    columns: inspection.columns,
    formulaCellsEscaped: protectedOutput.escaped,
    originalFormatPreserved: true
  };
}

module.exports = {
  MAX_CSV_BYTES,
  decodeCsvBuffer,
  detectDelimiter,
  inspectCsvText,
  sanitizeFormulaCells,
  extractCsvDocument,
  renderRedactedCsv
};

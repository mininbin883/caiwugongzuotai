'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const iconv = require('iconv-lite');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log', '.pdf', '.docx', '.xlsx', '.xls'];

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function decodeText(bytes) {
  const utf8 = bytes.toString('utf8');
  const replacementRatio = (utf8.match(/\uFFFD/g) || []).length / Math.max(1, utf8.length);
  return replacementRatio < 0.002 ? utf8 : iconv.decode(bytes, 'gb18030');
}

async function extractPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false
  });
  const pdf = await task.promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || '').join(' '));
    page.cleanup();
  }
  await pdf.destroy();
  return pages.join('\n\n');
}

function extractWorkbook(bytes) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellNF: false, cellStyles: false });
  return workbook.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name], { FS: '\t', blankrows: false });
    return `【工作表：${name}】\n${csv}`;
  }).join('\n\n');
}

async function extractDocument(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_PATH_INVALID');
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new Error('LOCAL_TYPE_UNSUPPORTED');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > MAX_INPUT_BYTES) throw new Error('LOCAL_FILE_TOO_LARGE');
  const bytes = await fs.readFile(filePath);

  let text;
  if (['.txt', '.md', '.csv', '.json', '.log'].includes(extension)) {
    text = decodeText(bytes);
  } else if (extension === '.docx') {
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } else if (extension === '.pdf') {
    text = await extractPdf(bytes);
  } else {
    text = extractWorkbook(bytes);
  }

  text = normalizeText(text);
  if (!text) throw new Error('LOCAL_DOCUMENT_EMPTY');
  return {
    name: path.basename(filePath),
    extension,
    sourceBytes: stat.size,
    characters: text.length,
    text
  };
}

module.exports = { extractDocument, normalizeText, SUPPORTED_EXTENSIONS, MAX_INPUT_BYTES };

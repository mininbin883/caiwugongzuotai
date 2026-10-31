'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { createWorker, OEM, PSM } = require('tesseract.js');
const { recognizeWithRapidOcr } = require('./rapidocr-service.cjs');

const IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 40 * 1024 * 1024;
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 900;
const MIN_OCR_SHORT_EDGE = 900;
const LOW_RES_SHORT_EDGE = 480;
const MAX_ENHANCEMENT_SCALE = 3;
const LOW_CONTRAST_STDEV = 28;
const CORRECTION_THRESHOLD = 72;
const OCR_RETRY_CONFIDENCE = 58;
const GRID_ANALYSIS_MAX_EDGE = 2200;
const GRID_DARK_THRESHOLD = 112;

let workerPromise;
let workerQueue = Promise.resolve();

function requestedOcrBackend(options = {}) {
  const value = String(options.backend || process.env.VEILFORGE_OCR_BACKEND || 'auto').trim().toLowerCase();
  if (!['auto', 'tesseract', 'rapidocr'].includes(value)) throw new Error('LOCAL_OCR_BACKEND_INVALID');
  return value;
}

function ocrDataPath() {
  if (process.env.VEILFORGE_OCR_DATA) return path.resolve(process.env.VEILFORGE_OCR_DATA);
  if (process.resourcesPath && !process.defaultApp) return path.join(process.resourcesPath, 'ocr-data');
  return path.resolve(__dirname, '../../ocr-data');
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
      langPath: ocrDataPath(),
      gzip: true,
      logger: () => {}
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        user_defined_dpi: '300',
        preserve_interword_spaces: '1'
      });
      return worker;
    }).catch((error) => {
      workerPromise = undefined;
      throw error;
    });
  }
  return workerPromise;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clusterWordsIntoRows(values) {
  const words = (values || []).filter((word) => word?.bbox).slice().sort((left, right) => {
    const leftCenter = (left.bbox.y0 + left.bbox.y1) / 2;
    const rightCenter = (right.bbox.y0 + right.bbox.y1) / 2;
    return leftCenter - rightCenter || left.bbox.x0 - right.bbox.x0;
  });
  const typicalHeight = Math.max(8, median(words.map((word) => Math.max(1, word.bbox.y1 - word.bbox.y0))));
  const rows = [];
  for (const word of words) {
    const center = (word.bbox.y0 + word.bbox.y1) / 2;
    let row = rows.find((candidate) => Math.abs(center - candidate.center) <= typicalHeight * 0.58);
    if (!row) {
      row = { center, words: [] };
      rows.push(row);
    }
    row.words.push(word);
    row.center = row.words.reduce((sum, item) => sum + (item.bbox.y0 + item.bbox.y1) / 2, 0) / row.words.length;
  }
  return rows
    .sort((left, right) => left.center - right.center)
    .map((row, lineIndex) => ({
      lineIndex,
      words: row.words.sort((left, right) => left.bbox.x0 - right.bbox.x0),
      y0: Math.min(...row.words.map((word) => word.bbox.y0)),
      y1: Math.max(...row.words.map((word) => word.bbox.y1))
    }));
}

function detectDocumentColumns(words, width = 0, height = 0) {
  const values = (words || []).filter((word) => word?.bbox);
  if (values.length < 8 || width < 240) return [];
  const intervals = values.map((word) => ({ left: word.bbox.x0, right: word.bbox.x1 })).sort((a, b) => a.left - b.left);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (!last || interval.left > last.right) merged.push({ ...interval });
    else last.right = Math.max(last.right, interval.right);
  }
  const candidateGaps = [];
  for (let index = 1; index < merged.length; index += 1) {
    const left = merged[index - 1].right;
    const right = merged[index].left;
    const gap = right - left;
    const middle = (left + right) / 2;
    if (gap >= Math.max(36, width * 0.07) && middle > width * 0.18 && middle < width * 0.82) candidateGaps.push({ left, right, gap, middle });
  }
  candidateGaps.sort((a, b) => b.gap - a.gap);
  for (const gap of candidateGaps) {
    const leftWords = values.filter((word) => (word.bbox.x0 + word.bbox.x1) / 2 < gap.middle);
    const rightWords = values.filter((word) => (word.bbox.x0 + word.bbox.x1) / 2 > gap.middle);
    if (leftWords.length < 4 || rightWords.length < 4) continue;
    const leftRows = clusterWordsIntoRows(leftWords);
    const rightRows = clusterWordsIntoRows(rightWords);
    const strongGutter = gap.gap >= Math.max(72, width * 0.12);
    if (leftRows.length < (strongGutter ? 2 : 3) || rightRows.length < (strongGutter ? 2 : 3)) continue;
    const typicalHeight = Math.max(8, median(values.map((word) => word.bbox.y1 - word.bbox.y0)));
    const aligned = leftRows.filter((leftRow) => rightRows.some((rightRow) => Math.abs(leftRow.center - rightRow.center) <= typicalHeight * 0.8)).length;
    const alignmentRatio = aligned / Math.max(1, Math.min(leftRows.length, rightRows.length));
    // A wide, persistent gutter is a stronger column signal than row alignment.
    // Without this exception, aligned two-column forms are flattened row-wise and
    // split email/identifier values at the page edge.
    if (alignmentRatio >= 0.65 && !strongGutter) continue;
    const pageHeight = height || Math.max(...values.map((word) => word.bbox.y1));
    const makeColumn = (columnWords, id) => ({
      id,
      wordCount: columnWords.length,
      bbox: {
        x0: Math.min(...columnWords.map((word) => word.bbox.x0)),
        y0: Math.min(...columnWords.map((word) => word.bbox.y0)),
        x1: Math.max(...columnWords.map((word) => word.bbox.x1)),
        y1: Math.max(...columnWords.map((word) => word.bbox.y1))
      }
    });
    const columns = [makeColumn(leftWords, 'column-1'), makeColumn(rightWords, 'column-2')];
    if (columns.some((column) => column.bbox.y1 - column.bbox.y0 < pageHeight * 0.18)) continue;
    return columns.map((column) => ({ ...column, gutter: { x0: gap.left, x1: gap.right }, alignmentRatio: Number(alignmentRatio.toFixed(3)) }));
  }
  return [];
}

function orderWordsForLayout(words, width = 0, height = 0) {
  const columns = detectDocumentColumns(words, width, height);
  const groups = columns.length === 2
    ? columns.map((column) => words.filter((word) => {
      const center = (word.bbox.x0 + word.bbox.x1) / 2;
      return center >= column.bbox.x0 && center <= column.bbox.x1;
    }))
    : [words];
  const orderedRows = [];
  for (const group of groups) orderedRows.push(...clusterWordsIntoRows(group));
  return { rows: orderedRows, columns, readingOrder: columns.length === 2 ? 'columns-left-to-right' : 'rows-top-to-bottom' };
}

function detectTableRegions(words, width = 0, height = 0) {
  const rows = clusterWordsIntoRows(words).filter((row) => row.words.length >= 2);
  if (rows.length < 2) return [];
  const typicalHeight = Math.max(8, median(rows.map((row) => row.y1 - row.y0)));
  const groups = [];
  for (const row of rows) {
    const group = groups[groups.length - 1];
    if (!group || row.y0 - group[group.length - 1].y1 > typicalHeight * 2.8) groups.push([row]);
    else group.push(row);
  }
  const regions = [];
  for (const group of groups.filter((candidate) => candidate.length >= 2)) {
    const anchors = [];
    const tolerance = Math.max(24, Number(width || 0) * 0.025);
    for (const row of group) {
      for (const word of row.words) {
        const x = word.bbox.x0;
        let anchor = anchors.find((candidate) => Math.abs(candidate.x - x) <= tolerance);
        if (!anchor) {
          anchor = { x, rows: new Set() };
          anchors.push(anchor);
        }
        anchor.rows.add(row.lineIndex);
        anchor.x = (anchor.x * (anchor.rows.size - 1) + x) / anchor.rows.size;
      }
    }
    const stableColumns = anchors.filter((anchor) => anchor.rows.size >= Math.max(2, Math.ceil(group.length * 0.6))).length;
    if (stableColumns < 2) continue;
    const groupWords = group.flatMap((row) => row.words);
    const padding = Math.max(4, Math.round(typicalHeight * 0.25));
    const left = Math.max(0, Math.min(...groupWords.map((word) => word.bbox.x0)) - padding);
    const top = Math.max(0, Math.min(...groupWords.map((word) => word.bbox.y0)) - padding);
    const right = Math.min(width || Number.MAX_SAFE_INTEGER, Math.max(...groupWords.map((word) => word.bbox.x1)) + padding);
    const bottom = Math.min(height || Number.MAX_SAFE_INTEGER, Math.max(...groupWords.map((word) => word.bbox.y1)) + padding);
    regions.push({
      id: `table-${regions.length + 1}`,
      rows: group.length,
      columns: stableColumns,
      confidence: Math.min(1, stableColumns / Math.max(...group.map((row) => row.words.length))),
      bbox: { x0: left, y0: top, x1: right, y1: bottom }
    });
  }
  return regions;
}

function buildCorrectionQueue(words, threshold = CORRECTION_THRESHOLD) {
  const limit = Number.isFinite(Number(threshold)) ? Math.max(0, Math.min(100, Number(threshold))) : CORRECTION_THRESHOLD;
  return (words || []).map((word, wordIndex) => ({ word, wordIndex }))
    .filter(({ word }) => Number(word.confidence || 0) < limit && String(word.text || '').trim())
    .map(({ word, wordIndex }) => ({
      id: `ocr-${wordIndex}`,
      wordIndex,
      text: String(word.text),
      confidence: Number(word.confidence || 0),
      start: word.start,
      end: word.end,
      bbox: { ...word.bbox }
    }));
}

function rebuildMappedWords(words, globalOffset = 0, options = {}) {
  const width = Number(options.width || Math.max(0, ...(words || []).map((word) => word?.bbox?.x1 || 0)));
  const height = Number(options.height || Math.max(0, ...(words || []).map((word) => word?.bbox?.y1 || 0)));
  const layout = orderWordsForLayout(words, width, height);
  const rows = layout.rows;
  let text = '';
  const mapped = [];
  const asciiWord = /[A-Za-z0-9]$/u;
  const asciiStart = /^[A-Za-z0-9]/u;
  for (const [lineIndex, row] of rows.entries()) {
    if (text) text += '\n';
    let previous = '';
    let previousWord = null;
    let previousSourceRecord = null;
    const sourceCursors = new Map();
    for (const word of row.words) {
      const value = String(word.text || '').trim();
      if (!value) continue;
      const centerX = (Number(word.bbox?.x0 || 0) + Number(word.bbox?.x1 || 0)) / 2;
      const centerY = (Number(word.bbox?.y0 || 0) + Number(word.bbox?.y1 || 0)) / 2;
      const sourceRecord = (options.lineRecords || [])
        .filter((line) => centerY >= Number(line.bbox?.y0 || 0) - 4 && centerY <= Number(line.bbox?.y1 || 0) + 4)
        .sort((left, right) => {
          const leftDistance = centerX < left.bbox.x0 ? left.bbox.x0 - centerX : centerX > left.bbox.x1 ? centerX - left.bbox.x1 : 0;
          const rightDistance = centerX < right.bbox.x0 ? right.bbox.x0 - centerX : centerX > right.bbox.x1 ? centerX - right.bbox.x1 : 0;
          return leftDistance - rightDistance;
        })[0] || null;
      const sourceCursor = sourceRecord ? sourceCursors.get(sourceRecord) || 0 : 0;
      const sourceIndex = sourceRecord ? sourceRecord.text.indexOf(value, sourceCursor) : -1;
      const explicitWhitespace = sourceIndex >= 0 && /\s/u.test(sourceRecord.text.slice(sourceCursor, sourceIndex));
      const separateDetection = Boolean(previousSourceRecord && sourceRecord && previousSourceRecord !== sourceRecord);
      if (previous && asciiWord.test(previous) && asciiStart.test(value)) {
        const gap = Number(word.bbox?.x0 || 0) - Number(previousWord?.bbox?.x1 || 0);
        const height = Math.max(1, Number(word.bbox?.y1 || 0) - Number(word.bbox?.y0 || 0));
        if (separateDetection || explicitWhitespace || (!sourceRecord && (!options.geometricSpacing || gap >= Math.max(2, height * 0.28)))) text += ' ';
      }
      const start = globalOffset + text.length;
      text += value;
      mapped.push({ ...word, text: value, start, end: globalOffset + text.length, lineIndex });
      previous = value;
      previousWord = word;
      previousSourceRecord = sourceRecord;
      if (sourceRecord && sourceIndex >= 0) sourceCursors.set(sourceRecord, sourceIndex + value.length);
    }
  }
  return { text: text.trim(), words: mapped, columns: layout.columns, readingOrder: layout.readingOrder };
}

function applyOcrCorrections(words, corrections, globalOffset = 0) {
  if (!Array.isArray(words) || !Array.isArray(corrections) || corrections.length > 500) throw new Error('LOCAL_OCR_CORRECTIONS_INVALID');
  const updated = words.map((word) => ({ ...word, bbox: { ...word.bbox } }));
  let changed = 0;
  for (const correction of corrections) {
    const wordIndex = Number(correction?.wordIndex);
    const text = String(correction?.text ?? '').trim();
    if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= updated.length || !text || text.length > 128 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
      throw new Error('LOCAL_OCR_CORRECTION_INVALID');
    }
    if (updated[wordIndex].text !== text) {
      updated[wordIndex].text = text;
      updated[wordIndex].confidence = 100;
      updated[wordIndex].corrected = true;
      changed += 1;
    }
  }
  const width = Math.max(0, ...updated.map((word) => word.bbox.x1));
  const height = Math.max(0, ...updated.map((word) => word.bbox.y1));
  return { ...rebuildMappedWords(updated, globalOffset, { width, height }), changed };
}

function flattenWords(blocks, options = {}) {
  const values = [];
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        values.push(...(line.words || [])
          .filter((word) => word && String(word.text || '').trim() && word.bbox)
          .map((word) => ({
            text: String(word.text).trim(),
            confidence: Number(word.confidence || 0),
            bbox: {
              x0: Math.round(word.bbox.x0),
              y0: Math.round(word.bbox.y0),
              x1: Math.round(word.bbox.x1),
              y1: Math.round(word.bbox.y1)
            }
          })));
      }
    }
  }
  const mapped = rebuildMappedWords(values, 0, options);
  const tableRegions = detectTableRegions(mapped.words, options.width, options.height);
  for (const word of mapped.words) {
    const region = tableRegions.find((candidate) => word.bbox.x0 < candidate.bbox.x1 && candidate.bbox.x0 < word.bbox.x1 &&
      word.bbox.y0 < candidate.bbox.y1 && candidate.bbox.y0 < word.bbox.y1);
    if (region) word.regionId = region.id;
  }
  return { ...mapped, tableRegions, corrections: buildCorrectionQueue(mapped.words) };
}

function findBoxesForFindings(words, findings, width, height) {
  const boxes = [];
  const seen = new Set();
  for (const finding of findings || []) {
    if (finding.enabled === false || !Number.isInteger(finding.start) || !Number.isInteger(finding.end)) continue;
    for (const word of words || []) {
      if (finding.start >= word.end || word.start >= finding.end) continue;
      const padding = Math.max(2, Math.round((word.bbox.y1 - word.bbox.y0) * 0.08));
      const left = Math.max(0, word.bbox.x0 - padding);
      const top = Math.max(0, word.bbox.y0 - padding);
      const right = Math.min(width, word.bbox.x1 + padding);
      const bottom = Math.min(height, word.bbox.y1 + padding);
      const key = `${left}:${top}:${right}:${bottom}`;
      if (!seen.has(key) && right > left && bottom > top) {
        seen.add(key);
        boxes.push({ left, top, width: right - left, height: bottom - top });
      }
    }
  }
  return boxes;
}

function clusterLineIndices(indices, maxGap = 2) {
  const groups = [];
  for (const value of indices) {
    const group = groups[groups.length - 1];
    if (!group || value - group[group.length - 1] > maxGap) groups.push([value]);
    else group.push(value);
  }
  return groups.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length));
}

function darkCoverage(raw, width, x0, y0, x1, y1, axis) {
  let dark = 0;
  let total = 0;
  if (axis === 'vertical') {
    for (let y = Math.max(0, y0); y <= Math.min(y1, Math.floor(raw.length / width) - 1); y += 1) {
      let pixelDark = false;
      for (let x = Math.max(0, x0 - 1); x <= Math.min(width - 1, x0 + 1); x += 1) pixelDark ||= raw[y * width + x] < GRID_DARK_THRESHOLD;
      dark += pixelDark ? 1 : 0;
      total += 1;
    }
  } else {
    for (let x = Math.max(0, x0); x <= Math.min(x1, width - 1); x += 1) {
      let pixelDark = false;
      const maxY = Math.floor(raw.length / width) - 1;
      for (let y = Math.max(0, y0 - 1); y <= Math.min(maxY, y0 + 1); y += 1) pixelDark ||= raw[y * width + x] < GRID_DARK_THRESHOLD;
      dark += pixelDark ? 1 : 0;
      total += 1;
    }
  }
  return total ? dark / total : 0;
}

function recoverMergedGridCells(xLines, yLines, raw, width) {
  const rows = yLines.length - 1;
  const columns = xLines.length - 1;
  if (rows < 1 || columns < 1) return [];
  const parent = Array.from({ length: rows * columns }, (_, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = current;
      index = next;
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const coverage = darkCoverage(raw, width, xLines[column], yLines[row] + 2, xLines[column], yLines[row + 1] - 2, 'vertical');
      if (coverage < 0.48) union(row * columns + column - 1, row * columns + column);
    }
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const coverage = darkCoverage(raw, width, xLines[column] + 2, yLines[row], xLines[column + 1] - 2, yLines[row], 'horizontal');
      if (coverage < 0.48) union((row - 1) * columns + column, row * columns + column);
    }
  }
  const groups = new Map();
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const root = find(row * columns + column);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push({ row, column });
    }
  }
  return [...groups.values()].map((members, index) => {
    const rowStart = Math.min(...members.map((cell) => cell.row));
    const rowEnd = Math.max(...members.map((cell) => cell.row)) + 1;
    const columnStart = Math.min(...members.map((cell) => cell.column));
    const columnEnd = Math.max(...members.map((cell) => cell.column)) + 1;
    return {
      id: `cell-${index + 1}`,
      row: rowStart,
      column: columnStart,
      rowSpan: rowEnd - rowStart,
      columnSpan: columnEnd - columnStart,
      merged: members.length > 1,
      bbox: { x0: xLines[columnStart], y0: yLines[rowStart], x1: xLines[columnEnd], y1: yLines[rowEnd] }
    };
  });
}

async function detectTableGrid(image) {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) return [];
  const scale = Math.min(1, GRID_ANALYSIS_MAX_EDGE / Math.max(metadata.width, metadata.height));
  const analyzed = await sharp(image)
    .resize({ width: Math.max(1, Math.round(metadata.width * scale)), height: Math.max(1, Math.round(metadata.height * scale)), fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = analyzed.info.width;
  const height = analyzed.info.height;
  const horizontal = [];
  const vertical = [];
  for (let y = 0; y < height; y += 1) {
    let dark = 0;
    for (let x = 0; x < width; x += 1) dark += analyzed.data[y * width + x] < GRID_DARK_THRESHOLD ? 1 : 0;
    if (dark >= Math.max(80, width * 0.32)) horizontal.push(y);
  }
  for (let x = 0; x < width; x += 1) {
    let dark = 0;
    for (let y = 0; y < height; y += 1) dark += analyzed.data[y * width + x] < GRID_DARK_THRESHOLD ? 1 : 0;
    if (dark >= Math.max(60, height * 0.35)) vertical.push(x);
  }
  const xLines = clusterLineIndices(vertical).filter((value, index, all) => index === 0 || value - all[index - 1] >= 12);
  const yLines = clusterLineIndices(horizontal).filter((value, index, all) => index === 0 || value - all[index - 1] >= 12);
  if (xLines.length < 2 || yLines.length < 2) return [];
  const cells = recoverMergedGridCells(xLines, yLines, analyzed.data, width);
  if (!cells.length) return [];
  const inv = 1 / scale;
  const mapBox = (bbox) => ({
    x0: Math.round(bbox.x0 * inv), y0: Math.round(bbox.y0 * inv),
    x1: Math.round(bbox.x1 * inv), y1: Math.round(bbox.y1 * inv)
  });
  return [{
    id: 'grid-1',
    rows: yLines.length - 1,
    columns: xLines.length - 1,
    mergedCells: cells.filter((cell) => cell.merged).length,
    bbox: mapBox({ x0: xLines[0], y0: yLines[0], x1: xLines[xLines.length - 1], y1: yLines[yLines.length - 1] }),
    xLines: xLines.map((value) => Math.round(value * inv)),
    yLines: yLines.map((value) => Math.round(value * inv)),
    cells: cells.map((cell) => ({ ...cell, bbox: mapBox(cell.bbox) }))
  }];
}

function queueWorkerJob(task) {
  const job = workerQueue.then(task, task);
  workerQueue = job.catch(() => {});
  return job;
}

function imageFromDataUrl(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(String(value || ''));
  return match ? Buffer.from(match[1], 'base64') : null;
}

function enhancementScale(width, height) {
  const shortEdge = Math.max(1, Math.min(width, height));
  const pixelLimit = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
  if (shortEdge >= LOW_RES_SHORT_EDGE) return 1;
  return Math.max(1, Math.min(MAX_ENHANCEMENT_SCALE, MIN_OCR_SHORT_EDGE / shortEdge, pixelLimit));
}

async function prepareOcrImage(source) {
  const normalized = await sharp(source, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 6 })
    .toBuffer({ resolveWithObject: true });
  const width = Number(normalized.info.width);
  const height = Number(normalized.info.height);
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('LOCAL_IMAGE_DIMENSIONS_INVALID');
  const stats = await sharp(normalized.data).greyscale().stats();
  const contrast = Number(stats.channels?.[0]?.stdev || 0);
  const scale = enhancementScale(width, height);
  const contrastEnhanced = scale > 1.01 && contrast < LOW_CONTRAST_STDEV;
  let pipeline = sharp(normalized.data);
  if (scale > 1.01) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      fit: 'fill',
      kernel: sharp.kernel.lanczos3
    });
  }
  if (contrastEnhanced) pipeline = pipeline.normalize().sharpen({ sigma: 0.5 });
  const processed = await pipeline.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
  return {
    data: processed.data,
    width: processed.info.width,
    height: processed.info.height,
    enhancement: {
      scale: Number(scale.toFixed(3)),
      upscaled: scale > 1.01,
      contrastEnhanced,
      sourceContrast: Number(contrast.toFixed(2)),
      sourceWidth: width,
      sourceHeight: height
    }
  };
}

function recognitionScore(result) {
  const characters = String(result?.mapped?.text || '').replace(/\s/gu, '').length;
  return Number(result?.confidence || 0) * 0.45 + mappedConfidence(result) * 0.55 + Math.min(20, characters / 4);
}

function mappedConfidence(result) {
  const words = Array.isArray(result?.mapped?.words) ? result.mapped.words : [];
  return words.reduce((sum, word) => sum + Number(word.confidence || 0), 0) / Math.max(1, words.length);
}

function needsQuarterTurnRecovery(result) {
  return !String(result?.mapped?.text || '').trim() || mappedConfidence(result) < OCR_RETRY_CONFIDENCE;
}

function reliableRecognition(result) {
  return Boolean(String(result?.mapped?.text || '').trim()) &&
    Number(result?.confidence || 0) >= OCR_RETRY_CONFIDENCE &&
    mappedConfidence(result) >= OCR_RETRY_CONFIDENCE;
}

async function recognizePass(worker, image, psm, rotateAuto = true) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const result = await worker.recognize(image, { rotateAuto }, { text: true, blocks: true, imageColor: true });
  const orientedImage = imageFromDataUrl(result.data.imageColor) || image;
  const metadata = await sharp(orientedImage).metadata();
  const mapped = flattenWords(result.data.blocks, { width: metadata.width, height: metadata.height });
  return {
    result,
    mapped,
    image: orientedImage,
    width: metadata.width,
    height: metadata.height,
    confidence: Math.round(Number(result.data.confidence || 0)),
    psm
  };
}

async function terminateWorker() {
  const active = workerPromise;
  workerPromise = undefined;
  workerQueue = Promise.resolve();
  if (active) await (await active).terminate();
}

async function recognizeImage(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_PATH_INVALID');
  const extension = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(extension)) throw new Error('LOCAL_IMAGE_TYPE_UNSUPPORTED');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('LOCAL_IMAGE_TOO_LARGE');

  const source = await fs.readFile(filePath);
  return recognizeImageBuffer(source, {
    name: path.basename(filePath),
    extension,
    sourceBytes: stat.size
  });
}

async function recognizeImageBuffer(source, options = {}) {
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) throw new Error('LOCAL_IMAGE_BUFFER_INVALID');
  if (source.byteLength > MAX_IMAGE_BYTES) throw new Error('LOCAL_IMAGE_TOO_LARGE');
  const prepared = await prepareOcrImage(source);
  const backend = requestedOcrBackend(options);
  if (backend === 'rapidocr') return recognizeRapidImageBuffer(source, prepared, options);
  if (backend === 'auto') {
    try { return await recognizeRapidImageBuffer(source, prepared, options); }
    catch (error) {
      if (!/^LOCAL_RAPIDOCR_(RUNTIME_PACK_MISSING|MODEL_PACK_MISSING)$/u.test(String(error?.message || error))) throw error;
    }
  }
  const recognized = await queueWorkerJob(async () => {
    const worker = await getWorker();
    const primary = await recognizePass(worker, prepared.data, PSM.AUTO, true);
    if (reliableRecognition(primary)) return { chosen: primary, passes: 1 };
    const unrotated = await recognizePass(worker, prepared.data, PSM.AUTO, false);
    if (reliableRecognition(unrotated)) {
      return { chosen: recognitionScore(unrotated) > recognitionScore(primary) ? unrotated : primary, passes: 2 };
    }
    const sparse = await recognizePass(worker, prepared.data, PSM.SPARSE_TEXT, false);
    const candidates = [primary, unrotated, sparse];
    const initialBest = candidates.slice().sort((left, right) => recognitionScore(right) - recognitionScore(left))[0];
    if (needsQuarterTurnRecovery(initialBest)) {
      for (const appliedRotationDegrees of [90, -90]) {
        const rotated = await sharp(prepared.data)
          .rotate(appliedRotationDegrees, { background: '#ffffff' })
          .png({ compressionLevel: 6 })
          .toBuffer();
        const candidate = await recognizePass(worker, rotated, PSM.AUTO, false);
        candidates.push({ ...candidate, appliedRotationDegrees, rotationRecovery: true });
      }
    }
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    candidates.sort((left, right) => recognitionScore(right) - recognitionScore(left));
    return { chosen: candidates[0], passes: candidates.length };
  });
  const { chosen, passes } = recognized;
  const { width, height } = chosen;
  const mapped = chosen.mapped;
  if (!mapped.text) throw new Error('LOCAL_OCR_EMPTY');
  const gridTables = await detectTableGrid(chosen.image);
  for (const word of mapped.words) {
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    const cell = gridTables.flatMap((table) => table.cells.map((item) => ({ ...item, tableId: table.id })))
      .find((item) => centerX > item.bbox.x0 && centerX < item.bbox.x1 && centerY > item.bbox.y0 && centerY < item.bbox.y1);
    if (cell) {
      word.gridTableId = cell.tableId;
      word.gridCellId = cell.id;
    }
  }
  const preview = await sharp(chosen.image)
    .resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 8 })
    .toBuffer();
  const rotateRadians = Number(chosen.result.data.rotateRadians || 0);
  const orientationDegrees = Number((Number(chosen.appliedRotationDegrees || 0) + rotateRadians * 180 / Math.PI).toFixed(2));

  return {
    name: String(options.name || 'image.png'),
    extension: String(options.extension || '.png').toLowerCase(),
    sourceBytes: Number(options.sourceBytes ?? source.byteLength),
    characters: mapped.text.length,
    text: mapped.text,
    image: chosen.image,
    width,
    height,
    words: mapped.words,
    previewDataUrl: `data:image/png;base64,${preview.toString('base64')}`,
    confidence: Math.round(mapped.words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, mapped.words.length)),
    orientationDegrees,
    orientationDetected: Math.abs(orientationDegrees) >= 0.5,
    enhancement: prepared.enhancement,
    segmentationMode: chosen.rotationRecovery ? 'auto-quarter-turn' : chosen.psm === PSM.SPARSE_TEXT ? 'sparse' : 'auto',
    rotationRecovery: Boolean(chosen.rotationRecovery),
    recognitionPasses: passes,
    tableRegions: mapped.tableRegions,
    gridTables,
    columns: mapped.columns,
    readingOrder: mapped.readingOrder,
    corrections: mapped.corrections,
    correctionThreshold: CORRECTION_THRESHOLD,
    backend: 'tesseract'
  };
}

async function recognizeRapidImageBuffer(source, prepared, options = {}) {
  const recognized = await recognizeWithRapidOcr(prepared.data, options.rapidOcr || {});
  const mapped = rebuildMappedWords(recognized.words, 0, {
    width: recognized.width,
    height: recognized.height,
    geometricSpacing: true,
    lineRecords: recognized.lineRecords
  });
  if (!mapped.text) throw new Error('LOCAL_OCR_EMPTY');
  const tableRegions = detectTableRegions(mapped.words, recognized.width, recognized.height);
  for (const word of mapped.words) {
    const region = tableRegions.find((candidate) => word.bbox.x0 < candidate.bbox.x1 && candidate.bbox.x0 < word.bbox.x1 &&
      word.bbox.y0 < candidate.bbox.y1 && candidate.bbox.y0 < word.bbox.y1);
    if (region) word.regionId = region.id;
  }
  const gridTables = await detectTableGrid(prepared.data);
  for (const word of mapped.words) {
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    const cell = gridTables.flatMap((table) => table.cells.map((item) => ({ ...item, tableId: table.id })))
      .find((item) => centerX > item.bbox.x0 && centerX < item.bbox.x1 && centerY > item.bbox.y0 && centerY < item.bbox.y1);
    if (cell) {
      word.gridTableId = cell.tableId;
      word.gridCellId = cell.id;
    }
  }
  const preview = await sharp(prepared.data)
    .resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 8 })
    .toBuffer();
  return {
    name: String(options.name || 'image.png'),
    extension: String(options.extension || '.png').toLowerCase(),
    sourceBytes: Number(options.sourceBytes ?? source.byteLength),
    characters: mapped.text.length,
    text: mapped.text,
    image: prepared.data,
    width: recognized.width,
    height: recognized.height,
    words: mapped.words,
    previewDataUrl: `data:image/png;base64,${preview.toString('base64')}`,
    confidence: Math.round(mapped.words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, mapped.words.length)),
    orientationDegrees: 0,
    orientationDetected: false,
    enhancement: prepared.enhancement,
    segmentationMode: 'rapidocr-det-rec',
    recognitionPasses: 1,
    tableRegions,
    gridTables,
    columns: mapped.columns,
    readingOrder: mapped.readingOrder,
    corrections: buildCorrectionQueue(mapped.words),
    correctionThreshold: CORRECTION_THRESHOLD,
    backend: recognized.backend,
    modelPack: recognized.modelPack,
    backendElapsedSeconds: recognized.elapsedSeconds,
    detectedLines: recognized.lines
  };
}

async function renderRedactedBuffer(session, findings, options = {}) {
  const imageInput = session?.image || (typeof session?.imagePath === 'string' && path.isAbsolute(session.imagePath) ? session.imagePath : null);
  if (!imageInput || !Array.isArray(session.words)) throw new Error('LOCAL_IMAGE_SESSION_INVALID');
  const boxes = findBoxesForFindings(session.words, findings, session.width, session.height);
  if (!boxes.length && options.requireRedactions !== false) throw new Error('LOCAL_IMAGE_NO_REDACTIONS');
  const overlays = boxes.map((box) => ({
    input: { create: { width: box.width, height: box.height, channels: 4, background: '#111614' } },
    left: box.left,
    top: box.top
  }));
  const rendered = await sharp(imageInput)
    .composite(overlays)
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: rendered.data,
    boxes: boxes.length,
    bytes: rendered.data.length,
    width: rendered.info.width,
    height: rendered.info.height
  };
}

async function renderRedactedImage(session, findings, outputPath) {
  const rendered = await renderRedactedBuffer(session, findings);
  await fs.writeFile(outputPath, rendered.buffer);
  return {
    boxes: rendered.boxes,
    bytes: rendered.bytes,
    width: rendered.width,
    height: rendered.height
  };
}

module.exports = {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  recognizeImage,
  recognizeImageBuffer,
  renderRedactedImage,
  renderRedactedBuffer,
  flattenWords,
  clusterWordsIntoRows,
  detectDocumentColumns,
  orderWordsForLayout,
  rebuildMappedWords,
  detectTableRegions,
  detectTableGrid,
  recoverMergedGridCells,
  buildCorrectionQueue,
  applyOcrCorrections,
  enhancementScale,
  prepareOcrImage,
  findBoxesForFindings,
  requestedOcrBackend,
  mappedConfidence,
  needsQuarterTurnRecovery,
  recognizeRapidImageBuffer,
  ocrDataPath,
  terminateWorker
};

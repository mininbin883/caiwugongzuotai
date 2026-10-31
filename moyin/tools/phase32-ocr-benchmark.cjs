'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { recognizeImageBuffer, terminateWorker } = require('../src/services/ocr-service.cjs');

const CASES = Object.freeze([
  {
    id: 'shadow-ticket', effect: '票据阴影', expected: 'CUSTOMER: ZHANG SAN\nMOBILE: 13812345678\nEMAIL: alice@example.com',
    sensitive: ['13812345678', 'alice@example.com'],
    render: (text) => ticketSvg(text, { shadow: true })
  },
  {
    id: 'perspective-ticket', effect: '透视/倾斜', expected: 'TRAIN ORDER 2026-10-31\nPASSENGER: LI SI\nID: 11010519491231002X',
    sensitive: ['2026-10-31', '11010519491231002X'],
    render: (text) => ticketSvg(text, { transform: 'skewX(-7) rotate(-1 600 400)' })
  },
  {
    id: 'stamp-occlusion', effect: '印章覆盖', expected: 'RECIPIENT: WANG WU\nPHONE: 13912345678\nCITY: BEIJING CHAOYANG',
    sensitive: ['13912345678', 'BEIJING CHAOYANG'],
    render: (text) => ticketSvg(text, { stamp: true })
  },
  {
    id: 'vertical-text', effect: '竖排文字', expected: 'VERTICAL OCR\nID 1234567890',
    sensitive: ['1234567890'],
    render: (text) => verticalSvg(text)
  },
  {
    id: 'phone-noise', effect: '手机噪声', expected: 'CONTACT: ZHAO LIU\nMOBILE: 13712345678\nEMAIL: bob@example.com',
    sensitive: ['13712345678', 'bob@example.com'],
    render: (text) => ticketSvg(text, { noise: true })
  },
  {
    id: 'multi-column', effect: '多栏穿插', expected: 'LEFT CUSTOMER: ZHANG SAN\nLEFT MOBILE: 13812345678\nRIGHT ORDER: alice@example.com\nRIGHT ID: 11010519491231002X',
    sensitive: ['13812345678', 'alice@example.com', '11010519491231002X'],
    render: (text) => columnsSvg(text)
  }
]);

function escapeXml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function lines(text) {
  return String(text).split('\n').map((value) => escapeXml(value));
}

function ticketSvg(text, options = {}) {
  const transform = options.transform || '';
  const shadow = options.shadow ? '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="24" dy="22" stdDeviation="18" flood-color="#324052" flood-opacity=".42"/></filter>' : '';
  const body = lines(text).map((value, index) => `<text x="120" y="${190 + index * 82}" class="line">${value}</text>`).join('');
  const stamp = options.stamp ? '<g transform="rotate(-18 860 410)" opacity=".55"><ellipse cx="860" cy="410" rx="158" ry="92" fill="none" stroke="#c92f46" stroke-width="12"/><text x="770" y="420" class="stamp">REVIEWED</text></g>' : '';
  const noise = options.noise ? Array.from({ length: 260 }, (_, index) => `<circle cx="${35 + ((index * 83) % 1130)}" cy="${45 + ((index * 47) % 700)}" r="${index % 3 === 0 ? 2 : 1}" fill="#3c4655" opacity=".${index % 5 + 1}"/>`).join('') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><defs>${shadow}<style>.line{font-family:Arial,sans-serif;font-size:42px;font-weight:600;fill:#152235}.stamp{font-family:Arial,sans-serif;font-size:30px;font-weight:700;fill:#c92f46}</style></defs><rect width="1200" height="800" fill="#e7ecf2"/><g ${transform ? `transform="${transform}"` : ''}><rect x="70" y="70" width="1060" height="660" rx="18" fill="#fffdf7" ${options.shadow ? 'filter="url(#shadow)"' : ''}/><path d="M90 145H1110" stroke="#d9dee7" stroke-width="3"/>${body}${stamp}</g>${noise}</svg>`;
}

function verticalSvg(text) {
  const [first = 'VERTICAL OCR', second = 'ID 1234567890'] = String(text).split('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#f7f4ec"/><rect x="120" y="70" width="960" height="660" fill="#fff" stroke="#344054" stroke-width="5"/><g transform="translate(370 650) rotate(-90)"><text x="0" y="0" font-family="Arial,sans-serif" font-size="58" font-weight="700" fill="#152235">${escapeXml(first)}</text></g><g transform="translate(620 680) rotate(-90)"><text x="0" y="0" font-family="Arial,sans-serif" font-size="52" font-weight="700" fill="#152235">${escapeXml(second)}</text></g></svg>`;
}

function columnsSvg(text) {
  const values = String(text).split('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="900"><rect width="1800" height="900" fill="#f2f5f8"/><rect x="60" y="55" width="1680" height="790" rx="16" fill="#fff" stroke="#b7c2d0" stroke-width="4"/><line x1="850" y1="90" x2="850" y2="810" stroke="#ccd4df" stroke-width="4"/>${values.slice(0, 2).map((value, index) => `<text x="120" y="${220 + index * 130}" font-family="Arial,sans-serif" font-size="38" font-weight="600" fill="#152235">${escapeXml(value)}</text>`).join('')}${values.slice(2).map((value, index) => `<text x="980" y="${220 + index * 130}" font-family="Arial,sans-serif" font-size="38" font-weight="600" fill="#152235">${escapeXml(value)}</text>`).join('')}</svg>`;
}

function normalizedCharacters(value) { return [...String(value || '').normalize('NFKC').toUpperCase().replace(/\s+/gu, '')]; }
function normalizedWords(value) {
  return String(value || '').normalize('NFKC').toUpperCase()
    .replace(/[^\p{L}\p{N}@._+\-]+/gu, ' ')
    .split(/\s+/u).filter(Boolean);
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]; previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function compact(value) { return String(value || '').normalize('NFKC').toUpperCase().replace(/\s+/gu, ''); }

function score(expected, actual, sensitive = []) {
  const expectedChars = normalizedCharacters(expected); const actualChars = normalizedCharacters(actual);
  const expectedWords = normalizedWords(expected); const actualWords = normalizedWords(actual);
  const charErrors = levenshtein(expectedChars, actualChars); const wordErrors = levenshtein(expectedWords, actualWords);
  const detectedSensitive = sensitive.filter((token) => compact(actual).includes(compact(token)));
  return {
    expectedCharacters: expectedChars.length, actualCharacters: actualChars.length, charErrors,
    cer: expectedChars.length ? charErrors / expectedChars.length : 0,
    expectedWords: expectedWords.length, actualWords: actualWords.length, wordErrors,
    wer: expectedWords.length ? wordErrors / expectedWords.length : 0,
    expectedSensitive: sensitive.length, detectedSensitive: detectedSensitive.length,
    sensitiveRecall: sensitive.length ? detectedSensitive.length / sensitive.length : 1,
    detectedSensitiveTokens: detectedSensitive
  };
}

async function sampleMemory(task) {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const started = process.hrtime.bigint();
  try {
    const value = await task();
    return { value, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, peakRssBytes: Math.max(peak, process.memoryUsage().rss) };
  } finally { clearInterval(timer); }
}

async function buildCorpus(directory) {
  await fs.mkdir(directory, { recursive: true });
  const manifest = [];
  for (const item of CASES) {
    const buffer = await sharp(Buffer.from(item.render(item.expected))).png({ compressionLevel: 8 }).toBuffer();
    const filePath = path.join(directory, `${item.id}.png`);
    await fs.writeFile(filePath, buffer);
    manifest.push({ id: item.id, effect: item.effect, file: filePath, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), expected: item.expected, sensitive: item.sensitive });
  }
  await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({ schema: 'VEILFORGE_OCR_PHASE32_CORPUS_V1', cases: manifest }, null, 2)}\n`, 'utf8');
  return manifest;
}

async function benchmarkCase(item, backend) {
  const source = await fs.readFile(item.file);
  try {
    const measured = await sampleMemory(() => recognizeImageBuffer(source, { name: path.basename(item.file), extension: '.png', sourceBytes: source.length, backend }));
    return { backend, case: item.id, effect: item.effect, expected: item.expected, actual: measured.value.text, elapsedMs: Number(measured.elapsedMs.toFixed(2)), peakRssBytes: measured.peakRssBytes, ...score(item.expected, measured.value.text, item.sensitive), confidence: measured.value.confidence, words: measured.value.words?.length || 0, orientationDegrees: measured.value.orientationDegrees, rotationRecovery: Boolean(measured.value.rotationRecovery), recognitionPasses: measured.value.recognitionPasses, segmentationMode: measured.value.segmentationMode, enhancementScale: measured.value.enhancement?.scale || 1, backendElapsedSeconds: measured.value.backendElapsedSeconds || null };
  } catch (error) {
    return { backend, case: item.id, effect: item.effect, expected: item.expected, actual: '', elapsedMs: null, peakRssBytes: process.memoryUsage().rss, error: String(error?.message || error), ...score(item.expected, '', item.sensitive) };
  }
}

function aggregate(rows) {
  const valid = rows.filter((row) => !row.error); const failures = rows.filter((row) => row.error);
  const expectedCharacters = rows.reduce((sum, row) => sum + row.expectedCharacters, 0);
  const charErrors = rows.reduce((sum, row) => sum + row.charErrors, 0);
  const expectedWords = rows.reduce((sum, row) => sum + row.expectedWords, 0);
  const wordErrors = rows.reduce((sum, row) => sum + row.wordErrors, 0);
  const expectedSensitive = rows.reduce((sum, row) => sum + row.expectedSensitive, 0);
  const detectedSensitive = rows.reduce((sum, row) => sum + row.detectedSensitive, 0);
  const times = valid.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(times.length * 0.95) - 1);
  return { cases: rows.length, failures: failures.length, expectedCharacters, charErrors, cer: expectedCharacters ? charErrors / expectedCharacters : 0, expectedWords, wordErrors, wer: expectedWords ? wordErrors / expectedWords : 0, expectedSensitive, detectedSensitive, detectionRecall: expectedSensitive ? detectedSensitive / expectedSensitive : 1, meanElapsedMs: valid.length ? valid.reduce((sum, row) => sum + row.elapsedMs, 0) / valid.length : null, p95ElapsedMs: times.length ? times[p95Index] : null, peakRssBytes: Math.max(0, ...rows.map((row) => row.peakRssBytes || 0)), peakRssMiB: Math.max(0, ...rows.map((row) => row.peakRssBytes || 0)) / 1024 / 1024, maxEnhancementScale: Math.max(1, ...rows.map((row) => row.enhancementScale || 1)) };
}

function recallGateStatus(aggregates, rows) {
  const rapidTargetGate = aggregates.rapidocr.detectionRecall >= 0.99 && rows
    .filter((row) => row.backend === 'rapidocr' && ['stamp-occlusion', 'multi-column'].includes(row.case))
    .every((row) => row.sensitiveRecall >= 0.99);
  const tesseractVertical = rows.find((row) => row.backend === 'tesseract' && row.case === 'vertical-text');
  const tesseractVerticalGate = Boolean(tesseractVertical && !tesseractVertical.error && tesseractVertical.sensitiveRecall >= 0.99);
  return { passed: rapidTargetGate && tesseractVerticalGate, rapidTargetGate, tesseractVerticalGate };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.resolve(process.argv[2] || path.join(root, 'output', 'ocr', 'phase32', 'corpus'));
  const reportPath = path.resolve(process.argv[3] || path.join(root, 'output', 'ocr', 'phase32', 'ocr-phase32-report.json'));
  const manifest = await buildCorpus(directory);
  const rows = [];
  for (const backend of ['rapidocr', 'tesseract']) for (const item of manifest) rows.push(await benchmarkCase(item, backend));
  const aggregates = { rapidocr: aggregate(rows.filter((row) => row.backend === 'rapidocr')), tesseract: aggregate(rows.filter((row) => row.backend === 'tesseract')) };
  const report = { schema: 'VEILFORGE_OCR_PHASE32_REPORT_V1', generatedAt: new Date().toISOString(), corpus: { schema: 'VEILFORGE_OCR_PHASE32_CORPUS_V1', cases: manifest.length, effects: CASES.map((item) => item.effect), directory }, measurement: { cer: 'normalized Unicode NFKC uppercase character edit distance; whitespace ignored', wer: 'NFKC uppercase token edit distance; punctuation spacing ignored', detectionRecall: 'expected sensitive token occurrences detected in OCR text', peakMemory: 'Node.js parent-process RSS sampled every 20 ms; RapidOCR child-process RSS excluded' }, aggregates, results: rows };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const [backend, value] of Object.entries(aggregates)) process.stdout.write(`PHASE32_BENCHMARK backend=${backend} cases=${value.cases} failures=${value.failures} CER=${value.cer.toFixed(6)} WER=${value.wer.toFixed(6)} detectionRecall=${value.detectionRecall.toFixed(6)} meanMs=${value.meanElapsedMs?.toFixed(2) || 'NA'} p95Ms=${value.p95ElapsedMs?.toFixed(2) || 'NA'} peakMiB=${value.peakRssMiB.toFixed(2)}\n`);
  const recallGate = recallGateStatus(aggregates, rows);
  process.stdout.write(`PHASE32_${recallGate.passed ? 'PASS' : 'FAIL'} corpus=6 effects=shadow,perspective,stamp,vertical,noise,multicolumn recallGate=${recallGate.passed ? 1 : 0} verticalGate=${recallGate.tesseractVerticalGate ? 1 : 0} report=${reportPath}\n`);
  if (!recallGate.passed) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`PHASE32_FAILED ${error?.stack || error}\n`); process.exitCode = 2; }).finally(() => terminateWorker().catch(() => {}));

module.exports = { CASES, score, aggregate, recallGateStatus, buildCorpus };

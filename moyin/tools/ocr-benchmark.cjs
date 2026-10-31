'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { recognizeImageBuffer, terminateWorker } = require('../src/services/ocr-service.cjs');

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function normalizedCharacters(value) {
  return [...String(value || '').normalize('NFKC').toUpperCase().replace(/\s+/gu, '')];
}

function normalizedWords(value) {
  return String(value || '').normalize('NFKC').toUpperCase()
    .replace(/([\p{Script=Han}])/gu, ' $1 ')
    .split(/\s+/u).filter(Boolean);
}

function score(expected, actual) {
  const expectedChars = normalizedCharacters(expected);
  const actualChars = normalizedCharacters(actual);
  const expectedWords = normalizedWords(expected);
  const actualWords = normalizedWords(actual);
  const charErrors = levenshtein(expectedChars, actualChars);
  const wordErrors = levenshtein(expectedWords, actualWords);
  return {
    expectedCharacters: expectedChars.length,
    actualCharacters: actualChars.length,
    charErrors,
    cer: expectedChars.length ? charErrors / expectedChars.length : 0,
    expectedWords: expectedWords.length,
    actualWords: actualWords.length,
    wordErrors,
    wer: expectedWords.length ? wordErrors / expectedWords.length : 0
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const reportPath = path.resolve(process.argv[2] || path.join(root, 'output', 'phase25', 'ocr-benchmark.json'));
  const sensitive = '客户：张三\n手机：13812345678\n邮箱：alice@example.com\n身份证：11010519491231002X';
  const cases = [
    { id: 'lowres-skew', file: 'output/ocr/phase15/corpus/01-lowres-skew.png', expected: sensitive },
    { id: 'low-contrast', file: 'output/ocr/phase15/corpus/02-low-contrast.png', expected: sensitive },
    { id: 'merged-grid', file: 'output/ocr/phase15/corpus/03-merged-grid.png', expected: 'MERGED HEADER\nA1 B1 C1\nA2 B2 C2' },
    { id: 'two-column', file: 'output/ocr/phase15/corpus/04-two-column.png', expected: 'LEFT 1\nLEFT 2\nLEFT 3\nLEFT 4\nRIGHT 1\nRIGHT 2\nRIGHT 3\nRIGHT 4' }
  ];
  const engines = ['rapidocr', 'tesseract'];
  const results = [];
  for (const backend of engines) {
    for (const item of cases) {
      const absolute = path.join(root, item.file);
      const source = await fs.readFile(absolute);
      const started = Date.now();
      try {
        const observed = await recognizeImageBuffer(source, { name: path.basename(absolute), extension: '.png', backend });
        results.push({ backend, case: item.id, file: item.file, expected: item.expected, actual: observed.text, elapsedMs: Date.now() - started, ...score(item.expected, observed.text) });
      } catch (error) {
        results.push({ backend, case: item.id, file: item.file, expected: item.expected, actual: '', elapsedMs: Date.now() - started, error: String(error?.message || error), ...score(item.expected, '') });
      }
    }
  }
  const aggregates = Object.fromEntries(engines.map((backend) => {
    const rows = results.filter((item) => item.backend === backend);
    const expectedCharacters = rows.reduce((sum, item) => sum + item.expectedCharacters, 0);
    const charErrors = rows.reduce((sum, item) => sum + item.charErrors, 0);
    const expectedWords = rows.reduce((sum, item) => sum + item.expectedWords, 0);
    const wordErrors = rows.reduce((sum, item) => sum + item.wordErrors, 0);
    return [backend, {
      cases: rows.length,
      failures: rows.filter((item) => item.error).length,
      expectedCharacters,
      charErrors,
      cer: charErrors / expectedCharacters,
      expectedWords,
      wordErrors,
      wer: wordErrors / expectedWords,
      elapsedMs: rows.reduce((sum, item) => sum + item.elapsedMs, 0)
    }];
  }));
  const report = {
    format: 'VEILFORGE_OCR_BENCHMARK_V1',
    generatedAt: new Date().toISOString(),
    corpus: 'phase15 deterministic local corpus',
    normalization: 'Unicode NFKC + uppercase; CER ignores whitespace; WER segments Han characters and whitespace tokens',
    aggregates,
    results
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const [backend, value] of Object.entries(aggregates)) {
    process.stdout.write(`OCR_BENCHMARK backend=${backend} cases=${value.cases} failures=${value.failures} CER=${value.cer.toFixed(6)} WER=${value.wer.toFixed(6)} elapsedMs=${value.elapsedMs}\n`);
  }
  process.stdout.write(`REPORT=${reportPath}\n`);
  process.exitCode = Object.values(aggregates).some((value) => value.failures) ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`OCR_BENCHMARK_FAILED ${error?.stack || error}\n`);
  process.exitCode = 2;
}).finally(() => terminateWorker().catch(() => {}));

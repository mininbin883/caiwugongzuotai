'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { inspectRuntimePack } = require('../src/services/runtime-pack-service.cjs');
const { inspectRapidOcrBackend } = require('../src/services/rapidocr-service.cjs');
const { recognizeImageBuffer } = require('../src/services/ocr-service.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const runtimeDirectory = path.join(root, 'runtime-packs', 'rapidocr-python-win-x64-v1');
  const { analyzeText } = await import(pathToFileURL(path.join(root, 'src', 'core', 'redaction-engine.mjs')).href);
  const runtime = await inspectRuntimePack(runtimeDirectory);
  const backend = await inspectRapidOcrBackend();
  const input = path.join(root, 'output', 'ocr', 'phase14', 'lowres-skew.png');
  const source = await fs.readFile(input);
  const ocr = await recognizeImageBuffer(source, { name: path.basename(input), extension: '.png', backend: 'rapidocr' });
  const analysis = analyzeText(ocr.text, { enabledTypes: ['person', 'mobile', 'email', 'idcard'] });
  const expected = ['person', 'mobile', 'email', 'idcard'];
  const observed = [...new Set(analysis.findings.map((item) => item.type))].sort();
  const pass = runtime.id === 'rapidocr-python-win-x64-v1' && runtime.files > 2500 &&
    backend.runtimePack?.id === runtime.id && backend.python === runtime.entry &&
    expected.every((type) => observed.includes(type)) && ocr.words.length >= 50;
  const report = {
    format: 'VEILFORGE_PHASE25_INTEGRATION',
    result: pass ? 'PASS' : 'FAIL',
    runtimePack: { id: runtime.id, files: runtime.files, bytes: runtime.bytes, manifestSha256: runtime.manifestSha256 },
    backend: backend.backend,
    modelPack: backend.modelPack,
    text: ocr.text,
    words: ocr.words.length,
    findings: observed
  };
  const reportPath = path.join(root, 'output', 'phase25', 'phase25-report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PHASE25_${report.result} runtime=${runtime.id} files=${runtime.files} bytes=${runtime.bytes} backend=${backend.backend} words=${ocr.words.length} findings=${observed.length}\n`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`PHASE25_FAILED ${error?.stack || error}\n`);
  process.exitCode = 2;
});

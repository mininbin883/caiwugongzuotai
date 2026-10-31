#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectModelPack } = require('../src/services/model-pack-service.cjs');
const { loadNerModel } = require('../src/services/ner-service.cjs');
const { recognizeImage } = require('../src/services/ocr-service.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'output', 'phase24');
  await fs.mkdir(output, { recursive: true });
  const nerDirectory = path.join(root, 'model-packs', 'zh-ner-bert-v1');
  const ocrDirectory = path.join(root, 'model-packs', 'rapidocr-ppocrv6-small-v1');
  const [nerPack, ocrPack] = await Promise.all([
    inspectModelPack(nerDirectory, 'ner'),
    inspectModelPack(ocrDirectory, 'ocr')
  ]);

  const text = '王伟今日抵达上海，与北京星河科技有限公司代表陈明会面。';
  const ner = await loadNerModel(nerDirectory);
  let inference;
  try { inference = await ner.analyze(text, { acceptThreshold: 0.78, reviewThreshold: 0.52 }); }
  finally { await ner.close(); }
  const expectedEntities = ['王伟', '上海', '北京星河科技有限公司', '陈明'];
  const nerPass = expectedEntities.every((value) => inference.entities.some((item) => item.value === value && item.enabled));

  if (!process.env.VEILFORGE_RAPIDOCR_PYTHON) throw new Error('VEILFORGE_RAPIDOCR_PYTHON_REQUIRED');
  process.env.VEILFORGE_OCR_BACKEND = 'rapidocr';
  const fixture = path.resolve(process.env.VEILFORGE_RAPIDOCR_FIXTURE || path.join(root, 'output', 'ocr', 'phase14', 'lowres-skew.png'));
  const ocr = await recognizeImage(fixture);
  const ocrPass = ocr.backend === 'rapidocr-ppocrv6' && ocr.modelPack?.id === ocrPack.id &&
    ['张三', '13812345678', 'alice@example.com', '11010519491231002X'].every((value) => ocr.text.includes(value));

  const report = {
    format: 'VEILFORGE_PHASE24_REPORT',
    result: nerPass && ocrPass ? 'PASS' : 'FAIL',
    ner: {
      pack: nerPack.id,
      manifestSha256: nerPack.manifestSha256,
      modelSha256: ner.metadata.modelSha256,
      entities: inference.entities.map((item) => ({ type: item.type, value: item.value, confidence: item.confidence, enabled: item.enabled }))
    },
    ocr: {
      pack: ocrPack.id,
      manifestSha256: ocrPack.manifestSha256,
      backend: ocr.backend,
      characters: ocr.characters,
      words: ocr.words.length,
      confidence: ocr.confidence,
      text: ocr.text
    }
  };
  await fs.writeFile(path.join(output, 'phase24-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`PHASE24_${report.result} ner=${inference.entities.length}/${expectedEntities.length} nerPack=${nerPack.id} ocr=${ocr.words.length}words ocrPack=${ocrPack.id} backend=${ocr.backend}\n`);
  if (report.result !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

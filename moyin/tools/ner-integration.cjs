'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { loadNerModel } = require('../src/services/ner-service.cjs');

async function main() {
  const modelDirectory = process.argv[2] || process.env.VEILFORGE_NER_MODEL;
  if (!modelDirectory) throw new Error('NER_MODEL_DIRECTORY_REQUIRED');
  const outputValue = process.argv[3] || path.join('output', 'ner', 'phase13', 'phase13-ner-report.json');
  const outputPath = path.resolve(outputValue);
  const text = '王伟今日抵达上海，与北京星河科技有限公司代表陈明会面。';
  const context = await loadNerModel(path.resolve(modelDirectory));
  try {
    const inference = await context.analyze(text, { acceptThreshold: 0.78, reviewThreshold: 0.52 });
    const engine = await import('../src/core/redaction-engine.mjs');
    const merged = engine.analyzeText(text, { style: 'label', externalFindings: inference.entities });
    const expected = [
      ['person', '王伟'],
      ['address', '上海'],
      ['company', '北京星河科技有限公司'],
      ['person', '陈明']
    ];
    const checks = {
      expectedEntities: expected.every(([type, value]) => inference.entities.some((item) => item.type === type && item.value === value)),
      accepted: inference.entities.filter((item) => item.enabled).length >= 4,
      noReview: inference.entities.every((item) => !item.reviewRequired),
      singleWindow: inference.windows === 1,
      mergedRedaction: expected.every(([, value]) => !merged.redactedText.includes(value)),
      hash: /^[a-f0-9]{64}$/iu.test(inference.modelSha256)
    };
    const passed = Object.values(checks).every(Boolean);
    const report = {
      format: 'VEILFORGE_NER_INTEGRATION',
      result: passed ? 'PASS' : 'FAIL',
      checks,
      text,
      entities: inference.entities,
      tokens: inference.tokens,
      windows: inference.windows,
      merged: {
        count: merged.findings.length,
        modelCount: merged.modelCount,
        reviewCount: merged.reviewCount,
        findings: merged.findings,
        redactedText: merged.redactedText
      },
      metadata: context.metadata
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`NER_INTEGRATION_${report.result} entities=${inference.entities.length} accepted=${inference.entities.filter((item) => item.enabled).length} review=${inference.entities.filter((item) => item.reviewRequired).length} tokens=${inference.tokens} windows=${inference.windows} merged=${merged.findings.length}\n`);
    process.stdout.write(`REPORT=${outputPath}\n`);
    process.exitCode = passed ? 0 : 1;
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  process.stderr.write(`NER_INTEGRATION_FAILED ${error?.stack || error}\n`);
  process.exitCode = 1;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CASES, score, aggregate, recallGateStatus } = require('../tools/phase32-ocr-benchmark.cjs');
const { mappedConfidence, needsQuarterTurnRecovery } = require('../src/services/ocr-service.cjs');

test('Phase32 corpus covers six requested real-world effects', () => {
  assert.deepEqual(CASES.map((item) => item.id), ['shadow-ticket', 'perspective-ticket', 'stamp-occlusion', 'vertical-text', 'phone-noise', 'multi-column']);
  assert.deepEqual(CASES.map((item) => item.effect), ['票据阴影', '透视/倾斜', '印章覆盖', '竖排文字', '手机噪声', '多栏穿插']);
});

test('Phase32 score reports CER, WER and sensitive detection recall', () => {
  const value = score('客户 13812345678 alice@example.com', '客户 13812345678 alice@example.com', ['13812345678', 'alice@example.com']);
  assert.equal(value.cer, 0);
  assert.equal(value.wer, 0);
  assert.equal(value.sensitiveRecall, 1);
  const degraded = score('13812345678 alice@example.com', '13812345678', ['13812345678', 'alice@example.com']);
  assert.equal(degraded.sensitiveRecall, 0.5);
});

test('Phase32 aggregate computes weighted error and p95 latency', () => {
  const rows = [
    { expectedCharacters: 10, charErrors: 1, expectedWords: 4, wordErrors: 1, expectedSensitive: 2, detectedSensitive: 1, elapsedMs: 10, peakRssBytes: 100, enhancementScale: 1, },
    { expectedCharacters: 20, charErrors: 0, expectedWords: 5, wordErrors: 0, expectedSensitive: 1, detectedSensitive: 1, elapsedMs: 20, peakRssBytes: 120, enhancementScale: 2, },
    { expectedCharacters: 5, charErrors: 0, expectedWords: 1, wordErrors: 0, expectedSensitive: 0, detectedSensitive: 0, elapsedMs: 40, peakRssBytes: 110, enhancementScale: 1 },
  ];
  const result = aggregate(rows);
  assert.equal(result.cer, 1 / 35);
  assert.equal(result.wer, 1 / 10);
  assert.equal(result.detectionRecall, 2 / 3);
  assert.equal(result.p95ElapsedMs, 40);
  assert.equal(result.peakRssBytes, 120);
  assert.equal(result.maxEnhancementScale, 2);
});

test('Phase32 recall gate targets stamp occlusion and multi-column tokens', () => {
  const targetCases = CASES.filter((item) => ['stamp-occlusion', 'multi-column'].includes(item.id));
  assert.equal(targetCases.length, 2);
  assert.equal(targetCases.flatMap((item) => item.sensitive).length, 5);
  assert.equal(targetCases.find((item) => item.id === 'multi-column').sensitive.includes('alice@example.com'), true);
});

test('Phase34 low-confidence mapped words trigger quarter-turn recovery', () => {
  const degraded = { mapped: { text: '068499V5Z1', words: [{ confidence: 40 }, { confidence: 52 }] } };
  const reliable = { mapped: { text: 'ID 1234567890', words: [{ confidence: 88 }, { confidence: 92 }] } };
  assert.equal(mappedConfidence(degraded), 46);
  assert.equal(needsQuarterTurnRecovery(degraded), true);
  assert.equal(needsQuarterTurnRecovery(reliable), false);
});

test('Phase34 recall gate requires Tesseract vertical sensitive recall', () => {
  const aggregates = { rapidocr: { detectionRecall: 1 }, tesseract: { detectionRecall: 1 } };
  const targets = [
    { backend: 'rapidocr', case: 'stamp-occlusion', sensitiveRecall: 1 },
    { backend: 'rapidocr', case: 'multi-column', sensitiveRecall: 1 },
    { backend: 'tesseract', case: 'vertical-text', sensitiveRecall: 0 }
  ];
  assert.equal(recallGateStatus(aggregates, targets).passed, false);
  targets[2].sensitiveRecall = 1;
  assert.deepEqual(recallGateStatus(aggregates, targets), { passed: true, rapidTargetGate: true, tesseractVerticalGate: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BertTokenizer,
  decodeBioEntities,
  inspectNerModelDirectory
} = require('../src/services/ner-service.cjs');

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '王', '伟', '上', '海', 'alice', '##123', '。'].join('\n');

test('BERT tokenizer preserves UTF-16 source offsets for Chinese and WordPiece tokens', () => {
  const tokenizer = new BertTokenizer(VOCAB);
  const tokens = tokenizer.tokenize('王伟 alice123。');
  assert.deepEqual(tokens.map(({ id, start, end }) => [id, start, end]), [
    [4, 0, 1], [5, 1, 2], [8, 3, 8], [9, 8, 11], [10, 11, 12]
  ]);
});

test('BIO decoder emits accepted and review-required entities from confidence thresholds', () => {
  const text = '王伟到上海';
  const tokens = [
    { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }, { start: 4, end: 5 }
  ];
  const entities = decodeBioEntities(text, tokens, ['B-PER', 'I-PER', 'O', 'B-LOC', 'I-LOC'], [0.96, 0.94, 0.99, 0.65, 0.63], {
    acceptThreshold: 0.78,
    reviewThreshold: 0.52
  });
  assert.deepEqual(entities.map((item) => [item.type, item.value, item.enabled, item.reviewRequired]), [
    ['person', '王伟', true, false],
    ['address', '上海', false, true]
  ]);
});

test('model directory inspection validates fixed local assets without loading the model', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-ner-'));
  try {
    await fs.writeFile(path.join(directory, 'model.onnx'), Buffer.from([8, 1, 2, 3]));
    await fs.writeFile(path.join(directory, 'vocab.txt'), VOCAB, 'utf8');
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
      model_type: 'bert',
      vocab_size: 11,
      max_position_embeddings: 128,
      id2label: { 0: 'O', 1: 'B-PER', 2: 'I-PER', 3: 'B-ORG', 4: 'I-ORG', 5: 'B-LOC', 6: 'I-LOC' }
    }), 'utf8');
    await assert.rejects(() => inspectNerModelDirectory(directory), /LOCAL_NER_CONFIG_INVALID/);

    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    config.vocab_size = 100;
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config), 'utf8');
    const inspected = await inspectNerModelDirectory(directory);
    assert.equal(inspected.model.bytes, 4);
    assert.equal(inspected.labels.get(1), 'B-PER');
    assert.match(inspected.modelSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

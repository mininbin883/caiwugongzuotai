'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ort = require('onnxruntime-node');
const { inspectModelPack } = require('./model-pack-service.cjs');

const MODEL_FILE = 'model.onnx';
const VOCAB_FILE = 'vocab.txt';
const CONFIG_FILE = 'config.json';
const MAX_MODEL_BYTES = 1024 * 1024 * 1024;
const MAX_VOCAB_BYTES = 8 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_ACCEPT_THRESHOLD = 0.78;
const DEFAULT_REVIEW_THRESHOLD = 0.52;
const DEFAULT_WINDOW_TOKENS = 126;
const DEFAULT_OVERLAP = 32;
const ENTITY_TYPES = Object.freeze({ ORG: 'company', PER: 'person', LOC: 'address' });

function assertModelDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('LOCAL_NER_PATH_INVALID');
}

async function fileInfo(filePath, maximum) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size < 1 || stat.size > maximum) throw new Error('LOCAL_NER_MODEL_INVALID');
  return { path: filePath, bytes: stat.size };
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function labelMap(config) {
  const entries = Object.entries(config?.id2label || {});
  if (!entries.length) throw new Error('LOCAL_NER_CONFIG_INVALID');
  const labels = new Map();
  for (const [id, label] of entries) {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || typeof label !== 'string' || !/^(?:[BI]-(?:ORG|PER|LOC|TIME)|O)$/u.test(label)) {
      throw new Error('LOCAL_NER_CONFIG_INVALID');
    }
    labels.set(numeric, label);
  }
  return labels;
}

async function inspectNerModelDirectory(directory) {
  assertModelDirectory(directory);
  const resolved = path.resolve(directory);
  const hasManifest = (await fsp.stat(path.join(resolved, 'manifest.json')).catch(() => null))?.isFile() === true;
  const modelPack = hasManifest ? await inspectModelPack(resolved, 'ner') : null;
  const model = await fileInfo(path.join(resolved, MODEL_FILE), MAX_MODEL_BYTES);
  const vocab = await fileInfo(path.join(resolved, VOCAB_FILE), MAX_VOCAB_BYTES);
  const configFile = await fileInfo(path.join(resolved, CONFIG_FILE), MAX_CONFIG_BYTES);
  let config;
  try {
    config = JSON.parse(await fsp.readFile(configFile.path, 'utf8'));
  } catch {
    throw new Error('LOCAL_NER_CONFIG_INVALID');
  }
  if (config.model_type !== 'bert' || !Number.isInteger(config.vocab_size) || config.vocab_size < 100 ||
      !Number.isInteger(config.max_position_embeddings) || config.max_position_embeddings < 16) {
    throw new Error('LOCAL_NER_CONFIG_INVALID');
  }
  const labels = labelMap(config);
  const [modelSha256, vocabSha256, configSha256] = await Promise.all([
    sha256File(model.path), sha256File(vocab.path), sha256File(configFile.path)
  ]);
  return {
    directory: resolved,
    name: path.basename(resolved),
    model,
    vocab,
    configFile,
    config,
    labels,
    modelSha256,
    vocabSha256,
    configSha256,
    modelPack
  };
}

function isCjk(codePoint) {
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf) || (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || (codePoint >= 0x20000 && codePoint <= 0x3134f);
}

function isPunctuation(character) {
  return /[\p{P}\p{S}]/u.test(character);
}

class BertTokenizer {
  constructor(vocabText) {
    const words = String(vocabText || '').split(/\r?\n/u).filter((value) => value.length > 0);
    this.vocab = new Map(words.map((word, index) => [word, index]));
    this.unknown = this.required('[UNK]');
    this.cls = this.required('[CLS]');
    this.sep = this.required('[SEP]');
  }

  required(token) {
    const id = this.vocab.get(token);
    if (!Number.isInteger(id)) throw new Error('LOCAL_NER_VOCAB_INVALID');
    return id;
  }

  wordPieces(word, start) {
    const normalized = word.toLocaleLowerCase('zh-CN');
    if (normalized.length > 100) return [{ id: this.unknown, start, end: start + word.length }];
    const pieces = [];
    let at = 0;
    while (at < normalized.length) {
      let end = normalized.length;
      let matched = null;
      while (end > at) {
        const candidate = `${at > 0 ? '##' : ''}${normalized.slice(at, end)}`;
        const id = this.vocab.get(candidate);
        if (Number.isInteger(id)) {
          matched = { id, start: start + at, end: start + end };
          break;
        }
        end -= 1;
      }
      if (!matched) return [{ id: this.unknown, start, end: start + word.length }];
      pieces.push(matched);
      at = end;
    }
    return pieces;
  }

  tokenize(textValue) {
    const text = String(textValue || '');
    const tokens = [];
    let wordStart = -1;
    const flushWord = (end) => {
      if (wordStart < 0) return;
      tokens.push(...this.wordPieces(text.slice(wordStart, end), wordStart));
      wordStart = -1;
    };
    for (let index = 0; index < text.length;) {
      const codePoint = text.codePointAt(index);
      const character = String.fromCodePoint(codePoint);
      const width = character.length;
      if (/\s/u.test(character) || isCjk(codePoint) || isPunctuation(character)) {
        flushWord(index);
        if (!/\s/u.test(character)) {
          tokens.push({ id: this.vocab.get(character) ?? this.unknown, start: index, end: index + width });
        }
      } else if (wordStart < 0) {
        wordStart = index;
      }
      index += width;
    }
    flushWord(text.length);
    return tokens;
  }
}

function softmaxRow(data, offset, count) {
  let maximum = -Infinity;
  for (let index = 0; index < count; index += 1) maximum = Math.max(maximum, Number(data[offset + index]));
  let total = 0;
  const values = new Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = Math.exp(Number(data[offset + index]) - maximum);
    total += values[index];
  }
  return values.map((value) => value / total);
}

function decodeBioEntities(text, tokens, labels, confidences, options = {}) {
  const acceptThreshold = Number.isFinite(options.acceptThreshold) ? options.acceptThreshold : DEFAULT_ACCEPT_THRESHOLD;
  const reviewThreshold = Number.isFinite(options.reviewThreshold) ? options.reviewThreshold : DEFAULT_REVIEW_THRESHOLD;
  const found = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const confidence = current.confidenceTotal / current.tokenCount;
    const value = text.slice(current.start, current.end);
    if (confidence >= reviewThreshold && value.trim()) {
      found.push({
        type: current.type,
        modelLabel: current.modelLabel,
        value,
        start: current.start,
        end: current.end,
        confidence,
        reviewRequired: confidence < acceptThreshold,
        enabled: confidence >= acceptThreshold,
        source: 'onnx'
      });
    }
    current = null;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const label = labels[index] || 'O';
    const [prefix, rawKind] = label.includes('-') ? label.split('-', 2) : ['O', null];
    const type = ENTITY_TYPES[rawKind];
    const token = tokens[index];
    const confidence = Number(confidences[index] || 0);
    if (!type) {
      finish();
      continue;
    }
    const continues = prefix === 'I' && current?.type === type && token.start <= current.end + 1;
    if (!continues) {
      finish();
      current = { type, modelLabel: rawKind, start: token.start, end: token.end, confidenceTotal: confidence, tokenCount: 1 };
    } else {
      current.end = token.end;
      current.confidenceTotal += confidence;
      current.tokenCount += 1;
    }
  }
  finish();
  return found;
}

function tensorInt64(values, dimensions) {
  return new ort.Tensor('int64', BigInt64Array.from(values, (value) => BigInt(value)), dimensions);
}

async function loadNerModel(directory, options = {}) {
  const metadata = await inspectNerModelDirectory(directory);
  const vocabText = await fsp.readFile(metadata.vocab.path, 'utf8');
  const tokenizer = new BertTokenizer(vocabText);
  const session = await ort.InferenceSession.create(metadata.model.path, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    intraOpNumThreads: Math.max(1, Math.min(4, Number(options.threads) || 2)),
    interOpNumThreads: 1
  });
  const publicMetadata = {
    name: metadata.name,
    modelBytes: metadata.model.bytes,
    vocabSize: metadata.config.vocab_size,
    labels: Object.fromEntries(metadata.labels),
    modelSha256: metadata.modelSha256,
    vocabSha256: metadata.vocabSha256,
    configSha256: metadata.configSha256,
    inputs: session.inputNames,
    outputs: session.outputNames,
    modelPackId: metadata.modelPack?.id || null,
    modelPackVersion: metadata.modelPack?.version || null,
    modelPackManifestSha256: metadata.modelPack?.manifestSha256 || null,
    modelPackVerified: Boolean(metadata.modelPack)
  };

  async function analyze(textValue, analyzeOptions = {}) {
    const text = String(textValue || '');
    const tokens = tokenizer.tokenize(text);
    if (!tokens.length) return { text, entities: [], tokens: 0, windows: 0, ...publicMetadata };
    const windowTokens = Math.max(8, Math.min(DEFAULT_WINDOW_TOKENS, Number(analyzeOptions.windowTokens) || DEFAULT_WINDOW_TOKENS));
    const overlap = Math.max(0, Math.min(windowTokens - 1, Number(analyzeOptions.overlap) || DEFAULT_OVERLAP));
    const predictions = Array.from({ length: tokens.length }, () => ({ label: 'O', confidence: 0, margin: -1 }));
    let start = 0;
    let windows = 0;
    while (start < tokens.length) {
      const end = Math.min(tokens.length, start + windowTokens);
      const slice = tokens.slice(start, end);
      const ids = [tokenizer.cls, ...slice.map((token) => token.id), tokenizer.sep];
      const positions = ids.map((_, index) => index);
      const feeds = {};
      for (const inputName of session.inputNames) {
        if (inputName === 'input_ids') feeds[inputName] = tensorInt64(ids, [1, ids.length]);
        else if (inputName === 'position_ids') feeds[inputName] = tensorInt64(positions, [1, ids.length]);
        else if (inputName === 'attention_mask') feeds[inputName] = tensorInt64(ids.map(() => 1), [1, ids.length]);
        else if (inputName === 'token_type_ids') feeds[inputName] = tensorInt64(ids.map(() => 0), [1, ids.length]);
        else throw new Error(`LOCAL_NER_INPUT_UNSUPPORTED:${inputName}`);
      }
      const result = await session.run(feeds);
      const logits = result.logits || result[session.outputNames[0]];
      const labelCount = logits.dims[logits.dims.length - 1];
      for (let offset = 0; offset < slice.length; offset += 1) {
        const rowOffset = (offset + 1) * labelCount;
        const probabilities = softmaxRow(logits.data, rowOffset, labelCount);
        let chosen = 0;
        for (let index = 1; index < probabilities.length; index += 1) {
          if (probabilities[index] > probabilities[chosen]) chosen = index;
        }
        const margin = Math.min(offset, slice.length - 1 - offset);
        const at = start + offset;
        if (margin > predictions[at].margin || (margin === predictions[at].margin && probabilities[chosen] > predictions[at].confidence)) {
          predictions[at] = { label: metadata.labels.get(chosen) || 'O', confidence: probabilities[chosen], margin };
        }
      }
      windows += 1;
      if (end === tokens.length) break;
      start = end - overlap;
    }
    const entities = decodeBioEntities(
      text,
      tokens,
      predictions.map((item) => item.label),
      predictions.map((item) => item.confidence),
      analyzeOptions
    );
    return { text, entities, tokens: tokens.length, windows, ...publicMetadata };
  }

  return {
    metadata: publicMetadata,
    analyze,
    async close() {
      await session.release();
    }
  };
}

module.exports = {
  DEFAULT_ACCEPT_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  DEFAULT_WINDOW_TOKENS,
  DEFAULT_OVERLAP,
  ENTITY_TYPES,
  BertTokenizer,
  decodeBioEntities,
  inspectNerModelDirectory,
  loadNerModel
};

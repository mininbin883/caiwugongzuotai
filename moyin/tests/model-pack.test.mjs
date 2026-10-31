import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MODEL_PACK_FORMAT, inspectModelPack } = require('../src/services/model-pack-service.cjs');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-model-pack-'));
  const values = { 'model.onnx': Buffer.from('model'), 'LICENSE.txt': Buffer.from('license'), 'NOTICE.txt': Buffer.from('notice') };
  for (const [name, value] of Object.entries(values)) await fs.writeFile(path.join(directory, name), value);
  const manifest = {
    format: MODEL_PACK_FORMAT,
    id: 'fixture-ner-v1',
    kind: 'ner',
    name: 'Fixture',
    version: '1',
    engine: 'test',
    source: 'fixture',
    license: 'Apache-2.0',
    entry: 'model.onnx',
    files: Object.entries(values).map(([filePath, value]) => ({ path: filePath, bytes: value.length, sha256: hash(value), role: filePath }))
  };
  await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

test('model pack verifies every declared byte and exposes a manifest hash', async () => {
  const directory = await fixture();
  try {
    const pack = await inspectModelPack(directory, 'ner');
    assert.equal(pack.id, 'fixture-ner-v1');
    assert.equal(pack.files.length, 3);
    assert.match(pack.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.equal(pack.bytes, 18);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('model pack rejects hash mutation and path traversal', async () => {
  const directory = await fixture();
  try {
    await fs.writeFile(path.join(directory, 'model.onnx'), 'tampered');
    await assert.rejects(() => inspectModelPack(directory, 'ner'), /LOCAL_MODEL_PACK_SIZE_MISMATCH|LOCAL_MODEL_PACK_HASH_MISMATCH/u);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.files[0].path = '../model.onnx';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => inspectModelPack(directory, 'ner'), /LOCAL_MODEL_PACK_PATH_INVALID/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inspectRuntimePack } = require('../src/services/runtime-pack-service.cjs');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-runtime-pack-'));
  const names = [
    'runtime/python.exe', 'packages/rapidocr.txt', 'LICENSE-PYTHON.txt', 'LICENSE-RAPIDOCR.txt',
    'NOTICE.txt', 'SBOM.json', 'runtime/python313.zip', 'runtime/python313.dll',
    'packages/onnxruntime.txt', 'packages/numpy.txt'
  ];
  const files = [];
  for (const [index, name] of names.entries()) {
    const content = Buffer.from(`runtime-${index + 1}`);
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), content);
    files.push({ path: name, bytes: content.length, sha256: sha256(content) });
  }
  const manifest = {
    format: 'VEILFORGE_RUNTIME_PACK_V1', id: 'rapidocr-test-runtime', kind: 'python-ocr-runtime',
    name: 'test', version: '1', platform: 'win32', arch: 'x64', python: '3.13',
    engine: 'rapidocr@test', entry: 'runtime/python.exe', packagesDir: 'packages', files
  };
  await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return directory;
}

test('runtime pack verifies the complete declared tree', async (t) => {
  const directory = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await inspectRuntimePack(directory);
  assert.equal(result.id, 'rapidocr-test-runtime');
  assert.equal(result.files, 10);
  assert.equal(result.entry, path.join(directory, 'runtime/python.exe'));
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u);
});

test('runtime pack rejects a mutated declared file', async (t) => {
  const directory = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'packages/numpy.txt'), 'tampered');
  await assert.rejects(inspectRuntimePack(directory), /LOCAL_RUNTIME_PACK_(SIZE|HASH)_MISMATCH/u);
});

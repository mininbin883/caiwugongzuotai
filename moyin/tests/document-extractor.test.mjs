import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractDocument, normalizeText } = require('../src/services/document-extractor.cjs');

test('规范化换行与尾部空白', () => {
  assert.equal(normalizeText('第一行  \r\n第二行\r\n'), '第一行\n第二行');
});

test('导入 UTF-8 文本文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-'));
  const file = path.join(dir, 'sample.txt');
  await fs.writeFile(file, '联系人：13812345678\n', 'utf8');
  const result = await extractDocument(file);
  assert.equal(result.name, 'sample.txt');
  assert.equal(result.text, '联系人：13812345678');
  await fs.rm(dir, { recursive: true, force: true });
});

test('拒绝未支持的文件类型', async () => {
  await assert.rejects(() => extractDocument(path.resolve('sample.exe')), /LOCAL_TYPE_UNSUPPORTED/);
});

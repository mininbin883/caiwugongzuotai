import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AUDIT_FORMAT, MANIFEST_FORMAT, exportBatchResults } = require('../src/services/batch-export-service.cjs');

const handlers = {
  analyzeText(text) {
    const start = text.indexOf('13800138000');
    const findings = start < 0 ? [] : [{ type: 'mobile', label: '手机号', start, end: start + 11, replacement: '138****8000', enabled: true }];
    return { findings, redactedText: text.replace('13800138000', '138****8000') };
  },
  applyFindings: (text) => text,
  renderOffice: async () => { throw new Error('UNEXPECTED_OFFICE'); },
  renderPdf: async () => { throw new Error('UNEXPECTED_PDF'); },
  renderImage: async () => { throw new Error('UNEXPECTED_IMAGE'); }
};

test('batch export preserves collisions and writes scrubbed audit manifests', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-batch-export-'));
  try {
    const input = path.join(directory, '客户.txt');
    const collision = path.join(directory, '客户-脱敏.txt');
    await fs.writeFile(input, '电话 13800138000', 'utf8');
    await fs.writeFile(collision, 'SENTINEL', 'utf8');
    const result = await exportBatchResults([{
      id: 'one', input, result: { name: '客户.txt', extension: '.txt', sourceBytes: 17, text: '电话 13800138000' }
    }], directory, handlers);
    assert.equal(result.exported, 1);
    assert.equal(await fs.readFile(collision, 'utf8'), 'SENTINEL');
    assert.equal(path.basename(result.records[0].outputPath), '客户-脱敏 (2).txt');
    assert.equal(await fs.readFile(result.records[0].outputPath, 'utf8'), '电话 138****8000');
    const auditRaw = await fs.readFile(result.records[0].auditPath, 'utf8');
    const audit = JSON.parse(auditRaw);
    assert.equal(audit.format, AUDIT_FORMAT);
    assert.equal(audit.findingCount, 1);
    assert.equal('value' in audit.findings[0], false);
    assert.equal(auditRaw.includes('13800138000'), false);
    assert.equal(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')).format, MANIFEST_FORMAT);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('batch export cancellation stops before the next job and records the transition', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-batch-cancel-'));
  try {
    const first = path.join(directory, 'first.txt');
    const second = path.join(directory, 'second.txt');
    await fs.writeFile(first, 'plain one', 'utf8');
    await fs.writeFile(second, 'plain two', 'utf8');
    let checks = 0;
    const result = await exportBatchResults([
      { id: 'one', input: first, result: { name: 'first.txt', extension: '.txt', sourceBytes: 9, text: 'plain one' } },
      { id: 'two', input: second, result: { name: 'second.txt', extension: '.txt', sourceBytes: 9, text: 'plain two' } }
    ], directory, { ...handlers, shouldCancel: () => checks++ > 0 });
    assert.equal(result.canceled, true);
    assert.equal(result.exported, 1);
    assert.equal(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')).canceled, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('batch export routes CSV through the original-format renderer', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-batch-csv-'));
  try {
    const input = path.join(directory, '客户.csv');
    const source = '姓名,电话\r\n张三,13800138000\r\n';
    await fs.writeFile(input, source, 'utf8');
    let calls = 0;
    const result = await exportBatchResults([{
      id: 'csv-one',
      input,
      result: { name: '客户.csv', extension: '.csv', sourceBytes: source.length, text: source, csv: { token: 'csv-token', kind: 'csv' } }
    }], directory, {
      ...handlers,
      renderCsv: async (descriptor, text, outputPath) => {
        calls += 1;
        assert.equal(descriptor.token, 'csv-token');
        await fs.writeFile(outputPath, text.replace('13800138000', '138****8000'), { encoding: 'utf8', flag: 'wx' });
        return { bytes: Buffer.byteLength(text, 'utf8'), originalFormatPreserved: true };
      }
    });
    assert.equal(calls, 1);
    assert.equal(path.extname(result.records[0].outputPath), '.csv');
    assert.match(await fs.readFile(result.records[0].outputPath, 'utf8'), /138\*\*\*\*8000/u);
    assert.equal(result.records[0].render.originalFormatPreserved, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

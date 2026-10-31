import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CallbackSigner } = require('../src/services/pdf-signing-service.cjs');
const { findCompliance, validatePdfA } = require('../src/services/pdf-validation-service.cjs');

test('findCompliance locates nested veraPDF compliance status', () => {
  assert.equal(findCompliance({ validationReport: { details: { isCompliant: true } } }), true);
  assert.equal(findCompliance({ jobs: [{ compliant: false }] }), false);
  assert.equal(findCompliance({ validationReport: {} }), null);
});

test('validatePdfA passes JSON mode and flavour to an injected CLI adapter', async () => {
  const filePath = path.resolve('tests', 'fixture.pdf');
  let observed;
  const result = await validatePdfA(filePath, {
    flavour: '2b',
    runner: async (command, args) => {
      observed = { command, args };
      return { stdout: '{"validationReport":{"isCompliant":true}}', stderr: '' };
    }
  });
  assert.equal(result.compliant, true);
  assert.equal(result.executed, true);
  assert.equal(observed.command, 'verapdf');
  assert.deepEqual(observed.args.slice(0, 2), ['--format', 'json']);
  assert.ok(observed.args.includes('--flavour'));
  assert.equal(observed.args.at(-1), filePath);
});

test('CallbackSigner exposes HSM metadata and returns detached CMS bytes', async () => {
  let metadata;
  const signer = new CallbackSigner(async (bytes, value) => {
    assert.equal(bytes.toString('utf8'), 'byte-range-content');
    metadata = value;
    return Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x01]);
  }, { adapter: 'pkcs11-test', slot: 'slot-7' });
  const signed = await signer.sign(Buffer.from('byte-range-content'), new Date('2026-10-30T00:00:00.000Z'));
  assert.ok(Buffer.isBuffer(signed));
  assert.equal(signed.toString('hex'), '3003020101');
  assert.equal(metadata.adapter, 'pkcs11-test');
  assert.equal(metadata.slot, 'slot-7');
});

test('CallbackSigner rejects non-binary signer results', async () => {
  const signer = new CallbackSigner(async () => 'not-cms');
  await assert.rejects(() => signer.sign(Buffer.from('x')), /LOCAL_PDF_SIGNER_RESULT_INVALID/u);
});

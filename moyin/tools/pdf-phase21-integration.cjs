'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const forge = require('node-forge');
const { P12Signer } = require('@signpdf/signer-p12');
const { extractSignature } = require('@signpdf/utils');
const {
  recognizePdf,
  renderRedactedPdf,
  extractNativePdfText
} = require('../src/services/pdf-redaction-service.cjs');
const {
  signPdfWithP12,
  signPdfWithExternalSigner
} = require('../src/services/pdf-signing-service.cjs');
const { validatePdfA } = require('../src/services/pdf-validation-service.cjs');

function createTestIdentity(password) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '21000001';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00.000Z');
  certificate.validity.notAfter = new Date('2036-01-01T00:00:00.000Z');
  const attributes = [{ name: 'commonName', value: 'VeilForge Phase21 Test Signer' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificate], password, {
    algorithm: '3des',
    friendlyName: 'VeilForge Phase21 Test Signer'
  });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

function inspectCms(pdfBytes) {
  const extracted = extractSignature(pdfBytes);
  const signatureBuffer = Buffer.from(extracted.signature, 'binary');
  const message = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(signatureBuffer.toString('binary')));
  return {
    byteRange: extracted.ByteRange,
    signatureBytes: signatureBuffer.length,
    certificates: Array.isArray(message.certificates) ? message.certificates.length : 0,
    signedDataBytes: extracted.signedData.length
  };
}

async function expectPasswordError(inputPath, password, expected) {
  try {
    await recognizePdf(inputPath, password === undefined ? {} : { password });
  } catch (error) {
    return String(error?.code || error?.message || error) === expected;
  }
  return false;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const outputDirectory = path.join(root, 'output', 'pdf', 'phase21');
  const encryptedPath = path.join(root, 'output', 'pdf', 'phase20', 'encrypted-diagnostic.pdf');
  const sanitizedPath = path.join(outputDirectory, 'password-decrypted-redacted.pdf');
  const p12Path = path.join(outputDirectory, 'phase21-test-signer.p12');
  const p12SignedPath = path.join(outputDirectory, 'password-decrypted-redacted-p12-signed.pdf');
  const hsmSignedPath = path.join(outputDirectory, 'password-decrypted-redacted-hsm-adapter-signed.pdf');
  const reportPath = path.join(outputDirectory, 'phase21-security-pipeline-report.json');
  const password = 'phase20-password';
  const p12Password = 'phase21-p12-password';
  await fs.mkdir(outputDirectory, { recursive: true });

  const passwordRequired = await expectPasswordError(encryptedPath, undefined, 'LOCAL_PDF_PASSWORD_REQUIRED');
  const wrongPassword = await expectPasswordError(encryptedPath, 'wrong-password', 'LOCAL_PDF_PASSWORD_INVALID');
  const source = await recognizePdf(encryptedPath, { password });
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const analysis = analyzeText(source.text, { customTerms: ['Alice Example'] });
  const rendered = await renderRedactedPdf(source, analysis.findings, sanitizedPath);
  const extracted = await extractNativePdfText(sanitizedPath);
  const sanitizedBytes = await fs.readFile(sanitizedPath);
  const sensitiveValues = ['Alice Example', '13812345678', 'alice@example.com'];
  const sensitiveAbsent = sensitiveValues.every((value) => !extracted.text.includes(value) && !sanitizedBytes.includes(Buffer.from(value)));
  const decryptedInMemory = source.passwordDecryptedInMemory === true && source.encryptionState === 'decrypted-in-memory' &&
    rendered.preservationMode === 'password-decrypted-raster' && rendered.passwordDecryptedInMemory === true;

  const p12Bytes = createTestIdentity(p12Password);
  await fs.writeFile(p12Path, p12Bytes, { mode: 0o600 });
  await signPdfWithP12(sanitizedPath, p12SignedPath, p12Path, p12Password, {
    overwrite: true,
    reason: 'Phase21 P12 re-sign validation',
    name: 'VeilForge Phase21 Test Signer',
    signingTime: new Date('2026-10-30T10:00:00.000Z')
  });
  const p12SignedBytes = await fs.readFile(p12SignedPath);
  const p12Cms = inspectCms(p12SignedBytes);

  const delegatedSigner = new P12Signer(p12Bytes, { passphrase: p12Password });
  let hsmCallbackCount = 0;
  await signPdfWithExternalSigner(sanitizedPath, hsmSignedPath, async (bytes, metadata) => {
    hsmCallbackCount += 1;
    if (metadata.adapter !== 'phase21-pkcs11-hsm') throw new Error('HSM_ADAPTER_METADATA_INVALID');
    return delegatedSigner.sign(bytes, metadata.signingTime);
  }, {
    overwrite: true,
    reason: 'Phase21 external HSM adapter validation',
    name: 'VeilForge Phase21 HSM Adapter',
    metadata: { adapter: 'phase21-pkcs11-hsm', slot: 'test-slot-01' },
    signingTime: new Date('2026-10-30T10:01:00.000Z')
  });
  const hsmSignedBytes = await fs.readFile(hsmSignedPath);
  const hsmCms = inspectCms(hsmSignedBytes);

  const veraPdfRuntime = await validatePdfA(sanitizedPath);
  let adapterCommand = '';
  let adapterArgs = [];
  const veraPdfAdapter = await validatePdfA(sanitizedPath, {
    flavour: '2b',
    runner: async (command, args) => {
      adapterCommand = command;
      adapterArgs = [...args];
      return { stdout: JSON.stringify({ validationReport: { isCompliant: true, flavour: '2b' } }), stderr: '' };
    }
  });

  const checks = {
    passwordRequired,
    wrongPassword,
    decryptedInMemory,
    p12Signed: p12Cms.signatureBytes > 0 && p12Cms.certificates >= 1 && p12Cms.byteRange.every(Number.isInteger),
    hsmSigned: hsmCallbackCount === 1 && hsmCms.signatureBytes > 0 && hsmCms.certificates >= 1,
    veraPdfRuntimeDetected: veraPdfRuntime.executed || veraPdfRuntime.reason === 'VERAPDF_NOT_INSTALLED',
    veraPdfAdapter: veraPdfAdapter.executed && veraPdfAdapter.compliant === true && adapterCommand === 'verapdf' && adapterArgs.includes('--flavour'),
    sensitiveAbsent
  };
  const passed = Object.values(checks).every(Boolean);
  const report = {
    format: 'VEILFORGE_PHASE21_PDF_SECURITY_PIPELINE',
    result: passed ? 'PASS' : 'FAIL',
    passwordImport: {
      requiredWithoutPassword: passwordRequired,
      rejectsWrongPassword: wrongPassword,
      decryptedInMemory,
      pageCount: source.pageCount,
      findings: analysis.findings.length,
      render: rendered,
      sensitiveAbsent
    },
    signing: {
      p12: { output: p12SignedPath, ...p12Cms },
      hsmAdapter: { output: hsmSignedPath, callbackCount: hsmCallbackCount, ...hsmCms }
    },
    validation: { runtime: veraPdfRuntime, injectedAdapter: veraPdfAdapter },
    artifacts: { sanitizedPath, p12Path, p12SignedPath, hsmSignedPath },
    checks
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_SECURITY_PIPELINE_${report.result} password=${passwordRequired ? 1 : 0} wrong=${wrongPassword ? 1 : 0} memory=${decryptedInMemory ? 1 : 0} p12=${checks.p12Signed ? 1 : 0} hsm=${checks.hsmSigned ? 1 : 0} verapdf=available:${veraPdfRuntime.available ? 1 : 0}/adapter:${checks.veraPdfAdapter ? 1 : 0} safe=${sensitiveAbsent ? 1 : 0}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

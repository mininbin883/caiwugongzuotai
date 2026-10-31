'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/probe-phase21.cjs TREE_ROOT');
  process.exit(2);
}
function read(relative) {
  const file = path.join(root, ...relative.split('/'));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
const redaction = read('src/services/pdf-redaction-service.cjs');
const main = read('src/main.cjs');
const preload = read('src/preload.cjs');
const html = read('src/renderer/index.html');
const renderer = read('src/renderer/renderer.mjs');
const signing = read('src/services/pdf-signing-service.cjs');
const validation = read('src/services/pdf-validation-service.cjs');
const integration = read('tools/pdf-phase21-integration.cjs');
const pkg = read('package.json');
const checks = [
  ['password-error-branches', redaction.includes('LOCAL_PDF_PASSWORD_REQUIRED') && redaction.includes('LOCAL_PDF_PASSWORD_INVALID')],
  ['memory-only-decryption', redaction.includes("encryptionState: 'decrypted-in-memory'") && redaction.includes("'password-decrypted-raster'")],
  ['encrypted-session-ipc', main.includes('pendingEncryptedDocuments') && main.includes('openEncryptedDocument') && preload.includes('openEncryptedPdf')],
  ['password-dialog-retry', html.includes('pdfPasswordDialog') && renderer.includes('requestPdfPassword') && renderer.includes('LOCAL_PDF_PASSWORD_INVALID')],
  ['p12-cades-signing', signing.includes('signPdfWithP12') && signing.includes('P12Signer') && signing.includes('SUBFILTER_ETSI_CADES_DETACHED')],
  ['hsm-callback-adapter', signing.includes('class CallbackSigner') && signing.includes('pkcs11-hsm-callback') && signing.includes('signPdfWithExternalSigner')],
  ['verapdf-export-validation', validation.includes('async function validatePdfA') && validation.includes("'--format', 'json'") && main.includes('pdfaValidation')],
  ['security-pipeline-release', integration.includes('PDF_SECURITY_PIPELINE_') && pkg.includes('"version": "2.1.0"') && pkg.includes('"test:pdf-security"')]
];
for (const [name, ok] of checks) console.log(`CHECK ${name}=${ok ? 1 : 0}`);
const passed = checks.filter(([, ok]) => ok).length;
console.log(`PHASE21_PROBE ${passed}/${checks.length}`);
process.exit(passed === checks.length ? 0 : 1);

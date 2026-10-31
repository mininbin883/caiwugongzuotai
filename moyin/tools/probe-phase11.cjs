#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  console.error('USAGE: node tools/probe-phase11.cjs <pdf-redaction-service.cjs>');
  process.exit(2);
}

const resolved = path.resolve(target);
const source = fs.readFileSync(resolved, 'utf8');
const checks = [
  ['native-page-text-map', /function\s+nativePageText\s*\(/u.test(source)],
  ['native-vs-ocr-source-mode', /sourceMode\s*:/u.test(source) && /nativePages/u.test(source) && /ocrPages/u.test(source)],
  ['tokenized-pdf-export', /async\s+function\s+renderTokenizedPdf\s*\(/u.test(source)],
  ['coordinate-sidecar-schema', /VEILFORGE_PDF_TOKEN_COORDINATES/u.test(source)],
  ['safe-page-background', /backgroundFile/u.test(source) && /page-\$\{String\(/u.test(source)],
  ['native-token-extraction', /async\s+function\s+extractNativePdfText\s*\(/u.test(source)],
  ['coordinate-restore', /async\s+function\s+restoreReversiblePdf\s*\(/u.test(source) && /coordinateSidecarUsed/u.test(source)],
  ['public-api-exports', /renderTokenizedPdf\s*,/u.test(source) && /restoreReversiblePdf\s*,/u.test(source) && /extractNativePdfText\s*,/u.test(source)],
];

for (const [name, pass] of checks) {
  console.log(`CHECK ${name}=${pass ? 1 : 0}`);
}
const passed = checks.filter(([, pass]) => pass).length;
console.log(`PHASE11_PROBE ${passed}/${checks.length}`);
process.exit(passed === checks.length ? 0 : 1);

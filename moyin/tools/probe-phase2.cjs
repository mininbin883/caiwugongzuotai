'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  console.error('USAGE: node tools/probe-phase2.cjs <main.cjs>');
  process.exit(2);
}
const source = fs.readFileSync(target, 'utf8');
const checks = {
  image_extensions: source.includes('IMAGE_EXTENSIONS'),
  recognize_image: source.includes('recognizeImage(filePath)'),
  session_token: source.includes('imageSessions.set(token'),
  export_image: source.includes("payload.kind === 'image'"),
  redacted_renderer: source.includes('renderRedactedImage(imageSession'),
  packaged_smoke: source.includes('runOcrSmoke()')
};
const count = Object.values(checks).filter(Boolean).length;
console.log(`FILE=${path.basename(target)}`);
console.log('INPUT=OCR import/export branch probe');
console.log(`CHECKS=${JSON.stringify(checks)}`);
console.log(`OCR_BRANCHES=${count}/6`);
console.log(`RESULT=${count === 6 ? 'PASS' : 'FAIL'}`);
process.exit(count === 6 ? 0 : 1);

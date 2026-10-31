'use strict';

const fs = require('node:fs');
const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/probe-phase19.cjs TARGET');
  process.exit(2);
}
const text = fs.readFileSync(target, 'utf8');
const checks = [
  ['feature-inventory', text.includes('function inspectPdfDocument(document)')],
  ['feature-path-api', text.includes('async function inspectPdfFeatures(filePath)')],
  ['structure-preserving-render', text.includes('async function renderStructurePreservingPdf(')],
  ['stale-object-deletion', text.includes('context.delete(ref)')],
  ['secure-content-mode', text.includes("preservationMode: 'structure-preserving-raster'")],
  ['signature-invalidation-state', text.includes("'invalidated-by-modification'")],
  ['signature-field-preservation', text.includes('signaturesPreservedAsFields')],
  ['pdf-specific-guard-band', text.includes('pdfFindingPlacements(sourcePage, findings)')]
];
for (const [name, passed] of checks) console.log(`CHECK ${name}=${passed ? 1 : 0}`);
const passed = checks.filter(([, value]) => value).length;
console.log(`PHASE19_PROBE ${passed}/${checks.length}`);
process.exit(passed === checks.length ? 0 : 1);

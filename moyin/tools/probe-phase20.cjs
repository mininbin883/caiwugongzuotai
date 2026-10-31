'use strict';
const fs=require('node:fs');
const target=process.argv[2];
if(!target){console.error('usage: node tools/probe-phase20.cjs TARGET');process.exit(2)}
const text=fs.readFileSync(target,'utf8');
const checks=[
 ['rotation-and-crop-inventory',text.includes('rotatedPages')&&text.includes('cropBoxes')&&text.includes('pageGeometry')],
 ['transformed-text-bounds',text.includes('function textItemViewportBounds(')],
 ['geometry-raster-rewrite',text.includes('async function pageRasterForGeometry(')],
 ['encrypted-pdf-gate',text.includes('LOCAL_PDF_ENCRYPTED')&&text.includes('encrypted-password-required')],
 ['pdfa-diagnostics',text.includes('pdfaDeclared')&&text.includes('pdfaDeclarationPreserved')],
 ['xfa-preservation-state',text.includes("xfaState: before.hasXfa ? 'preserved-unvalidated'")],
 ['resigning-interface',text.includes('async function createPdfResigningRequest(')&&text.includes('external-post-export')],
 ['geometry-preservation-gate',text.includes('rotationsPreserved')&&text.includes('cropBoxesPreserved')]
];
for(const [name,ok] of checks)console.log(`CHECK ${name}=${ok?1:0}`);
const passed=checks.filter(([,ok])=>ok).length;
console.log(`PHASE20_PROBE ${passed}/${checks.length}`);
process.exit(passed===checks.length?0:1);

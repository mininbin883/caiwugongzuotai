'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = path.resolve(process.argv[2] || 'src/main.cjs');
const source = fs.readFileSync(input, 'utf8');
const probes = {
  pdf_import: /recognizePdf/.test(source),
  pdf_renderer: /renderRedactedPdf/.test(source),
  pdf_open_branch: /extension === '\.pdf'/.test(source),
  pdf_export_branch: /payload\.kind === 'pdf'/.test(source),
  pdf_smoke: /runPdfSmoke/.test(source),
  page_fields: /pageCount: pages\.length/.test(source)
};
const passed = Object.values(probes).filter(Boolean).length;
const detail = Object.entries(probes).map(([name, value]) => `${name}=${value ? 1 : 0}`).join(' ');
process.stdout.write(`PHASE3_PROBE input=${path.basename(input)} checks=${passed}/${Object.keys(probes).length} ${detail}\n`);
process.exitCode = passed === Object.keys(probes).length ? 0 : 1;

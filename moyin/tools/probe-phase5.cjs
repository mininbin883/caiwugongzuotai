'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = path.resolve(process.argv[2] || 'src/main.cjs');
const source = fs.readFileSync(input, 'utf8');
const probes = {
  office_import: /extractOfficeDocument[\s\S]*renderRedactedOffice/.test(source),
  office_sessions: /const officeSessions = new Map\(\)/.test(source),
  office_open_branch: /OFFICE_EXTENSIONS\.includes\(extension\)/.test(source),
  office_export_docx: /payload\.kind === 'docx'/.test(source),
  office_export_xlsx: /payload\.kind === 'xlsx'/.test(source),
  office_token: /payload\.officeToken/.test(source),
  office_smoke: /runOfficeSmoke/.test(source)
};
const passed = Object.values(probes).filter(Boolean).length;
const detail = Object.entries(probes).map(([name, value]) => `${name}=${value ? 1 : 0}`).join(' ');
process.stdout.write(`PHASE5_PROBE input=${path.basename(input)} checks=${passed}/${Object.keys(probes).length} ${detail}\n`);
process.exitCode = passed === Object.keys(probes).length ? 0 : 1;

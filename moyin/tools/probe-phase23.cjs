#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || process.cwd());
const read = (relative) => {
  try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return ''; }
};
const exists = (relative) => fs.existsSync(path.join(root, relative));

const pkg = read('package.json');
const service = read('src/services/csv-redaction-service.cjs');
const main = read('src/main.cjs');
const batch = read('src/services/batch-export-service.cjs');
const renderer = read('src/renderer/renderer.mjs');
const html = read('src/renderer/index.html');
const unit = read('tests/csv-redaction.test.mjs');
const batchTest = read('tests/batch-export.test.mjs');
const integration = read('tools/csv-integration.cjs');
const comparison = read('ORIGINAL_COMPARISON_PHASE23.md');

const checks = [
  ['package-v2.3-and-test-script', /"version"\s*:\s*"2\.3\.0"/u.test(pkg) && /"test:csv"/u.test(pkg)],
  ['csv-service-encodings', exists('src/services/csv-redaction-service.cjs') && /utf16le/u.test(service) && /utf16-be/u.test(service) && /gb18030/u.test(service)],
  ['csv-dialect-structure-formula', /detectDelimiter/u.test(service) && /lineEnding/u.test(service) && /LOCAL_CSV_STRUCTURE_CHANGED/u.test(service) && /sanitizeFormulaCells/u.test(service)],
  ['main-csv-session-export-restore', /csvSessions/u.test(main) && /renderRedactedCsv/u.test(main) && /payload\.kind\s*===\s*['"]csv['"]/u.test(main) && /CSV_PACKAGED_SMOKE_/u.test(main)],
  ['batch-routes-csv-renderer', /result\.csv/u.test(batch) && /renderCsv/u.test(batch)],
  ['renderer-csv-metadata-and-state', /csvMappingValid/u.test(renderer) && /delimiterName/u.test(renderer) && /导出可逆代号 CSV/u.test(renderer)],
  ['renderer-csv-dedicated-button', /exportCsvButton/u.test(html) && /导出原格式 CSV/u.test(html)],
  ['csv-unit-and-batch-tests', /byte-identical UTF-8 BOM/u.test(unit) && /LOCAL_CSV_STRUCTURE_CHANGED/u.test(unit) && /routes CSV through the original-format renderer/u.test(batchTest)],
  ['csv-integration-three-formats', /utf16le-tab-lf/u.test(integration) && /gb18030-semicolon-crlf/u.test(integration) && /CSV_PHASE23_/u.test(integration)],
  ['phase23-comparison-and-next-gaps', /CSV 对齐复核/u.test(comparison) && /RapidOCR/u.test(comparison) && /复杂 Office/u.test(comparison)]
];

let passed = 0;
for (const [name, ok] of checks) {
  if (ok) passed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
}
process.stdout.write(`SUMMARY ${passed}/${checks.length}\n`);
process.exitCode = passed === checks.length ? 0 : 3;

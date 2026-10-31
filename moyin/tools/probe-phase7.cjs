'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
if (!input) {
  process.stderr.write('usage: node tools/probe-phase7.cjs <main.cjs>\n');
  process.exit(2);
}

const source = fs.readFileSync(input, 'utf8');
const checks = {
  export_service: /batch-export-service\.cjs/.test(source),
  export_sessions: /batchExportSessions/.test(source),
  redaction_engine: /function loadRedactionEngine/.test(source),
  export_handler: /async function exportCompletedBatch/.test(source),
  cancel_handler: /function cancelBatchExport/.test(source),
  progress_event: /veilforge:batch-export-progress/.test(source),
  export_ipc: /veilforge:batch-export'/.test(source),
  cancel_ipc: /veilforge:batch-export-cancel/.test(source),
  smoke_branch: /async function runBatchExportSmoke/.test(source),
  cleanup_cancel: /exportSession\.cancelRequested = true/.test(source)
};
const passed = Object.values(checks).filter(Boolean).length;
const details = Object.entries(checks).map(([name, value]) => `${name}=${value ? 1 : 0}`).join(' ');
process.stdout.write(`PHASE7_PROBE input=${path.basename(input)} checks=${passed}/${Object.keys(checks).length} ${details}\n`);
process.exit(passed === Object.keys(checks).length ? 0 : 1);

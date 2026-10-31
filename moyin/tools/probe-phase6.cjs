'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
if (!input) {
  process.stderr.write('usage: node tools/probe-phase6.cjs <main.cjs>\n');
  process.exit(2);
}

const source = fs.readFileSync(input, 'utf8');
const checks = {
  queue_service: /SerialTaskQueue/.test(source),
  shared_processor: /async function processDocumentPath/.test(source),
  enqueue_branch: /async function enqueueBatch/.test(source),
  list_branch: /function listBatch/.test(source),
  open_branch: /function openBatchResult/.test(source),
  cancel_branch: /function cancelBatch/.test(source),
  clear_branch: /function clearBatch/.test(source),
  ipc_surface: /veilforge:batch-enqueue/.test(source) && /veilforge:batch-open/.test(source),
  smoke_branch: /async function runBatchSmoke/.test(source)
};
const passed = Object.values(checks).filter(Boolean).length;
const details = Object.entries(checks).map(([name, value]) => `${name}=${value ? 1 : 0}`).join(' ');
process.stdout.write(`PHASE6_PROBE input=${path.basename(input)} checks=${passed}/${Object.keys(checks).length} ${details}\n`);
process.exit(passed === Object.keys(checks).length ? 0 : 1);

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

async function main() {
  const html = read('src/renderer/index.html');
  const css = read('src/renderer/styles.css');
  const renderer = read('src/renderer/renderer.mjs');
  const mainSource = read('src/main.cjs');
  const preload = read('src/preload.cjs');
  const controller = await import(pathToFileURL(path.join(root, 'src/core/navigation-controller.mjs')).href);

  const ids = [...html.matchAll(/data-module="([^"]+)"/g)].map((match) => match[1]);
  if (ids.length !== 5 || new Set(ids).size !== 5) throw new Error(`NAV_DESTINATION_COUNT:${ids.join(',')}`);
  if (ids.join(',') !== controller.MODULE_IDS.join(',')) throw new Error('NAV_ORDER_MISMATCH');
  if (!html.includes('aria-label="功能导航"') || !html.includes('aria-label="三步脱敏闭环"')) throw new Error('NAV_ARIA_MISSING');
  if (!html.includes('data-module-section="redact protect"') || !html.includes('data-module-section="vault"')) throw new Error('CONTEXTUAL_SIDEBAR_MISSING');
  if (!css.includes('.module-hidden') || !css.includes('.module-nav-item:focus-visible')) throw new Error('NAV_VISUAL_STATE_MISSING');
  if (!renderer.includes("case 'ArrowRight'") || !renderer.includes("case 'End'") || !renderer.includes('event.ctrlKey')) throw new Error('KEYBOARD_NAV_MISSING');
  if (!renderer.includes("window.addEventListener('hashchange'") || !renderer.includes('history.pushState')) throw new Error('HASH_NAV_MISSING');
  if (!mainSource.includes("properties: ['openFile', 'multiSelections']") || !preload.includes('pickBatchDocuments')) throw new Error('BATCH_PICKER_MISSING');
  if (!controller.moduleVisibility('redact').showRedactionWorkflow || controller.moduleVisibility('batch').showRedactionWorkflow) throw new Error('WORKFLOW_VISIBILITY_INVALID');
  if (controller.nextModuleId('protect', 'next') !== 'redact' || controller.nextModuleId('redact', 'previous') !== 'protect') throw new Error('NAV_WRAP_INVALID');

  process.stdout.write('PHASE26_PASS modules=5 routes=5 keyboard=arrow+home+end+ctrl1-5 hash=1 batchPicker=multi workflow=preserved\n');
}

main().catch((error) => {
  process.stderr.write(`PHASE26_FAIL ${error?.stack || error}\n`);
  process.exitCode = 1;
});

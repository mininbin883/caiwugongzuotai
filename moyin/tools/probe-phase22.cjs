const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
const read = (p) => {
  try { return fs.readFileSync(path.join(root, p), 'utf8'); }
  catch { return ''; }
};

const files = {
  html: read('src/renderer/index.html'),
  renderer: read('src/renderer/renderer.mjs'),
  css: read('src/renderer/styles.css'),
  demo: read('src/core/workflow-demo.mjs'),
  test: read('tests/workflow-demo.test.mjs'),
  package: read('package.json'),
  comparison: read('ORIGINAL_COMPARISON_PHASE22.md')
};

const checks = [
  ['workflow guide', /workflowGuide/.test(files.html) && /workflowStepImport/.test(files.html)],
  ['onboarding copy', /用示例试一试/.test(files.html) && /文件无需上传/.test(files.html) && /PNG\/JPG\/WEBP\/TIFF/.test(files.html)],
  ['local demo core', /DEMO_DOCUMENT/.test(files.demo) && /demoDocumentResult/.test(files.demo)],
  ['workflow renderer', /renderWorkflowProgress/.test(files.renderer) && /workflowSteps/.test(files.renderer)],
  ['demo custom term', /loadDemo/.test(files.renderer) && /流光计划/.test(files.renderer)],
  ['stage transitions', /workflowStage:\s*'import'/.test(files.renderer) && /renderWorkflowProgress\('review'\)/.test(files.renderer) && /renderWorkflowProgress\('complete'\)/.test(files.renderer)],
  ['responsive workflow css', /\.workflow-guide > li\.current/.test(files.css) && /\.workflow-guide > li\.done/.test(files.css) && /@media\s*\(max-width:\s*1180px\)/.test(files.css)],
  ['release and evidence', /"version": "2\.2\.0"/.test(files.package) && /three-step workflow/.test(files.test) && /墨隐 2\.2\.0/.test(files.comparison)]
];

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'MISS'} ${name}`);
const score = checks.filter(([, ok]) => ok).length;
console.log(`PHASE22_SCORE=${score}/${checks.length}`);
process.exit(score === checks.length ? 0 : 3);

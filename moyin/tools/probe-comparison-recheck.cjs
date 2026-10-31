'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node tools/probe-comparison-recheck.cjs <report.md>\n');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const checks = [
  ['fresh-evidence', '## 本次重新核验的新增证据'],
  ['installed-versions', '### 安装体量与版本'],
  ['capacity-boundaries', '### 明确容量边界'],
  ['production-fidelity', '### 生产文档兼容度'],
  ['overall-verdict', '## 总体判断'],
  ['priority-order', '## 优先级排序'],
  ['observed-label', '**Observed：**'],
  ['inferred-label', '**Inferred：**']
];

let passed = 0;
for (const [name, marker] of checks) {
  const ok = text.includes(marker);
  if (ok) passed += 1;
  process.stdout.write(`CHECK ${name}=${ok ? 1 : 0}\n`);
}
process.stdout.write(`COMPARISON_RECHECK ${passed}/${checks.length}\n`);
process.exit(passed === checks.length ? 0 : 1);

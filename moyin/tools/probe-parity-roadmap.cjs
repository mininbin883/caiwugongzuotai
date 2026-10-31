'use strict';

const fs = require('node:fs');
const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node tools/probe-parity-roadmap.cjs <roadmap.md>\n');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const checks = [
  ['success-gates', '## 追平与超越的量化门槛'],
  ['architecture', '## 目标架构'],
  ['capacity', '### Phase 16：流式任务底座与容量追平'],
  ['office', '### Phase 18：XLSX、DOCX、CSV 生产兼容度'],
  ['pdf', '### Phase 19：复杂 PDF 语义保真'],
  ['ocr-ner', '### Phase 20：OCR 与中文 NER 超越'],
  ['acceptance', '## 统一验收矩阵'],
  ['risks', '## 风险与止损线']
];

let passed = 0;
for (const [name, marker] of checks) {
  const ok = text.includes(marker);
  if (ok) passed += 1;
  process.stdout.write(`CHECK ${name}=${ok ? 1 : 0}\n`);
}
process.stdout.write(`PARITY_ROADMAP ${passed}/${checks.length}\n`);
process.exit(passed === checks.length ? 0 : 1);

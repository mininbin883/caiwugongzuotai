'use strict';

// 整个文件夹还原：例如税务筛查技能生成的“筛查结果”（报告 .md/.docx、台账 .xlsx）。
// 输出到“原文件夹名-已还原”，文件名与子目录结构不变；.json 等不需要还原的文件跳过。

const fs = require('node:fs/promises');
const path = require('node:path');

const FOLDER_RESTORE_EXTENSIONS = ['docx', 'xlsx', 'csv', 'md', 'txt'];

async function walk(root, relative, depth, out) {
  if (depth > 3 || out.files.length > 500) return;
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) { await walk(root, rel, depth + 1, out); continue; }
    if (!entry.isFile()) continue;
    const kind = path.extname(entry.name).toLowerCase().slice(1);
    if (FOLDER_RESTORE_EXTENSIONS.includes(kind) && !entry.name.startsWith('~$')) out.files.push({ rel, kind });
    else out.skipped.push(rel);
  }
}

async function listRestorableFiles(folderPath) {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) throw new Error('LOCAL_PATH_INVALID');
  const out = { files: [], skipped: [] };
  await walk(folderPath, '', 0, out);
  // 编号来自路径（如 …/MI-000200-税务筛查资料/筛查结果）或文件名。
  const fileNumber = folderPath.match(/MI-\d{6}/u)?.[0] || out.files.map((item) => item.rel.match(/MI-\d{6}/u)?.[0]).find(Boolean) || '';
  return { ...out, fileNumber };
}

async function availableOutput(folderPath) {
  let output = `${folderPath}-已还原`;
  for (let counter = 2; counter < 100; counter += 1) {
    try {
      await fs.access(output);
      output = `${folderPath}-已还原 (${counter})`;
    } catch {
      break;
    }
  }
  return output;
}

async function restoreFolderFiles(folderPath, files, mapping, deps) {
  if (!Array.isArray(mapping) || !mapping.length) throw new Error('LOCAL_VAULT_MAPPING_INVALID');
  const output = await availableOutput(folderPath);
  await fs.mkdir(output, { recursive: true });
  const results = [];
  for (const file of files) {
    const source = path.join(folderPath, file.rel);
    const target = path.join(output, file.rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      if (file.kind === 'docx' || file.kind === 'xlsx') {
        try {
          const restored = await deps.restoreReversibleOffice(source, mapping, target);
          results.push({ rel: file.rel, restored: restored.restoredOccurrences, unknown: restored.unknownTokens.length });
        } catch (error) {
          if (!String(error?.message || '').includes('TOKENS_NOT_FOUND')) throw error;
          await fs.copyFile(source, target);
          results.push({ rel: file.rel, restored: 0, unknown: 0 });
        }
      } else if (file.kind === 'csv') {
        const csv = await deps.extractCsvDocument(source);
        const report = deps.restoreTokens(csv.text, mapping, { mode: 'analysis' });
        await deps.renderRedactedCsv(csv.session, report.restoredText, target, { sanitizeFormulas: false });
        results.push({ rel: file.rel, restored: report.restoredCount, unknown: report.unknownTokens.length });
      } else {
        const raw = await fs.readFile(source, 'utf8');
        const bom = raw.startsWith('﻿') ? '﻿' : '';
        const report = deps.restoreTokens(bom ? raw.slice(1) : raw, mapping, { mode: 'analysis' });
        await fs.writeFile(target, `${bom}${report.restoredText}`, 'utf8');
        results.push({ rel: file.rel, restored: report.restoredCount, unknown: report.unknownTokens.length });
      }
    } catch (error) {
      results.push({ rel: file.rel, error: String(error?.message || error) });
    }
  }
  return { outputDirectory: output, results };
}

module.exports = { FOLDER_RESTORE_EXTENSIONS, listRestorableFiles, restoreFolderFiles };

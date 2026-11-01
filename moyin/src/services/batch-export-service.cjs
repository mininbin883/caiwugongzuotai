'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

const AUDIT_FORMAT = 'VEILFORGE_BATCH_AUDIT';
const MANIFEST_FORMAT = 'VEILFORGE_BATCH_MANIFEST';

function cleanStem(value) {
  return String(value || 'document')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim()
    .slice(0, 120) || 'document';
}

function outputFileName(result, prefix = '') {
  const parsed = path.parse(String(result?.name || 'document.txt'));
  // 批次模式：MI-000123-01-原名-脱敏副本.xlsx，编号一致，逆脱敏时选这一个编号即可。
  const stem = prefix ? `${prefix}-${cleanStem(parsed.name)}-脱敏副本` : `${cleanStem(parsed.name)}-脱敏`;
  if (result?.office?.kind === 'docx' || result?.office?.kind === 'xlsx') return `${stem}.${result.office.kind}`;
  if (result?.image?.kind === 'pdf') return `${stem}.pdf`;
  if (result?.image?.kind === 'image') return `${stem}.png`;
  const extension = /^\.[a-z0-9]{1,8}$/iu.test(result?.extension || '') ? result.extension.toLowerCase() : '.txt';
  return `${stem}${extension}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function availablePath(directory, fileName, reserved, includeAuditSidecar = false) {
  const parsed = path.parse(fileName);
  for (let counter = 1; counter <= 9999; counter += 1) {
    const suffix = counter === 1 ? '' : ` (${counter})`;
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    const key = candidate.toLocaleLowerCase('en-US');
    if (reserved.has(key) || await exists(candidate)) continue;
    if (includeAuditSidecar && await exists(`${candidate}.audit.json`)) continue;
    reserved.add(key);
    return candidate;
  }
  throw new Error('LOCAL_BATCH_EXPORT_NAME_EXHAUSTED');
}

function safeFindings(findings) {
  return findings.map(({ type, label, start, end, replacement }) => ({ type, label, start, end, replacement }));
}

async function renderJob(job, directory, handlers, reserved, index = 0) {
  const result = job?.result;
  if (!result || typeof result.text !== 'string') throw new Error('LOCAL_BATCH_EXPORT_RESULT_INVALID');
  const analysis = await handlers.analyzeText(result.text, job);
  const findings = Array.isArray(analysis?.findings) ? analysis.findings.filter((item) => item.enabled !== false) : [];
  const redactedText = analysis.redactedText ?? await handlers.applyFindings(result.text, findings);
  const prefix = typeof handlers.outputPrefix === 'function' ? handlers.outputPrefix(index) : '';
  const outputPath = await availablePath(directory, outputFileName(result, prefix), reserved, true);
  // 记录目录：审计记录可与资料分开存放（税务筛查模式下资料文件夹只放资料本身）。
  const auditPath = path.join(handlers.recordDirectory || directory, `${path.basename(outputPath)}.audit.json`);
  let render = { unchanged: findings.length === 0 };
  try {
    if (result.csv) {
      if (typeof handlers.renderCsv !== 'function') throw new Error('LOCAL_BATCH_EXPORT_HANDLER_REQUIRED:renderCsv');
      render = await handlers.renderCsv(result.csv, redactedText, outputPath, job);
    } else if (!findings.length) {
      await fs.copyFile(job.input, outputPath, constants.COPYFILE_EXCL);
      render.bytes = (await fs.stat(outputPath)).size;
    } else if (result.office) {
      render = await handlers.renderOffice(result.office, findings, outputPath, job);
    } else if (result.image?.kind === 'pdf') {
      render = await handlers.renderPdf(result.image, findings, outputPath, job);
    } else if (result.image?.kind === 'image') {
      render = await handlers.renderImage(result.image, findings, outputPath, job);
    } else {
      await fs.writeFile(outputPath, redactedText, { encoding: 'utf8', flag: 'wx' });
      render = { bytes: Buffer.byteLength(redactedText, 'utf8'), characters: redactedText.length };
    }
    const audit = {
      format: AUDIT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceName: result.name,
      sourceExtension: result.extension,
      sourceBytes: result.sourceBytes,
      outputName: path.basename(outputPath),
      findingCount: findings.length,
      findings: safeFindings(findings),
      render
    };
    await fs.writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return {
      id: job.id,
      sourceName: result.name,
      outputPath,
      auditPath,
      findingCount: findings.length,
      findingTypes: [...new Set(findings.map((item) => String(item.type || 'custom')))],
      vaultText: redactedText,
      render
    };
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => {});
    await fs.rm(auditPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function exportBatchResults(jobs, directory, handlers = {}) {
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('LOCAL_BATCH_EXPORT_EMPTY');
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) throw new Error('LOCAL_BATCH_EXPORT_DIRECTORY_INVALID');
  for (const name of ['analyzeText', 'applyFindings', 'renderOffice', 'renderPdf', 'renderImage']) {
    if (typeof handlers[name] !== 'function') throw new Error(`LOCAL_BATCH_EXPORT_HANDLER_REQUIRED:${name}`);
  }
  const reserved = new Set();
  const records = [];
  const errors = [];
  let canceled = false;
  const progress = (detail) => handlers.onProgress?.({ total: jobs.length, exported: records.length, failed: errors.length, ...detail });

  for (let index = 0; index < jobs.length; index += 1) {
    if (handlers.shouldCancel?.()) {
      canceled = true;
      progress({ status: 'canceled', index, name: jobs[index]?.result?.name || '' });
      break;
    }
    const job = jobs[index];
    progress({ status: 'processing', index, name: job?.result?.name || '' });
    try {
      const record = await renderJob(job, directory, handlers, reserved, index);
      records.push(record);
      progress({ status: 'done', index, id: job?.id, name: record.sourceName, outputName: path.basename(record.outputPath) });
    } catch (error) {
      const failure = { id: job?.id, sourceName: job?.result?.name || '', error: String(error?.message || error) };
      errors.push(failure);
      progress({ status: 'failed', index, id: failure.id, name: failure.sourceName, error: failure.error });
    }
  }

  const manifestPath = await availablePath(handlers.recordDirectory || directory, '墨隐-批处理清单.json', reserved);
  const manifest = {
    format: MANIFEST_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    canceled,
    total: jobs.length,
    exported: records.length,
    failed: errors.length,
    items: records.map((record) => ({
      sourceName: record.sourceName,
      outputName: path.basename(record.outputPath),
      auditName: path.basename(record.auditPath),
      findingCount: record.findingCount,
      render: record.render
    })),
    errors
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  progress({ status: canceled ? 'canceled' : 'complete', index: records.length + errors.length, manifestName: path.basename(manifestPath) });
  return { directory, canceled, total: jobs.length, exported: records.length, failed: errors.length, records, errors, manifestPath };
}

module.exports = {
  AUDIT_FORMAT,
  MANIFEST_FORMAT,
  outputFileName,
  exportBatchResults
};

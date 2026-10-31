'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function executableExists(value) {
  if (!value) return false;
  if (path.isAbsolute(value)) return fs.access(value).then(() => true, () => false);
  return true;
}

function findCompliance(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['isCompliant', 'compliant']) if (typeof value[key] === 'boolean') return value[key];
  for (const child of Object.values(value)) {
    const result = findCompliance(child);
    if (result !== null) return result;
  }
  return null;
}

async function validatePdfA(filePath, options = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_PATH_INVALID');
  const executable = String(options.executable || process.env.VEILFORGE_VERAPDF || 'verapdf');
  const args = ['--format', 'json', '--maxfailures', String(options.maxFailures || 100)];
  if (options.flavour) args.push('--flavour', String(options.flavour));
  if (options.password) args.push('--password', String(options.password));
  args.push(filePath);
  const runner = options.runner || (async (command, commandArgs) => execFileAsync(command, commandArgs, {
    windowsHide: true,
    timeout: Number(options.timeoutMs || 120000),
    maxBuffer: 16 * 1024 * 1024
  }));
  if (path.isAbsolute(executable) && !(await executableExists(executable))) {
    return { validator: 'veraPDF', available: false, executed: false, compliant: null, executable, reason: 'VERAPDF_NOT_INSTALLED' };
  }
  try {
    const result = await runner(executable, args);
    const stdout = String(result?.stdout || '');
    const report = JSON.parse(stdout);
    return {
      validator: 'veraPDF',
      available: true,
      executed: true,
      compliant: findCompliance(report),
      executable,
      args: args.filter((value, index) => args[index - 1] !== '--password'),
      report
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { validator: 'veraPDF', available: false, executed: false, compliant: null, executable, reason: 'VERAPDF_NOT_INSTALLED' };
    const stdout = String(error?.stdout || '');
    let report = null;
    try { report = stdout ? JSON.parse(stdout) : null; } catch {}
    return {
      validator: 'veraPDF',
      available: true,
      executed: true,
      compliant: findCompliance(report),
      executable,
      exitCode: Number(error?.code) || 1,
      reason: 'VERAPDF_VALIDATION_FAILED',
      report,
      stderr: String(error?.stderr || '').slice(0, 4096)
    };
  }
}

module.exports = { validatePdfA, findCompliance };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { createResourceBudget, assertNotAborted } = require('./resource-budget-service.cjs');

const WORKSPACE_PREFIX = 'veilforge-job-';
const MANIFEST_NAME = 'job-manifest.json';
const JOB_ID_PATTERN = /^[A-Za-z0-9-]{8,80}$/u;

function resolveAbsolute(value, code = 'LOCAL_WORKSPACE_PATH_INVALID') {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(code);
  return path.resolve(value);
}

function safeJobId(value = randomUUID()) {
  const normalized = String(value || '');
  if (!JOB_ID_PATTERN.test(normalized)) throw new Error('LOCAL_WORKSPACE_JOB_ID_INVALID');
  return normalized;
}

function assertChildPath(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('LOCAL_WORKSPACE_PATH_INVALID');
  return resolvedCandidate;
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filePath);
}

async function removeWorkspaceDirectory(root, directory) {
  const resolvedRoot = resolveAbsolute(root);
  const resolvedDirectory = assertChildPath(resolvedRoot, directory);
  if (path.dirname(resolvedDirectory) !== resolvedRoot || !path.basename(resolvedDirectory).startsWith(WORKSPACE_PREFIX)) {
    throw new Error('LOCAL_WORKSPACE_DELETE_DENIED');
  }
  await fs.rm(resolvedDirectory, { recursive: true, force: true });
}

async function copyAndHash(source, destination, options = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        assertNotAborted(options.signal);
        hash.update(chunk);
        bytes += chunk.length;
        options.onProgress?.({ stage: 'copy-input', bytes, totalBytes: options.totalBytes || 0 });
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    }
  });
  assertNotAborted(options.signal);
  await pipeline(
    createReadStream(source),
    meter,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    { signal: options.signal }
  );
  return { bytes, sha256: hash.digest('hex') };
}

function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function recoverOrphanedWorkspaces(root, options = {}) {
  const resolvedRoot = resolveAbsolute(root);
  await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  const report = { scanned: 0, removed: 0, active: 0, errors: [] };
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKSPACE_PREFIX)) continue;
    report.scanned += 1;
    const directory = assertChildPath(resolvedRoot, path.join(resolvedRoot, entry.name));
    let manifest = null;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(directory, MANIFEST_NAME), 'utf8'));
    } catch (error) {
      report.errors.push({ directory: entry.name, code: error?.code || 'INVALID_MANIFEST' });
    }
    if (manifest?.pid === process.pid || isProcessRunning(Number(manifest?.pid))) {
      report.active += 1;
      continue;
    }
    try {
      await removeWorkspaceDirectory(resolvedRoot, directory);
      report.removed += 1;
    } catch (error) {
      report.errors.push({ directory: entry.name, code: error?.code || error?.message || 'REMOVE_FAILED' });
    }
  }
  return report;
}

async function createJobWorkspace(inputPath, options = {}) {
  const sourcePath = resolveAbsolute(inputPath, 'LOCAL_PATH_INVALID');
  const root = resolveAbsolute(options.root, 'LOCAL_WORKSPACE_ROOT_INVALID');
  const jobId = safeJobId(options.jobId);
  const budget = options.budget || createResourceBudget({ profile: options.profile || 'parity' });
  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  budget.assertInputBytes(sourceStat.size);
  assertNotAborted(options.signal);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await budget.assertDiskSpace(root, Math.min(budget.profile.maxWorkspaceBytes, sourceStat.size * 3 + 64 * 1024 * 1024));
  const directory = assertChildPath(root, path.join(root, `${WORKSPACE_PREFIX}${jobId}`));
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  const inputDirectory = path.join(directory, 'input');
  const pageDirectory = path.join(directory, 'pages');
  const outputDirectory = path.join(directory, 'output');
  await Promise.all([
    fs.mkdir(inputDirectory, { mode: 0o700 }),
    fs.mkdir(pageDirectory, { mode: 0o700 }),
    fs.mkdir(outputDirectory, { mode: 0o700 })
  ]);
  const extension = path.extname(sourcePath).toLowerCase();
  const stagedName = `source${extension || '.bin'}`;
  const stagedInputPath = path.join(inputDirectory, stagedName);
  const manifestPath = path.join(directory, MANIFEST_NAME);
  const manifest = {
    format: 'VEILFORGE_JOB_WORKSPACE',
    version: 1,
    jobId,
    pid: process.pid,
    state: 'staging',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceName: path.basename(sourcePath),
    sourceBytes: sourceStat.size,
    sourceSha256: '',
    stagedName,
    profile: budget.profile.name,
    stages: []
  };
  await atomicJson(manifestPath, manifest);
  try {
    const copied = await copyAndHash(sourcePath, stagedInputPath, {
      signal: options.signal,
      onProgress: options.onProgress,
      totalBytes: sourceStat.size
    });
    if (copied.bytes !== sourceStat.size) throw new Error('LOCAL_WORKSPACE_COPY_INCOMPLETE');
    manifest.state = 'active';
    manifest.sourceSha256 = copied.sha256;
    manifest.updatedAt = new Date().toISOString();
    manifest.stages.push({ name: 'staged', at: manifest.updatedAt, bytes: copied.bytes });
    await atomicJson(manifestPath, manifest);
  } catch (error) {
    await removeWorkspaceDirectory(root, directory).catch(() => {});
    if (error?.name === 'AbortError' || options.signal?.aborted) throw new Error('LOCAL_JOB_ABORTED', { cause: error });
    throw error;
  }

  let closed = false;
  const workspace = {
    jobId,
    root,
    directory,
    inputPath: stagedInputPath,
    pageDirectory,
    outputDirectory,
    manifestPath,
    sourceName: manifest.sourceName,
    sourceBytes: manifest.sourceBytes,
    sourceSha256: manifest.sourceSha256,
    budget,
    createPath(relativePath) {
      if (closed) throw new Error('LOCAL_WORKSPACE_CLOSED');
      if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error('LOCAL_WORKSPACE_PATH_INVALID');
      return assertChildPath(directory, path.join(directory, relativePath));
    },
    async recordStage(name, detail = {}) {
      if (closed) throw new Error('LOCAL_WORKSPACE_CLOSED');
      manifest.updatedAt = new Date().toISOString();
      manifest.stages.push({ name: String(name), at: manifest.updatedAt, ...detail });
      await atomicJson(manifestPath, manifest);
    },
    async measure() {
      let total = 0;
      const queue = [directory];
      while (queue.length) {
        const current = queue.pop();
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory()) queue.push(fullPath);
          else if (entry.isFile()) total += (await fs.stat(fullPath)).size;
        }
      }
      budget.assertWorkspaceBytes(total);
      return total;
    },
    async cleanup() {
      if (closed) return false;
      closed = true;
      await removeWorkspaceDirectory(root, directory);
      return true;
    }
  };
  return Object.freeze(workspace);
}

module.exports = {
  WORKSPACE_PREFIX,
  MANIFEST_NAME,
  createJobWorkspace,
  recoverOrphanedWorkspaces,
  removeWorkspaceDirectory,
  copyAndHash,
  isProcessRunning,
  assertChildPath
};

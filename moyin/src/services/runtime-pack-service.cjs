'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const RUNTIME_PACK_FORMAT = 'VEILFORGE_RUNTIME_PACK_V1';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_FILES = 10000;
const MAX_RUNTIME_BYTES = 1024 * 1024 * 1024;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeRelative(value) {
  const normalized = String(value || '').replace(/\\/gu, '/');
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('LOCAL_RUNTIME_PACK_PATH_INVALID');
  }
  return normalized;
}

function runtimePackRoot() {
  if (process.env.VEILFORGE_RUNTIME_PACK_ROOT) return path.resolve(process.env.VEILFORGE_RUNTIME_PACK_ROOT);
  if (process.resourcesPath && !process.defaultApp) return path.join(process.resourcesPath, 'runtime-packs');
  return path.resolve(__dirname, '../../runtime-packs');
}

async function inspectRuntimePack(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('LOCAL_RUNTIME_PACK_DIRECTORY_INVALID');
  const resolved = path.resolve(directory);
  const manifestPath = path.join(resolved, 'manifest.json');
  const stat = await fsp.stat(manifestPath).catch(() => null);
  if (!stat?.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) throw new Error('LOCAL_RUNTIME_PACK_MANIFEST_MISSING');
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); }
  catch { throw new Error('LOCAL_RUNTIME_PACK_MANIFEST_INVALID'); }
  if (manifest?.format !== RUNTIME_PACK_FORMAT || manifest.kind !== 'python-ocr-runtime' ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(String(manifest.id || '')) ||
      manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      !Array.isArray(manifest.files) || manifest.files.length < 10 || manifest.files.length > MAX_RUNTIME_FILES) {
    throw new Error('LOCAL_RUNTIME_PACK_MANIFEST_INVALID');
  }
  const seen = new Set();
  let bytes = 0;
  for (const item of manifest.files) {
    item.path = safeRelative(item.path);
    if (seen.has(item.path) || !Number.isInteger(item.bytes) || item.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(String(item.sha256 || ''))) throw new Error('LOCAL_RUNTIME_PACK_MANIFEST_INVALID');
    seen.add(item.path);
    bytes += item.bytes;
  }
  const entry = safeRelative(manifest.entry);
  const packagesDir = safeRelative(manifest.packagesDir);
  for (const required of [entry, 'LICENSE-PYTHON.txt', 'LICENSE-RAPIDOCR.txt', 'NOTICE.txt', 'SBOM.json']) {
    if (!seen.has(required)) throw new Error(`LOCAL_RUNTIME_PACK_REQUIRED_FILE_MISSING:${required}`);
  }
  if (bytes > MAX_RUNTIME_BYTES) throw new Error('LOCAL_RUNTIME_PACK_TOO_LARGE');
  for (const item of manifest.files) {
    const filePath = path.resolve(resolved, item.path);
    if (!filePath.startsWith(`${resolved}${path.sep}`)) throw new Error('LOCAL_RUNTIME_PACK_PATH_INVALID');
    const fileStat = await fsp.stat(filePath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size !== item.bytes) throw new Error(`LOCAL_RUNTIME_PACK_SIZE_MISMATCH:${item.path}`);
    if (await sha256File(filePath) !== item.sha256) throw new Error(`LOCAL_RUNTIME_PACK_HASH_MISMATCH:${item.path}`);
  }
  return {
    directory: resolved,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    id: manifest.id,
    name: String(manifest.name || manifest.id),
    version: String(manifest.version || ''),
    pythonVersion: String(manifest.python || ''),
    engine: String(manifest.engine || ''),
    entry: path.join(resolved, entry),
    packagesDir: path.join(resolved, packagesDir),
    files: manifest.files.length,
    bytes,
    manifest
  };
}

async function findBundledRuntimePack(root = runtimePackRoot()) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try { return await inspectRuntimePack(path.join(root, entry.name)); }
    catch { /* Ignore invalid candidates and keep searching. */ }
  }
  return null;
}

module.exports = {
  RUNTIME_PACK_FORMAT,
  runtimePackRoot,
  inspectRuntimePack,
  findBundledRuntimePack,
  sha256File
};

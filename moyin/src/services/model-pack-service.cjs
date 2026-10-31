'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MODEL_PACK_FORMAT = 'VEILFORGE_MODEL_PACK_V1';
const MANIFEST_FILE = 'manifest.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PACK_FILES = 32;
const MAX_MODEL_FILE_BYTES = 1024 * 1024 * 1024;

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
    throw new Error('LOCAL_MODEL_PACK_PATH_INVALID');
  }
  return normalized;
}

function validateManifest(manifest, expectedKind) {
  if (!manifest || manifest.format !== MODEL_PACK_FORMAT || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(String(manifest.id || ''))) {
    throw new Error('LOCAL_MODEL_PACK_MANIFEST_INVALID');
  }
  if (!['ner', 'ocr'].includes(manifest.kind) || (expectedKind && manifest.kind !== expectedKind)) {
    throw new Error('LOCAL_MODEL_PACK_KIND_INVALID');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 3 || manifest.files.length > MAX_PACK_FILES) {
    throw new Error('LOCAL_MODEL_PACK_MANIFEST_INVALID');
  }
  const seen = new Set();
  for (const item of manifest.files) {
    item.path = safeRelative(item.path);
    if (seen.has(item.path) || !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_MODEL_FILE_BYTES ||
        !/^[a-f0-9]{64}$/u.test(String(item.sha256 || ''))) {
      throw new Error('LOCAL_MODEL_PACK_MANIFEST_INVALID');
    }
    seen.add(item.path);
  }
  if (!seen.has(safeRelative(manifest.entry)) || !seen.has('LICENSE.txt') || !seen.has('NOTICE.txt')) {
    throw new Error('LOCAL_MODEL_PACK_MANIFEST_INVALID');
  }
  return manifest;
}

async function inspectModelPack(directory, expectedKind = null) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('LOCAL_MODEL_PACK_DIRECTORY_INVALID');
  const resolved = path.resolve(directory);
  const manifestPath = path.join(resolved, MANIFEST_FILE);
  const manifestStat = await fsp.stat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.size < 2 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('LOCAL_MODEL_PACK_MANIFEST_MISSING');
  }
  let manifest;
  try { manifest = validateManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf8')), expectedKind); }
  catch (error) {
    if (String(error?.message || '').startsWith('LOCAL_MODEL_PACK_')) throw error;
    throw new Error('LOCAL_MODEL_PACK_MANIFEST_INVALID');
  }
  const files = [];
  for (const item of manifest.files) {
    const filePath = path.resolve(resolved, item.path);
    if (!filePath.startsWith(`${resolved}${path.sep}`)) throw new Error('LOCAL_MODEL_PACK_PATH_INVALID');
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size !== item.bytes) throw new Error(`LOCAL_MODEL_PACK_SIZE_MISMATCH:${item.path}`);
    const sha256 = await sha256File(filePath);
    if (sha256 !== item.sha256) throw new Error(`LOCAL_MODEL_PACK_HASH_MISMATCH:${item.path}`);
    files.push({ ...item, filePath, sha256 });
  }
  const manifestSha256 = await sha256File(manifestPath);
  return {
    directory: resolved,
    manifestPath,
    manifestSha256,
    id: manifest.id,
    kind: manifest.kind,
    name: String(manifest.name || manifest.id),
    version: String(manifest.version || ''),
    engine: String(manifest.engine || ''),
    source: String(manifest.source || ''),
    license: String(manifest.license || ''),
    entry: path.join(resolved, safeRelative(manifest.entry)),
    files,
    bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    manifest
  };
}

function modelPackRoot() {
  if (process.env.VEILFORGE_MODEL_PACK_ROOT) return path.resolve(process.env.VEILFORGE_MODEL_PACK_ROOT);
  if (process.resourcesPath && !process.defaultApp) return path.join(process.resourcesPath, 'model-packs');
  return path.resolve(__dirname, '../../model-packs');
}

async function findModelPacks(expectedKind = null, root = modelPackRoot()) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try { results.push(await inspectModelPack(path.join(root, entry.name), expectedKind)); }
    catch (error) { results.push({ directory: path.join(root, entry.name), valid: false, error: String(error?.message || error) }); }
  }
  return results;
}

async function findFirstModelPack(kind, root = modelPackRoot()) {
  const packs = await findModelPacks(kind, root);
  return packs.find((item) => item.kind === kind) || null;
}

module.exports = {
  MODEL_PACK_FORMAT,
  inspectModelPack,
  findModelPacks,
  findFirstModelPack,
  modelPackRoot,
  sha256File
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectModelPack, findFirstModelPack } = require('./model-pack-service.cjs');
const { inspectRuntimePack, findBundledRuntimePack } = require('./runtime-pack-service.cjs');

const RESULT_FORMAT = 'VEILFORGE_RAPIDOCR_RESULT_V1';
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

function bridgePath() {
  if (process.env.VEILFORGE_RAPIDOCR_BRIDGE) return path.resolve(process.env.VEILFORGE_RAPIDOCR_BRIDGE);
  if (process.resourcesPath && !process.defaultApp) return path.join(process.resourcesPath, 'tools', 'rapidocr-bridge.py');
  return path.resolve(__dirname, '../../tools/rapidocr-bridge.py');
}

function resolveExplicitPython(options = {}) {
  const value = options.pythonPath || process.env.VEILFORGE_RAPIDOCR_PYTHON;
  if (!value) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('LOCAL_RAPIDOCR_PYTHON_NOT_CONFIGURED');
  const resolved = path.resolve(value);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error('LOCAL_RAPIDOCR_PYTHON_INVALID');
  return resolved;
}

async function resolvePython(options = {}) {
  const explicit = resolveExplicitPython(options);
  if (explicit) return { python: explicit, runtimePack: null, packagesDir: String(options.packagesDir || process.env.PYTHONPATH || '') };
  const runtimePack = options.runtimeDirectory
    ? await inspectRuntimePack(path.resolve(options.runtimeDirectory))
    : await findBundledRuntimePack();
  if (!runtimePack) throw new Error('LOCAL_RAPIDOCR_RUNTIME_PACK_MISSING');
  return { python: runtimePack.entry, runtimePack, packagesDir: runtimePack.packagesDir };
}

function bboxFromPolygon(value) {
  if (!Array.isArray(value) || value.length < 4) throw new Error('LOCAL_RAPIDOCR_RESULT_INVALID');
  const xs = value.map((point) => Number(point?.[0]));
  const ys = value.map((point) => Number(point?.[1]));
  if ([...xs, ...ys].some((number) => !Number.isFinite(number))) throw new Error('LOCAL_RAPIDOCR_RESULT_INVALID');
  return {
    x0: Math.max(0, Math.round(Math.min(...xs))),
    y0: Math.max(0, Math.round(Math.min(...ys))),
    x1: Math.max(1, Math.round(Math.max(...xs))),
    y1: Math.max(1, Math.round(Math.max(...ys)))
  };
}

function normalizeResult(payload) {
  if (!payload || payload.format !== RESULT_FORMAT || !Number.isInteger(payload.width) || !Number.isInteger(payload.height) ||
      payload.width < 1 || payload.height < 1 || !Array.isArray(payload.words)) throw new Error('LOCAL_RAPIDOCR_RESULT_INVALID');
  const words = payload.words.map((word) => {
    const text = String(word?.text || '').trim();
    const confidence = Number(word?.confidence);
    if (!text || !Number.isFinite(confidence)) throw new Error('LOCAL_RAPIDOCR_RESULT_INVALID');
    return { text, confidence: Math.max(0, Math.min(100, confidence <= 1 ? confidence * 100 : confidence)), bbox: bboxFromPolygon(word.box) };
  });
  if (!words.length) throw new Error('LOCAL_OCR_EMPTY');
  const lineRecords = [];
  for (const line of Array.isArray(payload.lines) ? payload.lines : []) {
    const text = String(line?.text || '').trim();
    if (!text || !Array.isArray(line?.box)) continue;
    try {
      const confidence = Number(line?.confidence || 0);
      lineRecords.push({ text, confidence: Math.max(0, Math.min(100, confidence <= 1 ? confidence * 100 : confidence)), bbox: bboxFromPolygon(line.box) });
    } catch { /* Word boxes remain authoritative when an optional line box is malformed. */ }
  }
  return {
    width: payload.width,
    height: payload.height,
    elapsedSeconds: Number(payload.elapsedSeconds || 0),
    words,
    lines: Array.isArray(payload.lines) ? payload.lines.length : 0,
    lineRecords
  };
}

async function rapidOcrModelPack(options = {}) {
  if (options.modelDirectory) return inspectModelPack(path.resolve(options.modelDirectory), 'ocr');
  if (process.env.VEILFORGE_RAPIDOCR_PACK) return inspectModelPack(path.resolve(process.env.VEILFORGE_RAPIDOCR_PACK), 'ocr');
  const pack = await findFirstModelPack('ocr');
  if (!pack) throw new Error('LOCAL_RAPIDOCR_MODEL_PACK_MISSING');
  return pack;
}

async function inspectRapidOcrBackend(options = {}) {
  const [runtime, pack] = await Promise.all([resolvePython(options), rapidOcrModelPack(options)]);
  const bridge = path.resolve(options.bridgePath || bridgePath());
  if (!fs.statSync(bridge, { throwIfNoEntry: false })?.isFile()) throw new Error('LOCAL_RAPIDOCR_BRIDGE_MISSING');
  return {
    backend: 'rapidocr-ppocrv6',
    python: runtime.python,
    bridge,
    packagesDir: runtime.packagesDir,
    runtimePack: runtime.runtimePack ? {
      id: runtime.runtimePack.id,
      name: runtime.runtimePack.name,
      version: runtime.runtimePack.version,
      pythonVersion: runtime.runtimePack.pythonVersion,
      engine: runtime.runtimePack.engine,
      manifestSha256: runtime.runtimePack.manifestSha256,
      files: runtime.runtimePack.files,
      bytes: runtime.runtimePack.bytes
    } : null,
    modelPack: { id: pack.id, name: pack.name, version: pack.version, manifestSha256: pack.manifestSha256, bytes: pack.bytes },
    pack
  };
}

async function recognizeWithRapidOcr(source, options = {}) {
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) throw new Error('LOCAL_IMAGE_BUFFER_INVALID');
  const backend = await inspectRapidOcrBackend(options);
  const timeoutMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const child = spawn(backend.python, [backend.bridge, '--models', backend.pack.directory], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: backend.runtimePack?.directory || path.dirname(backend.python),
    env: {
      ...process.env,
      ...(backend.packagesDir ? { PYTHONPATH: backend.packagesDir } : {}),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    }
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('LOCAL_RAPIDOCR_TIMEOUT'));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`LOCAL_RAPIDOCR_SPAWN_FAILED:${error.message}`)); });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdoutBytes > MAX_STDOUT_BYTES) return reject(new Error('LOCAL_RAPIDOCR_OUTPUT_TOO_LARGE'));
      if (code !== 0) return reject(new Error(`LOCAL_RAPIDOCR_FAILED:${code}:${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`));
      try { resolve(normalizeResult(JSON.parse(Buffer.concat(stdout).toString('utf8')))); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(source));
  });
  return { ...result, backend: backend.backend, modelPack: backend.modelPack, runtimePack: backend.runtimePack };
}

module.exports = {
  RESULT_FORMAT,
  bridgePath,
  resolveExplicitPython,
  resolvePython,
  normalizeResult,
  rapidOcrModelPack,
  inspectRapidOcrBackend,
  recognizeWithRapidOcr
};

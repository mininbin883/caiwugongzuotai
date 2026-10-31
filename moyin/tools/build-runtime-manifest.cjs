'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(process.argv[2] || 'runtime-packs/rapidocr-python-win-x64-v1');

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function walk(directory, prefix = '') {
  const output = [];
  for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`RUNTIME_PACK_SYMLINK_REJECTED:${relative}`);
    if (entry.isDirectory()) output.push(...await walk(absolute, relative));
    else if (entry.isFile() && relative !== 'manifest.json') output.push({ relative, absolute });
  }
  return output;
}

function metadataField(text, name) {
  return new RegExp(`^${name}:\\s*(.+)$`, 'mu').exec(text)?.[1]?.trim() || '';
}

async function buildSbom() {
  const directory = path.join(root, 'packages');
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.endsWith('.dist-info')).sort((a, b) => a.name.localeCompare(b.name))) {
    const metadataPath = path.join(directory, entry.name, 'METADATA');
    const text = await fsp.readFile(metadataPath, 'utf8').catch(() => '');
    packages.push({
      name: metadataField(text, 'Name') || entry.name.replace(/\.dist-info$/u, ''),
      version: metadataField(text, 'Version'),
      licenseExpression: metadataField(text, 'License-Expression') || metadataField(text, 'License') || 'SEE-DIST-INFO',
      summary: metadataField(text, 'Summary'),
      metadata: `packages/${entry.name}/METADATA`
    });
  }
  return {
    format: 'VEILFORGE_RUNTIME_SBOM_V1',
    generatedAt: '2026-10-31T00:00:00.000Z',
    python: '3.13.15',
    architecture: 'win32-x64',
    packages
  };
}

async function main() {
  const sbom = await buildSbom();
  await fsp.writeFile(path.join(root, 'SBOM.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  const notice = [
    '墨隐 RapidOCR 离线运行时包',
    '',
    'Runtime: CPython 3.13.15 win32-x64',
    'OCR: RapidOCR 3.9.2 + ONNX Runtime 1.29.0 + OpenCV 5.0.0 + NumPy 2.5.3',
    'Purpose: local-only PP-OCRv6 inference; no network access is required.',
    '',
    'License materials are retained in LICENSE-PYTHON.txt, LICENSE-RAPIDOCR.txt,',
    'LICENSE-ANTLR4.txt, LICENSE-FLATBUFFERS.txt, package dist-info license folders,',
    'and packages/onnxruntime/ThirdPartyNotices.txt. See SBOM.json for installed versions.',
    ''
  ].join('\n');
  await fsp.writeFile(path.join(root, 'NOTICE.txt'), notice, 'utf8');
  const paths = await walk(root);
  const files = [];
  for (const item of paths) {
    const stat = await fsp.stat(item.absolute);
    files.push({ path: item.relative.replace(/\\/gu, '/'), bytes: stat.size, sha256: await sha256File(item.absolute) });
  }
  const manifest = {
    format: 'VEILFORGE_RUNTIME_PACK_V1',
    id: 'rapidocr-python-win-x64-v1',
    kind: 'python-ocr-runtime',
    name: 'CPython 3.13 + RapidOCR 3.9.2',
    version: '1.0.0',
    platform: 'win32',
    arch: 'x64',
    python: '3.13.15',
    engine: 'rapidocr@3.9.2+onnxruntime@1.29.0',
    entry: 'runtime/python.exe',
    packagesDir: 'packages',
    license: 'Multiple; see SBOM.json and retained license files',
    files
  };
  await fsp.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const bytes = files.reduce((sum, item) => sum + item.bytes, 0);
  process.stdout.write(`RUNTIME_MANIFEST_OK files=${files.length} bytes=${bytes} packages=${sbom.packages.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

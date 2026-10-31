'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { once } = require('node:events');
const { randomBytes, randomUUID, scrypt, createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);
const MAGIC = Buffer.from([0x4d, 0x49, 0x59, 0x49, 0x4e, 0x03, 0x0d, 0x0a]);
const FORMAT_VERSION = 3;
const INDEX_FORMAT = 'VEILFORGE_VAULT_CHUNK_INDEX';
const CHUNK_RECORD = 1;
const COMMIT_RECORD = 2;
const RECORD_FIXED_BYTES = 41;
const MAX_HEADER_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_COMMIT_BYTES = 32 * 1024 * 1024;
const MAX_VAULT_BYTES = 2 * 1024 * 1024 * 1024;
const PARITY_VAULT_BYTES = 256 * 1024 * 1024;
const CIPHER_NAME = 'aes-256-gcm';
const ACTIVITY_SCHEMA_VERSION = 1;
const MAX_ACTIVITY = 20;
const KDF_TEMPLATE = Object.freeze({ name: 'scrypt', n: 32768, r: 8, p: 1, keyLength: 32 });

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('LOCAL_VAULT_PASSWORD_POLICY');
  }
  return password;
}

function validateKdf(value) {
  if (!value || value.name !== KDF_TEMPLATE.name || value.n !== KDF_TEMPLATE.n || value.r !== KDF_TEMPLATE.r ||
      value.p !== KDF_TEMPLATE.p || value.keyLength !== KDF_TEMPLATE.keyLength || typeof value.salt !== 'string' ||
      Buffer.from(value.salt, 'base64').length !== 16) {
    throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  }
  return { ...KDF_TEMPLATE, salt: value.salt };
}

function newKdf() {
  return { ...KDF_TEMPLATE, salt: randomBytes(16).toString('base64') };
}

async function deriveKey(password, kdf) {
  validatePassword(password);
  return Buffer.from(await scryptAsync(password, Buffer.from(kdf.salt, 'base64'), kdf.keyLength, {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024
  }));
}

function assertAbsoluteFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_VAULT_PATH_INVALID');
}

function assertVaultGrowth(currentBytes, additionalBytes) {
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0 || !Number.isSafeInteger(additionalBytes) || additionalBytes < 0 ||
      currentBytes + additionalBytes > MAX_VAULT_BYTES) {
    throw new Error('LOCAL_VAULT_TOO_LARGE');
  }
  return currentBytes + additionalBytes;
}

function headerAad(header, type, sequence, ciphertextBytes) {
  return Buffer.from(JSON.stringify({
    format: header.format,
    version: FORMAT_VERSION,
    vaultId: header.vaultId,
    type,
    sequence: String(sequence),
    ciphertextBytes
  }), 'utf8');
}

function buildHeader(format, kdf) {
  return {
    format,
    version: FORMAT_VERSION,
    vaultId: randomUUID(),
    createdAt: new Date().toISOString(),
    kdf,
    cipher: { name: CIPHER_NAME },
    chunkBytes: CHUNK_BYTES
  };
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  if (json.length > MAX_HEADER_BYTES) throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  const prefix = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(json.length, MAGIC.length);
  return Buffer.concat([prefix, json]);
}

async function readExact(handle, length, position) {
  const output = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(output, read, length - read, position + read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  return read === length ? output : output.subarray(0, read);
}

async function readHeader(filePath) {
  assertAbsoluteFile(filePath);
  const handle = await fs.open(filePath, 'r');
  try {
    const prefix = await readExact(handle, MAGIC.length + 4, 0);
    if (prefix.length !== MAGIC.length + 4 || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('LOCAL_VAULT_FORMAT_INVALID');
    }
    const length = prefix.readUInt32BE(MAGIC.length);
    if (!length || length > MAX_HEADER_BYTES) throw new Error('LOCAL_VAULT_FORMAT_INVALID');
    const bytes = await readExact(handle, length, MAGIC.length + 4);
    if (bytes.length !== length) throw new Error('LOCAL_VAULT_FORMAT_INVALID');
    let header;
    try {
      header = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('LOCAL_VAULT_FORMAT_INVALID');
    }
    if (!header || header.version !== FORMAT_VERSION || typeof header.format !== 'string' || typeof header.vaultId !== 'string' ||
        header.cipher?.name !== CIPHER_NAME || header.chunkBytes !== CHUNK_BYTES) {
      throw new Error('LOCAL_VAULT_FORMAT_INVALID');
    }
    header.kdf = validateKdf(header.kdf);
    return { header, headerBytes: MAGIC.length + 4 + length };
  } finally {
    await handle.close();
  }
}

async function isV3Vault(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const bytes = await readExact(handle, MAGIC.length, 0);
    return bytes.length === MAGIC.length && bytes.equals(MAGIC);
  } finally {
    await handle.close();
  }
}

function encryptRecord(header, key, type, sequence, plaintext) {
  if (!Buffer.isBuffer(plaintext)) throw new Error('LOCAL_VAULT_PAYLOAD_INVALID');
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER_NAME, key, iv);
  cipher.setAAD(headerAad(header, type, sequence, plaintext.length), { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const bodyLength = 1 + 8 + 12 + 16 + ciphertext.length;
  const record = Buffer.alloc(4 + bodyLength);
  record.writeUInt32BE(bodyLength, 0);
  record.writeUInt8(type, 4);
  record.writeBigUInt64BE(BigInt(sequence), 5);
  iv.copy(record, 13);
  cipher.getAuthTag().copy(record, 25);
  ciphertext.copy(record, RECORD_FIXED_BYTES);
  return record;
}

async function recordMetaAt(handle, offset, fileSize) {
  if (offset === fileSize) return null;
  if (offset + 4 > fileSize) return { partial: true, offset };
  const sizeBytes = await readExact(handle, 4, offset);
  if (sizeBytes.length !== 4) return { partial: true, offset };
  const bodyLength = sizeBytes.readUInt32BE(0);
  if (bodyLength < RECORD_FIXED_BYTES - 4 || bodyLength > MAX_COMMIT_BYTES + RECORD_FIXED_BYTES) {
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
  const recordLength = 4 + bodyLength;
  if (offset + recordLength > fileSize) return { partial: true, offset };
  const fixed = await readExact(handle, RECORD_FIXED_BYTES - 4, offset + 4);
  if (fixed.length !== RECORD_FIXED_BYTES - 4) return { partial: true, offset };
  const type = fixed.readUInt8(0);
  const sequence = Number(fixed.readBigUInt64BE(1));
  const ciphertextBytes = bodyLength - (RECORD_FIXED_BYTES - 4);
  if (![CHUNK_RECORD, COMMIT_RECORD].includes(type) || !Number.isSafeInteger(sequence) || sequence < 1 ||
      ciphertextBytes < 0 || (type === CHUNK_RECORD && ciphertextBytes > CHUNK_BYTES) ||
      (type === COMMIT_RECORD && ciphertextBytes > MAX_COMMIT_BYTES)) {
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
  return {
    offset,
    recordLength,
    end: offset + recordLength,
    type,
    sequence,
    iv: fixed.subarray(9, 21),
    tag: fixed.subarray(21, 37),
    ciphertextOffset: offset + RECORD_FIXED_BYTES,
    ciphertextBytes
  };
}

async function decryptRecord(handle, header, key, meta) {
  try {
    const ciphertext = await readExact(handle, meta.ciphertextBytes, meta.ciphertextOffset);
    if (ciphertext.length !== meta.ciphertextBytes) throw new Error('partial');
    const decipher = createDecipheriv(CIPHER_NAME, key, meta.iv);
    decipher.setAAD(headerAad(header, meta.type, meta.sequence, meta.ciphertextBytes), { plaintextLength: meta.ciphertextBytes });
    decipher.setAuthTag(meta.tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
}

function emptyIndex() {
  const timestamp = new Date().toISOString();
  return {
    format: INDEX_FORMAT,
    version: FORMAT_VERSION,
    schemaVersion: 4,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextSequence: 1,
    nextRecordSequence: 1,
    activitySchemaVersion: 1,
    activityHistory: [],
    entries: []
  };
}

function normalizeActivityHistory(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ACTIVITY) throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  const ids = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        !['export', 'import'].includes(item.action) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) ||
        typeof item.name !== 'string' || !item.name || item.name.length > 240 || /[\\/]/u.test(item.name) ||
        !Number.isSafeInteger(item.entries) || item.entries < 0 || !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
        typeof item.sha256 !== 'string' || (item.sha256 && !/^[A-F0-9]{64}$/u.test(item.sha256)) ||
        !Number.isSafeInteger(item.imported) || item.imported < 0 || !Number.isSafeInteger(item.skipped) || item.skipped < 0 ||
        !Number.isSafeInteger(item.renamed) || item.renamed < 0 ||
        ['path', 'filePath', 'sourcePath', 'destinationPath', 'password', 'secret', 'token'].some((field) => Object.hasOwn(item, field))) {
      throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
    }
    ids.add(item.id);
    return structuredClone(item);
  });
}

function validateIndex(index, records) {
  if (!index || index.format !== INDEX_FORMAT || index.version !== FORMAT_VERSION || !Array.isArray(index.entries) ||
      !Number.isSafeInteger(index.nextSequence) || index.nextSequence < 1 || !Number.isSafeInteger(index.nextRecordSequence) ||
      index.nextRecordSequence < 1 || typeof index.createdAt !== 'string' || typeof index.updatedAt !== 'string') {
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
  index.activityHistory = normalizeActivityHistory(index.activityHistory);
  index.activitySchemaVersion = ACTIVITY_SCHEMA_VERSION;
  const ids = new Set();
  const sequences = new Set();
  for (const entry of index.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !Number.isInteger(entry.sequence) ||
        entry.sequence < 1 || sequences.has(entry.sequence) || typeof entry.name !== 'string' || typeof entry.createdAt !== 'string' ||
        !Array.isArray(entry.chunks) || !entry.chunks.length || !Number.isSafeInteger(entry.payloadBytes) || entry.payloadBytes < 1 ||
        typeof entry.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.payloadSha256) ||
        typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)) {
      throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
    }
    ids.add(entry.id);
    sequences.add(entry.sequence);
    let total = 0;
    for (const chunk of entry.chunks) {
      const meta = records.get(chunk.recordSequence);
      if (!meta || meta.type !== CHUNK_RECORD || meta.offset !== chunk.offset || meta.recordLength !== chunk.recordLength ||
          meta.ciphertextBytes !== chunk.plaintextBytes) {
        throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
      }
      total += chunk.plaintextBytes;
    }
    if (total !== entry.payloadBytes) throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
  return index;
}

async function scanVault(filePath, header, headerBytes, key, options = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const handle = await fs.open(filePath, 'r');
  const records = new Map();
  let offset = headerBytes;
  let lastSequence = 0;
  let lastCommit = null;
  try {
    while (offset < stat.size) {
      let meta;
      try {
        meta = await recordMetaAt(handle, offset, stat.size);
      } catch (error) {
        if (lastCommit && offset >= lastCommit.meta.end) break;
        throw error;
      }
      if (!meta || meta.partial) break;
      if (meta.sequence <= lastSequence || records.has(meta.sequence)) throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
      lastSequence = meta.sequence;
      records.set(meta.sequence, meta);
      const plaintext = await decryptRecord(handle, header, key, meta);
      if (meta.type === COMMIT_RECORD) {
        let index;
        try {
          index = JSON.parse(plaintext.toString('utf8'));
        } catch {
          throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
        }
        validateIndex(index, records);
        lastCommit = { meta, index };
      }
      offset = meta.end;
    }
  } finally {
    await handle.close();
  }
  if (!lastCommit) throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  const committedEnd = lastCommit.meta.end;
  if (options.recover !== false && stat.size !== committedEnd) await fs.truncate(filePath, committedEnd);
  return {
    data: lastCommit.index,
    committedEnd,
    lastRecordSequence: lastCommit.meta.sequence,
    lastCommitRecordLength: lastCommit.meta.recordLength,
    recoveredBytes: stat.size - committedEnd
  };
}

async function writeRecord(handle, offset, header, key, type, sequence, plaintext) {
  const record = encryptRecord(header, key, type, sequence, plaintext);
  assertVaultGrowth(offset, record.length);
  const result = await handle.write(record, 0, record.length, offset);
  if (result.bytesWritten !== record.length) throw new Error('LOCAL_VAULT_WRITE_INCOMPLETE');
  return {
    offset,
    recordLength: record.length,
    end: offset + record.length,
    type,
    sequence,
    plaintextBytes: plaintext.length
  };
}

function entryMetadata(entry, payload, chunks) {
  return {
    id: entry.id,
    sequence: entry.sequence,
    fileNumber: entry.fileNumber,
    createdAt: entry.createdAt,
    name: entry.name,
    kind: entry.kind,
    audit: entry.audit,
    characters: entry.text.length,
    importedFrom: entry.importedFrom,
    attachment: entry.attachment,
    attachments: entry.attachments,
    hidden: entry.kind === 'file-blob',
    fingerprint: entry.fingerprint,
    payloadBytes: payload.length,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    chunks
  };
}

async function commitIndex(context, nextData) {
  if (!context?.data || !Buffer.isBuffer(context.key) || context.version !== FORMAT_VERSION) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const originalEnd = context.committedEnd;
  const next = structuredClone(nextData);
  next.activityHistory = normalizeActivityHistory(next.activityHistory);
  next.activitySchemaVersion = ACTIVITY_SCHEMA_VERSION;
  const recordSequence = context.lastRecordSequence + 1;
  next.updatedAt = new Date().toISOString();
  next.nextRecordSequence = recordSequence + 1;
  const payload = Buffer.from(JSON.stringify(next), 'utf8');
  if (payload.length > MAX_COMMIT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const handle = await fs.open(context.filePath, 'r+');
  try {
    await handle.truncate(originalEnd);
    const commit = await writeRecord(handle, originalEnd, context.header, context.key, COMMIT_RECORD, recordSequence, payload);
    await handle.sync();
    context.data = next;
    context.committedEnd = commit.end;
    context.lastRecordSequence = recordSequence;
    context.lastCommitRecordLength = commit.recordLength;
    return next;
  } catch (error) {
    await handle.truncate(originalEnd).catch(() => {});
    await handle.sync().catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

async function appendEntries(context, iterable, options = {}) {
  if (!context?.data || !Buffer.isBuffer(context.key) || context.version !== FORMAT_VERSION) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const originalEnd = context.committedEnd;
  const next = structuredClone(context.data);
  const handle = await fs.open(context.filePath, 'r+');
  let offset = originalEnd;
  let recordSequence = context.lastRecordSequence + 1;
  let appended = 0;
  try {
    await handle.truncate(originalEnd);
    for await (const entry of iterable) {
      const payload = Buffer.from(JSON.stringify(entry), 'utf8');
      const chunks = [];
      for (let position = 0; position < payload.length; position += CHUNK_BYTES) {
        const plaintext = payload.subarray(position, Math.min(position + CHUNK_BYTES, payload.length));
        const written = await writeRecord(handle, offset, context.header, context.key, CHUNK_RECORD, recordSequence, plaintext);
        chunks.push({
          recordSequence,
          offset: written.offset,
          recordLength: written.recordLength,
          plaintextBytes: plaintext.length
        });
        offset = written.end;
        recordSequence += 1;
      }
      next.entries.push(entryMetadata(entry, payload, chunks));
      next.nextSequence = Math.max(next.nextSequence, entry.sequence + 1);
      appended += 1;
    }
    let metadataChanged = false;
    if (Number.isSafeInteger(options.nextSequenceFloor) && options.nextSequenceFloor > next.nextSequence) {
      next.nextSequence = options.nextSequenceFloor;
      metadataChanged = true;
    }
    if (Number.isInteger(options.schemaVersion) && options.schemaVersion > Number(next.schemaVersion || FORMAT_VERSION)) {
      next.schemaVersion = options.schemaVersion;
      metadataChanged = true;
    }
    if (typeof options.createdAt === 'string' && options.createdAt !== next.createdAt) {
      next.createdAt = options.createdAt;
      metadataChanged = true;
    }
    if (options.activityHistory !== undefined) {
      next.activityHistory = normalizeActivityHistory(options.activityHistory);
      next.activitySchemaVersion = ACTIVITY_SCHEMA_VERSION;
      metadataChanged = true;
    }
    if (!appended && !metadataChanged) return { appended: 0, entries: next.entries };
    next.updatedAt = new Date().toISOString();
    next.nextRecordSequence = recordSequence + 1;
    const commitPayload = Buffer.from(JSON.stringify(next), 'utf8');
    const commit = await writeRecord(handle, offset, context.header, context.key, COMMIT_RECORD, recordSequence, commitPayload);
    await handle.sync();
    context.data = next;
    context.committedEnd = commit.end;
    context.lastRecordSequence = recordSequence;
    context.lastCommitRecordLength = commit.recordLength;
    return { appended, entries: next.entries };
  } catch (error) {
    await handle.truncate(originalEnd).catch(() => {});
    await handle.sync().catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

async function initializeChunkVault(filePath, format, kdf, key) {
  assertAbsoluteFile(filePath);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const header = buildHeader(format, kdf);
  const headerBytes = encodeHeader(header);
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(headerBytes);
    const data = emptyIndex();
    data.nextRecordSequence = 2;
    const commit = await writeRecord(handle, headerBytes.length, header, key, COMMIT_RECORD, 1, Buffer.from(JSON.stringify(data), 'utf8'));
    await handle.sync();
    return {
      filePath,
      format,
      version: FORMAT_VERSION,
      header,
      headerBytes: headerBytes.length,
      key,
      kdf,
      data,
      committedEnd: commit.end,
      lastRecordSequence: 1,
      lastCommitRecordLength: commit.recordLength,
      recoveredBytes: 0
    };
  } catch (error) {
    key.fill(0);
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

async function createChunkVault(filePath, password, format) {
  const kdf = newKdf();
  const key = await deriveKey(password, kdf);
  return initializeChunkVault(filePath, format, kdf, key);
}

async function createChunkVaultWithKey(filePath, format, kdf, sourceKey) {
  const normalizedKdf = validateKdf(kdf);
  if (!Buffer.isBuffer(sourceKey) || sourceKey.length !== 32) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  return initializeChunkVault(filePath, format, normalizedKdf, Buffer.from(sourceKey));
}

async function openChunkVault(filePath, password, expectedFormat) {
  const { header, headerBytes } = await readHeader(filePath);
  if (header.format !== expectedFormat) throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  const key = await deriveKey(password, header.kdf);
  try {
    const scanned = await scanVault(filePath, header, headerBytes, key);
    return {
      filePath,
      format: header.format,
      version: FORMAT_VERSION,
      header,
      headerBytes,
      key,
      kdf: header.kdf,
      ...scanned
    };
  } catch (error) {
    key.fill(0);
    if (['LOCAL_VAULT_TOO_LARGE', 'LOCAL_NOT_A_FILE', 'LOCAL_VAULT_FORMAT_INVALID'].includes(error?.message)) throw error;
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
}

async function readEntry(context, id) {
  if (!context?.data || !Buffer.isBuffer(context.key) || typeof id !== 'string') throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const metadata = context.data.entries.find((entry) => entry.id === id);
  if (!metadata) throw new Error('LOCAL_VAULT_ENTRY_NOT_FOUND');
  const handle = await fs.open(context.filePath, 'r');
  try {
    const parts = [];
    for (const chunk of metadata.chunks) {
      const stat = await handle.stat();
      const meta = await recordMetaAt(handle, chunk.offset, stat.size);
      if (!meta || meta.partial || meta.type !== CHUNK_RECORD || meta.sequence !== chunk.recordSequence ||
          meta.recordLength !== chunk.recordLength) throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
      parts.push(await decryptRecord(handle, context.header, context.key, meta));
    }
    const payload = Buffer.concat(parts);
    if (payload.length !== metadata.payloadBytes || createHash('sha256').update(payload).digest('hex') !== metadata.payloadSha256) {
      throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
    }
    const entry = JSON.parse(payload.toString('utf8'));
    if (entry.id !== metadata.id || entry.sequence !== metadata.sequence) throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
    return entry;
  } catch (error) {
    if (error?.message === 'LOCAL_VAULT_ENTRY_NOT_FOUND') throw error;
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  } finally {
    await handle.close();
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('data', (chunk) => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

function closeChunkVault(context) {
  if (Buffer.isBuffer(context?.key)) context.key.fill(0);
  if (context) {
    context.key = null;
    context.data = null;
  }
}

module.exports = {
  MAGIC,
  FORMAT_VERSION,
  ACTIVITY_SCHEMA_VERSION,
  INDEX_FORMAT,
  CHUNK_BYTES,
  MAX_VAULT_BYTES,
  PARITY_VAULT_BYTES,
  KDF_TEMPLATE,
  CIPHER_NAME,
  validatePassword,
  validateKdf,
  newKdf,
  deriveKey,
  assertAbsoluteFile,
  assertVaultGrowth,
  isV3Vault,
  readHeader,
  createChunkVault,
  createChunkVaultWithKey,
  openChunkVault,
  appendEntries,
  commitIndex,
  normalizeActivityHistory,
  readEntry,
  sha256File,
  closeChunkVault
};

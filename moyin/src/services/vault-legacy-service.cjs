'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { randomBytes, randomUUID, scrypt, createCipheriv, createDecipheriv, createHash } = require('node:crypto');

const scryptAsync = promisify(scrypt);
const VAULT_FORMAT = 'VEILFORGE_ENCRYPTED_VAULT';
const VAULT_BACKUP_FORMAT = 'VEILFORGE_ENCRYPTED_VAULT_BACKUP';
const PAYLOAD_FORMAT = 'VEILFORGE_VAULT_PAYLOAD';
const VAULT_VERSION = 1;
const VAULT_SCHEMA_VERSION = 2;
const MAX_VAULT_BYTES = 64 * 1024 * 1024;
const MAX_VAULT_PLAINTEXT_BYTES = 45 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 500;
const KDF_TEMPLATE = Object.freeze({ name: 'scrypt', n: 32768, r: 8, p: 1, keyLength: 32 });
const CIPHER_NAME = 'aes-256-gcm';

function assertAbsoluteFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_VAULT_PATH_INVALID');
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256) {
    throw new Error('LOCAL_VAULT_PASSWORD_POLICY');
  }
  if (Buffer.byteLength(password, 'utf8') > 1024) throw new Error('LOCAL_VAULT_PASSWORD_POLICY');
  return password;
}

function newKdf() {
  return { ...KDF_TEMPLATE, salt: randomBytes(16).toString('base64') };
}

function validateKdf(value) {
  if (!value || value.name !== KDF_TEMPLATE.name || value.n !== KDF_TEMPLATE.n || value.r !== KDF_TEMPLATE.r ||
      value.p !== KDF_TEMPLATE.p || value.keyLength !== KDF_TEMPLATE.keyLength || typeof value.salt !== 'string') {
    throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  }
  const salt = Buffer.from(value.salt, 'base64');
  if (salt.length !== 16) throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  return { ...KDF_TEMPLATE, salt: value.salt };
}

function aadFor(kdf, format = VAULT_FORMAT) {
  return Buffer.from(JSON.stringify({ format, version: VAULT_VERSION, kdf }), 'utf8');
}

async function deriveKey(password, kdf) {
  validatePassword(password);
  const salt = Buffer.from(kdf.salt, 'base64');
  return Buffer.from(await scryptAsync(password, salt, kdf.keyLength, {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024
  }));
}

function fileNumber(sequence) {
  return `MI-${String(sequence).padStart(6, '0')}`;
}

function nextAvailableSequence(used, start = 1) {
  let value = Math.max(1, Number.isInteger(start) ? start : 1);
  while (used.has(value)) value += 1;
  return value;
}

function validatePayload(data) {
  if (!data || data.format !== PAYLOAD_FORMAT || data.version !== VAULT_VERSION || !Array.isArray(data.entries) ||
      typeof data.createdAt !== 'string' || typeof data.updatedAt !== 'string' || data.entries.length > MAX_ENTRIES) {
    throw new Error('LOCAL_VAULT_PAYLOAD_INVALID');
  }
  const normalized = structuredClone(data);
  const used = new Set();
  let cursor = 1;
  normalized.entries = normalized.entries.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' ||
        typeof entry.createdAt !== 'string' || typeof entry.text !== 'string' || !entry.audit ||
        !Number.isInteger(entry.audit.findingCount) || !Array.isArray(entry.audit.findingTypes)) {
      throw new Error('LOCAL_VAULT_PAYLOAD_INVALID');
    }
    let sequence = Number(entry.sequence);
    if (!Number.isInteger(sequence) || sequence < 1 || used.has(sequence)) {
      sequence = nextAvailableSequence(used, cursor);
    }
    used.add(sequence);
    cursor = Math.max(cursor, sequence + 1);
    return { ...entry, sequence, fileNumber: fileNumber(sequence) };
  });
  const requestedNext = Number(normalized.nextSequence);
  normalized.nextSequence = Number.isInteger(requestedNext) && requestedNext >= cursor && !used.has(requestedNext)
    ? requestedNext
    : nextAvailableSequence(used, cursor);
  normalized.schemaVersion = VAULT_SCHEMA_VERSION;
  return normalized;
}

function encryptPayload(data, key, kdf, options = {}) {
  const normalized = validatePayload(data);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const format = options.format === VAULT_BACKUP_FORMAT ? VAULT_BACKUP_FORMAT : VAULT_FORMAT;
  const plaintext = Buffer.from(JSON.stringify(normalized), 'utf8');
  if (plaintext.length > MAX_VAULT_PLAINTEXT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER_NAME, key, iv);
  cipher.setAAD(aadFor(kdf, format), { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format,
    version: VAULT_VERSION,
    kdf,
    cipher: {
      name: CIPHER_NAME,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    },
    payload: ciphertext.toString('base64')
  };
}

function parseEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  }
  if (!envelope || ![VAULT_FORMAT, VAULT_BACKUP_FORMAT].includes(envelope.format) || envelope.version !== VAULT_VERSION ||
      envelope.cipher?.name !== CIPHER_NAME || typeof envelope.cipher.iv !== 'string' ||
      typeof envelope.cipher.tag !== 'string' || typeof envelope.payload !== 'string') {
    throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  }
  const kdf = validateKdf(envelope.kdf);
  const iv = Buffer.from(envelope.cipher.iv, 'base64');
  const tag = Buffer.from(envelope.cipher.tag, 'base64');
  const ciphertext = Buffer.from(envelope.payload, 'base64');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  return { envelope, kdf, iv, tag, ciphertext };
}

function decryptPayload(parsed, key) {
  try {
    const decipher = createDecipheriv(CIPHER_NAME, key, parsed.iv);
    decipher.setAAD(aadFor(parsed.kdf, parsed.envelope.format), { plaintextLength: parsed.ciphertext.length });
    decipher.setAuthTag(parsed.tag);
    const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    return validatePayload(JSON.parse(plaintext.toString('utf8')));
  } catch (error) {
    if (error?.message === 'LOCAL_VAULT_PAYLOAD_INVALID') throw error;
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
}

async function writeNewFile(filePath, envelope) {
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(filePath, envelope) {
  const suffix = randomUUID();
  const temporary = `${filePath}.${suffix}.new`;
  const previous = `${filePath}.${suffix}.previous`;
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  let movedPrevious = false;
  try {
    await fs.rename(filePath, previous);
    movedPrevious = true;
    await fs.rename(temporary, filePath);
    await fs.rm(previous, { force: true });
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (movedPrevious) {
      await fs.rename(previous, filePath).catch(() => {});
    }
    throw error;
  }
}

function createPayload(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    format: PAYLOAD_FORMAT,
    version: VAULT_VERSION,
    schemaVersion: VAULT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextSequence: 1,
    entries: []
  };
}

async function createVault(filePath, password) {
  assertAbsoluteFile(filePath);
  const kdf = newKdf();
  const key = await deriveKey(password, kdf);
  const data = createPayload();
  try {
    await writeNewFile(filePath, encryptPayload(data, key, kdf));
    return { filePath, key, kdf, data };
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

async function openVault(filePath, password) {
  assertAbsoluteFile(filePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const parsed = parseEnvelope(await fs.readFile(filePath));
  if (parsed.envelope.format !== VAULT_FORMAT) throw new Error('LOCAL_VAULT_FORMAT_INVALID');
  const key = await deriveKey(password, parsed.kdf);
  try {
    const data = decryptPayload(parsed, key);
    return { filePath, key, kdf: parsed.kdf, data };
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

function sanitizeEntryFields(entry) {
  const text = String(entry?.text || '');
  const name = String(entry?.name || '未命名脱敏结果').trim().slice(0, 240) || '未命名脱敏结果';
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_ENTRY_BYTES) throw new Error('LOCAL_VAULT_ENTRY_INVALID');
  const types = Array.isArray(entry?.findingTypes) ? entry.findingTypes.map(String).slice(0, 10000) : [];
  const kind = entry?.kind === 'reversible-map' ? 'reversible-map' : 'redacted-text';
  const mapping = kind === 'reversible-map' ? (Array.isArray(entry?.mapping) ? entry.mapping : []).map((item) => {
    const token = String(item?.token || '');
    const value = String(item?.value ?? '');
    const type = String(item?.type || 'custom').slice(0, 80);
    const label = String(item?.label || type).slice(0, 80);
    const occurrences = Number(item?.occurrences);
    if (!/^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]$/u.test(token) || !value || Buffer.byteLength(value, 'utf8') > 65536 ||
        !Number.isInteger(occurrences) || occurrences < 1 || occurrences > 100000) {
      throw new Error('LOCAL_VAULT_MAPPING_INVALID');
    }
    return { token, value, type, label, occurrences };
  }) : [];
  if (kind === 'reversible-map' && (!mapping.length || mapping.length > 10000 || new Set(mapping.map((item) => item.token)).size !== mapping.length)) {
    throw new Error('LOCAL_VAULT_MAPPING_INVALID');
  }
  const audit = {
    findingCount: Number.isInteger(entry?.findingCount) ? Math.max(0, entry.findingCount) : types.length,
    findingTypes: types,
    tokenCount: mapping.length
  };
  const saved = {
    name,
    kind,
    text,
    mapping,
    audit
  };
  if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > MAX_ENTRY_BYTES) throw new Error('LOCAL_VAULT_ENTRY_INVALID');
  return saved;
}

function sanitizeEntry(entry, sequence, now = new Date()) {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('LOCAL_VAULT_SEQUENCE_INVALID');
  return {
    id: randomUUID(),
    sequence,
    fileNumber: fileNumber(sequence),
    createdAt: now.toISOString(),
    ...sanitizeEntryFields(entry)
  };
}

function entryFingerprint(entry) {
  const stable = {
    kind: entry.kind,
    text: entry.text,
    mapping: entry.mapping,
    audit: entry.audit
  };
  return createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
}

async function addVaultEntry(context, entry) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  if (context.data.entries.length >= MAX_ENTRIES) throw new Error('LOCAL_VAULT_ENTRY_LIMIT');
  const next = structuredClone(context.data);
  const sequence = nextAvailableSequence(new Set(next.entries.map((item) => item.sequence)), next.nextSequence);
  const saved = sanitizeEntry(entry, sequence);
  next.entries.push(saved);
  next.nextSequence = sequence + 1;
  next.updatedAt = new Date().toISOString();
  await replaceFile(context.filePath, encryptPayload(next, context.key, context.kdf));
  context.data = next;
  return { ...saved, text: undefined };
}

function listVaultEntries(context) {
  if (!context?.data) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  return context.data.entries.map(({ id, sequence, fileNumber: number, name, kind, createdAt, audit, text }) => ({
    id,
    sequence,
    fileNumber: number,
    name,
    kind,
    createdAt,
    audit,
    characters: text.length
  }));
}

async function exportVaultBackup(context, backupPath, password) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  assertAbsoluteFile(backupPath);
  const kdf = newKdf();
  const key = await deriveKey(password, kdf);
  const snapshot = structuredClone(context.data);
  snapshot.backup = {
    format: VAULT_BACKUP_FORMAT,
    version: VAULT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceName: path.basename(context.filePath),
    entryCount: snapshot.entries.length
  };
  try {
    const envelope = encryptPayload(snapshot, key, kdf, { format: VAULT_BACKUP_FORMAT });
    await writeNewFile(backupPath, envelope);
    const bytes = await fs.readFile(backupPath);
    return {
      filePath: backupPath,
      name: path.basename(backupPath),
      entries: snapshot.entries.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  } finally {
    key.fill(0);
  }
}

function importedName(name, usedNames) {
  if (!usedNames.has(name)) return name;
  let suffix = 2;
  while (usedNames.has(`${name} (导入 ${suffix})`)) suffix += 1;
  return `${name} (导入 ${suffix})`;
}

async function importVaultBackup(context, backupPath, password, conflictPolicy = 'reject') {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  assertAbsoluteFile(backupPath);
  if (!['reject', 'skip', 'rename'].includes(conflictPolicy)) throw new Error('LOCAL_VAULT_IMPORT_POLICY_INVALID');
  const stat = await fs.stat(backupPath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const parsed = parseEnvelope(await fs.readFile(backupPath));
  if (parsed.envelope.format !== VAULT_BACKUP_FORMAT) throw new Error('LOCAL_VAULT_BACKUP_FORMAT_INVALID');
  const backupKey = await deriveKey(password, parsed.kdf);
  let source;
  try {
    source = decryptPayload(parsed, backupKey);
  } finally {
    backupKey.fill(0);
  }
  const existingFingerprints = new Set(context.data.entries.map(entryFingerprint));
  const usedNames = new Set(context.data.entries.map((entry) => entry.name));
  const conflicts = [];
  const accepted = [];
  for (const sourceEntry of source.entries) {
    const fingerprint = entryFingerprint(sourceEntry);
    if (existingFingerprints.has(fingerprint)) {
      conflicts.push({ kind: 'duplicate', sourceId: sourceEntry.id, name: sourceEntry.name, fingerprint });
      continue;
    }
    let name = sourceEntry.name;
    if (usedNames.has(name)) {
      conflicts.push({ kind: 'name', sourceId: sourceEntry.id, name, fingerprint });
      if (conflictPolicy === 'rename') name = importedName(name, usedNames);
      else continue;
    }
    accepted.push({ sourceEntry, name, fingerprint });
    usedNames.add(name);
    existingFingerprints.add(fingerprint);
  }
  if (conflictPolicy === 'reject' && conflicts.length) {
    const error = new Error('LOCAL_VAULT_IMPORT_CONFLICT');
    error.conflicts = conflicts;
    throw error;
  }
  if (context.data.entries.length + accepted.length > MAX_ENTRIES) throw new Error('LOCAL_VAULT_ENTRY_LIMIT');
  const next = structuredClone(context.data);
  const usedSequences = new Set(next.entries.map((entry) => entry.sequence));
  let renamed = 0;
  for (const item of accepted) {
    const sequence = nextAvailableSequence(usedSequences, next.nextSequence);
    usedSequences.add(sequence);
    if (item.name !== item.sourceEntry.name) renamed += 1;
    const fields = sanitizeEntryFields({
      ...item.sourceEntry,
      name: item.name,
      findingCount: item.sourceEntry.audit?.findingCount,
      findingTypes: item.sourceEntry.audit?.findingTypes
    });
    next.entries.push({
      id: randomUUID(),
      sequence,
      fileNumber: fileNumber(sequence),
      createdAt: new Date().toISOString(),
      importedFrom: {
        backup: path.basename(backupPath),
        sourceId: item.sourceEntry.id,
        sourceSequence: item.sourceEntry.sequence,
        fingerprint: item.fingerprint
      },
      ...fields
    });
    next.nextSequence = sequence + 1;
  }
  next.updatedAt = new Date().toISOString();
  if (accepted.length) {
    await replaceFile(context.filePath, encryptPayload(next, context.key, context.kdf));
    context.data = next;
  }
  return {
    imported: accepted.length,
    skipped: source.entries.length - accepted.length,
    renamed,
    conflicts,
    entries: listVaultEntries(context)
  };
}

function readVaultEntry(context, id) {
  if (!context?.data || typeof id !== 'string') throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const entry = context.data.entries.find((item) => item.id === id);
  if (!entry) throw new Error('LOCAL_VAULT_ENTRY_NOT_FOUND');
  return structuredClone(entry);
}

async function rotateVaultPassword(context, newPassword) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const kdf = newKdf();
  const key = await deriveKey(newPassword, kdf);
  const next = structuredClone(context.data);
  next.updatedAt = new Date().toISOString();
  try {
    await replaceFile(context.filePath, encryptPayload(next, key, kdf));
  } catch (error) {
    key.fill(0);
    throw error;
  }
  context.key.fill(0);
  context.key = key;
  context.kdf = kdf;
  context.data = next;
}

function closeVault(context) {
  if (Buffer.isBuffer(context?.key)) context.key.fill(0);
  if (context) {
    context.key = null;
    context.data = null;
  }
}

module.exports = {
  VAULT_FORMAT,
  VAULT_BACKUP_FORMAT,
  VAULT_VERSION,
  VAULT_SCHEMA_VERSION,
  MAX_VAULT_BYTES,
  MAX_VAULT_PLAINTEXT_BYTES,
  MAX_ENTRY_BYTES,
  MAX_ENTRIES,
  createVault,
  openVault,
  addVaultEntry,
  listVaultEntries,
  readVaultEntry,
  exportVaultBackup,
  importVaultBackup,
  rotateVaultPassword,
  closeVault,
  parseEnvelope,
  encryptPayload,
  decryptPayload,
  validatePayload,
  validatePassword,
  entryFingerprint,
  fileNumber,
  deriveKey,
  newKdf
};


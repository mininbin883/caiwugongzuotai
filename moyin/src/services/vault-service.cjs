'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const legacy = require('./vault-legacy-service.cjs');
const storage = require('./vault-v3-storage.cjs');
const { filterVaultEntries, recordVaultActivity, sanitizeActivityHistory, mergeVaultActivity } = require('./vault-explorer-service.cjs');

const VAULT_FORMAT = legacy.VAULT_FORMAT;
const VAULT_BACKUP_FORMAT = legacy.VAULT_BACKUP_FORMAT;
const PAYLOAD_FORMAT = 'VEILFORGE_VAULT_PAYLOAD';
const VAULT_VERSION = storage.FORMAT_VERSION;
const VAULT_SCHEMA_VERSION = 4;
const LEGACY_VAULT_VERSION = legacy.VAULT_VERSION;
const MAX_VAULT_BYTES = storage.MAX_VAULT_BYTES;
const PARITY_VAULT_BYTES = storage.PARITY_VAULT_BYTES;
const MAX_VAULT_PLAINTEXT_BYTES = MAX_VAULT_BYTES;
const MAX_ENTRY_BYTES = 144 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_ENTRY = 8;
const MAX_ENTRIES = 5000;

function listVaultActivity(context) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  return sanitizeActivityHistory(context.data.activityHistory);
}

async function appendVaultActivity(context, event, now = new Date()) {
  const history = recordVaultActivity(listVaultActivity(context), event, now);
  const next = structuredClone(context.data);
  next.activitySchemaVersion = 1;
  next.activityHistory = history;
  await storage.commitIndex(context, next);
  return history;
}

function fileNumber(sequence) {
  return `MI-${String(sequence).padStart(6, '0')}`;
}

function nextAvailableSequence(used, start = 1) {
  let value = Math.max(1, Number.isInteger(start) ? start : 1);
  while (used.has(value)) value += 1;
  return value;
}

function sanitizeAttachmentDescriptor(value) {
  const sha256 = String(value?.sha256 || '').toLowerCase();
  const bytes = Number(value?.bytes);
  const blobId = String(value?.blobId || `blob-${sha256}`);
  const role = ['original', 'redacted-copy', 'sidecar'].includes(value?.role) ? value.role : 'sidecar';
  if (!/^[a-f0-9]{64}$/u.test(sha256) || blobId !== `blob-${sha256}` || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error('LOCAL_VAULT_ATTACHMENT_INVALID');
  }
  const name = path.basename(String(value?.name || 'attachment.bin')).replace(/[\u0000-\u001f]/gu, '').slice(0, 240) || 'attachment.bin';
  const extension = path.extname(name).toLowerCase().slice(0, 16);
  return { blobId, role, name, extension, bytes, sha256 };
}

function sanitizeEntryFields(entry) {
  const text = String(entry?.text || '');
  const name = String(entry?.name || '未命名脱敏结果').trim().slice(0, 240) || '未命名脱敏结果';
  const requestedKind = String(entry?.kind || 'redacted-text');
  if (requestedKind === 'file-blob') {
    const attachment = sanitizeAttachmentDescriptor(entry?.attachment);
    const dataBase64 = String(entry?.dataBase64 || '');
    const decoded = Buffer.from(dataBase64, 'base64');
    if (decoded.length !== attachment.bytes || createHash('sha256').update(decoded).digest('hex') !== attachment.sha256) {
      throw new Error('LOCAL_VAULT_ATTACHMENT_INVALID');
    }
    const saved = {
      name: `blob-${attachment.sha256}`,
      kind: 'file-blob',
      text: '',
      mapping: [],
      audit: { findingCount: 0, findingTypes: [], tokenCount: 0 },
      attachment,
      attachments: [],
      dataBase64
    };
    if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > MAX_ENTRY_BYTES) throw new Error('LOCAL_VAULT_ATTACHMENT_TOO_LARGE');
    return saved;
  }
  if (!text) throw new Error('LOCAL_VAULT_ENTRY_INVALID');
  const types = Array.isArray(entry?.findingTypes)
    ? entry.findingTypes.map(String).slice(0, 10000)
    : Array.isArray(entry?.audit?.findingTypes) ? entry.audit.findingTypes.map(String).slice(0, 10000) : [];
  const kind = requestedKind === 'reversible-map' ? 'reversible-map' : 'redacted-text';
  const mapping = kind === 'reversible-map' ? (Array.isArray(entry?.mapping) ? entry.mapping : []).map((item) => {
    const token = String(item?.token || '');
    const value = String(item?.value ?? '');
    const type = String(item?.type || 'custom').slice(0, 80);
    const label = String(item?.label || type).slice(0, 80);
    const occurrences = Number(item?.occurrences);
    // 税务筛查模式的假名：2–120 个字符、不含控制字符和换行。
    const pseudonym = item?.form === 'pseudonym';
    const tokenValid = pseudonym
      ? token.length >= 2 && token.length <= 120 && !/[\u0000-\u001f]/u.test(token)
      : /^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]$/u.test(token);
    if (!tokenValid || !value || Buffer.byteLength(value, 'utf8') > 65536 ||
        !Number.isInteger(occurrences) || occurrences < 1 || occurrences > 100000) {
      throw new Error('LOCAL_VAULT_MAPPING_INVALID');
    }
    return pseudonym ? { token, value, type, label, occurrences, form: 'pseudonym' } : { token, value, type, label, occurrences };
  }) : [];
  if (kind === 'reversible-map' && (!mapping.length || mapping.length > 100000 || new Set(mapping.map((item) => item.token)).size !== mapping.length)) {
    throw new Error('LOCAL_VAULT_MAPPING_INVALID');
  }
  const audit = {
    findingCount: Number.isInteger(entry?.findingCount)
      ? Math.max(0, entry.findingCount)
      : Number.isInteger(entry?.audit?.findingCount) ? Math.max(0, entry.audit.findingCount) : types.length,
    findingTypes: types,
    tokenCount: mapping.length
  };
  const attachments = Array.isArray(entry?.attachments) ? entry.attachments.map(sanitizeAttachmentDescriptor) : [];
  if (attachments.length > MAX_ATTACHMENTS_PER_ENTRY || new Set(attachments.map((item) => `${item.role}:${item.blobId}`)).size !== attachments.length) {
    throw new Error('LOCAL_VAULT_ATTACHMENT_INVALID');
  }
  const saved = { name, kind, text, mapping, audit, attachments };
  if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > MAX_ENTRY_BYTES) throw new Error('LOCAL_VAULT_ENTRY_INVALID');
  return saved;
}

function entryFingerprint(entry) {
  if (!entry?.attachments?.length && entry?.kind !== 'file-blob') return legacy.entryFingerprint(entry);
  const stable = {
    kind: entry.kind,
    text: entry.text,
    mapping: entry.mapping,
    audit: entry.audit,
    attachment: entry.attachment ? { sha256: entry.attachment.sha256, bytes: entry.attachment.bytes } : null,
    attachments: (entry.attachments || []).map(({ role, sha256, bytes }) => ({ role, sha256, bytes }))
  };
  return createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
}

function prepareEntry(entry, sequence, options = {}) {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('LOCAL_VAULT_SEQUENCE_INVALID');
  const fields = sanitizeEntryFields(entry);
  const prepared = {
    id: options.preserveIdentity && typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
    sequence,
    fileNumber: fileNumber(sequence),
    createdAt: options.preserveIdentity && typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    importedFrom: entry.importedFrom,
    ...fields
  };
  prepared.fingerprint = entryFingerprint(prepared);
  return prepared;
}

async function atomicReplace(targetPath, replacementPath) {
  const suffix = randomUUID();
  const previous = `${targetPath}.${suffix}.previous`;
  let moved = false;
  try {
    await fs.rename(targetPath, previous);
    moved = true;
    await fs.rename(replacementPath, targetPath);
    await fs.rm(previous, { force: true });
  } catch (error) {
    await fs.rm(replacementPath, { force: true }).catch(() => {});
    if (moved) await fs.rename(previous, targetPath).catch(() => {});
    throw error;
  }
}

async function createLegacyVault(filePath, password, entries = []) {
  const context = await legacy.createVault(filePath, password);
  try {
    for (const entry of entries) await legacy.addVaultEntry(context, entry);
  } finally {
    legacy.closeVault(context);
  }
}

async function migrateLegacyVault(filePath, password) {
  const legacyContext = await legacy.openVault(filePath, password);
  const legacyEntries = structuredClone(legacyContext.data.entries);
  legacy.closeVault(legacyContext);
  const temporary = `${filePath}.${randomUUID()}.v3-new`;
  const context = await storage.createChunkVault(temporary, password, VAULT_FORMAT);
  try {
    async function* entries() {
      const used = new Set();
      let cursor = 1;
      for (const item of legacyEntries) {
        const sequence = nextAvailableSequence(used, item.sequence || cursor);
        used.add(sequence);
        cursor = sequence + 1;
        yield prepareEntry(item, sequence, { preserveIdentity: true });
      }
    }
    if (legacyEntries.length) await storage.appendEntries(context, entries(), { schemaVersion: VAULT_SCHEMA_VERSION });
    await atomicReplace(filePath, temporary);
    context.filePath = filePath;
    context.migration = { fromVersion: 2, toVersion: VAULT_SCHEMA_VERSION, entries: legacyEntries.length };
    return context;
  } catch (error) {
    storage.closeChunkVault(context);
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function createVault(filePath, password) {
  return storage.createChunkVault(filePath, password, VAULT_FORMAT);
}

async function openVault(filePath, password) {
  storage.assertAbsoluteFile(filePath);
  return await storage.isV3Vault(filePath)
    ? storage.openChunkVault(filePath, password, VAULT_FORMAT)
    : migrateLegacyVault(filePath, password);
}

async function addVaultEntry(context, entry) {
  if (!context?.data || !Buffer.isBuffer(context.key) || context.version !== VAULT_VERSION) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  if (context.data.entries.length >= MAX_ENTRIES) throw new Error('LOCAL_VAULT_ENTRY_LIMIT');
  const sequence = nextAvailableSequence(new Set(context.data.entries.map((item) => item.sequence)), context.data.nextSequence);
  const saved = prepareEntry(entry, sequence);
  await storage.appendEntries(context, [saved], { schemaVersion: VAULT_SCHEMA_VERSION });
  return {
    id: saved.id,
    sequence,
    fileNumber: saved.fileNumber,
    name: saved.name,
    kind: saved.kind,
    createdAt: saved.createdAt,
    audit: saved.audit,
    characters: saved.text.length,
    attachments: saved.attachments || []
  };
}

async function addVaultEntryWithAttachments(context, entry, attachmentFiles = []) {
  if (!context?.data || !Buffer.isBuffer(context.key) || context.version !== VAULT_VERSION) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  if (!Array.isArray(attachmentFiles) || !attachmentFiles.length || attachmentFiles.length > MAX_ATTACHMENTS_PER_ENTRY) {
    throw new Error('LOCAL_VAULT_ATTACHMENT_INVALID');
  }
  const usedSequences = new Set(context.data.entries.map((item) => item.sequence));
  let cursor = nextAvailableSequence(usedSequences, context.data.nextSequence);
  const pendingBlobs = new Map();
  const descriptors = [];
  let deduplicated = 0;
  for (const file of attachmentFiles) {
    const filePath = String(file?.path || '');
    storage.assertAbsoluteFile(filePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('LOCAL_VAULT_ATTACHMENT_TOO_LARGE');
    const bytes = await fs.readFile(filePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const descriptor = sanitizeAttachmentDescriptor({
      blobId: `blob-${sha256}`,
      role: file?.role,
      name: file?.name || path.basename(filePath),
      bytes: bytes.length,
      sha256
    });
    const existing = context.data.entries.find((item) => item.kind === 'file-blob' && item.id === descriptor.blobId);
    if (existing || pendingBlobs.has(descriptor.blobId)) {
      deduplicated += 1;
    } else {
      const blob = prepareEntry({
        id: descriptor.blobId,
        name: descriptor.blobId,
        kind: 'file-blob',
        attachment: descriptor,
        dataBase64: bytes.toString('base64')
      }, cursor, { preserveIdentity: true });
      pendingBlobs.set(descriptor.blobId, blob);
      usedSequences.add(cursor);
      cursor = nextAvailableSequence(usedSequences, cursor + 1);
    }
    descriptors.push(descriptor);
  }
  if (context.data.entries.length + pendingBlobs.size + 1 > MAX_ENTRIES) throw new Error('LOCAL_VAULT_ENTRY_LIMIT');
  const saved = prepareEntry({ ...entry, attachments: descriptors }, cursor);
  await storage.appendEntries(context, [...pendingBlobs.values(), saved], { schemaVersion: VAULT_SCHEMA_VERSION });
  return {
    ...publicEntry(context.data.entries.find((item) => item.id === saved.id)),
    attachmentResult: { files: descriptors.length, newBlobs: pendingBlobs.size, deduplicated }
  };
}

function publicEntry({ id, sequence, fileNumber: number, name, kind, createdAt, audit, characters, attachments }) {
  return { id, sequence, fileNumber: number, name, kind, createdAt, audit, characters, attachments: attachments || [] };
}

function listVaultEntries(context) {
  if (!context?.data) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  return context.data.entries.filter((entry) => entry.kind !== 'file-blob').map(publicEntry);
}

function listVaultEntriesPage(context, options = {}) {
  if (!context?.data) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const requested = Number(options.pageSize);
  const pageSize = Number.isInteger(requested) ? Math.min(100, Math.max(1, requested)) : 20;
  const cursorValue = options.cursor === null || options.cursor === undefined || options.cursor === ''
    ? Number.POSITIVE_INFINITY
    : Number(options.cursor);
  if (!(cursorValue === Number.POSITIVE_INFINITY || (Number.isInteger(cursorValue) && cursorValue > 0))) {
    throw new Error('LOCAL_VAULT_CURSOR_INVALID');
  }
  const visibleEntries = context.data.entries.filter((entry) => entry.kind !== 'file-blob');
  const filtered = filterVaultEntries(visibleEntries, options.filters);
  const candidates = [...filtered.entries]
    .filter((entry) => entry.sequence < cursorValue)
    .sort((left, right) => right.sequence - left.sequence);
  const selected = candidates.slice(0, pageSize);
  return {
    entries: selected.map(publicEntry),
    total: visibleEntries.length,
    filteredTotal: filtered.entries.length,
    filters: filtered.filters,
    pageSize,
    cursor: cursorValue === Number.POSITIVE_INFINITY ? null : cursorValue,
    nextCursor: candidates.length > pageSize && selected.length ? selected.at(-1).sequence : null,
    hasMore: candidates.length > pageSize
  };
}

function vaultStatistics(context) {
  if (!context?.data || !Number.isSafeInteger(context.committedEnd)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const activeChunkBytes = context.data.entries.reduce((total, entry) =>
    total + entry.chunks.reduce((chunkTotal, chunk) => chunkTotal + chunk.recordLength, 0), 0);
  const activeStorageBytes = context.headerBytes + activeChunkBytes + (context.lastCommitRecordLength || 0);
  const visibleEntries = context.data.entries.filter((entry) => entry.kind !== 'file-blob');
  const fileBlobs = context.data.entries.filter((entry) => entry.kind === 'file-blob');
  const attachmentReferences = visibleEntries.reduce((total, entry) => total + (entry.attachments?.length || 0), 0);
  return {
    entries: visibleEntries.length,
    fileBlobs: fileBlobs.length,
    attachmentReferences,
    attachmentBytes: fileBlobs.reduce((total, entry) => total + Number(entry.attachment?.bytes || 0), 0),
    deduplicatedReferences: Math.max(0, attachmentReferences - fileBlobs.length),
    fileBytes: context.committedEnd,
    activePayloadBytes: context.data.entries.reduce((total, entry) => total + entry.payloadBytes, 0),
    activeStorageBytes,
    reclaimableBytes: Math.max(0, context.committedEnd - activeStorageBytes),
    deletedEntries: Number(context.data.deletedEntries || 0),
    nextSequence: context.data.nextSequence
  };
}

async function readVaultEntry(context, id) {
  return storage.readEntry(context, id);
}

async function exportVaultAttachment(context, entryId, blobId, outputPath) {
  storage.assertAbsoluteFile(outputPath);
  const entry = await readVaultEntry(context, String(entryId || ''));
  const reference = (entry.attachments || []).find((item) => item.blobId === blobId);
  if (!reference) throw new Error('LOCAL_VAULT_ATTACHMENT_NOT_FOUND');
  const blob = await readVaultEntry(context, blobId);
  if (blob.kind !== 'file-blob' || blob.attachment?.sha256 !== reference.sha256) throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  const bytes = Buffer.from(String(blob.dataBase64 || ''), 'base64');
  if (bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
    throw new Error('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID');
  }
  await fs.writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  return { path: outputPath, name: path.basename(outputPath), bytes: bytes.length, sha256: reference.sha256, role: reference.role };
}

async function deleteVaultEntry(context, id) {
  if (!context?.data || !Buffer.isBuffer(context.key) || typeof id !== 'string' || !id) {
    throw new Error('LOCAL_VAULT_SESSION_INVALID');
  }
  const index = context.data.entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error('LOCAL_VAULT_ENTRY_NOT_FOUND');
  const next = structuredClone(context.data);
  const [removed] = next.entries.splice(index, 1);
  if (removed.kind === 'file-blob') throw new Error('LOCAL_VAULT_ENTRY_NOT_FOUND');
  const referencedBlobIds = new Set(next.entries.flatMap((entry) => (entry.attachments || []).map((item) => item.blobId)));
  const beforeBlobCount = next.entries.filter((entry) => entry.kind === 'file-blob').length;
  next.entries = next.entries.filter((entry) => entry.kind !== 'file-blob' || referencedBlobIds.has(entry.id));
  const orphanedBlobs = beforeBlobCount - next.entries.filter((entry) => entry.kind === 'file-blob').length;
  next.deletedEntries = Number(next.deletedEntries || 0) + 1;
  next.schemaVersion = VAULT_SCHEMA_VERSION;
  await storage.commitIndex(context, next);
  return { deletedId: removed.id, deletedFileNumber: removed.fileNumber, orphanedBlobs, stats: vaultStatistics(context) };
}

// 批量删除：一次提交索引。删除只是从目录中移除，旧密文块要“压缩回收空间”后才真正清除。
async function deleteVaultEntries(context, ids) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
  if (!wanted.size || wanted.size > 5000) throw new Error('LOCAL_VAULT_ENTRY_NOT_FOUND');
  const next = structuredClone(context.data);
  const removed = next.entries.filter((entry) => wanted.has(entry.id) && entry.kind !== 'file-blob');
  if (!removed.length) throw new Error('LOCAL_VAULT_ENTRY_NOT_FOUND');
  const removedIds = new Set(removed.map((entry) => entry.id));
  next.entries = next.entries.filter((entry) => !removedIds.has(entry.id));
  const referencedBlobIds = new Set(next.entries.flatMap((entry) => (entry.attachments || []).map((item) => item.blobId)));
  const beforeBlobCount = next.entries.filter((entry) => entry.kind === 'file-blob').length;
  next.entries = next.entries.filter((entry) => entry.kind !== 'file-blob' || referencedBlobIds.has(entry.id));
  const orphanedBlobs = beforeBlobCount - next.entries.filter((entry) => entry.kind === 'file-blob').length;
  next.deletedEntries = Number(next.deletedEntries || 0) + removed.length;
  next.schemaVersion = VAULT_SCHEMA_VERSION;
  await storage.commitIndex(context, next);
  return { deleted: removed.length, deletedFileNumbers: removed.map((entry) => entry.fileNumber), orphanedBlobs, stats: vaultStatistics(context) };
}

/** 返回符合筛选条件的全部记录编号（用于“全选筛选结果”）。 */
function listVaultEntryIds(context, filters) {
  if (!context?.data) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const visible = context.data.entries.filter((entry) => entry.kind !== 'file-blob');
  return filterVaultEntries(visible, filters).entries
    .sort((left, right) => right.sequence - left.sequence)
    .map((entry) => ({ id: entry.id, fileNumber: entry.fileNumber }));
}

async function compactVault(context) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const before = vaultStatistics(context);
  const temporary = `${context.filePath}.${randomUUID()}.compact-new`;
  const replacement = await storage.createChunkVaultWithKey(temporary, VAULT_FORMAT, context.kdf, context.key);
  try {
    async function* activeEntries() {
      for (const metadata of context.data.entries) yield await readVaultEntry(context, metadata.id);
    }
    await storage.appendEntries(replacement, activeEntries(), {
      createdAt: context.data.createdAt,
      nextSequenceFloor: context.data.nextSequence,
      schemaVersion: VAULT_SCHEMA_VERSION,
      activitySchemaVersion: 1,
      activityHistory: listVaultActivity(context)
    });
    const originalPath = context.filePath;
    await atomicReplace(originalPath, temporary);
    const oldKey = context.key;
    Object.assign(context, replacement, { filePath: originalPath });
    replacement.key = null;
    replacement.data = null;
    oldKey.fill(0);
    const after = vaultStatistics(context);
    return {
      before,
      after,
      reclaimedBytes: Math.max(0, before.fileBytes - after.fileBytes),
      compactedEntries: after.entries
    };
  } catch (error) {
    storage.closeChunkVault(replacement);
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function exportVaultBackup(context, backupPath, password, options = {}) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  storage.assertAbsoluteFile(backupPath);
  // 只导出所选记录：连同它们引用的附件一起导出，其他记录不进入这份备份。
  let selected = context.data.entries;
  if (Array.isArray(options.entryIds) && options.entryIds.length) {
    const wanted = new Set(options.entryIds.map(String));
    const records = context.data.entries.filter((entry) => wanted.has(entry.id) && entry.kind !== 'file-blob');
    if (!records.length) throw new Error('LOCAL_VAULT_ENTRY_NOT_FOUND');
    const blobIds = new Set(records.flatMap((entry) => (entry.attachments || []).map((item) => item.blobId)));
    selected = context.data.entries.filter((entry) => wanted.has(entry.id) || (entry.kind === 'file-blob' && blobIds.has(entry.id)));
  }
  const backup = await storage.createChunkVault(backupPath, password, VAULT_BACKUP_FORMAT);
  try {
    async function* sourceEntries() {
      for (const metadata of selected) yield await readVaultEntry(context, metadata.id);
    }
    await storage.appendEntries(backup, sourceEntries(), {
      schemaVersion: VAULT_SCHEMA_VERSION,
      activitySchemaVersion: 1,
      activityHistory: listVaultActivity(context)
    });
    const stat = await fs.stat(backupPath);
    const result = {
      filePath: backupPath,
      name: path.basename(backupPath),
      entries: selected.length,
      records: selected.filter((entry) => entry.kind !== 'file-blob').length,
      bytes: stat.size,
      sha256: await storage.sha256File(backupPath)
    };
    storage.closeChunkVault(backup);
    return result;
  } catch (error) {
    storage.closeChunkVault(backup);
    await fs.rm(backupPath, { force: true }).catch(() => {});
    throw error;
  }
}

function importedName(name, usedNames) {
  if (!usedNames.has(name)) return name;
  let suffix = 2;
  while (usedNames.has(`${name} (导入 ${suffix})`)) suffix += 1;
  return `${name} (导入 ${suffix})`;
}

async function openBackup(backupPath, password) {
  if (await storage.isV3Vault(backupPath)) {
    return { kind: 'v3', context: await storage.openChunkVault(backupPath, password, VAULT_BACKUP_FORMAT) };
  }
  const stat = await fs.stat(backupPath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > legacy.MAX_VAULT_BYTES) throw new Error('LOCAL_VAULT_TOO_LARGE');
  const parsed = legacy.parseEnvelope(await fs.readFile(backupPath));
  if (parsed.envelope.format !== VAULT_BACKUP_FORMAT) throw new Error('LOCAL_VAULT_BACKUP_FORMAT_INVALID');
  const key = await legacy.deriveKey(password, parsed.kdf);
  try {
    return { kind: 'legacy', data: legacy.decryptPayload(parsed, key) };
  } finally {
    key.fill(0);
  }
}

async function importVaultBackup(context, backupPath, password, conflictPolicy = 'reject') {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  storage.assertAbsoluteFile(backupPath);
  if (!['reject', 'skip', 'rename'].includes(conflictPolicy)) throw new Error('LOCAL_VAULT_IMPORT_POLICY_INVALID');
  const source = await openBackup(backupPath, password);
  try {
    const sourceMetadata = source.kind === 'v3'
      ? source.context.data.entries
      : source.data.entries.map((entry) => ({ ...entry, fingerprint: entryFingerprint(entry) }));
    const sourceHistory = source.kind === 'v3' ? source.context.data.activityHistory : [];
    const existingFingerprints = new Set(context.data.entries.map((entry) => entry.fingerprint));
    const usedNames = new Set(context.data.entries.map((entry) => entry.name));
    const conflicts = [];
    const accepted = [];
    for (const metadata of sourceMetadata) {
      const fingerprint = metadata.fingerprint;
      if (existingFingerprints.has(fingerprint)) {
        conflicts.push({ kind: 'duplicate', sourceId: metadata.id, name: metadata.name, fingerprint });
        continue;
      }
      let name = metadata.name;
      if (usedNames.has(name)) {
        conflicts.push({ kind: 'name', sourceId: metadata.id, name, fingerprint });
        if (conflictPolicy === 'rename') name = importedName(name, usedNames);
        else continue;
      }
      accepted.push({ metadata, name, fingerprint });
      usedNames.add(name);
      existingFingerprints.add(fingerprint);
    }
    if (conflictPolicy === 'reject' && conflicts.length) {
      const error = new Error('LOCAL_VAULT_IMPORT_CONFLICT');
      error.conflicts = conflicts;
      throw error;
    }
    if (context.data.entries.length + accepted.length > MAX_ENTRIES) throw new Error('LOCAL_VAULT_ENTRY_LIMIT');
    const usedSequences = new Set(context.data.entries.map((entry) => entry.sequence));
    let cursor = context.data.nextSequence;
    for (const item of accepted) {
      item.sequence = nextAvailableSequence(usedSequences, cursor);
      usedSequences.add(item.sequence);
      cursor = item.sequence + 1;
    }
    async function* importedEntries() {
      for (const item of accepted) {
        const sourceEntry = source.kind === 'v3'
          ? await storage.readEntry(source.context, item.metadata.id)
          : structuredClone(item.metadata);
        yield prepareEntry({
          ...sourceEntry,
          name: item.name,
          findingCount: sourceEntry.audit?.findingCount,
          findingTypes: sourceEntry.audit?.findingTypes,
          importedFrom: {
            backup: path.basename(backupPath),
            sourceId: sourceEntry.id,
            sourceSequence: sourceEntry.sequence,
            fingerprint: item.fingerprint
          }
        }, item.sequence, { preserveIdentity: sourceEntry.kind === 'file-blob' });
      }
    }
    await storage.appendEntries(context, importedEntries(), {
      schemaVersion: VAULT_SCHEMA_VERSION,
      activitySchemaVersion: 1,
      activityHistory: mergeVaultActivity(listVaultActivity(context), sourceHistory)
    });
    return {
      imported: accepted.length,
      skipped: sourceMetadata.length - accepted.length,
      renamed: accepted.filter((item) => item.name !== item.metadata.name).length,
      conflicts,
      entries: listVaultEntries(context)
    };
  } finally {
    if (source.kind === 'v3') storage.closeChunkVault(source.context);
  }
}

async function rotateVaultPassword(context, newPassword) {
  if (!context?.data || !Buffer.isBuffer(context.key)) throw new Error('LOCAL_VAULT_SESSION_INVALID');
  const temporary = `${context.filePath}.${randomUUID()}.rotate-new`;
  const replacement = await storage.createChunkVault(temporary, newPassword, VAULT_FORMAT);
  try {
    async function* sourceEntries() {
      for (const metadata of context.data.entries) yield await readVaultEntry(context, metadata.id);
    }
    await storage.appendEntries(replacement, sourceEntries(), {
      schemaVersion: VAULT_SCHEMA_VERSION,
      activitySchemaVersion: 1,
      activityHistory: listVaultActivity(context)
    });
    const originalPath = context.filePath;
    await atomicReplace(originalPath, temporary);
    const oldKey = context.key;
    Object.assign(context, replacement, { filePath: originalPath });
    replacement.key = null;
    replacement.data = null;
    oldKey.fill(0);
  } catch (error) {
    storage.closeChunkVault(replacement);
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function closeVault(context) {
  storage.closeChunkVault(context);
}

module.exports = {
  VAULT_FORMAT,
  VAULT_BACKUP_FORMAT,
  PAYLOAD_FORMAT,
  VAULT_VERSION,
  VAULT_SCHEMA_VERSION,
  LEGACY_VAULT_VERSION,
  MAX_VAULT_BYTES,
  PARITY_VAULT_BYTES,
  MAX_VAULT_PLAINTEXT_BYTES,
  MAX_ENTRY_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ENTRIES,
  listVaultActivity,
  appendVaultActivity,
  createVault,
  openVault,
  addVaultEntry,
  addVaultEntryWithAttachments,
  listVaultEntries,
  listVaultEntriesPage,
  readVaultEntry,
  exportVaultAttachment,
  deleteVaultEntry,
  compactVault,
  vaultStatistics,
  exportVaultBackup,
  deleteVaultEntries,
  listVaultEntryIds,
  importVaultBackup,
  rotateVaultPassword,
  closeVault,
  parseEnvelope: legacy.parseEnvelope,
  encryptPayload: legacy.encryptPayload,
  decryptPayload: legacy.decryptPayload,
  validatePayload: legacy.validatePayload,
  validatePassword: legacy.validatePassword,
  entryFingerprint,
  fileNumber,
  createLegacyVault,
  assertVaultGrowth: storage.assertVaultGrowth,
  isV3Vault: storage.isV3Vault
};

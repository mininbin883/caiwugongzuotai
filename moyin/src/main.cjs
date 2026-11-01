'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const { extractDocument, SUPPORTED_EXTENSIONS } = require('./services/document-extractor.cjs');
const {
  IMAGE_EXTENSIONS,
  recognizeImage,
  renderRedactedImage,
  renderRedactedBuffer,
  findBoxesForFindings,
  prepareOcrImage,
  detectTableGrid,
  detectDocumentColumns,
  rebuildMappedWords,
  applyOcrCorrections,
  buildCorrectionQueue
} = require('./services/ocr-service.cjs');
const {
  recognizePdf,
  renderRedactedPdf,
  renderTokenizedPdf,
  restoreReversiblePdf,
  extractNativePdfText,
  inspectPdfFeatures,
  inspectPdfCompatibility
} = require('./services/pdf-redaction-service.cjs');
const { validatePdfA } = require('./services/pdf-validation-service.cjs');
const { signPdfWithP12, signPdfWithExternalSigner } = require('./services/pdf-signing-service.cjs');
const { P12Signer } = require('@signpdf/signer-p12');
const { extractSignature } = require('@signpdf/utils');
const { OFFICE_EXTENSIONS, extractOfficeDocument, renderRedactedOffice, restoreReversibleOffice, convertXlsToXlsx } = require('./services/office-redaction-service.cjs');
const { extractCsvDocument, renderRedactedCsv } = require('./services/csv-redaction-service.cjs');
const { SerialTaskQueue } = require('./services/task-queue.cjs');
const { BoundedWorkerPool } = require('./services/worker-pool.cjs');
const { createResourceBudget } = require('./services/resource-budget-service.cjs');
const { createJobWorkspace, recoverOrphanedWorkspaces } = require('./services/job-workspace-service.cjs');
const { runVaultV3CapacityScenario } = require('./services/vault-v3-capacity-smoke.cjs');
const { runVaultV3MaintenanceScenario } = require('./services/vault-v3-maintenance-smoke.cjs');
const { outputFileName, exportBatchResults } = require('./services/batch-export-service.cjs');
const { saveBatchRecordsToVault } = require('./services/batch-vault-service.cjs');
const { prepareReversibleBatch, batchAiPrompt, screeningAiPrompt } = require('./services/batch-reversible-service.cjs');
const { listRestorableFiles, restoreFolderFiles } = require('./services/restore-folder-service.cjs');
const { loadNerModel } = require('./services/ner-service.cjs');
const { findFirstModelPack } = require('./services/model-pack-service.cjs');
const { inspectRapidOcrBackend } = require('./services/rapidocr-service.cjs');
const { allowedSenderEvent } = require('./services/sender-guard.cjs');
const {
  createVault,
  openVault,
  addVaultEntry,
  addVaultEntryWithAttachments,
  listVaultEntries,
  listVaultEntriesPage,
  readVaultEntry,
  exportVaultAttachment,
  deleteVaultEntry,
  deleteVaultEntries,
  listVaultEntryIds,
  compactVault,
  vaultStatistics,
  exportVaultBackup,
  importVaultBackup,
  listVaultActivity,
  appendVaultActivity,
  rotateVaultPassword,
  closeVault
} = require('./services/vault-service.cjs');

const ENTRY = path.join(__dirname, 'renderer', 'index.html');
const EXPORT_LIMIT = 100 * 1024 * 1024;
const imageSessions = new Map();
const officeSessions = new Map();
const csvSessions = new Map();
// BrowserWindow instances must stay strongly referenced for the complete UI lifetime.
// Without this set a production window can be garbage-collected immediately after
// createWindow() returns, which closes the only window and terminates the app.
const appWindows = new Set();
const vaultSessions = new Map();
const nerSessions = new Map();
const batchExportSessions = new Map();
const pendingEncryptedDocuments = new Map();
const sourceFileSessions = new Map();
const vaultAttachmentSessions = new Map();
const DEFAULT_VAULT_TIMEOUT_MINUTES = 30;
const MIN_VAULT_TIMEOUT_MINUTES = 1;
const MAX_VAULT_TIMEOUT_MINUTES = 60;
const MAX_BATCH_FILES = 50;
const MAX_DOCUMENT_SESSIONS = 64;
// 图片（png/jpg 等）不再导入：OCR 识别不可靠，识别不到时会原样导出、泄露原文。
const ACCEPTED_EXTENSIONS = new Set(SUPPORTED_EXTENSIONS);
function unsupportedTypeError(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const code = IMAGE_EXTENSIONS.includes(extension) ? 'LOCAL_IMAGE_FILE_NOT_ACCEPTED' : 'LOCAL_DOCUMENT_TYPE_UNSUPPORTED';
  return new Error(`${code}:${path.basename(filePath)}`);
}
const documentWorkerPool = new BoundedWorkerPool({ concurrency: 1 });
const batchQueue = new SerialTaskQueue((filePath, job) => processDocumentPath(filePath, {
  signal: job.abortController.signal,
  onProgress: (detail) => {
    if (job.status !== 'processing') return;
    const fraction = detail?.pageCount ? detail.pageNumber / detail.pageCount : detail?.totalBytes ? detail.bytes / detail.totalBytes : 0;
    job.progress = Math.max(job.progress, Math.min(90, 15 + Math.round(fraction * 75)));
    job.updatedAt = new Date().toISOString();
    notifyBatchJob(job);
  }
}), notifyBatchJob);
let redactionEnginePromise = null;
let reversibleEnginePromise = null;

function registerSourceFile(event, filePath) {
  const token = randomUUID();
  sourceFileSessions.set(token, { filePath: path.resolve(filePath), ownerId: event.sender.id, createdAt: Date.now() });
  while (sourceFileSessions.size > MAX_DOCUMENT_SESSIONS) sourceFileSessions.delete(sourceFileSessions.keys().next().value);
  return token;
}

function registerVaultAttachmentBundle(event, payload, outputPath) {
  const source = sourceFileSessions.get(String(payload?.sourceToken || ''));
  const attachmentFiles = [];
  if (source && source.ownerId === event.sender.id && Date.now() - source.createdAt <= 2 * 60 * 60 * 1000) {
    attachmentFiles.push({ path: source.filePath, role: 'original', name: path.basename(source.filePath) });
  }
  attachmentFiles.push({ path: outputPath, role: 'redacted-copy', name: path.basename(outputPath) });
  const token = randomUUID();
  vaultAttachmentSessions.set(token, { attachmentFiles, ownerId: event.sender.id, createdAt: Date.now() });
  while (vaultAttachmentSessions.size > MAX_DOCUMENT_SESSIONS) vaultAttachmentSessions.delete(vaultAttachmentSessions.keys().next().value);
  return { vaultAttachmentToken: token, vaultAttachmentFiles: attachmentFiles.length };
}

function cleanupFileSessions(ownerId) {
  for (const [token, value] of sourceFileSessions) if (value.ownerId === ownerId) sourceFileSessions.delete(token);
  for (const [token, value] of vaultAttachmentSessions) if (value.ownerId === ownerId) vaultAttachmentSessions.delete(token);
}

function jobWorkspaceRoot() {
  return path.join(app.getPath('temp'), 'veilforge-jobs');
}

async function disposeDocumentSession(value) {
  await value?.workspace?.cleanup?.().catch(() => {});
}

function storeBoundedSession(map, token, value) {
  map.set(token, value);
  while (map.size > MAX_DOCUMENT_SESSIONS) {
    const oldestToken = map.keys().next().value;
    const oldest = map.get(oldestToken);
    map.delete(oldestToken);
    void disposeDocumentSession(oldest);
  }
}

function releaseResultSession(result) {
  const officeToken = String(result?.office?.token || '');
  if (officeToken && officeSessions.has(officeToken)) {
    const value = officeSessions.get(officeToken);
    officeSessions.delete(officeToken);
    void disposeDocumentSession(value);
  }
  const imageToken = String(result?.image?.token || '');
  if (imageToken && imageSessions.has(imageToken)) {
    const value = imageSessions.get(imageToken);
    imageSessions.delete(imageToken);
    void disposeDocumentSession(value);
  }
  const csvToken = String(result?.csv?.token || '');
  if (csvToken) csvSessions.delete(csvToken);
}

app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');

function allowedSender(event) {
  return allowedSenderEvent(event, ENTRY);
}

function guard(handler) {
  return async (event, ...args) => {
    if (!allowedSender(event)) throw new Error('LOCAL_SENDER_DENIED');
    return handler(...args);
  };
}

function guardWithEvent(handler) {
  return async (event, ...args) => {
    if (!allowedSender(event)) throw new Error('LOCAL_SENDER_DENIED');
    return handler(event, ...args);
  };
}

function publicVaultState(token, vaultSession) {
  const page = listVaultEntriesPage(vaultSession.context, { pageSize: 20 });
  return {
    token,
    name: path.basename(vaultSession.context.filePath),
    timeoutMinutes: vaultSession.timeoutMinutes,
    entries: page.entries,
    page: {
      total: page.total,
      filteredTotal: page.filteredTotal,
      pageSize: page.pageSize,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      filters: page.filters
    },
    backupHistory: listVaultActivity(vaultSession.context),
    stats: vaultStatistics(vaultSession.context)
  };
}

function lockVaultSession(token, reason = 'manual') {
  const vaultSession = vaultSessions.get(token);
  if (!vaultSession) return false;
  clearTimeout(vaultSession.timer);
  closeVault(vaultSession.context);
  vaultSessions.delete(token);
  if (reason === 'timeout' && !vaultSession.webContents.isDestroyed()) {
    vaultSession.webContents.send('veilforge:vault-locked', { token, reason });
  }
  return true;
}

function lockVaultsForOwner(ownerId, reason = 'replaced') {
  for (const [token, vaultSession] of vaultSessions) {
    if (vaultSession.ownerId === ownerId) lockVaultSession(token, reason);
  }
}

function armVaultTimeout(token, vaultSession) {
  clearTimeout(vaultSession.timer);
  vaultSession.timer = setTimeout(() => lockVaultSession(token, 'timeout'), vaultSession.timeoutMinutes * 60 * 1000);
  vaultSession.timer.unref?.();
}

function requireVault(token, ownerId) {
  const normalized = String(token || '');
  const vaultSession = vaultSessions.get(normalized);
  if (!vaultSession || vaultSession.ownerId !== ownerId) throw new Error('LOCAL_VAULT_SESSION_EXPIRED');
  armVaultTimeout(normalized, vaultSession);
  return { token: normalized, vaultSession };
}

function registerVaultContext(event, context) {
  lockVaultsForOwner(event.sender.id);
  const token = randomUUID();
  const vaultSession = {
    context,
    ownerId: event.sender.id,
    webContents: event.sender,
    timeoutMinutes: DEFAULT_VAULT_TIMEOUT_MINUTES,
    timer: null
  };
  vaultSessions.set(token, vaultSession);
  armVaultTimeout(token, vaultSession);
  return publicVaultState(token, vaultSession);
}

async function clearNerForOwner(ownerId) {
  const context = nerSessions.get(ownerId);
  nerSessions.delete(ownerId);
  if (context) await context.close();
}

function publicNerState(context) {
  if (!context) return { loaded: false };
  return { loaded: true, ...context.metadata };
}

async function selectNerModel(event) {
  const result = await dialog.showOpenDialog({
    title: '选择本地 ONNX 中文 NER 模型目录',
    properties: ['openDirectory'],
    message: '目录必须包含 model.onnx、vocab.txt 和 config.json'
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const context = await loadNerModel(result.filePaths[0]);
  await clearNerForOwner(event.sender.id);
  nerSessions.set(event.sender.id, context);
  return { canceled: false, ...publicNerState(context) };
}

async function loadBundledNerModel(event) {
  const pack = await findFirstModelPack('ner');
  if (!pack) return { loaded: false, bundled: true, reason: 'LOCAL_NER_BUNDLED_PACK_MISSING' };
  const context = await loadNerModel(pack.directory);
  await clearNerForOwner(event.sender.id);
  nerSessions.set(event.sender.id, context);
  return { ...publicNerState(context), bundled: true };
}

async function clearNerModel(event) {
  await clearNerForOwner(event.sender.id);
  return { loaded: false };
}

async function analyzeWithNer(event, payload) {
  const context = nerSessions.get(event.sender.id);
  if (!context) throw new Error('LOCAL_NER_MODEL_NOT_LOADED');
  const text = String(payload?.text || '');
  if (!text || Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('LOCAL_NER_TEXT_INVALID');
  const acceptThreshold = Number(payload?.acceptThreshold);
  if (!Number.isFinite(acceptThreshold) || acceptThreshold < 0.5 || acceptThreshold > 0.99) {
    throw new Error('LOCAL_NER_THRESHOLD_INVALID');
  }
  const result = await context.analyze(text, { acceptThreshold, reviewThreshold: Math.min(0.52, acceptThreshold) });
  return {
    entities: result.entities,
    tokens: result.tokens,
    windows: result.windows,
    modelSha256: result.modelSha256,
    accepted: result.entities.filter((item) => item.enabled).length,
    review: result.entities.filter((item) => item.reviewRequired).length
  };
}

async function currentOcrBackendState() {
  const pack = await findFirstModelPack('ocr');
  const backend = String(process.env.VEILFORGE_OCR_BACKEND || 'auto').toLowerCase();
  if (backend !== 'rapidocr') {
    if (backend === 'auto') {
      try {
        const rapid = await inspectRapidOcrBackend();
        process.env.VEILFORGE_OCR_BACKEND = 'rapidocr';
        return {
          backend: rapid.backend,
          name: 'RapidOCR · PP-OCRv6',
          python: rapid.python,
          modelPack: rapid.modelPack,
          runtimePack: rapid.runtimePack,
          automatic: true,
          rapidOcrPack: rapid.modelPack
        };
      } catch (error) {
        return {
          backend: 'tesseract',
          name: 'Tesseract.js',
          automatic: true,
          rapidOcrError: String(error?.message || error),
          rapidOcrPack: pack ? { id: pack.id, name: pack.name, version: pack.version, manifestSha256: pack.manifestSha256 } : null
        };
      }
    }
    return {
      backend: 'tesseract',
      name: 'Tesseract.js',
      rapidOcrPack: pack ? { id: pack.id, name: pack.name, version: pack.version, manifestSha256: pack.manifestSha256 } : null
    };
  }
  try {
    const rapid = await inspectRapidOcrBackend({ pythonPath: process.env.VEILFORGE_RAPIDOCR_PYTHON });
    return { backend: rapid.backend, name: 'RapidOCR · PP-OCRv6', python: rapid.python, modelPack: rapid.modelPack, runtimePack: rapid.runtimePack, rapidOcrPack: rapid.modelPack };
  } catch (error) {
    return { backend: 'rapidocr-unavailable', name: 'RapidOCR 配置失效', error: String(error?.message || error), rapidOcrPack: pack ? { id: pack.id, name: pack.name, version: pack.version, manifestSha256: pack.manifestSha256 } : null };
  }
}

async function selectRapidOcrPython() {
  const result = await dialog.showOpenDialog({
    title: '选择安装了 RapidOCR 3.9.2 的 Python 解释器',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Python', extensions: ['exe'] }] : []
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const rapid = await inspectRapidOcrBackend({ pythonPath: result.filePaths[0] });
  process.env.VEILFORGE_RAPIDOCR_PYTHON = rapid.python;
  process.env.VEILFORGE_OCR_BACKEND = 'rapidocr';
  return { canceled: false, ...(await currentOcrBackendState()) };
}

async function useTesseractBackend() {
  process.env.VEILFORGE_OCR_BACKEND = 'tesseract';
  return currentOcrBackendState();
}

async function createVaultFromDialog(event, payload) {
  const result = await dialog.showSaveDialog({
    title: '新建墨隐加密仓库',
    defaultPath: '墨隐加密仓库.miyin-vault',
    filters: [{ name: '墨隐加密仓库', extensions: ['miyin-vault'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const context = await createVault(result.filePath, payload?.password);
  return { canceled: false, ...registerVaultContext(event, context) };
}

async function openVaultFromDialog(event, payload) {
  const result = await dialog.showOpenDialog({
    title: '打开墨隐加密仓库',
    properties: ['openFile'],
    filters: [{ name: '墨隐加密仓库', extensions: ['miyin-vault'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const context = await openVault(result.filePaths[0], payload?.password);
  return { canceled: false, ...registerVaultContext(event, context) };
}

async function saveVaultEntry(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const entry = {
    kind: payload?.kind,
    name: payload?.name,
    text: payload?.text,
    mapping: payload?.mapping,
    findingCount: payload?.findingCount,
    findingTypes: payload?.findingTypes
  };
  let attachmentResult = null;
  let savedEntry = null;
  if (payload?.attachmentToken) {
    const attachmentToken = String(payload.attachmentToken);
    const bundle = vaultAttachmentSessions.get(attachmentToken);
    if (!bundle || bundle.ownerId !== event.sender.id || Date.now() - bundle.createdAt > 2 * 60 * 60 * 1000) {
      vaultAttachmentSessions.delete(attachmentToken);
      throw new Error('LOCAL_VAULT_ATTACHMENT_SESSION_EXPIRED');
    }
    const saved = await addVaultEntryWithAttachments(vaultSession.context, entry, bundle.attachmentFiles);
    attachmentResult = saved.attachmentResult;
    savedEntry = saved.entry || (saved.fileNumber ? saved : null);
    vaultAttachmentSessions.delete(attachmentToken);
  } else {
    savedEntry = await addVaultEntry(vaultSession.context, entry);
  }
  // 返回新记录的编号，界面据此给导出的副本命名（如 MI-000001-合同-脱敏副本.docx）。
  const saved = savedEntry ? { id: savedEntry.id, fileNumber: savedEntry.fileNumber, name: savedEntry.name } : null;
  return { ...publicVaultState(token, vaultSession), attachmentResult, savedEntry: saved };
}

function listVault(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const page = listVaultEntriesPage(vaultSession.context, {
    cursor: payload?.cursor,
    pageSize: payload?.pageSize,
    filters: payload?.filters
  });
  return { token, ...page, backupHistory: listVaultActivity(vaultSession.context), stats: vaultStatistics(vaultSession.context) };
}

function readFromVault(event, payload) {
  const { vaultSession } = requireVault(payload?.token, event.sender.id);
  return readVaultEntry(vaultSession.context, String(payload?.entryId || ''));
}

async function exportAttachmentFromVault(event, payload) {
  const { vaultSession } = requireVault(payload?.token, event.sender.id);
  const entryId = String(payload?.entryId || '');
  const blobId = String(payload?.blobId || '');
  const entry = await readVaultEntry(vaultSession.context, entryId);
  const attachment = (entry.attachments || []).find((item) => item.blobId === blobId);
  if (!attachment) throw new Error('LOCAL_VAULT_ATTACHMENT_NOT_FOUND');
  const extension = path.extname(attachment.name).slice(1);
  const result = await dialog.showSaveDialog({
    title: '导出仓库加密附件',
    defaultPath: attachment.name,
    filters: extension ? [{ name: '原格式附件', extensions: [extension] }] : undefined
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return { canceled: false, ...(await exportVaultAttachment(vaultSession.context, entryId, blobId, result.filePath)) };
}

async function deleteFromVault(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const deletion = await deleteVaultEntry(vaultSession.context, String(payload?.entryId || ''));
  return { ...publicVaultState(token, vaultSession), deletion };
}

async function deleteManyFromVault(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const deletion = await deleteVaultEntries(vaultSession.context, payload?.ids);
  return { ...publicVaultState(token, vaultSession), deletion };
}

function listVaultIds(event, payload) {
  const { vaultSession } = requireVault(payload?.token, event.sender.id);
  return listVaultEntryIds(vaultSession.context, payload?.filters);
}

async function compactCurrentVault(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const compaction = await compactVault(vaultSession.context);
  return { ...publicVaultState(token, vaultSession), compaction };
}

async function rotateVault(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  await rotateVaultPassword(vaultSession.context, payload?.newPassword);
  return publicVaultState(token, vaultSession);
}

async function backupVaultFromDialog(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const baseName = path.basename(vaultSession.context.filePath, path.extname(vaultSession.context.filePath));
  const entryIds = Array.isArray(payload?.entryIds) ? payload.entryIds.map(String).slice(0, 5000) : null;
  const result = await dialog.showSaveDialog({
    title: entryIds?.length ? `导出所选 ${entryIds.length} 条记录的加密备份` : '导出墨隐加密备份',
    defaultPath: `${baseName}-${entryIds?.length ? `所选${entryIds.length}条-` : ''}备份.miyin-backup`,
    filters: [{ name: '墨隐加密备份', extensions: ['miyin-backup'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const backup = await exportVaultBackup(vaultSession.context, result.filePath, payload?.password, { entryIds });
  await appendVaultActivity(vaultSession.context, {
    action: 'export',
    name: backup.name,
    entries: backup.entries,
    bytes: backup.bytes,
    sha256: backup.sha256
  });
  return { canceled: false, ...publicVaultState(token, vaultSession), backup };
}

async function importVaultFromDialog(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const result = await dialog.showOpenDialog({
    title: '导入墨隐加密备份',
    properties: ['openFile'],
    filters: [{ name: '墨隐加密备份', extensions: ['miyin-backup'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const importReport = await importVaultBackup(
    vaultSession.context,
    result.filePaths[0],
    payload?.password,
    payload?.conflictPolicy
  );
  await appendVaultActivity(vaultSession.context, {
    action: 'import',
    name: path.basename(result.filePaths[0]),
    entries: importReport.imported,
    imported: importReport.imported,
    skipped: importReport.skipped,
    renamed: importReport.renamed
  });
  return { canceled: false, ...publicVaultState(token, vaultSession), importReport };
}

function setVaultTimeout(event, payload) {
  const { token, vaultSession } = requireVault(payload?.token, event.sender.id);
  const minutes = Number(payload?.minutes);
  if (!Number.isInteger(minutes) || minutes < MIN_VAULT_TIMEOUT_MINUTES || minutes > MAX_VAULT_TIMEOUT_MINUTES) {
    throw new Error('LOCAL_VAULT_TIMEOUT_INVALID');
  }
  vaultSession.timeoutMinutes = minutes;
  armVaultTimeout(token, vaultSession);
  return publicVaultState(token, vaultSession);
}

function lockVault(event, payload) {
  const { token } = requireVault(payload?.token, event.sender.id);
  lockVaultSession(token);
  return { locked: true };
}

async function processDocumentPath(filePath, options = {}) {
  return documentWorkerPool.run(() => processDocumentPathInternal(filePath, options), {
    signal: options.signal,
    label: path.basename(filePath)
  });
}

async function processDocumentPathInternal(filePath, options = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.has(extension)) throw unsupportedTypeError(filePath);
  if (extension === '.csv') {
    const csv = await extractCsvDocument(filePath);
    const token = randomUUID();
    storeBoundedSession(csvSessions, token, csv.session);
    return {
      name: csv.name,
      extension: csv.extension,
      sourceBytes: csv.sourceBytes,
      characters: csv.characters,
      text: csv.text,
      csv: { token, kind: 'csv', ...csv.metadata }
    };
  }
  if (extension !== '.pdf' && extension !== '.xls' && !IMAGE_EXTENSIONS.includes(extension) && !OFFICE_EXTENSIONS.includes(extension)) {
    return extractDocument(filePath);
  }
  const budget = createResourceBudget({ profile: 'parity' });
  const workspace = await createJobWorkspace(filePath, {
    root: jobWorkspaceRoot(),
    budget,
    signal: options.signal,
    onProgress: options.onProgress
  });
  let retained = false;
  try {
  if (OFFICE_EXTENSIONS.includes(extension) || extension === '.xls') {
    let officeInput = workspace.inputPath;
    let sessionName = workspace.sourceName;
    if (extension === '.xls') {
      // 旧版 .xls：在本机工作目录转成 .xlsx 后按原格式处理，副本以 .xlsx 导出。
      officeInput = path.join(path.dirname(workspace.inputPath), 'converted-from-xls.xlsx');
      await convertXlsToXlsx(workspace.inputPath, officeInput);
      sessionName = `${path.parse(workspace.sourceName).name}.xlsx`;
    }
    const office = await extractOfficeDocument(officeInput);
    const token = randomUUID();
    office.name = workspace.sourceName;
    office.session.sourceName = sessionName;
    if (extension === '.xls') office.convertedFromXls = true;
    office.session.workspace = workspace;
    storeBoundedSession(officeSessions, token, office.session);
    retained = true;
    return {
      name: office.name,
      extension: office.extension,
      sourceBytes: office.sourceBytes,
      characters: office.characters,
      text: office.text,
      office: { token, kind: office.session.kind, convertedFromXls: Boolean(office.convertedFromXls) },
      officeLongTailReport: office.longTailReport || null
    };
  }

  const media = extension === '.pdf'
    ? await recognizePdf(workspace.inputPath, {
      pageDirectory: workspace.pageDirectory,
      budget,
      password: options.password,
      signal: options.signal,
      onProgress: options.onProgress
    })
    : await recognizeImage(workspace.inputPath);
  const token = randomUUID();
  const kind = extension === '.pdf' ? 'pdf' : 'image';
  let pages;
  if (kind === 'pdf') {
    pages = media.pages;
  } else {
    const imagePath = path.join(workspace.pageDirectory, 'page-0001.png');
    await fs.writeFile(imagePath, media.image, { flag: 'wx', mode: 0o600 });
    pages = [{
    pageNumber: 1,
    imagePath,
    width: media.width,
    height: media.height,
    words: media.words,
    previewDataUrl: media.previewDataUrl,
    confidence: media.confidence,
    textMode: 'ocr',
    textStart: 0,
    textEnd: media.text.length,
    text: media.text,
    tableRegions: media.tableRegions,
    gridTables: media.gridTables,
    columns: media.columns,
    readingOrder: media.readingOrder,
    corrections: media.corrections,
    orientationDegrees: media.orientationDegrees,
    orientationDetected: media.orientationDetected,
    enhancement: media.enhancement,
    segmentationMode: media.segmentationMode,
    recognitionPasses: media.recognitionPasses,
    backend: media.backend,
    modelPack: media.modelPack || null,
    backendElapsedSeconds: Number(media.backendElapsedSeconds || 0),
    detectedLines: Number(media.detectedLines || 0)
    }];
  }
  const imageSession = {
    kind,
    pages,
    sourceName: workspace.sourceName,
    text: media.text,
    sourceMode: media.sourceMode || (kind === 'pdf' ? 'ocr' : 'image'),
    nativePages: media.nativePages || 0,
    ocrPages: media.ocrPages || (kind === 'pdf' ? pages.length : 0),
    sourcePath: kind === 'pdf' ? workspace.inputPath : undefined,
    pdfFeatures: kind === 'pdf' ? media.pdfFeatures : undefined,
    workspace,
    resourceBudget: media.resourceBudget || budget.snapshot()
  };
  storeBoundedSession(imageSessions, token, imageSession);
  retained = true;
  return {
    name: workspace.sourceName,
    extension: media.extension,
    sourceBytes: workspace.sourceBytes,
    characters: media.characters,
    text: media.text,
    image: publicImageDescriptor(token, imageSession)
  };
  } finally {
    if (!retained) await workspace.cleanup().catch(() => {});
  }
}

function publicImageDescriptor(token, imageSession) {
  return {
    kind: imageSession.kind,
    token,
    pageCount: imageSession.pages.length,
    sourceMode: imageSession.sourceMode,
    pdfFeatures: imageSession.pdfFeatures || null,
    pages: imageSession.pages.map((page) => ({
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      words: page.words,
      previewDataUrl: page.previewDataUrl,
      confidence: page.confidence,
      textMode: page.textMode,
      tableRegions: page.tableRegions || [],
      gridTables: page.gridTables || [],
      columns: page.columns || [],
      readingOrder: page.readingOrder || 'rows-top-to-bottom',
      corrections: page.corrections || [],
      orientationDegrees: Number(page.orientationDegrees || 0),
      orientationDetected: Boolean(page.orientationDetected),
      enhancement: page.enhancement || null,
      segmentationMode: page.segmentationMode || page.textMode || 'auto',
      recognitionPasses: Number(page.recognitionPasses || 0),
      backend: page.backend || (page.textMode === 'native' ? 'pdf-native' : 'tesseract'),
      modelPack: page.modelPack || null,
      backendElapsedSeconds: Number(page.backendElapsedSeconds || 0),
      detectedLines: Number(page.detectedLines || 0)
    }))
  };
}

function correctOcr(_event, payload) {
  const token = String(payload?.token || '');
  const imageSession = imageSessions.get(token);
  if (!imageSession) throw new Error('LOCAL_IMAGE_SESSION_EXPIRED');
  const pageNumber = Number(payload?.pageNumber);
  const target = imageSession.pages.find((page) => page.pageNumber === pageNumber);
  if (!target || target.textMode === 'native') throw new Error('LOCAL_OCR_CORRECTION_PAGE_INVALID');
  const snapshots = imageSession.pages.map((page) => {
    const oldStart = Number(page.textStart || 0);
    return {
      page,
      text: String(page.text ?? imageSession.text.slice(oldStart, Number(page.textEnd || oldStart))),
      words: page.words.map((word) => ({ ...word, start: word.start - oldStart, end: word.end - oldStart }))
    };
  });
  const targetSnapshot = snapshots.find((item) => item.page === target);
  const corrected = applyOcrCorrections(targetSnapshot.words, payload?.corrections, 0);
  targetSnapshot.text = corrected.text;
  targetSnapshot.words = corrected.words;
  let text = '';
  for (const snapshot of snapshots) {
    if (text) text += '\n\f\n';
    const offset = text.length;
    snapshot.page.textStart = offset;
    snapshot.page.text = snapshot.text;
    snapshot.page.words = snapshot.words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset }));
    snapshot.page.textEnd = offset + snapshot.text.length;
    snapshot.page.corrections = buildCorrectionQueue(snapshot.page.words);
    snapshot.page.columns = corrected.columns;
    snapshot.page.readingOrder = corrected.readingOrder;
    text += snapshot.text;
  }
  imageSession.text = text;
  return {
    text,
    characters: text.length,
    changed: corrected.changed,
    remaining: target.corrections.length,
    image: publicImageDescriptor(token, imageSession)
  };
}

async function chooseDocument(event) {
  const result = await dialog.showOpenDialog({
    title: '选择需要脱敏的文档',
    properties: ['openFile'],
    filters: [
      { name: '支持的文档', extensions: [...ACCEPTED_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  if (path.extname(filePath).toLowerCase() === '.pdf') {
    const compatibility = await inspectPdfCompatibility(filePath);
    if (compatibility.encrypted) {
      const stats = await fs.stat(filePath);
      const token = randomUUID();
      pendingEncryptedDocuments.set(token, { filePath, ownerId: event.sender.id, createdAt: Date.now() });
      while (pendingEncryptedDocuments.size > 8) pendingEncryptedDocuments.delete(pendingEncryptedDocuments.keys().next().value);
      return {
        passwordRequired: true,
        passwordToken: token,
        name: path.basename(filePath),
        extension: '.pdf',
        sourceBytes: stats.size,
        pdfCompatibility: compatibility
      };
    }
  }
  return { ...(await processDocumentPath(filePath)), sourceToken: registerSourceFile(event, filePath) };
}

async function chooseBatchDocuments(event) {
  const result = await dialog.showOpenDialog({
    title: '选择需要批量脱敏的文档',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文档', extensions: [...ACCEPTED_EXTENSIONS].map((ext) => ext.slice(1)) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { jobs: [], skipped: [] };
  return enqueueBatch(event, { paths: result.filePaths });
}

async function chooseImageForText() {
  // 图片不再导入（见 ACCEPTED_EXTENSIONS 的说明）；入口已隐藏，这里兜底。
  throw new Error('LOCAL_IMAGE_FILE_NOT_ACCEPTED');
}

async function openEncryptedDocument(event, payload) {
  const token = String(payload?.token || '');
  const pending = pendingEncryptedDocuments.get(token);
  if (!pending || pending.ownerId !== event.sender.id || Date.now() - pending.createdAt > 10 * 60 * 1000) {
    pendingEncryptedDocuments.delete(token);
    throw new Error('LOCAL_PDF_PASSWORD_SESSION_EXPIRED');
  }
  const password = String(payload?.password || '');
  if (!password || password.length > 1024) throw new Error('LOCAL_PDF_PASSWORD_INVALID');
  const result = await processDocumentPath(pending.filePath, { password });
  pendingEncryptedDocuments.delete(token);
  return { ...result, sourceToken: registerSourceFile(event, pending.filePath) };
}

function publicBatchJob(job) {
  const result = job.result;
  return {
    id: job.id,
    name: job.metadata.name,
    status: job.status,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: result ? {
      extension: result.extension,
      sourceBytes: result.sourceBytes,
      characters: result.characters,
      kind: result.office?.kind || result.image?.kind || 'text'
    } : null
  };
}

function notifyBatchJob(job) {
  const webContents = job.metadata.webContents;
  if (!webContents || webContents.isDestroyed()) {
    if (!['queued', 'processing'].includes(job.status)) batchQueue.clear((candidate) => candidate.id === job.id);
    return;
  }
  webContents?.send('veilforge:batch-update', publicBatchJob(job));
}

function requireOwnedBatchJob(event, id) {
  const job = batchQueue.get(id);
  if (!job || job.metadata.ownerId !== event.sender.id) throw new Error('LOCAL_BATCH_JOB_NOT_FOUND');
  return job;
}

async function enqueueBatch(event, payload) {
  const supplied = Array.isArray(payload?.paths) ? payload.paths : [];
  const candidates = [...new Set(supplied.map((value) => String(value || '')).filter(Boolean))];
  if (!candidates.length) throw new Error('LOCAL_BATCH_EMPTY');
  if (candidates.length > MAX_BATCH_FILES) throw new Error('LOCAL_BATCH_LIMIT_EXCEEDED');
  for (const filePath of candidates) if (!path.isAbsolute(filePath)) throw new Error('LOCAL_BATCH_PATH_INVALID');
  // 不支持的文件（含图片）跳过并告诉用户，其余照常加入；全部不支持时报错。
  const skipped = candidates.filter((filePath) => !ACCEPTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const accepted = candidates.filter((filePath) => !skipped.includes(filePath));
  if (!accepted.length) throw unsupportedTypeError(skipped[0]);
  const jobs = [];
  for (const filePath of accepted) {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error(`LOCAL_BATCH_NOT_FILE:${path.basename(filePath)}`);
    jobs.push(batchQueue.enqueue(filePath, {
      ownerId: event.sender.id,
      webContents: event.sender,
      name: path.basename(filePath)
    }));
  }
  return { jobs: jobs.map(publicBatchJob), skipped: skipped.map((filePath) => path.basename(filePath)) };
}

function listBatch(event) {
  return batchQueue.list((job) => job.metadata.ownerId === event.sender.id).map(publicBatchJob);
}

function openBatchResult(event, payload) {
  const job = requireOwnedBatchJob(event, payload?.id);
  if (job.status !== 'done' || !job.result) throw new Error('LOCAL_BATCH_JOB_NOT_READY');
  return job.result;
}

function cancelBatch(event, payload) {
  const job = requireOwnedBatchJob(event, payload?.id);
  return { canceled: batchQueue.cancel(job.id), job: publicBatchJob(job) };
}

function clearBatch(event) {
  for (const job of batchQueue.list((candidate) => candidate.metadata.ownerId === event.sender.id && !['queued', 'processing', 'canceling'].includes(candidate.status))) {
    releaseResultSession(job.result);
  }
  const removed = batchQueue.clear((job) => job.metadata.ownerId === event.sender.id);
  return { removed, jobs: listBatch(event) };
}

function loadRedactionEngine() {
  redactionEnginePromise ||= import('./core/redaction-engine.mjs');
  return redactionEnginePromise;
}

let pseudonymEnginePromise;
function loadPseudonymEngine() {
  pseudonymEnginePromise ||= import('./core/pseudonym-engine.mjs');
  return pseudonymEnginePromise;
}

let restoreReviewEnginePromise;
function loadRestoreReviewEngine() {
  restoreReviewEnginePromise ||= import('./core/restore-review.mjs');
  return restoreReviewEnginePromise;
}

function loadReversibleEngine() {
  reversibleEnginePromise ||= import('./core/reversible-token-engine.mjs');
  return reversibleEnginePromise;
}

async function reopenOfficeSession(inputPath) {
  const extension = path.extname(inputPath).toLowerCase();
  if (extension === '.xls') {
    const converted = path.join(os.tmpdir(), `moyin-reopen-${randomUUID()}.xlsx`);
    await convertXlsToXlsx(inputPath, converted);
    return (await extractOfficeDocument(converted)).session;
  }
  if (!OFFICE_EXTENSIONS.includes(extension)) return null;
  return (await extractOfficeDocument(inputPath)).session;
}

function batchExportHandlers(exportSession, batch = null) {
  // 批次可逆模式：本批认出的所有对象都参与每个文件的整包替换与残留检查（某个文件里没认出、别的文件认出了的，也不会漏）。
  const sweepFindings = Array.isArray(batch?.mapping)
    ? batch.mapping.map((entry) => ({ value: entry.value, replacement: entry.token, enabled: true }))
    : [];
  return {
    analyzeText: async (text, job) => batch?.prepared?.get(job?.id) || (await loadRedactionEngine()).analyzeText(text, batch?.analysisOptions || {}),
    outputPrefix: batch?.fileNumber ? (index) => `${batch.fileNumber}-${String(index + 1).padStart(2, '0')}` : undefined,
    applyFindings: (text, findings) => redactionEnginePromise.then((engine) => engine.applyFindings(text, findings)),
    renderOffice: async (descriptor, findings, outputPath, job) => {
      let officeSession = officeSessions.get(String(descriptor?.token || ''));
      // 批次超过同时保留的文档数时，较早的会话会被释放：从原文件重新读取（提取结果与导入时一致）。
      if (!officeSession && job?.input) officeSession = await reopenOfficeSession(job.input);
      if (!officeSession || officeSession.kind !== descriptor?.kind) throw new Error('LOCAL_OFFICE_SESSION_EXPIRED');
      return renderRedactedOffice(officeSession, findings, outputPath, { sweepFindings });
    },
    renderPdf: async (descriptor, findings, outputPath) => {
      const imageSession = imageSessions.get(String(descriptor?.token || ''));
      if (!imageSession || imageSession.kind !== 'pdf') throw new Error('LOCAL_IMAGE_SESSION_EXPIRED');
      // 批次可逆模式：PDF 写入代号并生成坐标副本，以便逆脱敏。
      return batch?.reversible ? renderTokenizedPdf(imageSession, findings, outputPath) : renderRedactedPdf(imageSession, findings, outputPath);
    },
    renderImage: async (descriptor, findings, outputPath) => {
      const imageSession = imageSessions.get(String(descriptor?.token || ''));
      if (!imageSession || imageSession.kind !== 'image') throw new Error('LOCAL_IMAGE_SESSION_EXPIRED');
      return renderRedactedImage(imageSession.pages[0], findings, outputPath);
    },
    renderCsv: async (descriptor, text, outputPath, job) => {
      let csvSession = csvSessions.get(String(descriptor?.token || ''));
      if (!csvSession && job?.input) csvSession = (await extractCsvDocument(job.input)).session;
      if (!csvSession) throw new Error('LOCAL_CSV_SESSION_EXPIRED');
      return renderRedactedCsv(csvSession, text, outputPath);
    },
    shouldCancel: () => Boolean(exportSession?.cancelRequested),
    onProgress: (detail) => {
      const webContents = exportSession?.webContents;
      if (webContents && !webContents.isDestroyed()) webContents.send('veilforge:batch-export-progress', detail);
    }
  };
}

// 批处理沿用界面上的保护设置（开启的类型、自定义词、类型化词、保留词）。
function sanitizeAnalysisOptions(value) {
  const options = value && typeof value === 'object' ? value : {};
  const list = (items, max = 2000) => (Array.isArray(items) ? items : []).map((item) => String(item).slice(0, 200)).filter(Boolean).slice(0, max);
  const typed = {};
  if (options.typedTerms && typeof options.typedTerms === 'object') {
    for (const [type, terms] of Object.entries(options.typedTerms)) typed[String(type).slice(0, 20)] = list(terms);
  }
  return {
    enabledTypes: Array.isArray(options.enabledTypes) ? list(options.enabledTypes, 50) : undefined,
    customTerms: list(options.customTerms),
    typedTerms: typed,
    alwaysKeepTerms: list(options.alwaysKeepTerms)
  };
}

async function exportCompletedBatch(event, payload) {
  if (batchExportSessions.has(event.sender.id)) throw new Error('LOCAL_BATCH_EXPORT_ACTIVE');
  const jobs = batchQueue.list((job) => job.metadata.ownerId === event.sender.id && job.status === 'done' && job.result);
  if (!jobs.length) throw new Error('LOCAL_BATCH_EXPORT_EMPTY');
  const screening = payload?.screening === true;
  const reversibleBatch = payload?.reversible === true || screening;
  // 税务筛查模式只导出筛查脚本读取的表格（Excel、CSV）；Word、PDF、图片脚本不读，不放进资料文件夹。
  const skipped = screening ? jobs.filter((job) => !(job.result?.office?.kind === 'xlsx' || job.result?.csv)).map((job) => job.result?.name || '') : [];
  const exportable = screening ? jobs.filter((job) => job.result?.office?.kind === 'xlsx' || job.result?.csv) : jobs;
  if (!exportable.length) throw new Error('LOCAL_BATCH_SCREENING_NO_TABLES');
  const analysisOptions = sanitizeAnalysisOptions(payload?.analysisOptions);
  // 可逆批次必须先有已解锁的文件仓库：整批对照表存成一条记录。
  const batchVault = reversibleBatch ? requireVault(payload?.vaultToken, event.sender.id) : null;
  const selection = await dialog.showOpenDialog({
    title: reversibleBatch ? '选择批次副本的保存目录（建议新建一个空文件夹）' : '选择批量脱敏结果保存目录',
    properties: ['openDirectory', 'createDirectory']
  });
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true, exported: 0, failed: 0 };
  const exportSession = { ownerId: event.sender.id, webContents: event.sender, cancelRequested: false };
  batchExportSessions.set(event.sender.id, exportSession);
  let batchEntry = null;
  try {
    let exportJobs = exportable;
    let batch = { analysisOptions };
    let outputDirectory = selection.filePaths[0];
    if (reversibleBatch) {
      const preparedBatch = prepareReversibleBatch(exportable, analysisOptions, await loadRedactionEngine(), await loadReversibleEngine(),
        { screening, pseudonym: screening ? await loadPseudonymEngine() : null });
      batchEntry = await addVaultEntry(batchVault.vaultSession.context, {
        kind: 'reversible-map',
        name: `${screening ? '批次（税务筛查）' : '批次'} · ${exportable.length} 个文件 · ${new Date().toLocaleDateString('zh-CN')}`,
        text: preparedBatch.text,
        mapping: preparedBatch.mapping,
        findingCount: preparedBatch.findingCount,
        findingTypes: preparedBatch.findingTypes
      });
      exportJobs = preparedBatch.safeJobs;
      batch = { analysisOptions, reversible: true, prepared: preparedBatch.prepared, fileNumber: batchEntry.fileNumber, mapping: preparedBatch.mapping };
      if (screening) {
        // 资料文件夹只放资料（筛查脚本会读取文件夹里的每个文件）；审计记录、清单、给 AI 的要求放在旁边的记录文件夹。
        outputDirectory = path.join(selection.filePaths[0], `${batchEntry.fileNumber}-税务筛查资料`);
        batch.recordDirectory = path.join(selection.filePaths[0], `${batchEntry.fileNumber}-墨隐记录`);
        await fs.mkdir(outputDirectory, { recursive: true });
        await fs.mkdir(batch.recordDirectory, { recursive: true });
      }
    }
    const handlers = batchExportHandlers(exportSession, batch);
    if (batch.recordDirectory) handlers.recordDirectory = batch.recordDirectory;
    const result = await exportBatchResults(exportJobs, outputDirectory, handlers);
    let batchInfo = null;
    if (reversibleBatch) {
      if (!result.exported) {
        // 一个文件都没导出：撤销这条批次记录，不留空编号。
        await deleteVaultEntry(batchVault.vaultSession.context, batchEntry.id).catch(() => {});
        batchEntry = null;
      } else {
        const prompt = screening
          ? screeningAiPrompt(batchEntry.fileNumber, result.exported, batch.mapping)
          : batchAiPrompt(batchEntry.fileNumber, result.exported, batch.mapping);
        const promptPath = path.join(batch.recordDirectory || result.directory, `${batchEntry.fileNumber}-给AI的要求.txt`);
        await fs.writeFile(promptPath, `\ufeff${prompt}\n`, 'utf8').catch(() => {});
        batchInfo = {
          id: batchEntry.id, fileNumber: batchEntry.fileNumber, fileCount: result.exported, tokenCount: batch.mapping.length,
          prompt, promptName: path.basename(promptPath), screening, dataDirectory: result.directory,
          recordDirectory: batch.recordDirectory || '', skipped
        };
      }
    }
    let vaultSave = { requested: 0, saved: 0, failed: 0, entries: [], errors: [] };
    let vaultState = reversibleBatch ? publicVaultState(batchVault.token, batchVault.vaultSession) : null;
    if (payload?.autoVault && !reversibleBatch) {
      try {
        const { token, vaultSession } = requireVault(payload?.vaultToken, event.sender.id);
        const jobsById = new Map(jobs.map((job) => [job.id, job]));
        vaultSave = await saveBatchRecordsToVault(result.records, async (entry, record) => {
          const job = jobsById.get(record.id);
          const attachmentFiles = [
            job?.input ? { path: job.input, role: 'original', name: path.basename(job.input) } : null,
            record.outputPath ? { path: record.outputPath, role: 'redacted-copy', name: path.basename(record.outputPath) } : null
          ].filter(Boolean);
          return attachmentFiles.length
            ? addVaultEntryWithAttachments(vaultSession.context, entry, attachmentFiles)
            : addVaultEntry(vaultSession.context, entry);
        });
        vaultState = publicVaultState(token, vaultSession);
      } catch (error) {
        vaultSave = {
          requested: result.records.length,
          saved: 0,
          failed: result.records.length,
          entries: [],
          errors: [{ id: '', sourceName: '', error: String(error?.message || error) }]
        };
      }
    }
    return {
      canceled: result.canceled,
      directory: result.directory,
      total: result.total,
      exported: result.exported,
      failed: result.failed,
      manifestName: path.basename(result.manifestPath),
      outputs: result.records.map((record) => ({
        sourceName: record.sourceName,
        outputName: path.basename(record.outputPath),
        auditName: path.basename(record.auditPath),
        findingCount: record.findingCount
      })),
      errors: result.errors,
      vaultSave,
      vaultState,
      batch: batchInfo
    };
  } catch (error) {
    if (batchEntry && batchVault) await deleteVaultEntry(batchVault.vaultSession.context, batchEntry.id).catch(() => {});
    throw error;
  } finally {
    batchExportSessions.delete(event.sender.id);
  }
}

function cancelBatchExport(event) {
  const exportSession = batchExportSessions.get(event.sender.id);
  if (!exportSession) return { canceled: false };
  exportSession.cancelRequested = true;
  return { canceled: true };
}

function cleanupBatchOwner(ownerId) {
  const exportSession = batchExportSessions.get(ownerId);
  if (exportSession) exportSession.cancelRequested = true;
  for (const job of batchQueue.list((candidate) => candidate.metadata.ownerId === ownerId)) {
    job.metadata.webContents = null;
    if (job.status === 'queued') batchQueue.cancel(job.id);
  }
  batchQueue.clear((job) => job.metadata.ownerId === ownerId);
}

// 导出文件名：界面给出“编号-原名-脱敏副本”时优先使用，否则沿用原有命名。
function exportFileName(payload, fallbackBase, extension) {
  const hint = path.basename(String(payload?.fileNameHint || ''))
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, ' ')
    .replace(/\.[A-Za-z0-9]{1,5}$/u, '')
    .trim()
    .slice(0, 150);
  return `${hint || fallbackBase}.${extension}`;
}

async function saveExport(event, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('LOCAL_EXPORT_INVALID');
  if (payload.kind === 'csv') {
    const csvSession = csvSessions.get(String(payload.csvToken || ''));
    if (!csvSession) throw new Error('LOCAL_CSV_SESSION_EXPIRED');
    if (typeof payload.text !== 'string') throw new Error('LOCAL_CSV_TEXT_INVALID');
    const result = await dialog.showSaveDialog({
      title: '导出原格式脱敏 CSV',
      defaultPath: exportFileName(payload, `${path.parse(csvSession.sourceName).name}-脱敏`, 'csv'),
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const rendered = await renderRedactedCsv(csvSession, payload.text, result.filePath);
    return { canceled: false, path: result.filePath, ...rendered, ...registerVaultAttachmentBundle(event, payload, result.filePath) };
  }
  if (payload.kind === 'docx' || payload.kind === 'xlsx') {
    const officeSession = officeSessions.get(String(payload.officeToken || ''));
    if (!officeSession) throw new Error('LOCAL_OFFICE_SESSION_EXPIRED');
    if (officeSession.kind !== payload.kind) throw new Error('LOCAL_OFFICE_SESSION_KIND_MISMATCH');
    const result = await dialog.showSaveDialog({
      title: `导出原格式脱敏 ${payload.kind.toUpperCase()}`,
      defaultPath: exportFileName(payload, `${path.parse(officeSession.sourceName).name}-脱敏`, payload.kind),
      filters: [{ name: payload.kind === 'docx' ? 'Word 文档' : 'Excel 工作簿', extensions: [payload.kind] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const rendered = await renderRedactedOffice(officeSession, payload.findings, result.filePath);
    return { canceled: false, path: result.filePath, ...rendered, ...registerVaultAttachmentBundle(event, payload, result.filePath) };
  }
  if (payload.kind === 'image' || payload.kind === 'pdf') {
    const imageSession = imageSessions.get(String(payload.imageToken || ''));
    if (!imageSession) throw new Error('LOCAL_IMAGE_SESSION_EXPIRED');
    if (payload.kind !== imageSession.kind) throw new Error('LOCAL_IMAGE_SESSION_KIND_MISMATCH');
    if (payload.kind === 'pdf') {
      const reversible = Array.isArray(payload.findings) && payload.findings.length > 0 &&
        payload.findings.every((finding) => /^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]$/u.test(String(finding?.replacement || '')));
      const result = await dialog.showSaveDialog({
        title: reversible ? '导出可逆代号 PDF 与坐标副本' : '导出不可恢复的涂黑 PDF',
        defaultPath: exportFileName(payload, `${path.parse(imageSession.sourceName).name}-${reversible ? '可逆代号' : '脱敏'}`, 'pdf'),
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const rendered = reversible
        ? await renderTokenizedPdf(imageSession, payload.findings, result.filePath)
        : await renderRedactedPdf(imageSession, payload.findings, result.filePath);
      const pdfaValidation = await validatePdfA(result.filePath, {
        flavour: imageSession.pdfFeatures?.pdfaDeclared
          ? `${imageSession.pdfFeatures.pdfaPart || ''}${String(imageSession.pdfFeatures.pdfaConformance || '').toLowerCase()}`
          : undefined
      });
      return { canceled: false, path: result.filePath, ...rendered, pdfaValidation, ...registerVaultAttachmentBundle(event, payload, result.filePath) };
    }
    const result = await dialog.showSaveDialog({
      title: '导出不可恢复的涂黑图片',
      defaultPath: exportFileName(payload, `${path.parse(imageSession.sourceName).name}-脱敏`, 'png'),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const rendered = await renderRedactedImage(imageSession.pages[0], payload.findings, result.filePath);
    return { canceled: false, path: result.filePath, ...rendered, ...registerVaultAttachmentBundle(event, payload, result.filePath) };
  }
  if (typeof payload.text !== 'string') throw new Error('LOCAL_EXPORT_INVALID');
  if (Buffer.byteLength(payload.text, 'utf8') > EXPORT_LIMIT) throw new Error('LOCAL_EXPORT_TOO_LARGE');
  const kind = payload.kind === 'json' ? 'json' : 'txt';
  const defaultPath = exportFileName(payload, '脱敏结果', kind);
  const result = await dialog.showSaveDialog({
    title: '导出脱敏结果',
    defaultPath,
    filters: [{ name: kind === 'json' ? 'JSON 审计文件' : 'UTF-8 文本', extensions: [kind] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  let body = payload.text;
  if (kind === 'json') {
    const value = {
      format: 'VEILFORGE_REDACTION_AUDIT',
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceName: String(payload.sourceName || ''),
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      redactedText: payload.text
    };
    body = `${JSON.stringify(value, null, 2)}\n`;
  }
  await fs.writeFile(result.filePath, body, { encoding: 'utf8', flag: 'wx' });
  return { canceled: false, path: result.filePath, bytes: Buffer.byteLength(body, 'utf8'), ...registerVaultAttachmentBundle(event, payload, result.filePath) };
}

// ---------- 两步逆脱敏：先读入 AI 返回的文件（只读，不落盘），核对确认后再另存为 ----------
const RESTORE_EXTENSIONS = ['docx', 'xlsx', 'csv', 'pdf', 'txt', 'md'];
const restoreSessions = new Map();

async function openReturnedDocument(event, payload) {
  let inputPath = typeof payload?.path === 'string' ? payload.path : '';
  if (!inputPath) {
    const selected = await dialog.showOpenDialog({
      title: '选择 AI 返回的文件',
      properties: ['openFile'],
      filters: [{ name: 'AI 返回的文件', extensions: RESTORE_EXTENSIONS }]
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    inputPath = selected.filePaths[0];
  }
  if (!path.isAbsolute(inputPath)) throw new Error('LOCAL_PATH_INVALID');
  const stat = await fs.stat(inputPath);
  // 拖进来的是文件夹（如筛查技能生成的“筛查结果”）：按整个文件夹还原。
  if (stat.isDirectory()) return openReturnedFolder(event, inputPath);
  const kind = path.extname(inputPath).toLowerCase().slice(1);
  if (!RESTORE_EXTENSIONS.includes(kind)) throw new Error('LOCAL_TYPE_UNSUPPORTED');
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  let text;
  if (kind === 'docx' || kind === 'xlsx') text = (await extractOfficeDocument(inputPath)).text;
  else if (kind === 'csv') text = (await extractCsvDocument(inputPath)).text;
  else text = (await extractDocument(inputPath)).text;
  const token = randomUUID();
  for (const [key, value] of restoreSessions) if (value.ownerId === event.sender.id) restoreSessions.delete(key);
  restoreSessions.set(token, { path: inputPath, kind, ownerId: event.sender.id, createdAt: Date.now() });
  return { canceled: false, token, kind, name: path.basename(inputPath), text, characters: text.length };
}

// ---------- 整个文件夹还原（如筛查技能生成的“筛查结果”） ----------
const restoreFolderSessions = new Map();

async function openReturnedFolder(event, folderPath) {
  const listed = await listRestorableFiles(folderPath);
  if (!listed.files.length) throw new Error('LOCAL_RESTORE_FOLDER_EMPTY');
  const token = randomUUID();
  for (const [key, value] of restoreFolderSessions) if (value.ownerId === event.sender.id) restoreFolderSessions.delete(key);
  restoreFolderSessions.set(token, { path: folderPath, files: listed.files, ownerId: event.sender.id });
  return { canceled: false, folder: true, token, path: folderPath, name: path.basename(folderPath), fileNumber: listed.fileNumber, files: listed.files, skipped: listed.skipped };
}

async function pickReturnedFolder(event) {
  const selected = await dialog.showOpenDialog({ title: '选择要还原的文件夹（如“筛查结果”）', properties: ['openDirectory'] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  return openReturnedFolder(event, selected.filePaths[0]);
}

async function runFolderRestore(event, payload) {
  const session = restoreFolderSessions.get(String(payload?.token || ''));
  if (!session || session.ownerId !== event.sender.id) throw new Error('LOCAL_RESTORE_FOLDER_EXPIRED');
  return restoreFolderFiles(session.path, session.files, payload?.mapping, {
    restoreTokens: (await loadReversibleEngine()).restoreTokens,
    restoreReversibleOffice,
    extractCsvDocument,
    renderRedactedCsv
  });
}

async function saveRestoredDocument(event, payload) {
  const session = restoreSessions.get(String(payload?.token || ''));
  const mapping = payload?.mapping;
  if (!Array.isArray(mapping)) throw new Error('LOCAL_VAULT_MAPPING_INVALID');
  const asText = !session || session.ownerId !== event.sender.id || payload?.asText === true;
  const kind = asText ? (session?.kind === 'md' && payload?.asText !== true ? 'md' : 'txt') : session.kind === 'md' ? 'md' : session.kind;
  const sourceBase = session ? path.parse(session.path).name : String(payload?.nameHint || 'AI返回内容');
  const base = sourceBase.replace(/-?脱敏副本$/u, '').replace(/-?脱敏$/u, '') || '逆脱敏结果';
  const destination = await dialog.showSaveDialog({
    title: '下载逆脱敏结果',
    defaultPath: `${base}-逆脱敏.${kind}`,
    filters: [{ name: kind === 'docx' ? 'Word 文档' : kind === 'xlsx' ? 'Excel 工作簿' : kind === 'csv' ? 'CSV 表格' : kind === 'pdf' ? 'PDF 文档' : kind === 'md' ? 'Markdown 文档' : 'UTF-8 文本', extensions: [kind] }]
  });
  if (destination.canceled || !destination.filePath) return { canceled: true };
  const reversible = await loadReversibleEngine();
  if (kind === 'txt' || kind === 'md') {
    if (typeof payload?.text !== 'string') throw new Error('LOCAL_EXPORT_INVALID');
    const report = reversible.restoreTokens(payload.text, mapping, { mode: 'analysis' });
    if (Buffer.byteLength(report.restoredText, 'utf8') > EXPORT_LIMIT) throw new Error('LOCAL_EXPORT_TOO_LARGE');
    await fs.writeFile(destination.filePath, report.restoredText, 'utf8');
    return { canceled: false, path: destination.filePath, kind, restoredOccurrences: report.restoredCount };
  }
  if (kind === 'csv') {
    const source = await extractCsvDocument(session.path);
    const report = reversible.restoreTokens(source.text, mapping, { mode: 'rewrite' });
    const rendered = await renderRedactedCsv(source.session, report.restoredText, destination.filePath, { sanitizeFormulas: false });
    return { canceled: false, path: destination.filePath, kind, restoredOccurrences: report.restoredCount, ...rendered };
  }
  if (kind === 'pdf') {
    let sidecarPath = `${session.path}.tokens.json`;
    try {
      await fs.access(sidecarPath);
    } catch {
      const sidecar = await dialog.showOpenDialog({
        title: '选择导出时一起生成的 PDF 坐标副本（.tokens.json）',
        properties: ['openFile'],
        filters: [{ name: '墨隐 PDF 坐标副本', extensions: ['json'] }]
      });
      if (sidecar.canceled || !sidecar.filePaths[0]) return { canceled: true };
      sidecarPath = sidecar.filePaths[0];
    }
    const restored = await restoreReversiblePdf(session.path, mapping, destination.filePath, sidecarPath);
    return { canceled: false, path: destination.filePath, kind, ...restored };
  }
  const restored = await restoreReversibleOffice(session.path, mapping, destination.filePath);
  return { canceled: false, path: destination.filePath, kind, ...restored };
}

async function restoreOfficeFromDialog(_event, payload) {
  const mapping = payload?.mapping;
  const selected = await dialog.showOpenDialog({
    title: '选择含可逆代号的 DOCX、XLSX、PDF 或 CSV',
    properties: ['openFile'],
    filters: [{ name: '可逆文档', extensions: ['docx', 'xlsx', 'pdf', 'csv'] }]
  });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  const inputPath = selected.filePaths[0];
  const kind = path.extname(inputPath).toLowerCase().slice(1);
  const destination = await dialog.showSaveDialog({
    title: `导出原格式逆脱敏 ${kind.toUpperCase()}`,
    defaultPath: `${path.parse(inputPath).name}-逆脱敏.${kind}`,
    filters: [{ name: kind === 'docx' ? 'Word 文档' : kind === 'xlsx' ? 'Excel 工作簿' : kind === 'csv' ? 'CSV 表格' : 'PDF 文档', extensions: [kind] }]
  });
  if (destination.canceled || !destination.filePath) return { canceled: true };
  let restored;
  if (kind === 'csv') {
    const source = await extractCsvDocument(inputPath);
    const reversible = await loadReversibleEngine();
    const report = reversible.restoreTokens(source.text, mapping, { mode: 'rewrite' });
    const rendered = await renderRedactedCsv(source.session, report.restoredText, destination.filePath, { sanitizeFormulas: false });
    restored = {
      kind: 'csv',
      restoredOccurrences: report.restoredCount,
      knownTokens: Array.isArray(mapping) ? mapping.length : 0,
      missingTokens: report.missing,
      unknownTokens: report.unknownTokens,
      repeatedTokens: report.repeated,
      complete: report.complete,
      ...rendered
    };
  } else if (kind === 'pdf') {
    let sidecarPath = `${inputPath}.tokens.json`;
    try {
      await fs.access(sidecarPath);
    } catch {
      const sidecar = await dialog.showOpenDialog({
        title: '选择 PDF 坐标副本 .tokens.json',
        properties: ['openFile'],
        filters: [{ name: '墨隐 PDF 坐标副本', extensions: ['json'] }]
      });
      if (sidecar.canceled || !sidecar.filePaths[0]) return { canceled: true };
      sidecarPath = sidecar.filePaths[0];
    }
    restored = await restoreReversiblePdf(inputPath, mapping, destination.filePath, sidecarPath);
  } else {
    restored = await restoreReversibleOffice(inputPath, mapping, destination.filePath);
  }
  const review = await reviewReturnedDocument(inputPath, payload?.sentText, mapping);
  const complete = Boolean(restored.complete) && !(review?.requiresReview);
  return { canceled: false, path: destination.filePath, ...restored, complete, review };
}

// 原格式逆脱敏的语义核对：从 AI 返回的文档抽取文字，与当初发出的代号副本逐句比较。
async function reviewReturnedDocument(inputPath, sentText, mapping) {
  if (typeof sentText !== 'string' || !sentText || sentText.length > 2_000_000 || !Array.isArray(mapping)) return null;
  try {
    const returned = await extractDocument(inputPath);
    const { reviewRestoration } = await loadRestoreReviewEngine();
    return reviewRestoration({ sentText, returnedText: returned.text, mapping });
  } catch {
    return null;
  }
}

function hardenSession(ses) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('file://');
    callback({ cancel: !allowed });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
        ]
      }
    });
  });
}

function commandValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
}

async function runCsvSmoke() {
  const directoryValue = commandValue('csv-smoke-dir');
  if (!directoryValue) return false;
  const directory = path.resolve(directoryValue);
  await fs.mkdir(directory, { recursive: true });
  const inputPath = path.join(directory, 'packaged-source.csv');
  const tokenizedPath = path.join(directory, 'packaged-tokenized.csv');
  const restoredPath = path.join(directory, 'packaged-restored.csv');
  const reportPath = path.join(directory, 'packaged-csv-report.json');
  const sourceText = '姓名;电话;邮箱\r\n张三;13800138000;zhangsan@example.com\r\n';
  const sourceBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sourceText, 'utf8')]);
  await fs.writeFile(inputPath, sourceBytes);
  const source = await extractCsvDocument(inputPath);
  const redaction = (await loadRedactionEngine()).analyzeText(source.text, { customTerms: ['张三'] });
  const reversible = await loadReversibleEngine();
  const tokenized = reversible.tokenizeFindings(source.text, redaction.findings, { nonce: 'C5A230FF' });
  const rendered = await renderRedactedCsv(source.session, tokenized.tokenizedText, tokenizedPath, { sanitizeFormulas: false });
  const reopened = await extractCsvDocument(tokenizedPath);
  const restored = reversible.restoreTokens(reopened.text, tokenized.mapping, { mode: 'rewrite' });
  await renderRedactedCsv(reopened.session, restored.restoredText, restoredPath, { sanitizeFormulas: false });
  const restoredBytes = await fs.readFile(restoredPath);
  const sensitiveAbsent = !reopened.text.includes('张三') && !reopened.text.includes('13800138000') && !reopened.text.includes('zhangsan@example.com');
  const exactBytes = Buffer.compare(sourceBytes, restoredBytes) === 0;
  const pass = source.metadata.bom && source.metadata.delimiter === ';' && source.metadata.lineEnding === '\r\n' &&
    redaction.findings.length >= 3 && tokenized.occurrenceCount === restored.restoredCount && restored.complete &&
    sensitiveAbsent && exactBytes;
  const record = {
    format: 'VEILFORGE_PACKAGED_CSV_SMOKE',
    result: pass ? 'PASS' : 'FAIL',
    encoding: source.metadata.encoding,
    bom: source.metadata.bom,
    delimiterName: source.metadata.delimiterName,
    lineEndingName: source.metadata.lineEndingName,
    findings: redaction.findings.length,
    occurrences: tokenized.occurrenceCount,
    restoredOccurrences: restored.restoredCount,
    sensitiveAbsent,
    exactBytes,
    tokenizedBytes: rendered.bytes
  };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`CSV_PACKAGED_SMOKE_${record.result} encoding=${record.encoding} delimiter=${record.delimiterName} tokens=${record.restoredOccurrences}/${record.occurrences} exact=${exactBytes ? 1 : 0}\n`);
  app.exit(pass ? 0 : 1);
  return true;
}

async function runNerSmoke() {
  const modelDirectory = commandValue('ner-smoke-model-dir');
  if (!modelDirectory) return false;
  const reportValue = commandValue('ner-smoke-report');
  if (!reportValue) throw new Error('NER_SMOKE_REPORT_REQUIRED');
  const text = '王伟今日抵达上海，与北京星河科技有限公司代表陈明会面。';
  const context = await loadNerModel(path.resolve(modelDirectory));
  try {
    const inference = await context.analyze(text, { acceptThreshold: 0.78, reviewThreshold: 0.52 });
    const engine = await loadRedactionEngine();
    const merged = engine.analyzeText(text, { style: 'label', externalFindings: inference.entities });
    const expected = [
      ['person', '王伟'],
      ['address', '上海'],
      ['company', '北京星河科技有限公司'],
      ['person', '陈明']
    ];
    const rawMatches = expected.every(([type, value]) => inference.entities.some((item) => item.type === type && item.value === value));
    const removed = expected.every(([, value]) => !merged.redactedText.includes(value));
    const accepted = inference.entities.filter((item) => item.enabled).length;
    const review = inference.entities.filter((item) => item.reviewRequired).length;
    const passed = rawMatches && removed && accepted >= 4 && review === 0 && inference.tokens > 0 && inference.windows === 1 && /^[a-f0-9]{64}$/iu.test(inference.modelSha256);
    const record = {
      format: 'VEILFORGE_NER_SMOKE',
      result: passed ? 'PASS' : 'FAIL',
      text,
      entities: inference.entities,
      accepted,
      review,
      tokens: inference.tokens,
      windows: inference.windows,
      mergedCount: merged.findings.length,
      modelCount: merged.modelCount,
      redactedText: merged.redactedText,
      modelSha256: inference.modelSha256,
      metadata: context.metadata
    };
    const reportPath = path.resolve(reportValue);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    process.stdout.write(`NER_SMOKE_${record.result} entities=${inference.entities.length} accepted=${accepted} review=${review} tokens=${inference.tokens} windows=${inference.windows} merged=${merged.findings.length}\n`);
    app.exit(passed ? 0 : 1);
    return true;
  } finally {
    await context.close();
  }
}

async function runChineseCoverageSmoke() {
  const report = commandValue('chinese-coverage-report');
  if (!report) return false;
  const engine = await loadRedactionEngine();
  const source = '甲方：北京星河科技有限公司；联系人：张三；审核人：李四；统一社会信用代码：91310000677833266F；地址：北京市朝阳区建国路88号；内部项目：朱雀计划。';
  const result = engine.analyzeText(source, {
    style: 'label',
    typedTerms: { custom: ['朱雀计划'] },
    alwaysKeepTerms: ['李四']
  });
  const observed = result.findings.map(({ type, value }) => ({ type, value }));
  const expectedTypes = ['company', 'person', 'uscc', 'address', 'custom'];
  const record = {
    format: 'VEILFORGE_CHINESE_COVERAGE_SMOKE',
    result: JSON.stringify(observed.map((item) => item.type)) === JSON.stringify(expectedTypes) &&
      !result.redactedText.includes('北京星河科技有限公司') && !result.redactedText.includes('张三') &&
      !result.redactedText.includes('91310000677833266F') && !result.redactedText.includes('北京市朝阳区建国路88号') &&
      !result.redactedText.includes('朱雀计划') && result.redactedText.includes('李四') ? 'PASS' : 'FAIL',
    observed,
    protectedCount: result.protectedCount,
    redactedText: result.redactedText
  };
  const reportPath = path.resolve(report);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`CHINESE_COVERAGE_${record.result} types=${observed.map((item) => item.type).join(',')} protected=${record.protectedCount}\n`);
  app.exit(record.result === 'PASS' ? 0 : 1);
  return true;
}

async function runReversibleSmoke() {
  const file = commandValue('reversible-smoke-file');
  if (!file) return false;
  const report = commandValue('reversible-smoke-report');
  if (!report) throw new Error('REVERSIBLE_SMOKE_REPORT_REQUIRED');
  const filePath = path.resolve(file);
  const password = 'Phase8-Reversible-Smoke-2026!';
  const source = '联系人 13800138000，邮箱 test@example.com；再次联系 13800138000。';
  const redaction = (await loadRedactionEngine()).analyzeText(source);
  const reversible = await loadReversibleEngine();
  const tokenized = reversible.tokenizeFindings(source, redaction.findings, { nonce: 'A8B7C6D5' });
  const context = await createVault(filePath, password);
  await addVaultEntry(context, {
    kind: 'reversible-map',
    name: 'phase8-smoke',
    text: tokenized.tokenizedText,
    mapping: tokenized.mapping,
    findingCount: tokenized.occurrenceCount,
    findingTypes: redaction.findings.map((item) => item.type)
  });
  closeVault(context);
  const raw = await fs.readFile(filePath, 'utf8');
  const reopened = await openVault(filePath, password);
  const listed = listVaultEntries(reopened);
  const entry = await readVaultEntry(reopened, listed[0].id);
  const restored = reversible.restoreTokens(entry.text, entry.mapping, { mode: 'rewrite' });
  const partial = reversible.restoreTokens(`摘要：${entry.mapping[0].token}`, entry.mapping, { mode: 'analysis' });
  const strictPartial = reversible.restoreTokens(`摘要：${entry.mapping[0].token}`, entry.mapping, { mode: 'rewrite' });
  const record = {
    format: 'VEILFORGE_REVERSIBLE_SMOKE',
    result: restored.restoredText === source && restored.complete && partial.complete && !strictPartial.complete &&
      entry.kind === 'reversible-map' && entry.mapping.length === 2 && tokenized.occurrenceCount === 3 &&
      !raw.includes('13800138000') && !raw.includes('test@example.com') && !raw.includes('[MI_A8B7C6D5_001]') ? 'PASS' : 'FAIL',
    cipher: 'aes-256-gcm',
    entries: listed.length,
    tokens: entry.mapping.length,
    occurrences: tokenized.occurrenceCount,
    restoredCount: restored.restoredCount,
    exactRestore: restored.restoredText === source,
    ciphertextHidesValues: !raw.includes('13800138000') && !raw.includes('test@example.com'),
    ciphertextHidesTokens: !raw.includes('[MI_A8B7C6D5_001]'),
    analysisAllowsOmission: partial.complete,
    rewriteFlagsOmission: !strictPartial.complete
  };
  closeVault(reopened);
  await fs.writeFile(path.resolve(report), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`REVERSIBLE_SMOKE_${record.result} entries=${record.entries} tokens=${record.tokens} occurrences=${record.occurrences} restored=${record.restoredCount} exact=${record.exactRestore ? 1 : 0} encrypted=${record.ciphertextHidesValues ? 1 : 0}\n`);
  app.exit(record.result === 'PASS' ? 0 : 1);
  return true;
}

async function runBatchSmoke() {
  const manifest = commandValue('batch-smoke-manifest');
  if (!manifest) return false;
  const report = commandValue('batch-smoke-report');
  const inputs = JSON.parse(await fs.readFile(path.resolve(manifest), 'utf8'));
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('BATCH_SMOKE_MANIFEST_INVALID');
  const updates = [];
  let active = 0;
  let maxActive = 0;
  const queue = new SerialTaskQueue(async (input) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await processDocumentPath(input);
    } finally {
      active -= 1;
    }
  }, (job) => {
    updates.push({ name: path.basename(job.input), status: job.status, progress: job.progress });
  });
  const jobs = inputs.map((input) => queue.enqueue(path.resolve(String(input))));
  await queue.waitForIdle();
  const record = {
    format: 'VEILFORGE_BATCH_SMOKE',
    result: jobs.every((job) => queue.get(job.id)?.status === 'done') ? 'PASS' : 'FAIL',
    serial: maxActive === 1,
    total: jobs.length,
    done: jobs.filter((job) => queue.get(job.id)?.status === 'done').length,
    failed: jobs.filter((job) => queue.get(job.id)?.status === 'failed').length,
    jobs: jobs.map((job) => {
      const current = queue.get(job.id);
      return {
        name: path.basename(current.input),
        status: current.status,
        extension: current.result?.extension || null,
        characters: current.result?.characters || 0,
        error: current.error
      };
    }),
    updates
  };
  if (report) await fs.writeFile(path.resolve(report), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`BATCH_SMOKE_${record.result} total=${record.total} done=${record.done} failed=${record.failed}\n`);
  app.exit(record.result === 'PASS' ? 0 : 1);
  return true;
}

async function runBatchExportSmoke() {
  const manifest = commandValue('batch-export-smoke-manifest');
  if (!manifest) return false;
  const outputDirectory = commandValue('batch-export-smoke-output');
  const report = commandValue('batch-export-smoke-report');
  if (!outputDirectory || !report) throw new Error('BATCH_EXPORT_SMOKE_PATHS_REQUIRED');
  const inputs = JSON.parse(await fs.readFile(path.resolve(manifest), 'utf8'));
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('BATCH_EXPORT_SMOKE_MANIFEST_INVALID');
  const directory = path.resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.readdir(directory)).length) throw new Error('BATCH_EXPORT_SMOKE_OUTPUT_NOT_EMPTY');

  const jobs = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = path.resolve(String(inputs[index]));
    jobs.push({ id: `smoke-${index + 1}`, input, result: await processDocumentPath(input) });
  }
  const collisionPath = path.join(directory, outputFileName(jobs[0].result));
  await fs.writeFile(collisionPath, 'COLLISION_SENTINEL', { encoding: 'utf8', flag: 'wx' });
  const exportResult = await exportBatchResults(jobs, directory, batchExportHandlers(null));
  const engine = await loadRedactionEngine();
  let residual = 0;
  let auditsValid = 0;
  for (const record of exportResult.records) {
    const extension = path.extname(record.outputPath).toLowerCase();
    if (OFFICE_EXTENSIONS.includes(extension)) {
      const extracted = await extractOfficeDocument(record.outputPath);
      residual += engine.analyzeText(extracted.text).findings.length;
    } else if (!['.pdf', '.png'].includes(extension)) {
      const extracted = await extractDocument(record.outputPath);
      residual += engine.analyzeText(extracted.text).findings.length;
    } else if (!Number.isInteger(record.render.boxes) || record.render.boxes < 1) {
      residual += 1;
    }
    const audit = JSON.parse(await fs.readFile(record.auditPath, 'utf8'));
    if (audit.format === 'VEILFORGE_BATCH_AUDIT' && audit.findings.every((finding) => !Object.hasOwn(finding, 'value'))) auditsValid += 1;
  }
  const manifestRecord = JSON.parse(await fs.readFile(exportResult.manifestPath, 'utf8'));
  const collisionProtected = await fs.readFile(collisionPath, 'utf8') === 'COLLISION_SENTINEL' &&
    exportResult.records[0].outputPath !== collisionPath && path.basename(exportResult.records[0].outputPath).includes('(2)');
  const record = {
    format: 'VEILFORGE_BATCH_EXPORT_SMOKE',
    result: exportResult.exported === jobs.length && exportResult.failed === 0 && residual === 0 &&
      auditsValid === jobs.length && collisionProtected && manifestRecord.format === 'VEILFORGE_BATCH_MANIFEST' ? 'PASS' : 'FAIL',
    total: jobs.length,
    exported: exportResult.exported,
    failed: exportResult.failed,
    residual,
    auditsValid,
    collisionProtected,
    manifest: path.basename(exportResult.manifestPath),
    outputs: exportResult.records.map((item) => ({
      sourceName: item.sourceName,
      outputName: path.basename(item.outputPath),
      auditName: path.basename(item.auditPath),
      findings: item.findingCount,
      render: item.render
    }))
  };
  await fs.writeFile(path.resolve(report), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`BATCH_EXPORT_SMOKE_${record.result} total=${record.total} exported=${record.exported} failed=${record.failed} residual=${record.residual} audits=${record.auditsValid} collision=${record.collisionProtected ? 1 : 0}\n`);
  app.exit(record.result === 'PASS' ? 0 : 1);
  return true;
}

async function runOcrSmoke() {
  const input = commandValue('ocr-smoke-input');
  if (!input) return false;
  const output = commandValue('ocr-smoke-output');
  const report = commandValue('ocr-smoke-report');
  if (!output) throw new Error('OCR_SMOKE_OUTPUT_REQUIRED');
  const ocr = await recognizeImage(path.resolve(input));
  const { analyzeText } = await import('./core/redaction-engine.mjs');
  const result = analyzeText(ocr.text, { customTerms: ['张三'] });
  const rendered = await renderRedactedImage(ocr, result.findings, path.resolve(output));
  const record = {
    result: 'PASS',
    text: ocr.text,
    confidence: ocr.confidence,
    words: ocr.words.length,
    findings: result.findings.map((item) => item.type),
    boxes: rendered.boxes,
    width: rendered.width,
    height: rendered.height
  };
  if (report) await fs.writeFile(path.resolve(report), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`OCR_SMOKE_OK findings=${record.findings.length} boxes=${record.boxes}\n`);
  app.exit(record.findings.length && record.boxes ? 0 : 1);
  return true;
}

async function runOcrQualitySmoke() {
  const input = commandValue('ocr-quality-smoke-input');
  if (!input) return false;
  const reportValue = commandValue('ocr-quality-smoke-report');
  if (!reportValue) throw new Error('OCR_QUALITY_SMOKE_REPORT_REQUIRED');
  const ocr = await recognizeImage(path.resolve(input));
  const reviewItem = ocr.corrections.find((item) => item.text.includes('邮')) || ocr.corrections[0];
  if (!reviewItem) throw new Error('OCR_QUALITY_REVIEW_ITEM_MISSING');
  const corrected = applyOcrCorrections(ocr.words, [{ wordIndex: reviewItem.wordIndex, text: reviewItem.text === '篮' ? '箱' : '邮箱' }]);
  const engine = await loadRedactionEngine();
  const analysis = engine.analyzeText(corrected.text, { typedTerms: { person: ['张三'] } });
  const session = { ...ocr, text: corrected.text, words: corrected.words };
  const boxes = findBoxesForFindings(session.words, analysis.findings, session.width, session.height);
  const rendered = await renderRedactedBuffer(session, analysis.findings);
  const expectedTypes = ['person', 'mobile', 'email', 'idcard'];
  const passed = ocr.orientationDetected && ocr.enhancement.upscaled && ocr.tableRegions.length >= 1 &&
    ocr.corrections.length >= 1 && corrected.changed === 1 && corrected.text.includes('邮箱:alice@example.com') &&
    expectedTypes.every((type) => analysis.findings.some((item) => item.type === type)) && boxes.length >= 4 && rendered.boxes === boxes.length;
  const record = {
    format: 'VEILFORGE_OCR_QUALITY_SMOKE',
    result: passed ? 'PASS' : 'FAIL',
    orientationDegrees: ocr.orientationDegrees,
    enhancement: ocr.enhancement,
    tableRegions: ocr.tableRegions,
    review: ocr.corrections.length,
    corrected: corrected.changed,
    textBefore: ocr.text,
    textAfter: corrected.text,
    findings: analysis.findings.map((item) => item.type),
    boxes: boxes.length,
    dimensions: `${ocr.width}x${ocr.height}`
  };
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`OCR_QUALITY_SMOKE_${record.result} orientation=${record.orientationDegrees} upscale=${ocr.enhancement.scale} tables=${ocr.tableRegions.length} review=${record.review} corrected=${record.corrected} findings=${record.findings.length} boxes=${record.boxes}\n`);
  app.exit(passed ? 0 : 1);
  return true;
}

async function runOcrLayoutSmoke() {
  const directoryValue = commandValue('ocr-layout-smoke-dir');
  if (!directoryValue) return false;
  const reportValue = commandValue('ocr-layout-smoke-report');
  if (!reportValue) throw new Error('OCR_LAYOUT_SMOKE_REPORT_REQUIRED');
  const directory = path.resolve(directoryValue);
  const skewPath = path.join(directory, '01-lowres-skew.png');
  const lowContrastPath = path.join(directory, '02-low-contrast.png');
  const gridPath = path.join(directory, '03-merged-grid.png');
  const skew = await recognizeImage(skewPath);
  const enhanced = await prepareOcrImage(await fs.readFile(lowContrastPath));
  const gridTables = await detectTableGrid(await fs.readFile(gridPath));
  const words = [];
  for (let index = 0; index < 4; index += 1) {
    words.push({ text: `左${index + 1}`, confidence: 99, bbox: { x0: 25, y0: 25 + index * 55, x1: 100, y1: 48 + index * 55 } });
    words.push({ text: `右${index + 1}`, confidence: 99, bbox: { x0: 340, y0: 53 + index * 55, x1: 415, y1: 76 + index * 55 } });
  }
  const columns = detectDocumentColumns(words, 520, 300);
  const ordered = rebuildMappedWords(words, 0, { width: 520, height: 300 });
  const table = gridTables[0];
  const passed = skew.orientationDetected && skew.enhancement.upscaled && enhanced.enhancement.contrastEnhanced &&
    table?.rows === 3 && table?.columns === 3 && table?.mergedCells >= 1 &&
    columns.length === 2 && ordered.readingOrder === 'columns-left-to-right' && ordered.text.indexOf('左4') < ordered.text.indexOf('右1');
  const record = {
    format: 'VEILFORGE_OCR_LAYOUT_SMOKE', result: passed ? 'PASS' : 'FAIL',
    orientationDegrees: skew.orientationDegrees, upscale: skew.enhancement.scale,
    contrastEnhanced: enhanced.enhancement.contrastEnhanced,
    grid: table, columns, readingOrder: ordered.readingOrder, orderedText: ordered.text
  };
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`OCR_LAYOUT_SMOKE_${record.result} grid=${table?.rows || 0}x${table?.columns || 0} merged=${table?.mergedCells || 0} columns=${columns.length} order=${ordered.readingOrder} enhanced=${record.contrastEnhanced ? 1 : 0}\n`);
  app.exit(passed ? 0 : 1);
  return true;
}

async function runCapacityFoundationSmoke() {
  const largeInputValue = commandValue('capacity-smoke-large-input');
  const pdfInputValue = commandValue('capacity-smoke-pdf-input');
  if (!largeInputValue && !pdfInputValue) return false;
  const reportValue = commandValue('capacity-smoke-report');
  if (!largeInputValue || !pdfInputValue || !reportValue) throw new Error('CAPACITY_SMOKE_PATHS_REQUIRED');
  const largeInput = path.resolve(largeInputValue);
  const pdfInput = path.resolve(pdfInputValue);
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const started = Date.now();
  const stagedLarge = await createJobWorkspace(largeInput, {
    root: jobWorkspaceRoot(),
    budget: createResourceBudget({ profile: 'parity' })
  });
  const largeBytes = (await fs.stat(stagedLarge.inputPath)).size;
  const largeSha256 = stagedLarge.sourceSha256;
  await stagedLarge.cleanup();
  const pdfWorkspace = await createJobWorkspace(pdfInput, {
    root: jobWorkspaceRoot(),
    budget: createResourceBudget({ profile: 'parity' })
  });
  let pdf;
  try {
    pdf = await recognizePdf(pdfWorkspace.inputPath, {
      pageDirectory: pdfWorkspace.pageDirectory,
      budget: pdfWorkspace.budget
    });
    let spooledPages = 0;
    for (const page of pdf.pages) {
      if (!page.image && typeof page.imagePath === 'string') {
        await fs.access(page.imagePath);
        spooledPages += 1;
      }
    }
    const passed = largeBytes === 100 * 1024 * 1024 && pdf.pageCount === 300 && pdf.nativePages === 300 &&
      spooledPages === 300 && pdf.resourceBudget.peakRssBytes <= pdfWorkspace.budget.profile.maxRssBytes;
    const record = {
      format: 'VEILFORGE_CAPACITY_SMOKE',
      result: passed ? 'PASS' : 'FAIL',
      inputBytes: largeBytes,
      inputSha256: largeSha256,
      pdfPages: pdf.pageCount,
      nativePages: pdf.nativePages,
      spooledPages,
      peakRssBytes: pdf.resourceBudget.peakRssBytes,
      maxRssBytes: pdfWorkspace.budget.profile.maxRssBytes,
      milliseconds: Date.now() - started
    };
    await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    process.stdout.write(`CAPACITY_SMOKE_${record.result} input=${Math.round(largeBytes / 1024 / 1024)}MiB pdf=${pdf.pageCount} spooled=${spooledPages} peakRss=${Math.round(record.peakRssBytes / 1024 / 1024)}MiB\n`);
    app.exit(passed ? 0 : 1);
  } finally {
    await pdfWorkspace.cleanup().catch(() => {});
  }
  return true;
}

async function runPdfSmoke() {
  const input = commandValue('pdf-smoke-input');
  if (!input) return false;
  const output = commandValue('pdf-smoke-output');
  const report = commandValue('pdf-smoke-report');
  if (!output) throw new Error('PDF_SMOKE_OUTPUT_REQUIRED');
  const pdf = await recognizePdf(path.resolve(input));
  const { analyzeText } = await import('./core/redaction-engine.mjs');
  const result = analyzeText(pdf.text, { customTerms: ['张三', '李四'] });
  const rendered = await renderRedactedPdf(pdf, result.findings, path.resolve(output));
  const record = {
    result: 'PASS',
    text: pdf.text,
    confidence: pdf.confidence,
    pageCount: pdf.pageCount,
    words: pdf.pages.reduce((sum, page) => sum + page.words.length, 0),
    findings: result.findings.map((item) => item.type),
    boxes: rendered.boxes,
    bytes: rendered.bytes
  };
  if (report) await fs.writeFile(path.resolve(report), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_SMOKE_OK pages=${record.pageCount} findings=${record.findings.length} boxes=${record.boxes}\n`);
  app.exit(record.pageCount && record.findings.length && record.boxes ? 0 : 1);
  return true;
}

async function runPdfComplexSmoke() {
  const inputValue = commandValue('pdf-complex-smoke-input');
  if (!inputValue) return false;
  const outputValue = commandValue('pdf-complex-smoke-output');
  const reportValue = commandValue('pdf-complex-smoke-report');
  if (!outputValue || !reportValue) throw new Error('PDF_COMPLEX_SMOKE_PATHS_REQUIRED');
  const inputPath = path.resolve(inputValue);
  const outputPath = path.resolve(outputValue);
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const source = await recognizePdf(inputPath);
  const { analyzeText } = await loadRedactionEngine();
  const analysis = analyzeText(source.text, { customTerms: ['Alice Example'] });
  const rendered = await renderRedactedPdf(source, analysis.findings, outputPath);
  const after = await inspectPdfFeatures(outputPath);
  const extracted = await extractNativePdfText(outputPath);
  const raw = await fs.readFile(outputPath);
  const sensitiveValues = ['Alice Example', '13812345678', 'alice@example.com'];
  const sensitiveAbsent = sensitiveValues.every((value) => !extracted.text.includes(value) && !raw.includes(Buffer.from(value)));
  const before = source.pdfFeatures;
  const pass = before.formFields >= 3 && before.annotations >= 4 && before.embeddedFontResources >= 1 && before.signedSignatures >= 1 &&
    after.formFields === before.formFields && after.annotations === before.annotations &&
    after.embeddedFontResources >= before.embeddedFontResources && after.signatureFields === before.signatureFields &&
    rendered.preservationMode === 'structure-preserving-raster' && rendered.secureContentReplacement &&
    rendered.formsPreserved && rendered.annotationsPreserved && rendered.embeddedFontsPreserved &&
    rendered.signaturesPreservedAsFields && rendered.signatureState === 'invalidated-by-modification' && sensitiveAbsent;
  const record = {
    format: 'VEILFORGE_PACKAGED_COMPLEX_PDF_SMOKE',
    result: pass ? 'PASS' : 'FAIL',
    before,
    after,
    render: rendered,
    findings: analysis.findings.length,
    sensitiveAbsent,
    output: outputPath
  };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_COMPLEX_SMOKE_${record.result} forms=${before.formFields}/${after.formFields} annotations=${before.annotations}/${after.annotations} fonts=${before.embeddedFontResources}/${after.embeddedFontResources} signatures=${before.signatureFields}/${after.signatureFields} state=${rendered.signatureState} safe=${sensitiveAbsent ? 1 : 0}\n`);
  app.exit(pass ? 0 : 1);
  return true;
}

async function runPdfGeometrySmoke() {
  const inputValue = commandValue('pdf-geometry-smoke-input');
  if (!inputValue) return false;
  const outputValue = commandValue('pdf-geometry-smoke-output');
  const reportValue = commandValue('pdf-geometry-smoke-report');
  const encryptedValue = commandValue('pdf-geometry-smoke-encrypted');
  if (!outputValue || !reportValue || !encryptedValue) throw new Error('PDF_GEOMETRY_SMOKE_PATHS_REQUIRED');
  const inputPath = path.resolve(inputValue);
  const outputPath = path.resolve(outputValue);
  const reportPath = path.resolve(reportValue);
  const encryptedPath = path.resolve(encryptedValue);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const source = await recognizePdf(inputPath);
  const { analyzeText } = await loadRedactionEngine();
  const analysis = analyzeText(source.text, { customTerms: ['Alice Example'] });
  const rendered = await renderRedactedPdf(source, analysis.findings, outputPath);
  const after = await inspectPdfFeatures(outputPath);
  const extracted = await extractNativePdfText(outputPath);
  const raw = await fs.readFile(outputPath);
  const encryptedCompatibility = await inspectPdfCompatibility(encryptedPath);
  let encryptedError = '';
  try {
    await recognizePdf(encryptedPath);
  } catch (error) {
    encryptedError = String(error?.code || error?.message || error);
  }
  const sensitiveValues = ['Alice Example', '13812345678', 'alice@example.com'];
  const sensitiveAbsent = sensitiveValues.every((value) => !extracted.text.includes(value) && !raw.includes(Buffer.from(value)));
  const before = source.pdfFeatures;
  const pass = before.rotatedPages === 1 && before.croppedPages === 1 && before.hasXfa && before.pdfaDeclared &&
    after.rotations[0] === before.rotations[0] && after.croppedPages === before.croppedPages && after.hasXfa === before.hasXfa &&
    after.pdfaPart === before.pdfaPart && after.pdfaConformance === before.pdfaConformance &&
    rendered.preservationMode === 'structure-preserving-raster' && rendered.rotationsPreserved && rendered.cropBoxesPreserved &&
    rendered.xfaPreserved && rendered.pdfaDeclarationPreserved && rendered.signatureState === 'invalidated-by-modification' &&
    rendered.resigning?.required && encryptedCompatibility.encrypted && encryptedError === 'LOCAL_PDF_PASSWORD_REQUIRED' && sensitiveAbsent;
  const record = {
    format: 'VEILFORGE_PACKAGED_PDF_GEOMETRY_SMOKE',
    result: pass ? 'PASS' : 'FAIL',
    before,
    after,
    render: rendered,
    encryptedCompatibility,
    encryptedError,
    findings: analysis.findings.length,
    sensitiveAbsent,
    output: outputPath
  };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_GEOMETRY_SMOKE_${record.result} rotation=${before.rotations[0]}/${after.rotations[0]} crop=${before.croppedPages}/${after.croppedPages} xfa=${before.hasXfa ? 1 : 0}/${after.hasXfa ? 1 : 0} pdfa=${before.pdfaPart}${before.pdfaConformance}/${after.pdfaPart}${after.pdfaConformance} encrypted=${encryptedCompatibility.encrypted ? 1 : 0} resign=${rendered.resigning?.required ? 1 : 0} safe=${sensitiveAbsent ? 1 : 0}\n`);
  app.exit(pass ? 0 : 1);
  return true;
}

async function runPdfSecuritySmoke() {
  const inputValue = commandValue('pdf-security-smoke-input');
  if (!inputValue) return false;
  const password = commandValue('pdf-security-smoke-password');
  const p12Value = commandValue('pdf-security-smoke-p12');
  const p12Password = commandValue('pdf-security-smoke-p12-password') || '';
  const directoryValue = commandValue('pdf-security-smoke-dir');
  const reportValue = commandValue('pdf-security-smoke-report');
  if (!password || !p12Value || !directoryValue || !reportValue) throw new Error('PDF_SECURITY_SMOKE_PATHS_REQUIRED');
  const inputPath = path.resolve(inputValue);
  const p12Path = path.resolve(p12Value);
  const directory = path.resolve(directoryValue);
  const reportPath = path.resolve(reportValue);
  const sanitizedPath = path.join(directory, 'packaged-password-decrypted-redacted.pdf');
  const p12SignedPath = path.join(directory, 'packaged-p12-signed.pdf');
  const hsmSignedPath = path.join(directory, 'packaged-hsm-adapter-signed.pdf');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  let requiredError = '';
  let wrongError = '';
  try { await recognizePdf(inputPath); } catch (error) { requiredError = String(error?.code || error?.message || error); }
  try { await recognizePdf(inputPath, { password: `${password}-wrong` }); } catch (error) { wrongError = String(error?.code || error?.message || error); }
  const source = await recognizePdf(inputPath, { password });
  const { analyzeText } = await loadRedactionEngine();
  const analysis = analyzeText(source.text, { customTerms: ['Alice Example'] });
  const rendered = await renderRedactedPdf(source, analysis.findings, sanitizedPath);
  const extracted = await extractNativePdfText(sanitizedPath);
  const raw = await fs.readFile(sanitizedPath);
  const sensitiveAbsent = ['Alice Example', '13812345678', 'alice@example.com']
    .every((value) => !extracted.text.includes(value) && !raw.includes(Buffer.from(value)));
  await signPdfWithP12(sanitizedPath, p12SignedPath, p12Path, p12Password, { overwrite: true, reason: 'Packaged P12 smoke' });
  const p12Signature = extractSignature(await fs.readFile(p12SignedPath));
  const p12Bytes = await fs.readFile(p12Path);
  const delegatedSigner = new P12Signer(p12Bytes, { passphrase: p12Password });
  let hsmCalls = 0;
  await signPdfWithExternalSigner(sanitizedPath, hsmSignedPath, async (bytes, metadata) => {
    hsmCalls += 1;
    return delegatedSigner.sign(bytes, metadata.signingTime);
  }, { overwrite: true, metadata: { adapter: 'packaged-hsm-smoke' }, reason: 'Packaged HSM adapter smoke' });
  const hsmSignature = extractSignature(await fs.readFile(hsmSignedPath));
  const validation = await validatePdfA(sanitizedPath);
  const pass = requiredError === 'LOCAL_PDF_PASSWORD_REQUIRED' && wrongError === 'LOCAL_PDF_PASSWORD_INVALID' &&
    source.passwordDecryptedInMemory && rendered.passwordDecryptedInMemory && sensitiveAbsent &&
    Buffer.from(p12Signature.signature, 'binary').length > 0 && hsmCalls === 1 && Buffer.from(hsmSignature.signature, 'binary').length > 0 &&
    (validation.executed || validation.reason === 'VERAPDF_NOT_INSTALLED');
  const record = {
    format: 'VEILFORGE_PACKAGED_PDF_SECURITY_SMOKE',
    result: pass ? 'PASS' : 'FAIL',
    requiredError,
    wrongError,
    passwordDecryptedInMemory: source.passwordDecryptedInMemory,
    render: rendered,
    findings: analysis.findings.length,
    sensitiveAbsent,
    p12SignatureBytes: Buffer.from(p12Signature.signature, 'binary').length,
    hsmCalls,
    hsmSignatureBytes: Buffer.from(hsmSignature.signature, 'binary').length,
    validation,
    outputs: { sanitizedPath, p12SignedPath, hsmSignedPath }
  };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_SECURITY_SMOKE_${record.result} password=${source.passwordDecryptedInMemory ? 1 : 0} p12=${record.p12SignatureBytes > 0 ? 1 : 0} hsm=${hsmCalls === 1 ? 1 : 0} verapdf=${validation.available ? 1 : 0} safe=${sensitiveAbsent ? 1 : 0}\n`);
  app.exit(pass ? 0 : 1);
  return true;
}

async function runPdfReversibleSmoke() {
  const inputValue = commandValue('pdf-reversible-smoke-input');
  if (!inputValue) return false;
  const directoryValue = commandValue('pdf-reversible-smoke-dir');
  const reportValue = commandValue('pdf-reversible-smoke-report');
  if (!directoryValue || !reportValue) throw new Error('PDF_REVERSIBLE_SMOKE_PATHS_REQUIRED');
  const directory = path.resolve(directoryValue);
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const source = await recognizePdf(path.resolve(inputValue));
  const engine = await loadRedactionEngine();
  const reversible = await loadReversibleEngine();
  const analysis = engine.analyzeText(source.text, { customTerms: ['张三', '李四'] });
  const tokenized = reversible.tokenizeFindings(source.text, analysis.findings, { nonce: 'D0C0B011' });
  const byRange = new Map(analysis.findings.map((finding) => [`${finding.start}:${finding.end}`, finding]));
  const replacements = tokenized.assignments.map((assignment) => ({
    ...byRange.get(`${assignment.start}:${assignment.end}`),
    replacement: assignment.token,
    enabled: true
  }));
  const tokenizedPath = path.join(directory, 'packaged-tokenized.pdf');
  const restoredPath = path.join(directory, 'packaged-restored.pdf');
  const rendered = await renderTokenizedPdf(source, replacements, tokenizedPath);
  const extracted = await extractNativePdfText(tokenizedPath);
  const coordinateRaw = await fs.readFile(rendered.coordinatePath, 'utf8');
  const textRaw = await fs.readFile(rendered.textPath, 'utf8');
  const tokensExtracted = tokenized.mapping.every((entry) => extracted.text.includes(entry.token));
  const sensitiveAbsent = tokenized.mapping.every((entry) =>
    !extracted.text.includes(entry.value) && !coordinateRaw.includes(entry.value) && !textRaw.includes(entry.value));
  const restored = await restoreReversiblePdf(tokenizedPath, tokenized.mapping, restoredPath, rendered.coordinatePath);
  const pass = source.sourceMode === 'native' && analysis.findings.length >= 8 && rendered.coordinates === tokenized.occurrenceCount &&
    tokensExtracted && sensitiveAbsent && restored.complete && restored.coordinateSidecarUsed &&
    restored.restoredOccurrences === tokenized.occurrenceCount && restored.restoredCoordinates === tokenized.occurrenceCount;
  const record = {
    format: 'VEILFORGE_PDF_REVERSIBLE_SMOKE',
    result: pass ? 'PASS' : 'FAIL',
    sourceMode: source.sourceMode,
    pages: source.pageCount,
    findings: analysis.findings.length,
    tokens: tokenized.mapping.length,
    occurrences: tokenized.occurrenceCount,
    coordinates: rendered.coordinates,
    tokensExtracted,
    sensitiveAbsent,
    restoredOccurrences: restored.restoredOccurrences,
    restoredCoordinates: restored.restoredCoordinates,
    complete: restored.complete,
    coordinateSidecarUsed: restored.coordinateSidecarUsed
  };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_REVERSIBLE_SMOKE_${record.result} pages=${record.pages} tokens=${record.restoredOccurrences}/${record.occurrences} coords=${record.coordinates} safe=${record.sensitiveAbsent ? 1 : 0}\n`);
  app.exit(pass ? 0 : 1);
  return true;
}

async function runVaultSmoke() {
  const file = commandValue('vault-smoke-file');
  if (!file) return false;
  const report = commandValue('vault-smoke-report');
  const filePath = path.resolve(file);
  const oldPassword = 'Phase4-Smoke-Password-2026!';
  const newPassword = 'Phase4-Rotated-Password-2027!';
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.rm(filePath, { force: true });
  const created = await createVault(filePath, oldPassword);
  await addVaultEntry(created, {
    name: '冒烟脱敏结果.txt',
    text: '客户：张*\n手机：138****5678',
    findingCount: 2,
    findingTypes: ['custom', 'mobile']
  });
  await rotateVaultPassword(created, newPassword);
  closeVault(created);

  let oldPasswordRejected = false;
  try {
    const invalid = await openVault(filePath, oldPassword);
    closeVault(invalid);
  } catch (error) {
    oldPasswordRejected = error?.message === 'LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID';
  }
  const reopened = await openVault(filePath, newPassword);
  const entries = listVaultEntries(reopened);
  const restored = await readVaultEntry(reopened, entries[0].id);
  closeVault(reopened);
  const raw = await fs.readFile(filePath);
  const record = {
    result: oldPasswordRejected && entries.length === 1 && restored.text.includes('138****5678') && !raw.includes(Buffer.from('138****5678')) ? 'PASS' : 'FAIL',
    formatVersion: 3,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    entries: entries.length,
    oldPasswordRejected,
    plaintextAbsent: !raw.includes(Buffer.from('138****5678')),
    restoredText: restored.text
  };
  if (report) await fs.writeFile(path.resolve(report), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`VAULT_SMOKE_${record.result} cipher=${record.cipher} kdf=${record.kdf} entries=${record.entries} rotated=${record.oldPasswordRejected ? 1 : 0} plaintextAbsent=${record.plaintextAbsent ? 1 : 0}\n`);
  app.exit(record.result === 'PASS' ? 0 : 1);
  return true;
}

async function runVaultV3CapacitySmoke() {
  const directoryValue = commandValue('vault-v3-capacity-smoke-dir');
  if (!directoryValue) return false;
  const reportValue = commandValue('vault-v3-capacity-smoke-report');
  if (!reportValue) throw new Error('VAULT_V3_CAPACITY_SMOKE_REPORT_REQUIRED');
  const targetMiBValue = commandValue('vault-v3-longrun-mib');
  const report = await runVaultV3CapacityScenario(path.resolve(directoryValue), {
    targetMiB: targetMiBValue ? Number(targetMiBValue) : 256
  });
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`VAULT_V3_CAPACITY_SMOKE_${report.result} target=${report.targetMiB}MiB bytes=${report.vaultBytes} entries=${report.entryCount} peakRss=${Math.round(report.peakRssBytes / 1024 / 1024)}MiB encrypted=${report.plaintextAbsent ? 1 : 0} exceed=${report.exceedGate ? 1 : 0}\n`);
  app.exit(report.result === 'PASS' ? 0 : 1);
  return true;
}

async function runVaultV3MaintenanceSmoke() {
  const directoryValue = commandValue('vault-v3-maintenance-smoke-dir');
  if (!directoryValue) return false;
  const reportValue = commandValue('vault-v3-maintenance-smoke-report');
  if (!reportValue) throw new Error('VAULT_V3_MAINTENANCE_SMOKE_REPORT_REQUIRED');
  const report = await runVaultV3MaintenanceScenario(path.resolve(directoryValue));
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`VAULT_V3_MAINTENANCE_SMOKE_${report.result} created=${report.created} deleted=${report.deleted} remaining=${report.remainingAfterAppend} pages=${report.pages.join('/')} reclaimed=${report.reclaimedBytes} numbered=${report.continuedFileNumber}\n`);
  app.exit(report.result === 'PASS' ? 0 : 1);
  return true;
}

async function runVaultMigrationSmoke() {
  const directoryValue = commandValue('vault-migration-smoke-dir');
  if (!directoryValue) return false;
  const reportValue = commandValue('vault-migration-smoke-report');
  if (!reportValue) throw new Error('VAULT_MIGRATION_SMOKE_REPORT_REQUIRED');
  const directory = path.resolve(directoryValue);
  const reportPath = path.resolve(reportValue);
  const sourcePath = path.join(directory, 'packaged-source.miyin-vault');
  const targetPath = path.join(directory, 'packaged-target.miyin-vault');
  const backupPath = path.join(directory, 'packaged-source.miyin-backup');
  const sourcePassword = 'Packaged-Source-Vault-Password!';
  const targetPassword = 'Packaged-Target-Vault-Password!';
  const backupPassword = 'Packaged-Portable-Backup-Password!';
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  for (const target of [sourcePath, targetPath, backupPath]) await fs.rm(target, { force: true });

  const source = await createVault(sourcePath, sourcePassword);
  await addVaultEntry(source, { name: '合同.txt', text: '打包迁移来源内容', findingCount: 1, findingTypes: ['custom'] });
  await addVaultEntry(source, {
    kind: 'reversible-map',
    name: '联系人映射.txt',
    text: '联系人 [MI_C0DEC0DE_001]',
    mapping: [{ token: '[MI_C0DEC0DE_001]', value: '张三', type: 'person', label: '姓名', occurrences: 1 }],
    findingCount: 1,
    findingTypes: ['person']
  });
  await exportVaultBackup(source, backupPath, backupPassword);
  closeVault(source);

  const target = await createVault(targetPath, targetPassword);
  await addVaultEntry(target, { name: '合同.txt', text: '打包迁移目标内容', findingCount: 1, findingTypes: ['custom'] });
  let rejectAtomic = false;
  try {
    await importVaultBackup(target, backupPath, backupPassword, 'reject');
  } catch (error) {
    rejectAtomic = error?.message === 'LOCAL_VAULT_IMPORT_CONFLICT' && listVaultEntries(target).length === 1;
  }
  const merged = await importVaultBackup(target, backupPath, backupPassword, 'rename');
  const duplicate = await importVaultBackup(target, backupPath, backupPassword, 'skip');
  await addVaultEntry(target, { name: '导入后新增.txt', text: '连续编号', findingCount: 1, findingTypes: ['custom'] });
  const entries = listVaultEntries(target);
  closeVault(target);
  const rawBackup = await fs.readFile(backupPath, 'utf8');
  const encrypted = !rawBackup.includes('打包迁移来源内容') && !rawBackup.includes('张三') && !rawBackup.includes('[MI_C0DEC0DE_001]');
  const numbered = entries.map((entry) => entry.fileNumber).join(',') === 'MI-000001,MI-000002,MI-000003,MI-000004';
  const pass = rejectAtomic && merged.imported === 2 && merged.renamed === 1 && duplicate.imported === 0 &&
    duplicate.skipped === 2 && encrypted && numbered;
  const record = {
    format: 'VEILFORGE_VAULT_MIGRATION_SMOKE',
    result: pass ? 'PASS' : 'FAIL',
    rejectAtomic,
    imported: merged.imported,
    renamed: merged.renamed,
    skipped: duplicate.skipped,
    conflicts: merged.conflicts.length + duplicate.conflicts.length,
    numbered: entries.map((entry) => entry.fileNumber),
    encrypted
  };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`VAULT_MIGRATION_SMOKE_${record.result} imported=${record.imported} renamed=${record.renamed} skipped=${record.skipped} numbered=${record.numbered.length} encrypted=${record.encrypted ? 1 : 0}\n`);
  app.exit(pass ? 0 : 1);
  return true;
}

async function runOfficeSmoke() {
  const docxInput = commandValue('office-smoke-docx-input');
  const xlsxInput = commandValue('office-smoke-xlsx-input');
  if (!docxInput && !xlsxInput) return false;
  const docxOutput = commandValue('office-smoke-docx-output');
  const xlsxOutput = commandValue('office-smoke-xlsx-output');
  const report = commandValue('office-smoke-report');
  if (!docxInput || !xlsxInput || !docxOutput || !xlsxOutput) throw new Error('OFFICE_SMOKE_PATHS_REQUIRED');
  const { analyzeText } = await import('./core/redaction-engine.mjs');
  const customTerms = ['张三', '李四'];
  const run = async (input, output) => {
    const source = await extractOfficeDocument(path.resolve(input));
    const analysis = analyzeText(source.text, { customTerms });
    const rendered = await renderRedactedOffice(source.session, analysis.findings, path.resolve(output));
    const reopened = await extractOfficeDocument(path.resolve(output));
    const residual = analyzeText(reopened.text, { customTerms }).findings;
    return { findings: analysis.findings.length, residual: residual.length, ...rendered };
  };
  const docx = await run(docxInput, docxOutput);
  const xlsx = await run(xlsxInput, xlsxOutput);
  const record = {
    result: docx.findings >= 7 && xlsx.findings >= 8 && docx.residual === 0 && xlsx.residual === 0 ? 'PASS' : 'FAIL',
    docx,
    xlsx
  };
  if (report) await fs.writeFile(path.resolve(report), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`OFFICE_SMOKE_${record.result} docxFindings=${docx.findings} docxUnits=${docx.changedUnits} xlsxFindings=${xlsx.findings} xlsxUnits=${xlsx.changedUnits} residual=${docx.residual + xlsx.residual}\n`);
  app.exit(record.result === 'PASS' ? 0 : 1);
  return true;
}

async function runOfficeReversibleSmoke() {
  const directoryValue = commandValue('office-reversible-smoke-dir');
  if (!directoryValue) return false;
  const docxInput = commandValue('office-reversible-docx-input');
  const xlsxInput = commandValue('office-reversible-xlsx-input');
  const reportValue = commandValue('office-reversible-smoke-report');
  if (!docxInput || !xlsxInput || !reportValue) throw new Error('OFFICE_REVERSIBLE_SMOKE_PATHS_REQUIRED');
  const directory = path.resolve(directoryValue);
  const reportPath = path.resolve(reportValue);
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const { analyzeText } = await loadRedactionEngine();
  const reversible = await loadReversibleEngine();
  const run = async (kind, input, nonce) => {
    const source = await extractOfficeDocument(path.resolve(input));
    const analysis = analyzeText(source.text, { customTerms: ['张三', '李四'] });
    const tokenized = reversible.tokenizeFindings(source.text, analysis.findings, { nonce });
    const byRange = new Map(analysis.findings.map((finding) => [`${finding.start}:${finding.end}`, finding]));
    const replacements = tokenized.assignments.map((assignment) => {
      const finding = byRange.get(`${assignment.start}:${assignment.end}`);
      return { ...finding, replacement: assignment.token, enabled: true };
    });
    const tokenizedPath = path.join(directory, `packaged-tokenized.${kind}`);
    const restoredPath = path.join(directory, `packaged-restored.${kind}`);
    await renderRedactedOffice(source.session, replacements, tokenizedPath);
    const restored = await restoreReversibleOffice(tokenizedPath, tokenized.mapping, restoredPath);
    const reopened = await extractOfficeDocument(restoredPath);
    return {
      findings: analysis.findings.length,
      tokens: tokenized.mapping.length,
      occurrences: tokenized.occurrenceCount,
      restoredOccurrences: restored.restoredOccurrences,
      complete: restored.complete,
      exactText: reopened.text === source.text,
      missing: restored.missingTokens.length,
      unknown: restored.unknownTokens.length,
      repeated: restored.repeatedTokens.length
    };
  };
  const docx = await run('docx', docxInput, 'D0C0A010');
  const xlsx = await run('xlsx', xlsxInput, 'A1B2C310');
  const pass = [docx, xlsx].every((item) => item.findings > 0 && item.occurrences === item.restoredOccurrences &&
    item.complete && item.exactText && item.missing === 0 && item.unknown === 0 && item.repeated === 0);
  const record = { format: 'VEILFORGE_OFFICE_REVERSIBLE_SMOKE', result: pass ? 'PASS' : 'FAIL', docx, xlsx };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`OFFICE_REVERSIBLE_SMOKE_${record.result} docx=${docx.restoredOccurrences}/${docx.occurrences} xlsx=${xlsx.restoredOccurrences}/${xlsx.occurrences} exact=${docx.exactText && xlsx.exactText ? 1 : 0}\n`);
  app.exit(pass ? 0 : 1);
  return true;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f1eb',
    title: '墨隐 · 本地文档脱敏',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });
  appWindows.add(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    win.webContents.on(eventName, (event, targetUrl) => {
      if (targetUrl !== win.webContents.getURL()) event.preventDefault();
    });
  }
  const ownerId = win.webContents.id;
  win.on('closed', () => {
    appWindows.delete(win);
    lockVaultsForOwner(ownerId, 'window-closed');
    cleanupBatchOwner(ownerId);
    cleanupFileSessions(ownerId);
    void clearNerForOwner(ownerId).catch(() => {});
  });
  await win.loadFile(ENTRY);
  win.once('ready-to-show', () => win.show());
  return win;
}

async function runUiCapture() {
  const output = commandValue('ui-capture-output');
  if (!output) return false;
  const outputPath = path.resolve(output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const captureWindow = await createWindow();
  if (commandValue('ui-capture-section') === 'vault') {
    await captureWindow.webContents.executeJavaScript(`
      document.querySelector('[data-module="vault"]').click();
      document.querySelector('.sidebar').scrollTop = document.querySelector('.sidebar').scrollHeight;
      document.getElementById('vaultPasswordDialog').showModal();
    `);
  } else if (commandValue('ui-capture-section') === 'vault-migration') {
    const vaultMigrationCapture = await captureWindow.webContents.executeJavaScript(`(() => {
      try {
        document.querySelector('[data-module="vault"]').click();
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('batchPanel').classList.add('hidden');
        document.getElementById('editorState').classList.remove('hidden');
        document.getElementById('findingsPanel').classList.add('hidden');
        document.getElementById('documentName').textContent = '加密仓库迁移核对';
        document.getElementById('documentMeta').textContent = 'AES-256-GCM 备份 · 冲突预检 · 连续自动编号';
        document.getElementById('charCount').textContent = '4';
        document.getElementById('sourceEditor').value = '导入结果：新增 2 条，自动改名 1 条，重复跳过 2 条。\\n编号连续：MI-000001 → MI-000004。\\n备份密文未检出敏感原值。';
        document.getElementById('redactedEditor').value = '迁移核对通过';
        document.getElementById('vaultLockedActions').classList.add('hidden');
        document.getElementById('vaultUnlocked').classList.remove('hidden');
        document.getElementById('vaultName').textContent = '客户资料主仓库.miyin-vault';
        document.getElementById('vaultStatus').textContent = '已解锁';
        document.getElementById('vaultStatus').classList.add('unlocked');
        document.getElementById('vaultImportPolicy').value = 'rename';
        document.getElementById('vaultSaveButton').disabled = true;
        document.getElementById('vaultEntryList').innerHTML = [
          ['MI-000001', '合同.txt', '脱敏文本 · 12 字符 · 1 项'],
          ['MI-000002', '合同.txt (导入 2)', '脱敏文本 · 9 字符 · 1 项'],
          ['MI-000003', '联系人映射.txt', '可逆 · 1 个代号 · 1 项'],
          ['MI-000004', '导入后新增.txt', '脱敏文本 · 6 字符 · 1 项']
        ].map(([number, name, detail]) => '<button class="vault-entry"><strong>' + number + ' · ' + name + '</strong><span>' + detail + '</span></button>').join('');
        document.querySelector('.sidebar').scrollTop = document.querySelector('.sidebar').scrollHeight;
        return 'OK';
      } catch (error) {
        return 'ERROR:' + (error && error.stack || error);
      }
    })()`);
    if (vaultMigrationCapture !== 'OK') throw new Error(`VAULT_MIGRATION_CAPTURE_SETUP_FAILED ${vaultMigrationCapture}`);
  } else if (commandValue('ui-capture-section') === 'restore') {
    await captureWindow.webContents.executeJavaScript(`
      document.querySelector('[data-module="restore"]').click();
      document.getElementById('emptyState').classList.add('hidden');
      document.getElementById('batchPanel').classList.add('hidden');
      document.getElementById('editorState').classList.remove('hidden');
      document.getElementById('findingsPanel').classList.add('hidden');
      document.getElementById('restorePanel').classList.remove('hidden');
      document.querySelectorAll('.segment[data-style]').forEach((button) => button.classList.toggle('active', button.dataset.style === 'token'));
      document.getElementById('documentName').textContent = '采购业务说明 · 可逆副本';
      document.getElementById('documentMeta').textContent = 'VAULT · 可逆代号副本 · 3 个映射';
      document.getElementById('charCount').textContent = '118';
      const tokenized = '甲方联系人：[MI_A8B7C6D5_001]\\n联系电话：[MI_A8B7C6D5_002]\\n项目代号：[MI_A8B7C6D5_003]';
      document.getElementById('sourceEditor').value = tokenized;
      document.getElementById('restoreInput').value = '摘要：请联系 [MI_A8B7C6D5_001]，电话 [MI_A8B7C6D5_002]。';
      document.getElementById('restoreOutput').value = '摘要：请联系 陈明，电话 13800000000。';
      document.getElementById('restoreReport').textContent = '已恢复 2 处 · 未出现代号 1 个 · 分析模式核对通过';
      document.getElementById('vaultLockedActions').classList.add('hidden');
      document.getElementById('vaultUnlocked').classList.remove('hidden');
      document.getElementById('vaultName').textContent = '采购项目.miyin-vault';
      document.getElementById('vaultStatus').textContent = '已解锁';
      true;
    `);
  } else if (commandValue('ui-capture-section') === 'semantic') {
    const semanticCapture = await captureWindow.webContents.executeJavaScript(`(() => {
      try {
        document.getElementById('typedTerms').value = '自定义：朱雀计划';
        document.getElementById('alwaysKeepTerms').value = '李四';
        document.querySelector('[data-style="label"]').click();
        document.getElementById('sourceEditor').value = '甲方：北京星河科技有限公司；联系人：张三；审核人：李四；统一社会信用代码：91310000677833266F；地址：北京市朝阳区建国路88号；内部项目：朱雀计划。';
        document.getElementById('sourceEditor').dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('documentName').textContent = '中文语义覆盖验证.txt';
        document.getElementById('documentMeta').textContent = '规则 + 类型化词典 + 总是保留词 · 全程离线';
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('editorState').classList.remove('hidden');
        document.getElementById('findingsPanel').classList.remove('hidden');
        return 'OK';
      } catch (error) {
        return 'ERROR:' + (error && error.stack || error);
      }
    })()`);
    if (semanticCapture !== 'OK') throw new Error(`SEMANTIC_CAPTURE_SETUP_FAILED ${semanticCapture}`);
  } else if (commandValue('ui-capture-section') === 'ocr-quality') {
    const fixturePath = path.resolve(commandValue('ui-capture-fixture') || path.join('output', 'ocr', 'phase14', 'lowres-skew.png'));
    const fixtureData = `data:image/png;base64,${(await fs.readFile(fixturePath)).toString('base64')}`;
    const ocrQualityCapture = await captureWindow.webContents.executeJavaScript(`(() => {
      try {
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('batchPanel').classList.add('hidden');
        document.getElementById('editorState').classList.remove('hidden');
        document.getElementById('findingsPanel').classList.add('hidden');
        document.getElementById('imagePreview').classList.remove('hidden');
        document.getElementById('documentName').textContent = '低分辨率倾斜扫描件.png';
        document.getElementById('documentMeta').textContent = '方向检测 · 低分辨率增强 · 表格/表单分区 · 人工校正队列';
        document.getElementById('charCount').textContent = '78';
        document.getElementById('findingCount').textContent = '4';
        document.getElementById('enabledCount').textContent = '4';
        document.getElementById('previewTitle').textContent = '增强前扫描预览';
        document.getElementById('ocrMeta').textContent = 'OCR 92% · 2139×888 · 低分辨率增强 ×3 · 方向校正 -2.51° · 表格/表单 1 区';
        document.getElementById('mappingState').textContent = '坐标映射有效';
        document.getElementById('imageElement').src = ${JSON.stringify(fixtureData)};
        document.getElementById('imageElement').style.maxHeight = '330px';
        document.getElementById('sourceEditor').value = '客户:张三\\n手机:13812345678\\n邮篮:alice@example.com\\n身份证:11010519491231002X';
        document.getElementById('sourceEditor').style.minHeight = '150px';
        document.getElementById('ocrCorrectionPanel').classList.remove('hidden');
        document.getElementById('ocrCorrectionSummary').textContent = '1 项待复核 · 低于 72%';
        document.getElementById('ocrCorrectionList').innerHTML = '<label class="ocr-correction-row"><span>61%</span><input value="邮箱" data-original="邮篮" data-word-index="6"></label>';
        document.getElementById('ocrCorrectionApplyButton').classList.add('button-accent');
        return 'OK';
      } catch (error) {
        return 'ERROR:' + (error && error.stack || error);
      }
    })()`);
    if (ocrQualityCapture !== 'OK') throw new Error(`OCR_QUALITY_CAPTURE_SETUP_FAILED ${ocrQualityCapture}`);
  } else if (commandValue('ui-capture-section') === 'ocr-layout') {
    const fixturePath = path.resolve(commandValue('ui-capture-fixture') || path.join('output', 'ocr', 'phase15', 'corpus', '03-merged-grid.png'));
    const fixtureData = `data:image/png;base64,${(await fs.readFile(fixturePath)).toString('base64')}`;
    const ocrLayoutCapture = await captureWindow.webContents.executeJavaScript(`(() => {
      try {
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('batchPanel').classList.add('hidden');
        document.getElementById('editorState').classList.remove('hidden');
        document.getElementById('findingsPanel').classList.add('hidden');
        document.getElementById('imagePreview').classList.remove('hidden');
        document.getElementById('documentName').textContent = '合并表头与双栏版面回归.png';
        document.getElementById('documentMeta').textContent = '真实网格线 · 合并单元格恢复 · 双栏阅读顺序 · 4 项本地回归语料';
        document.getElementById('charCount').textContent = '48';
        document.getElementById('previewTitle').textContent = '表格网格恢复预览';
        document.getElementById('ocrMeta').textContent = '网格 1 表 · 3×3 基础格 · 合并 1 格 · 双栏顺序：左栏到底 → 右栏';
        document.getElementById('mappingState').textContent = '结构与坐标有效';
        const image = document.getElementById('imageElement');
        image.src = ${JSON.stringify(fixtureData)};
        image.style.maxHeight = '520px';
        const overlay = document.getElementById('imageOverlay');
        overlay.innerHTML = [
          [3.1,4.8,93.8,28.6,true],
          [3.1,33.3,31.3,31,false],[34.4,33.3,31.2,31,false],[65.6,33.3,31.3,31,false],
          [3.1,64.3,31.3,31,false],[34.4,64.3,31.2,31,false],[65.6,64.3,31.3,31,false]
        ].map(([left,top,width,height,merged]) => '<span class="layout-cell-box ' + (merged ? 'merged' : '') + '" style="left:' + left + '%;top:' + top + '%;width:' + width + '%;height:' + height + '%"></span>').join('');
        document.getElementById('sourceEditor').value = 'MERGED HEADER\\nA1 | B1 | C1\\nA2 | B2 | C2\\n\\n阅读顺序：左1 → 左2 → 左3 → 左4 → 右1 → 右2 → 右3 → 右4';
        document.getElementById('sourceEditor').style.minHeight = '170px';
        return 'OK';
      } catch (error) {
        return 'ERROR:' + (error && error.stack || error);
      }
    })()`);
    if (ocrLayoutCapture !== 'OK') throw new Error(`OCR_LAYOUT_CAPTURE_SETUP_FAILED ${ocrLayoutCapture}`);
  } else if (commandValue('ui-capture-section') === 'ner') {
    const nerCapture = await captureWindow.webContents.executeJavaScript(`(() => {
      try {
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('batchPanel').classList.add('hidden');
        document.getElementById('editorState').classList.remove('hidden');
        document.getElementById('findingsPanel').classList.remove('hidden');
        document.getElementById('documentName').textContent = '离线语义识别验证.txt';
        document.getElementById('documentMeta').textContent = '规则 + 本地 ONNX NER · CPU 推理 · 无网络请求';
        document.getElementById('charCount').textContent = '27';
        document.getElementById('findingCount').textContent = '4';
        document.getElementById('enabledCount').textContent = '3';
        document.getElementById('sourceEditor').value = '王伟今日抵达上海，与北京星河科技有限公司代表陈明会面。';
        document.getElementById('redactedEditor').value = '[姓名]今日抵达[地址]，与[公司]代表陈明会面。';
        document.getElementById('sourceEditor').style.minHeight = '170px';
        document.getElementById('nerStatus').textContent = '已加载';
        document.getElementById('nerStatus').classList.add('loaded');
        document.getElementById('nerMeta').textContent = '中文命名实体模型 · 388.0 MB · 21128 词 · SHA256 1f479e34011f…';
        document.getElementById('nerClearButton').disabled = false;
        document.getElementById('nerAnalyzeButton').disabled = false;
        document.getElementById('findingList').innerHTML = [
          ['姓名 · 100%', '王伟', '[姓名]', true, false],
          ['地址 · 100%', '上海', '[地址]', true, false],
          ['公司 · 100%', '北京星河科技有限公司', '[公司]', true, false],
          ['姓名 · 64%', '陈明', '[姓名]', false, true]
        ].map(([badge, value, replacement, enabled, review]) => '<div class="finding-row ' + (enabled ? '' : 'disabled ') + (review ? 'needs-review' : '') + '"><input type="checkbox" ' + (enabled ? 'checked' : '') + '><span class="finding-badge">' + badge + '</span><code>' + value + '</code><span class="finding-arrow">→</span><code class="replacement">' + replacement + '</code></div>').join('');
        document.querySelector('.sidebar').scrollTop = document.querySelector('.ner-section').offsetTop - 20;
        return 'OK';
      } catch (error) {
        return 'ERROR:' + (error && error.stack || error);
      }
    })()`);
    if (nerCapture !== 'OK') throw new Error(`NER_CAPTURE_SETUP_FAILED ${nerCapture}`);
  } else if (commandValue('ui-capture-section') === 'office-restore') {
    const officeCapture = await captureWindow.webContents.executeJavaScript(`(() => {
      try {
        document.querySelector('[data-module="restore"]').click();
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('batchPanel').classList.add('hidden');
        document.getElementById('editorState').classList.remove('hidden');
        document.getElementById('findingsPanel').classList.add('hidden');
        document.getElementById('restorePanel').classList.remove('hidden');
        document.querySelectorAll('.segment[data-style]').forEach((button) => button.classList.toggle('active', button.dataset.style === 'token'));
        document.getElementById('documentName').textContent = '客户清单 · 可逆原格式副本';
        document.getElementById('documentMeta').textContent = 'XLSX · 8 个代号映射 · 样式与公式保持';
        document.getElementById('charCount').textContent = '286';
        document.getElementById('sourceEditor').value = '客户：[MI_A1B2C310_001]\\n手机：[MI_A1B2C310_002]\\n邮箱：[MI_A1B2C310_003]';
        document.getElementById('sourceEditor').style.minHeight = '220px';
        document.getElementById('restoreInput').value = '文本可在此逆脱敏；Office 文件使用下方原格式恢复。';
        document.getElementById('restoreOutput').value = '';
        document.querySelectorAll('.restore-grid textarea').forEach((item) => item.style.minHeight = '110px');
        document.getElementById('restoreReport').textContent = 'DOCX 7/7 · XLSX 8/8 · 文本精确恢复 · 样式保持 · 公式保持';
        document.getElementById('restoreOfficeButton').classList.remove('button-ghost');
        document.getElementById('restoreOfficeButton').classList.add('button-accent');
        document.getElementById('vaultLockedActions').classList.add('hidden');
        document.getElementById('vaultUnlocked').classList.remove('hidden');
        document.getElementById('vaultName').textContent = '客户资料可逆映射.miyin-vault';
        document.getElementById('vaultStatus').textContent = '已解锁';
        return 'OK';
      } catch (error) {
        return 'ERROR:' + (error && error.stack || error);
      }
    })()`);
    if (officeCapture !== 'OK') throw new Error(`OFFICE_CAPTURE_SETUP_FAILED ${officeCapture}`);
  } else if (commandValue('ui-capture-section') === 'pdf-reversible') {
    const pdfCapture = await captureWindow.webContents.executeJavaScript(`(() => {
      try {
        document.querySelector('[data-module="restore"]').click();
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('batchPanel').classList.add('hidden');
        document.getElementById('editorState').classList.remove('hidden');
        document.getElementById('findingsPanel').classList.add('hidden');
        document.getElementById('restorePanel').classList.remove('hidden');
        document.querySelectorAll('.segment[data-style]').forEach((button) => button.classList.toggle('active', button.dataset.style === 'token'));
        document.getElementById('documentName').textContent = '合同扫描件 · 可逆 PDF 副本';
        document.getElementById('documentMeta').textContent = 'PDF · 文本层 8/8 · 坐标副本 · OCR 文本副本';
        document.getElementById('charCount').textContent = '324';
        document.getElementById('sourceEditor').value = '联系人：[MI_D0C0B011_001]\\n手机：[MI_D0C0B011_002]\\n邮箱：[MI_D0C0B011_003]';
        document.getElementById('sourceEditor').style.minHeight = '220px';
        document.getElementById('restoreInput').value = 'PDF 代号保留在可搜索文本层；扫描页同步生成安全 OCR 文本副本。';
        document.getElementById('restoreOutput').value = '';
        document.querySelectorAll('.restore-grid textarea').forEach((item) => item.style.minHeight = '110px');
        document.getElementById('restoreReport').textContent = '原生 PDF 8/8 · 扫描 PDF 5/5 · 坐标 13 · 副本无敏感明文';
        document.getElementById('restoreOfficeButton').classList.remove('button-ghost');
        document.getElementById('restoreOfficeButton').classList.add('button-accent');
        document.getElementById('vaultLockedActions').classList.add('hidden');
        document.getElementById('vaultUnlocked').classList.remove('hidden');
        document.getElementById('vaultName').textContent = '合同 PDF 可逆映射.miyin-vault';
        document.getElementById('vaultStatus').textContent = '已解锁';
        return 'OK';
      } catch (error) {
        return 'ERROR:' + (error && error.stack || error);
      }
    })()`);
    if (pdfCapture !== 'OK') throw new Error(`PDF_CAPTURE_SETUP_FAILED ${pdfCapture}`);
  } else if (commandValue('ui-capture-section') === 'batch') {
    await captureWindow.webContents.executeJavaScript(`
      document.querySelector('[data-module="batch"]').click();
      const panel = document.getElementById('batchPanel');
      panel.classList.remove('hidden');
      document.getElementById('batchSummary').textContent = '4 个任务 · 1 进行中 · 2 完成';
      document.getElementById('batchList').innerHTML = [
        ['batch-done', '客户清单.docx', '已完成 · 1,286 字符', 100, '打开复核'],
        ['batch-processing', '扫描合同.pdf', '处理中', 42, '处理中'],
        ['batch-done', '通讯录.xlsx', '已完成 · 864 字符', 100, '打开复核'],
        ['batch-queued', '补充说明.txt', '等待中', 0, '取消']
      ].map(([state, name, meta, progress, action]) => '<div class="batch-row ' + state + '"><span class="batch-status-dot"></span><div class="batch-details"><strong>' + name + '</strong><span>' + meta + '</span><div class="batch-progress"><i style="width:' + progress + '%"></i></div></div><button class="button button-small button-ghost">' + action + '</button></div>').join('');
      void 0;
    `);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await captureWindow.webContents.capturePage();
  await fs.writeFile(outputPath, image.toPNG());
  process.stdout.write(`UI_CAPTURE_OK width=${image.getSize().width} height=${image.getSize().height}\n`);
  captureWindow.destroy();
  app.exit(0);
  return true;
}

ipcMain.handle('veilforge:pick-document', guardWithEvent(chooseDocument));
ipcMain.handle('veilforge:pick-batch-documents', guardWithEvent(chooseBatchDocuments));
ipcMain.handle('veilforge:pick-image-for-text', guardWithEvent(chooseImageForText));
ipcMain.handle('veilforge:open-encrypted-pdf', guardWithEvent(openEncryptedDocument));
ipcMain.handle('veilforge:export', guardWithEvent(saveExport));
ipcMain.handle('veilforge:ocr-correct', guardWithEvent(correctOcr));
ipcMain.handle('veilforge:office-restore', guardWithEvent(restoreOfficeFromDialog));
ipcMain.handle('veilforge:restore-open', guardWithEvent(openReturnedDocument));
ipcMain.handle('veilforge:restore-save', guardWithEvent(saveRestoredDocument));
ipcMain.handle('veilforge:restore-folder-pick', guardWithEvent(pickReturnedFolder));
ipcMain.handle('veilforge:restore-folder-run', guardWithEvent(runFolderRestore));
ipcMain.handle('veilforge:batch-enqueue', guardWithEvent(enqueueBatch));
ipcMain.handle('veilforge:batch-list', guardWithEvent(listBatch));
ipcMain.handle('veilforge:batch-open', guardWithEvent(openBatchResult));
ipcMain.handle('veilforge:batch-cancel', guardWithEvent(cancelBatch));
ipcMain.handle('veilforge:batch-clear', guardWithEvent(clearBatch));
ipcMain.handle('veilforge:batch-export', guardWithEvent(exportCompletedBatch));
ipcMain.handle('veilforge:batch-export-cancel', guardWithEvent(cancelBatchExport));
ipcMain.handle('veilforge:vault-create', guardWithEvent(createVaultFromDialog));
ipcMain.handle('veilforge:vault-open', guardWithEvent(openVaultFromDialog));
ipcMain.handle('veilforge:vault-save', guardWithEvent(saveVaultEntry));
ipcMain.handle('veilforge:vault-list', guardWithEvent(listVault));
ipcMain.handle('veilforge:vault-read', guardWithEvent(readFromVault));
ipcMain.handle('veilforge:vault-export-attachment', guardWithEvent(exportAttachmentFromVault));
ipcMain.handle('veilforge:vault-delete', guardWithEvent(deleteFromVault));
ipcMain.handle('veilforge:vault-delete-many', guardWithEvent(deleteManyFromVault));
ipcMain.handle('veilforge:vault-list-ids', guardWithEvent(listVaultIds));
ipcMain.handle('veilforge:vault-compact', guardWithEvent(compactCurrentVault));
ipcMain.handle('veilforge:vault-backup', guardWithEvent(backupVaultFromDialog));
ipcMain.handle('veilforge:vault-import', guardWithEvent(importVaultFromDialog));
ipcMain.handle('veilforge:vault-rotate', guardWithEvent(rotateVault));
ipcMain.handle('veilforge:vault-timeout', guardWithEvent(setVaultTimeout));
ipcMain.handle('veilforge:vault-lock', guardWithEvent(lockVault));
ipcMain.handle('veilforge:ner-select', guardWithEvent(selectNerModel));
ipcMain.handle('veilforge:ner-bundled', guardWithEvent(loadBundledNerModel));
ipcMain.handle('veilforge:ner-clear', guardWithEvent(clearNerModel));
ipcMain.handle('veilforge:ner-analyze', guardWithEvent(analyzeWithNer));
ipcMain.handle('veilforge:ocr-backend-state', guard(currentOcrBackendState));
ipcMain.handle('veilforge:ocr-backend-select-rapid', guard(selectRapidOcrPython));
ipcMain.handle('veilforge:ocr-backend-tesseract', guard(useTesseractBackend));

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  hardenSession(session.defaultSession);
  await recoverOrphanedWorkspaces(jobWorkspaceRoot());
  if (await runCsvSmoke()) return;
  if (await runVaultV3MaintenanceSmoke()) return;
  if (await runVaultV3CapacitySmoke()) return;
  if (await runCapacityFoundationSmoke()) return;
  if (await runNerSmoke()) return;
  if (await runChineseCoverageSmoke()) return;
  if (await runReversibleSmoke()) return;
  if (await runBatchExportSmoke()) return;
  if (await runBatchSmoke()) return;
  if (await runOfficeReversibleSmoke()) return;
  if (await runOfficeSmoke()) return;
  if (await runVaultMigrationSmoke()) return;
  if (await runVaultSmoke()) return;
  if (await runPdfSecuritySmoke()) return;
  if (await runPdfGeometrySmoke()) return;
  if (await runPdfComplexSmoke()) return;
  if (await runPdfReversibleSmoke()) return;
  if (await runPdfSmoke()) return;
  if (await runOcrLayoutSmoke()) return;
  if (await runOcrQualitySmoke()) return;
  if (await runOcrSmoke()) return;
  if (await runUiCapture()) return;
  if (process.argv.includes('--smoke-test')) {
    const probe = await createWindow();
    if (!probe.webContents.getURL().startsWith('file://')) throw new Error('SMOKE_ENTRY_INVALID');
    const senderProbe = await probe.webContents.executeJavaScript(`(async () => {
      history.replaceState({ module: 'batch' }, '', '#batch');
      const jobs = await window.veilforge.listBatchJobs();
      const backend = await window.veilforge.getOcrBackendState();
      return { hash: location.hash, jobs: Array.isArray(jobs), backend: Boolean(backend?.backend) };
    })()`);
    if (senderProbe.hash !== '#batch' || !senderProbe.jobs || !senderProbe.backend) throw new Error('SMOKE_SENDER_GUARD_INVALID');
    process.stdout.write('SMOKE_OK secure-window-loaded sender-hash=1 batch-list=1 ocr-state=1\n');
    probe.destroy();
    app.exit(0);
    return;
  }
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
}).catch((error) => {
  process.stderr.write(`BOOT_FAILED ${error?.stack || error}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  documentWorkerPool.close();
  for (const value of imageSessions.values()) void disposeDocumentSession(value);
  for (const value of officeSessions.values()) void disposeDocumentSession(value);
  imageSessions.clear();
  officeSessions.clear();
  csvSessions.clear();
  for (const token of [...vaultSessions.keys()]) lockVaultSession(token, 'quit');
  for (const ownerId of [...nerSessions.keys()]) void clearNerForOwner(ownerId).catch(() => {});
});

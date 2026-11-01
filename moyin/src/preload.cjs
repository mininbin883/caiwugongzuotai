'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('veilforge', Object.freeze({
  pickDocument: () => ipcRenderer.invoke('veilforge:pick-document'),
  pickBatchDocuments: () => ipcRenderer.invoke('veilforge:pick-batch-documents'),
  pickImageForText: () => ipcRenderer.invoke('veilforge:pick-image-for-text'),
  openEncryptedPdf: (token, password) => ipcRenderer.invoke('veilforge:open-encrypted-pdf', { token, password }),
  enqueueDroppedFiles: (files) => {
    const paths = Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke('veilforge:batch-enqueue', { paths });
  },
  listBatchJobs: () => ipcRenderer.invoke('veilforge:batch-list'),
  openBatchResult: (id) => ipcRenderer.invoke('veilforge:batch-open', { id }),
  cancelBatchJob: (id) => ipcRenderer.invoke('veilforge:batch-cancel', { id }),
  clearBatchJobs: () => ipcRenderer.invoke('veilforge:batch-clear'),
  exportCompletedBatch: (options = {}) => ipcRenderer.invoke('veilforge:batch-export', options),
  cancelBatchExport: () => ipcRenderer.invoke('veilforge:batch-export-cancel'),
  exportResult: (payload) => ipcRenderer.invoke('veilforge:export', payload),
  correctOcr: (token, pageNumber, corrections) => ipcRenderer.invoke('veilforge:ocr-correct', { token, pageNumber, corrections }),
  restoreOffice: (mapping, sentText) => ipcRenderer.invoke('veilforge:office-restore', { mapping, sentText }),
  openReturnedDocument: (file) => ipcRenderer.invoke('veilforge:restore-open', { path: file ? webUtils.getPathForFile(file) : '' }),
  saveRestoredDocument: (payload) => ipcRenderer.invoke('veilforge:restore-save', payload),
  pickReturnedFolder: () => ipcRenderer.invoke('veilforge:restore-folder-pick'),
  runFolderRestore: (token, mapping) => ipcRenderer.invoke('veilforge:restore-folder-run', { token, mapping }),
  createVault: (password) => ipcRenderer.invoke('veilforge:vault-create', { password }),
  openVault: (password) => ipcRenderer.invoke('veilforge:vault-open', { password }),
  saveVaultEntry: (payload) => ipcRenderer.invoke('veilforge:vault-save', payload),
  listVaultEntries: (token, optionsOrCursor = null, pageSize = 20) => {
    const options = optionsOrCursor && typeof optionsOrCursor === 'object'
      ? optionsOrCursor
      : { cursor: optionsOrCursor, pageSize };
    return ipcRenderer.invoke('veilforge:vault-list', { token, ...options });
  },
  readVaultEntry: (token, entryId) => ipcRenderer.invoke('veilforge:vault-read', { token, entryId }),
  exportVaultAttachment: (token, entryId, blobId) => ipcRenderer.invoke('veilforge:vault-export-attachment', { token, entryId, blobId }),
  deleteVaultEntry: (token, entryId) => ipcRenderer.invoke('veilforge:vault-delete', { token, entryId }),
  compactVault: (token) => ipcRenderer.invoke('veilforge:vault-compact', { token }),
  backupVault: (token, password) => ipcRenderer.invoke('veilforge:vault-backup', { token, password }),
  importVault: (token, password, conflictPolicy) => ipcRenderer.invoke('veilforge:vault-import', { token, password, conflictPolicy }),
  rotateVaultPassword: (token, newPassword) => ipcRenderer.invoke('veilforge:vault-rotate', { token, newPassword }),
  setVaultTimeout: (token, minutes) => ipcRenderer.invoke('veilforge:vault-timeout', { token, minutes }),
  lockVault: (token) => ipcRenderer.invoke('veilforge:vault-lock', { token }),
  selectNerModel: () => ipcRenderer.invoke('veilforge:ner-select'),
  loadBundledNer: () => ipcRenderer.invoke('veilforge:ner-bundled'),
  clearNerModel: () => ipcRenderer.invoke('veilforge:ner-clear'),
  analyzeNer: (text, acceptThreshold) => ipcRenderer.invoke('veilforge:ner-analyze', { text, acceptThreshold }),
  getOcrBackendState: () => ipcRenderer.invoke('veilforge:ocr-backend-state'),
  selectRapidOcrPython: () => ipcRenderer.invoke('veilforge:ocr-backend-select-rapid'),
  useTesseractBackend: () => ipcRenderer.invoke('veilforge:ocr-backend-tesseract'),
  onVaultLocked: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('veilforge:vault-locked', listener);
    return () => ipcRenderer.removeListener('veilforge:vault-locked', listener);
  },
  onBatchUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, job) => callback(job);
    ipcRenderer.on('veilforge:batch-update', listener);
    return () => ipcRenderer.removeListener('veilforge:batch-update', listener);
  },
  onBatchExportProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('veilforge:batch-export-progress', listener);
    return () => ipcRenderer.removeListener('veilforge:batch-export-progress', listener);
  }
}));

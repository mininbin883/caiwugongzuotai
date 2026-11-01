import { TYPE_LABELS, analyzeText, applyFindings } from '../core/redaction-engine.mjs';
import { createTokenNonce, restoreTokens, tokenizeFindings } from '../core/reversible-token-engine.mjs';
import { auditBeforeExport, auditItemToFinding } from '../core/export-audit.mjs';
import { reviewRestoration, summarizeReview } from '../core/restore-review.mjs';
import { friendlyError } from '../core/error-messages.mjs';
import { buildAiPrompt } from '../core/ai-prompt.mjs';
import { demoDocumentResult, workflowSteps } from '../core/workflow-demo.mjs';
import { MODULE_DEFINITIONS, MODULE_IDS, moduleIdFromHash, nextModuleId, normalizeModuleId } from '../core/navigation-controller.mjs';
import { autoVaultDecision, createPastedDocument } from '../core/quick-entry-controller.mjs';

const state = {
  sourceName: '',
  sourceText: '',
  sourceToken: null,
  vaultAttachmentToken: null,
  vaultAttachmentFiles: 0,
  quickEntryMode: null,
  activeModule: 'redact',
  workflowStage: 'import',
  findings: [],
  style: 'token',
  unexported: false,
  lastExport: null,
  restoreFile: null,
  enabledTypes: new Set(Object.keys(TYPE_LABELS)),
  image: null,
  imageMappingValid: false,
  currentPage: 0,
  vault: null,
  office: null,
  officeLongTailReport: null,
  officeMappingValid: false,
  csv: null,
  csvMappingValid: false,
  batchJobs: new Map(),
  batchExport: null,
  reversibleNonce: createTokenNonce(),
  reversibleCache: null,
  manualFindings: [],
  exportAudit: null,
  restoreEntry: null,
  restoreResult: null,
  ner: null,
  nerFindings: [],
  nerText: '',
  nerBusy: false,
  ocrBackend: null,
  ocrBackendBusy: false,
  autoSaveToVault: false,
  batchAutoVault: false,
  vaultFilters: { query: '', kind: 'all', dateFrom: '', dateTo: '' }
};

const elements = Object.fromEntries([
  'openButton', 'emptyOpenButton', 'pasteTextButton', 'imageToTextButton', 'demoButton', 'resetButton', 'emptyState', 'editorState', 'findingsPanel',
  'sourceEditor', 'redactedEditor', 'documentName', 'documentMeta', 'charCount', 'findingCount',
  'enabledCount', 'typeList', 'customTerms', 'typedTerms', 'alwaysKeepTerms', 'findingList', 'exportTextButton', 'exportJsonButton',
  'exportImageButton', 'imagePreview', 'imageCanvas', 'imageElement', 'imageOverlay', 'ocrMeta', 'mappingState', 'toast',
  'ocrCorrectionPanel', 'ocrCorrectionSummary', 'ocrCorrectionList', 'ocrCorrectionApplyButton',
  'previewTitle', 'pageControls', 'pagePreviousButton', 'pageNextButton', 'pageIndicator',
  'vaultStatus', 'vaultLockedActions', 'vaultUnlocked', 'vaultName', 'vaultTimeout', 'vaultSaveButton', 'vaultBundleSaveButton',
  'vaultCreateButton', 'vaultOpenButton', 'vaultBackupButton', 'vaultImportButton', 'vaultImportPolicy',
  'vaultRotateButton', 'vaultLockButton', 'vaultCompactButton', 'vaultStorageStats', 'vaultPageSummary',
  'vaultLoadMoreButton', 'vaultEntryList',
  'vaultAutoSave', 'vaultSearchInput', 'vaultKindFilter', 'vaultDateFrom', 'vaultDateTo', 'vaultFilterClearButton',
  'vaultBackupHistory',
  'vaultPasswordDialog', 'vaultPasswordForm', 'vaultDialogTitle', 'vaultDialogDescription', 'vaultPassword',
  'vaultConfirmLabel', 'vaultPasswordConfirm', 'vaultDialogError', 'vaultDialogCancel', 'exportOfficeButton', 'exportCsvButton',
  'pdfPasswordDialog', 'pdfPasswordForm', 'pdfPasswordDescription', 'pdfPassword', 'pdfPasswordError', 'pdfPasswordCancel',
  'workflowGuide', 'workflowStepImport', 'workflowStepReview', 'workflowStepExport', 'workflowSummary',
  'batchPanel', 'batchList', 'batchSummary', 'batchClearButton', 'batchExportButton', 'batchAutoVault',
  'restorePanel', 'restoreInput', 'restoreOutput', 'restoreMode', 'restoreButton', 'restoreExportButton', 'restoreOfficeButton', 'restoreReport',
  'restoreChecklist', 'restoreConfirm', 'restoreConfirmLabel', 'exportAuditBox',
  'restoreEntryLabel', 'restoreSearch', 'restoreUnlockButton', 'restoreSearchResults', 'restoreDrop', 'restoreImportButton', 'restoreFileState',
  'exportBar', 'exportSummary', 'exportSummaryDetail', 'exportConfirm', 'exportPrimaryButton',
  'vaultGateDialog', 'vaultGateCreate', 'vaultGateOpen', 'vaultGateCancel',
  'nextStepsDialog', 'nextStepsTitle', 'nextStepsPath', 'nextStepsPrompt', 'nextStepsCopy', 'nextStepsDownload',
  'nextStepsRestore', 'nextStepsNew', 'nextStepsClose',
  'sourceEditorWrap', 'sourceHighlight', 'selectionBar', 'selectionHint', 'selectionActions', 'selectionPreview', 'selectionType',
  'selectionHideOnceButton', 'selectionHideAllButton', 'selectionKeepButton',
  'nerStatus', 'nerMeta', 'nerThreshold', 'nerSelectButton', 'nerClearButton', 'nerAnalyzeButton',
  'ocrBackendStatus', 'ocrBackendMeta', 'ocrRapidButton', 'ocrTesseractButton', 'exportOcrTextButton',
  'pasteTextDialog', 'pasteTextForm', 'pasteTextName', 'pasteTextInput', 'pasteTextCounter', 'pasteTextError', 'pasteTextCancel'
  , 'moduleNav', 'batchNavCount', 'vaultNavState', 'restoreNavState', 'protectNavState',
  'moduleSideGuide', 'moduleSideKicker', 'moduleSideTitle', 'moduleSideSteps',
  'moduleOverview', 'moduleOverviewKicker', 'moduleOverviewTitle', 'moduleOverviewDescription',
  'moduleOverviewStatus', 'moduleChecklist', 'modulePrimaryAction'
].map((id) => [id, document.getElementById(id)]));

function updateModuleBadges() {
  elements.batchNavCount.textContent = String(state.batchJobs.size);
  elements.vaultNavState.textContent = state.vault ? '已解锁' : '已锁定';
  elements.restoreNavState.textContent = state.restoreEntry?.mapping ? '映射已就绪' : '等待可逆记录';
  elements.protectNavState.textContent = String(state.enabledTypes.size);
}

function renderModuleNavigation() {
  const active = normalizeModuleId(state.activeModule);
  const definition = MODULE_DEFINITIONS[active];
  document.body.dataset.activeModule = active;
  for (const button of elements.moduleNav.querySelectorAll('[data-module]')) {
    const selected = button.dataset.module === active;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('[data-module-section]')) {
    const routes = String(section.dataset.moduleSection || '').split(/\s+/u);
    section.classList.toggle('module-hidden', !routes.includes(active));
  }
  for (const section of document.querySelectorAll('[data-redact-view]')) {
    section.classList.toggle('module-hidden', active !== 'redact');
  }
  elements.batchPanel.classList.toggle('module-hidden', active !== 'batch');
  elements.restorePanel.classList.toggle('module-hidden', active !== 'restore');
  elements.moduleOverview.classList.toggle('hidden', active === 'redact');
  elements.moduleOverviewKicker.textContent = definition.kicker;
  elements.moduleOverviewTitle.textContent = definition.title;
  elements.moduleOverviewDescription.textContent = definition.description;
  elements.moduleOverviewStatus.textContent = active === 'batch'
    ? `${state.batchJobs.size} 个任务 · 本机串行处理`
    : active === 'vault'
      ? state.vault ? '仓库已解锁 · 密钥仅在内存' : '仓库已锁定'
      : active === 'restore'
        ? state.restoreEntry?.mapping ? `当前：${state.restoreEntry.fileNumber || ''} · ${state.restoreEntry.mapping.length} 个代号` : '导入返回件后自动按编号找到记录'
        : active === 'protect'
          ? `${state.enabledTypes.size} 类规则已启用`
          : definition.status;
  elements.modulePrimaryAction.textContent = active === 'vault' && state.vault
    ? '查看仓库记录'
    : definition.action;
  elements.moduleChecklist.replaceChildren(...definition.checklist.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  elements.moduleSideKicker.textContent = definition.kicker;
  elements.moduleSideTitle.textContent = definition.label;
  elements.moduleSideSteps.replaceChildren(...definition.checklist.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  updateModuleBadges();
}

function setActiveModule(moduleId, { updateHash = true, focus = false } = {}) {
  const active = normalizeModuleId(moduleId);
  state.activeModule = active;
  renderModuleNavigation();
  const button = elements.moduleNav.querySelector(`[data-module="${active}"]`);
  if (focus) button?.focus();
  if (updateHash && window.location.hash !== `#${active}`) history.pushState({ module: active }, '', `#${active}`);
}

async function runModulePrimaryAction() {
  switch (state.activeModule) {
    case 'batch':
      await pickBatchDocuments();
      break;
    case 'vault':
      if (state.vault) (elements.vaultEntryList.querySelector('button') || elements.vaultSaveButton).focus({ preventScroll: false });
      else elements.vaultOpenButton.focus({ preventScroll: false });
      break;
    case 'restore':
      await importReturnedFile();
      break;
    case 'protect':
      elements.customTerms.focus({ preventScroll: false });
      break;
    default:
      await openDocument();
  }
}

function renderWorkflowProgress(stage = state.workflowStage) {
  state.workflowStage = stage;
  const nodes = [elements.workflowStepImport, elements.workflowStepReview, elements.workflowStepExport];
  for (const [index, step] of workflowSteps(stage).entries()) {
    nodes[index].classList.remove('current', 'done', 'pending');
    nodes[index].classList.add(step.state);
    if (step.state === 'current') nodes[index].setAttribute('aria-current', 'step');
    else nodes[index].removeAttribute('aria-current');
  }
  elements.workflowSummary.textContent = stage === 'import'
    ? '当前：导入文档'
    : stage === 'review'
      ? '当前：人工核对'
      : stage === 'export'
        ? '当前：导出副本'
        : '闭环完成';
}

function loadDemo() {
  if (!confirmDiscardUnexported('载入示例')) return;
  state.style = 'token';
  elements.customTerms.value = '流光计划';
  document.querySelectorAll('[data-style]').forEach((item) => item.classList.toggle('active', item.dataset.style === 'token'));
  applyDocumentResult(demoDocumentResult(), '已载入本地虚构示例，可直接核对并导出');
}

let vaultDialogResolve = null;
let vaultDialogNeedsConfirmation = false;
let pdfPasswordResolve = null;

function showToast(message, kind = 'ok') {
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.classList.add('visible');
  window.setTimeout(() => elements.toast.classList.remove('visible'), 3200);
}

function updatePasteTextCounter() {
  const value = elements.pasteTextInput.value;
  const bytes = new TextEncoder().encode(value).byteLength;
  elements.pasteTextCounter.textContent = `${value.length.toLocaleString('zh-CN')} 字符 · ${bytes.toLocaleString('zh-CN')} bytes`;
}

function openPasteTextDialog() {
  if (!confirmDiscardUnexported('粘贴新文字')) return;
  elements.pasteTextName.value = '粘贴文字';
  elements.pasteTextInput.value = '';
  elements.pasteTextError.textContent = '';
  updatePasteTextCounter();
  elements.pasteTextDialog.showModal();
  window.setTimeout(() => elements.pasteTextInput.focus(), 0);
}

function closePasteTextDialog() {
  if (elements.pasteTextDialog.open) elements.pasteTextDialog.close();
  elements.pasteTextInput.value = '';
  elements.pasteTextError.textContent = '';
  updatePasteTextCounter();
}

function vaultErrorMessage(error) {
  const message = String(error?.message || error || '未知错误');
  if (message.includes('LOCAL_VAULT_PASSWORD_POLICY')) return '密码至少 10 个字符，最多 256 个字符';
  if (message.includes('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID')) return '密码错误，或仓库完整性校验失败';
  if (message.includes('LOCAL_VAULT_SESSION_EXPIRED')) return '仓库已经锁定，请重新打开';
  if (message.includes('LOCAL_VAULT_IMPORT_CONFLICT')) return '备份中存在重复内容或同名记录；请调整冲突策略';
  if (message.includes('LOCAL_VAULT_BACKUP_FORMAT_INVALID')) return '所选文件不是墨隐加密备份';
  if (message.includes('LOCAL_VAULT_IMPORT_POLICY_INVALID')) return '导入冲突策略无效';
  if (message.includes('EEXIST')) return '目标仓库已经存在，请选择新的文件名';
  return friendlyError(error);
}

function requestVaultPassword(mode) {
  const needsConfirmation = ['create', 'rotate', 'backup'].includes(mode);
  vaultDialogNeedsConfirmation = needsConfirmation;
  const titles = {
    create: '设置仓库密码',
    rotate: '轮换仓库密码',
    backup: '设置备份密码',
    import: '输入备份密码',
    open: '输入仓库密码'
  };
  elements.vaultDialogTitle.textContent = titles[mode] || titles.open;
  elements.vaultDialogDescription.textContent = ['open', 'import'].includes(mode)
    ? '密码只在本机内存中用于解密，不会写入文件或发送到网络。'
    : '使用至少 10 个字符；遗失密码后加密内容不能恢复。';
  elements.vaultConfirmLabel.classList.toggle('hidden', !needsConfirmation);
  elements.vaultPasswordConfirm.classList.toggle('hidden', !needsConfirmation);
  elements.vaultPasswordConfirm.required = needsConfirmation;
  elements.vaultPassword.autocomplete = ['open', 'import'].includes(mode) ? 'current-password' : 'new-password';
  elements.vaultPassword.value = '';
  elements.vaultPasswordConfirm.value = '';
  elements.vaultDialogError.textContent = '';
  elements.vaultPasswordDialog.showModal();
  window.setTimeout(() => elements.vaultPassword.focus(), 0);
  return new Promise((resolve) => { vaultDialogResolve = resolve; });
}

function finishVaultPassword(value) {
  if (elements.vaultPasswordDialog.open) elements.vaultPasswordDialog.close();
  const resolve = vaultDialogResolve;
  vaultDialogResolve = null;
  const password = value || null;
  elements.vaultPassword.value = '';
  elements.vaultPasswordConfirm.value = '';
  resolve?.(password);
}

function requestPdfPassword(name, error = '') {
  elements.pdfPasswordDescription.textContent = `${name} 已加密；密码仅在当前导入任务的内存中使用。`;
  elements.pdfPassword.value = '';
  elements.pdfPasswordError.textContent = error;
  elements.pdfPasswordDialog.showModal();
  window.setTimeout(() => elements.pdfPassword.focus(), 0);
  return new Promise((resolve) => { pdfPasswordResolve = resolve; });
}

function finishPdfPassword(value) {
  if (elements.pdfPasswordDialog.open) elements.pdfPasswordDialog.close();
  const resolve = pdfPasswordResolve;
  pdfPasswordResolve = null;
  const password = value || null;
  elements.pdfPassword.value = '';
  resolve?.(password);
}

function vaultFiltersActive() {
  const filters = state.vaultFilters;
  return Boolean(filters.query || filters.kind !== 'all' || filters.dateFrom || filters.dateTo);
}

function renderVaultBackupHistory() {
  elements.vaultBackupHistory.replaceChildren();
  const history = state.vault?.backupHistory || [];
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'vault-entry-empty';
    empty.textContent = '暂无持久化备份操作';
    elements.vaultBackupHistory.append(empty);
    return;
  }
  for (const item of history) {
    const row = document.createElement('div');
    row.className = 'vault-backup-history-item';
    const title = document.createElement('strong');
    title.textContent = `${item.action === 'export' ? '导出' : '导入'} · ${item.name}`;
    const detail = document.createElement('span');
    const outcome = item.action === 'export'
      ? `${item.entries} 条 · ${formatBytes(item.bytes)}`
      : `新增 ${item.imported} · 跳过 ${item.skipped} · 改名 ${item.renamed}`;
    detail.textContent = `${new Date(item.at).toLocaleString('zh-CN', { hour12: false })} · ${outcome}`;
    row.append(title, detail);
    elements.vaultBackupHistory.append(row);
  }
}

async function refreshVaultEntries({ append = false } = {}) {
  if (!state.vault) return;
  const token = state.vault.token;
  const value = await window.veilforge.listVaultEntries(token, {
    cursor: append ? state.vault.page?.nextCursor : null,
    pageSize: state.vault.page?.pageSize || 20,
    filters: state.vaultFilters
  });
  if (!state.vault || state.vault.token !== token) return;
  if (append) {
    const known = new Set(state.vault.entries.map((entry) => entry.id));
    state.vault.entries.push(...value.entries.filter((entry) => !known.has(entry.id)));
  } else {
    state.vault.entries = value.entries;
  }
  state.vault.page = {
    total: value.total,
    filteredTotal: value.filteredTotal,
    pageSize: value.pageSize,
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
    filters: value.filters
  };
  state.vault.backupHistory = value.backupHistory || state.vault.backupHistory || [];
  state.vault.stats = value.stats;
  renderVaultState();
}

function renderVaultState() {
  renderRestoreState();
  const unlocked = Boolean(state.vault);
  if (!unlocked) {
    state.autoSaveToVault = false;
    state.batchAutoVault = false;
  }
  elements.vaultLockedActions.classList.toggle('hidden', unlocked);
  elements.vaultUnlocked.classList.toggle('hidden', !unlocked);
  elements.vaultStatus.textContent = unlocked ? '已解锁' : '已锁定';
  elements.vaultStatus.classList.toggle('unlocked', unlocked);
  elements.vaultAutoSave.disabled = !unlocked;
  elements.vaultAutoSave.checked = unlocked && state.autoSaveToVault;
  elements.batchAutoVault.disabled = !unlocked;
  elements.batchAutoVault.checked = unlocked && state.batchAutoVault;
  updateModuleBadges();
  elements.vaultSaveButton.disabled = !unlocked || !state.sourceText || Boolean(state.restoreEntry);
  elements.vaultSaveButton.textContent = state.restoreEntry
    ? '当前为已保存的可逆记录'
    : state.style === 'token' ? '保存可逆副本与映射' : '保存当前脱敏结果';
  elements.vaultBundleSaveButton.disabled = !unlocked || !state.sourceText || !state.vaultAttachmentToken || Boolean(state.restoreEntry);
  elements.vaultBundleSaveButton.textContent = state.vaultAttachmentToken
    ? state.vaultAttachmentFiles > 1 ? '保存原件＋脱敏副本' : '保存导出副本附件'
    : '导出后可保存原件＋副本';
  elements.vaultEntryList.replaceChildren();
  if (!unlocked) return;
  elements.vaultName.textContent = state.vault.name;
  elements.vaultTimeout.value = String(state.vault.timeoutMinutes);
  elements.vaultSearchInput.value = state.vaultFilters.query;
  elements.vaultKindFilter.value = state.vaultFilters.kind;
  elements.vaultDateFrom.value = state.vaultFilters.dateFrom;
  elements.vaultDateTo.value = state.vaultFilters.dateTo;
  const total = state.vault.page?.total ?? state.vault.entries.length;
  const filteredTotal = state.vault.page?.filteredTotal ?? total;
  elements.vaultPageSummary.textContent = vaultFiltersActive()
    ? `筛选 ${state.vault.entries.length}/${filteredTotal} · 全部 ${total}`
    : `显示 ${state.vault.entries.length}/${total}`;
  elements.vaultLoadMoreButton.classList.toggle('hidden', !state.vault.page?.hasMore);
  elements.vaultCompactButton.disabled = Boolean(state.vault.compacting);
  const stats = state.vault.stats;
  elements.vaultStorageStats.textContent = stats
    ? `${formatBytes(stats.fileBytes)} · 附件 ${stats.attachmentReferences || 0}/${stats.fileBlobs || 0} · 去重 ${stats.deduplicatedReferences || 0} · 可回收 ${formatBytes(stats.reclaimableBytes)}`
    : '';
  renderVaultBackupHistory();
  if (!state.vault.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'vault-entry-empty';
    empty.textContent = vaultFiltersActive() ? '没有符合筛选条件的记录' : '仓库尚无内容';
    elements.vaultEntryList.append(empty);
    return;
  }
  for (const entry of state.vault.entries) {
    const row = document.createElement('div');
    row.className = 'vault-entry-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vault-entry';
    const name = document.createElement('strong');
    name.textContent = `${entry.fileNumber || 'MI-??????'} · ${entry.name}`;
    const detail = document.createElement('span');
    const kindLabel = entry.kind === 'reversible-map' ? `可逆 · ${entry.audit.tokenCount || 0} 个代号` : '脱敏文本';
    const attachmentCount = entry.attachments?.length || 0;
    detail.textContent = `${kindLabel} · ${entry.characters.toLocaleString('zh-CN')} 字符 · ${entry.audit.findingCount} 项${attachmentCount ? ` · ${attachmentCount} 个加密附件` : ''}`;
    button.append(name, detail);
    button.addEventListener('click', () => loadVaultEntry(entry.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'vault-entry-delete';
    remove.title = `删除 ${entry.fileNumber}（删除后，外面流转的这份副本将无法再逆脱敏）`;
    remove.setAttribute('aria-label', `删除 ${entry.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => deleteVaultRecord(entry));
    const attachmentActions = document.createElement('div');
    attachmentActions.className = 'vault-attachment-actions';
    for (const attachment of entry.attachments || []) {
      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'vault-attachment-badge';
      exportButton.title = `导出 ${attachment.name}`;
      exportButton.textContent = attachment.role === 'original' ? '原件' : attachment.role === 'redacted-copy' ? '脱敏副本' : '附件';
      exportButton.addEventListener('click', () => exportStoredAttachment(entry, attachment));
      attachmentActions.append(exportButton);
    }
    if (entry.kind === 'reversible-map') {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'button button-ghost button-small vault-entry-restore';
      restore.textContent = '去逆脱敏 →';
      restore.title = `导入 AI 返回的内容，把 ${entry.fileNumber} 的代号换回原文`;
      restore.addEventListener('click', () => loadVaultEntry(entry.id));
      attachmentActions.append(restore);
    }
    row.append(button, attachmentActions, remove);
    elements.vaultEntryList.append(row);
  }
}

async function exportStoredAttachment(entry, attachment) {
  if (!state.vault) return;
  try {
    const result = await window.veilforge.exportVaultAttachment(state.vault.token, entry.id, attachment.blobId);
    if (result && !result.canceled) showToast(`${attachment.name} 已从加密仓库导出并校验 SHA-256`);
  } catch (error) {
    showToast(`附件导出失败：${vaultErrorMessage(error)}`, 'error');
  }
}

function applyVaultState(value) {
  state.vault = {
    token: value.token,
    name: value.name,
    timeoutMinutes: value.timeoutMinutes,
    entries: value.entries || [],
    page: value.page || { total: value.entries?.length || 0, filteredTotal: value.entries?.length || 0, nextCursor: null, hasMore: false },
    backupHistory: value.backupHistory || [],
    stats: value.stats || null,
    compacting: false
  };
  renderVaultState();
}

async function applyVaultStateAndFilters(value) {
  applyVaultState(value);
  if (vaultFiltersActive()) await refreshVaultEntries();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

async function deleteVaultRecord(entry) {
  if (!state.vault || !window.confirm(`确定删除 ${entry.fileNumber} · ${entry.name}？\n\n删除后，已经发给 AI 的这份副本就再也不能换回原文了。如果以后还要逆脱敏，请先“导出备份”。\n\n你的原文件不受影响。`)) return;
  try {
    const value = await window.veilforge.deleteVaultEntry(state.vault.token, entry.id);
    if (state.restoreEntry?.id === entry.id) clearRestoreSession();
    await applyVaultStateAndFilters(value);
    showToast(`${entry.fileNumber} 已删除；可回收 ${formatBytes(value.stats?.reclaimableBytes)}`);
  } catch (error) {
    showToast(`删除失败：${vaultErrorMessage(error)}`, 'error');
  }
}

function clearRestoreSession() {
  state.restoreEntry = null;
  state.restoreResult = null;
  elements.restoreInput.value = '';
  elements.restoreOutput.value = '';
  elements.restoreReport.textContent = '仓库已锁定；重新解锁并载入可逆记录后继续。';
  elements.restoreReport.classList.remove('needs-review');
  elements.restoreExportButton.disabled = true;
  elements.restoreChecklist.replaceChildren();
  elements.restoreChecklist.classList.add('hidden');
  elements.restoreConfirm.checked = false;
  elements.restoreConfirmLabel.classList.add('hidden');
  state.restoreFile = null;
  renderRestoreState();
  updateModuleBadges();
}

async function loadVaultEntry(entryId, { keepInput = false } = {}) {
  if (!state.vault) return;
  try {
    const entry = await window.veilforge.readVaultEntry(state.vault.token, entryId);
    if (entry.kind === 'reversible-map') {
      state.restoreEntry = entry;
      state.restoreResult = null;
      state.sourceName = entry.name;
      state.sourceText = entry.text;
      state.sourceToken = null;
      state.vaultAttachmentToken = null;
      state.vaultAttachmentFiles = 0;
      state.quickEntryMode = null;
      state.findings = [];
      state.image = null;
      state.imageMappingValid = false;
      state.office = null;
      state.officeLongTailReport = null;
      state.officeMappingValid = false;
      state.csv = null;
      state.csvMappingValid = false;
      state.currentPage = 0;
      elements.documentName.textContent = entry.name;
      elements.documentMeta.textContent = `VAULT · 可逆代号副本 · ${entry.mapping.length} 个映射`;
      elements.charCount.textContent = entry.text.length.toLocaleString('zh-CN');
      elements.emptyState.classList.add('hidden');
      elements.editorState.classList.remove('hidden');
      elements.findingsPanel.classList.add('hidden');
      elements.imagePreview.classList.add('hidden');
      elements.exportImageButton.classList.add('hidden');
      elements.exportOfficeButton.classList.add('hidden');
      elements.exportCsvButton.classList.add('hidden');
      elements.exportOcrTextButton.classList.add('hidden');
      elements.sourceEditor.value = entry.text;
      elements.redactedEditor.value = entry.text;
      if (!keepInput) {
        elements.restoreInput.value = '';
        state.restoreFile = null;
      }
      elements.restoreOutput.value = '';
      elements.restoreChecklist.replaceChildren();
      elements.restoreChecklist.classList.add('hidden');
      elements.restoreReport.textContent = keepInput
        ? '已找到对应记录，正在核对…'
        : '导入 AI 返回的文件，或粘贴 AI 的回复，然后点“开始逆脱敏”。';
      elements.restoreReport.classList.remove('needs-review');
      elements.restoreExportButton.disabled = true;
      renderTypes();
      renderVaultState();
      setActiveModule('restore');
      renderRestoreState();
      if (!keepInput) showToast(`已选择 ${entry.fileNumber || ''} · ${entry.name}`);
      return entry;
    }
    state.restoreEntry = null;
    state.restoreResult = null;
      state.sourceName = entry.name;
    state.sourceText = entry.text;
    state.sourceToken = null;
    state.vaultAttachmentToken = null;
    state.vaultAttachmentFiles = 0;
    state.quickEntryMode = null;
    state.reversibleNonce = createTokenNonce();
    state.reversibleCache = null;
    state.image = null;
    state.imageMappingValid = false;
    state.office = null;
    state.officeLongTailReport = null;
    state.officeMappingValid = false;
    state.csv = null;
    state.csvMappingValid = false;
    state.currentPage = 0;
    elements.documentName.textContent = entry.name;
    elements.documentMeta.textContent = `VAULT · ${entry.text.length.toLocaleString('zh-CN')} 字符 · 已从加密仓库载入`;
    elements.charCount.textContent = entry.text.length.toLocaleString('zh-CN');
    elements.emptyState.classList.add('hidden');
    elements.editorState.classList.remove('hidden');
    elements.findingsPanel.classList.remove('hidden');
    elements.imagePreview.classList.add('hidden');
    elements.exportImageButton.classList.add('hidden');
    elements.exportOfficeButton.classList.add('hidden');
    elements.exportCsvButton.classList.add('hidden');
    elements.exportOcrTextButton.classList.add('hidden');
    runAnalysis();
    renderVaultState();
    setActiveModule('redact');
    showToast('已从加密仓库载入脱敏结果');
  } catch (error) {
    showToast(`载入失败：${vaultErrorMessage(error)}`, 'error');
  }
}

function customTerms() {
  return elements.customTerms.value.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
}

const TYPED_TERM_ALIASES = Object.freeze({
  '公司': 'company', '企业': 'company', 'company': 'company',
  '姓名': 'person', '人员': 'person', 'person': 'person',
  '手机': 'mobile', '手机号': 'mobile', 'mobile': 'mobile',
  '固定电话': 'landline', '电话': 'landline', 'landline': 'landline',
  '身份证': 'idcard', '身份证号': 'idcard', 'idcard': 'idcard',
  '信用代码': 'uscc', '统一社会信用代码': 'uscc', 'uscc': 'uscc',
  '邮箱': 'email', 'email': 'email',
  '银行卡': 'bankcard', '银行账号': 'bankcard', 'bankcard': 'bankcard',
  '地址': 'address', 'address': 'address',
  'IPv4': 'ipv4', 'ipv4': 'ipv4',
  '密码': 'secret', '密钥': 'secret', 'secret': 'secret',
  '自定义': 'custom', 'custom': 'custom'
});

function typedTerms() {
  const result = {};
  for (const line of elements.typedTerms.value.split(/\r?\n/)) {
    const separator = line.search(/[：:]/u);
    if (separator < 1) continue;
    const type = TYPED_TERM_ALIASES[line.slice(0, separator).trim()];
    const value = line.slice(separator + 1).trim();
    if (!type || value.length < 2) continue;
    (result[type] ||= []).push(value);
  }
  return result;
}

function alwaysKeepTerms() {
  return elements.alwaysKeepTerms.value.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
}

function clearNerFindings() {
  state.nerFindings = [];
  state.nerText = '';
}

function renderNerState() {
  const loaded = Boolean(state.ner?.loaded);
  elements.nerStatus.textContent = state.nerBusy ? '识别中' : loaded ? '已加载' : '未加载';
  elements.nerStatus.classList.toggle('loaded', loaded);
  elements.nerStatus.classList.toggle('busy', state.nerBusy);
  elements.nerSelectButton.disabled = state.nerBusy;
  elements.nerClearButton.disabled = state.nerBusy || !loaded;
  elements.nerAnalyzeButton.disabled = state.nerBusy || !loaded || !state.sourceText;
  elements.nerAnalyzeButton.textContent = state.nerBusy ? '正在本机推理…' : '运行离线语义识别';
  if (!loaded) {
    elements.nerMeta.textContent = state.ner?.reason === 'LOCAL_NER_BUNDLED_PACK_MISSING'
      ? '随包模型未安装；可选择含 model.onnx、vocab.txt 和 config.json 的本机目录。'
      : '正在校验随包中文模型；也可以选择兼容的本机模型目录。';
    return;
  }
  const size = Number(state.ner.modelBytes || 0) / (1024 * 1024);
  const verified = state.ner.modelPackVerified ? ` · 固定哈希已校验 · ${state.ner.modelPackId}` : ' · 外部模型目录';
  elements.nerMeta.textContent = `${state.ner.name || '本地模型'} · ${size.toFixed(1)} MB · ${state.ner.vocabSize || 0} 词 · SHA256 ${String(state.ner.modelSha256 || '').slice(0, 12)}…${verified}`;
}

async function initializeBundledNer() {
  if (typeof window.veilforge?.loadBundledNer !== 'function') return;
  try {
    state.nerBusy = true;
    renderNerState();
    const value = await window.veilforge.loadBundledNer();
    state.ner = value;
    if (value?.loaded) showToast(`随包中文模型已校验：${value.modelPackId}`);
  } catch (error) {
    state.ner = { loaded: false, reason: String(error?.message || error) };
    showToast(`随包模型校验失败：${friendlyError(error)}`, 'error');
  } finally {
    state.nerBusy = false;
    renderNerState();
  }
}

function renderOcrBackendState() {
  const value = state.ocrBackend;
  const rapid = value?.backend === 'rapidocr-ppocrv6';
  elements.ocrBackendStatus.textContent = state.ocrBackendBusy ? '检测中' : rapid ? 'RapidOCR' : 'Tesseract';
  elements.ocrBackendStatus.classList.toggle('loaded', rapid);
  elements.ocrBackendStatus.classList.toggle('busy', state.ocrBackendBusy);
  elements.ocrRapidButton.disabled = state.ocrBackendBusy || rapid;
  elements.ocrTesseractButton.disabled = state.ocrBackendBusy || !rapid;
  if (!value) {
    elements.ocrBackendMeta.textContent = '正在校验固定哈希 PP-OCRv6 模型包。';
  } else if (rapid) {
    const runtime = value.runtimePack?.id
      ? ` · 内置运行时 ${value.runtimePack.id} 已校验`
      : ' · 外部 Python 运行时';
    elements.ocrBackendMeta.textContent = `${value.modelPack?.id || 'PP-OCRv6'} · 固定哈希已校验${runtime} · Python ${value.runtimePack?.pythonVersion || value.python || ''}`;
  } else {
    const pack = value.rapidOcrPack?.id ? ` · 可选包 ${value.rapidOcrPack.id} 已校验` : ' · PP-OCRv6 模型包未安装';
    elements.ocrBackendMeta.textContent = `当前使用 Tesseract.js${pack}`;
  }
}

async function initializeOcrBackend() {
  try {
    state.ocrBackendBusy = true;
    renderOcrBackendState();
    state.ocrBackend = await window.veilforge.getOcrBackendState();
  } catch (error) {
    state.ocrBackend = { backend: 'tesseract', error: String(error?.message || error) };
  } finally {
    state.ocrBackendBusy = false;
    renderOcrBackendState();
  }
}

function reversiblePreview() {
  const enabled = state.findings.filter((item) => item.enabled);
  const fingerprint = `${state.reversibleNonce}\u0000${state.sourceText}\u0000${enabled.map((item) => `${item.type}:${item.start}:${item.end}`).join('|')}`;
  if (state.reversibleCache?.fingerprint === fingerprint) return state.reversibleCache.value;
  const value = tokenizeFindings(state.sourceText, enabled, { nonce: state.reversibleNonce });
  state.reversibleCache = { fingerprint, value };
  return value;
}

function redactedText() {
  if (state.style === 'token') return reversiblePreview().tokenizedText;
  return applyFindings(state.sourceText, state.findings);
}

function currentImagePage() {
  return state.image?.pages?.[state.currentPage] || null;
}

function renderImageOverlay() {
  elements.imageOverlay.replaceChildren();
  if (!state.image || !state.imageMappingValid) return;
  const page = currentImagePage();
  if (!page) return;
  for (const table of page.gridTables || []) {
    for (const cell of table.cells || []) {
      const box = document.createElement('span');
      box.className = `layout-cell-box ${cell.merged ? 'merged' : ''}`;
      box.style.left = `${cell.bbox.x0 / page.width * 100}%`;
      box.style.top = `${cell.bbox.y0 / page.height * 100}%`;
      box.style.width = `${(cell.bbox.x1 - cell.bbox.x0) / page.width * 100}%`;
      box.style.height = `${(cell.bbox.y1 - cell.bbox.y0) / page.height * 100}%`;
      elements.imageOverlay.append(box);
    }
  }
  for (const column of page.columns || []) {
    const box = document.createElement('span');
    box.className = 'layout-column-box';
    box.style.left = `${column.bbox.x0 / page.width * 100}%`;
    box.style.top = `${column.bbox.y0 / page.height * 100}%`;
    box.style.width = `${(column.bbox.x1 - column.bbox.x0) / page.width * 100}%`;
    box.style.height = `${(column.bbox.y1 - column.bbox.y0) / page.height * 100}%`;
    elements.imageOverlay.append(box);
  }
  const seen = new Set();
  for (const finding of state.findings.filter((item) => item.enabled)) {
    for (const word of page.words) {
      if (finding.start >= word.end || word.start >= finding.end) continue;
      const key = `${word.bbox.x0}:${word.bbox.y0}:${word.bbox.x1}:${word.bbox.y1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const box = document.createElement('span');
      box.className = 'redaction-box';
      box.style.left = `${word.bbox.x0 / page.width * 100}%`;
      box.style.top = `${word.bbox.y0 / page.height * 100}%`;
      box.style.width = `${(word.bbox.x1 - word.bbox.x0) / page.width * 100}%`;
      box.style.height = `${(word.bbox.y1 - word.bbox.y0) / page.height * 100}%`;
      elements.imageOverlay.append(box);
    }
  }
}

function renderImagePage() {
  const page = currentImagePage();
  if (!page) return;
  elements.imageElement.src = page.previewDataUrl;
  const details = [page.textMode === 'native' ? '原生文本' : `OCR ${page.confidence}%`, `${page.width}×${page.height}`];
  if (page.enhancement?.upscaled) details.push(`低分辨率增强 ×${page.enhancement.scale}`);
  if (page.orientationDetected) details.push(`方向校正 ${page.orientationDegrees}°`);
  if (page.tableRegions?.length) details.push(`表格 ${page.tableRegions.length} 区`);
  if (page.gridTables?.length) details.push(`网格 ${page.gridTables.length} 表 / 合并 ${page.gridTables.reduce((sum, table) => sum + table.mergedCells, 0)} 格`);
  if (page.columns?.length > 1) details.push(`${page.columns.length} 栏阅读顺序`);
  if (page.recognitionPasses > 1) details.push(`分段重试 ${page.recognitionPasses} 次`);
  if (page.backend === 'rapidocr-ppocrv6') details.push(`RapidOCR · ${page.modelPack?.id || 'PP-OCRv6'}`);
  else if (page.backend === 'tesseract') details.push('Tesseract');
  elements.ocrMeta.textContent = details.join(' · ');
  elements.pageIndicator.textContent = `${state.currentPage + 1} / ${state.image.pageCount}`;
  elements.pagePreviousButton.disabled = state.currentPage === 0;
  elements.pageNextButton.disabled = state.currentPage >= state.image.pageCount - 1;
  elements.pageControls.classList.toggle('hidden', state.image.pageCount < 2);
  renderOcrCorrections(page);
  renderImageOverlay();
}

function renderOcrCorrections(page) {
  const corrections = page?.textMode === 'native' ? [] : (page?.corrections || []);
  elements.ocrCorrectionPanel.classList.toggle('hidden', corrections.length === 0);
  elements.ocrCorrectionSummary.textContent = `${corrections.length} 项待复核 · 低于 72%`;
  elements.ocrCorrectionList.replaceChildren();
  for (const item of corrections) {
    const row = document.createElement('label');
    row.className = 'ocr-correction-row';
    const confidence = document.createElement('span');
    confidence.textContent = `${Math.round(item.confidence)}%`;
    const input = document.createElement('input');
    input.className = 'ocr-correction-input';
    input.value = item.text;
    input.dataset.original = item.text;
    input.dataset.wordIndex = String(item.wordIndex);
    input.maxLength = 128;
    input.setAttribute('aria-label', `校正 ${item.text}`);
    row.append(confidence, input);
    elements.ocrCorrectionList.append(row);
  }
}

function renderTypes() {
  elements.typeList.replaceChildren();
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    const row = document.createElement('label');
    row.className = 'type-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.enabledTypes.has(type);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.enabledTypes.add(type); else state.enabledTypes.delete(type);
      updateModuleBadges();
      runAnalysis();
    });
    const dot = document.createElement('span');
    dot.className = `type-dot type-${type}`;
    const name = document.createElement('span');
    name.textContent = label;
    const count = document.createElement('b');
    count.textContent = String(state.findings.filter((item) => item.type === type).length);
    row.append(checkbox, dot, name, count);
    elements.typeList.append(row);
  }
  updateModuleBadges();
}

function renderFindings() {
  elements.findingList.replaceChildren();
  if (!state.findings.length) {
    const empty = document.createElement('div');
    empty.className = 'no-findings';
    empty.textContent = '当前规则没有发现敏感信息。可以补充自定义词或直接编辑原文。';
    elements.findingList.append(empty);
  }
  for (const finding of state.findings) {
    const row = document.createElement('div');
    row.className = `finding-row ${finding.enabled ? '' : 'disabled'} ${finding.reviewRequired ? 'needs-review' : ''} ${finding.source === 'manual' ? 'manual' : ''}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = finding.enabled;
    checkbox.setAttribute('aria-label', `处理 ${finding.value}`);
    checkbox.addEventListener('change', () => {
      finding.enabled = checkbox.checked;
      row.classList.toggle('disabled', !finding.enabled);
      refreshPreview();
    });
    const badge = document.createElement('span');
    badge.className = `finding-badge type-${finding.type}`;
    badge.textContent = finding.source === 'onnx'
      ? `${finding.label} · ${Math.round(Number(finding.confidence || 0) * 100)}%`
      : finding.label;
    if (finding.reviewRequired) badge.title = finding.source === 'onnx' ? '模型置信度低于自动采纳阈值，请人工复核后勾选' : '位置可能是词的一部分，请人工复核';
    const value = document.createElement('code');
    value.textContent = finding.value;
    value.className = 'locatable';
    value.title = '点击在原文中定位';
    value.addEventListener('click', () => selectSourceRange(finding.start, finding.end));
    const arrow = document.createElement('span');
    arrow.className = 'finding-arrow';
    arrow.textContent = '→';
    const replacement = document.createElement('code');
    replacement.className = 'replacement';
    replacement.textContent = finding.replacement;
    row.append(checkbox, badge, value, arrow, replacement);
    if (finding.hint) {
      const hint = document.createElement('span');
      hint.className = 'finding-hint';
      hint.textContent = finding.hint;
      row.append(hint);
    }
    if (finding.source === 'manual') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini-button';
      remove.textContent = '移除';
      remove.title = '撤销这一处手动补选';
      remove.addEventListener('click', () => removeManualFinding(finding));
      row.append(remove);
    }
    elements.findingList.append(row);
  }
}

function selectSourceRange(start, end) {
  const editor = elements.sourceEditor;
  document.querySelector('[data-tab="source"]')?.click();
  editor.focus();
  editor.setSelectionRange(start, end);
  const before = editor.value.slice(0, start).split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 18;
  editor.scrollTop = Math.max(0, before * lineHeight - editor.clientHeight / 3);
}

function renderExportAudit() {
  const box = elements.exportAuditBox;
  if (!box) return;
  box.replaceChildren();
  if (!state.sourceText || state.restoreEntry) { box.classList.add('hidden'); return; }
  const audit = auditBeforeExport(state.sourceText, state.findings, { enabledTypes: [...state.enabledTypes] });
  state.exportAudit = audit;
  box.classList.toggle('hidden', !audit.total);
  if (!audit.total) return;
  const title = document.createElement('strong');
  title.textContent = `${audit.summary}（不拦导出，请确认是否有意保留）`;
  box.append(title);
  for (const item of audit.items.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'audit-row';
    const label = document.createElement('span');
    label.textContent = TYPE_LABELS[item.type] || item.type;
    const code = document.createElement('code');
    code.textContent = item.masked;
    const reason = document.createElement('span');
    reason.className = 'muted';
    reason.textContent = item.reasonLabel;
    const locate = document.createElement('button');
    locate.type = 'button';
    locate.className = 'mini-button';
    locate.textContent = '定位';
    locate.addEventListener('click', () => selectSourceRange(item.start, item.end));
    row.append(label, code, reason, locate);
    if (item.fixable) {
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'mini-button';
      fix.textContent = '隐藏这一处';
      fix.addEventListener('click', () => hideAuditItem(item));
      row.append(fix);
    }
    box.append(row);
  }
  if (audit.items.length > 50) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.textContent = `另有 ${audit.items.length - 50} 处未列出`;
    box.append(more);
  }
}

function hideAuditItem(item) {
  const existing = state.findings.find((finding) => finding.start === item.start && finding.end === item.end);
  if (existing) {
    existing.enabled = true;
    state.reversibleCache = null;
    renderFindings();
    refreshPreview();
    return;
  }
  // 人工补选绑定当前原文；重新识别时作为外部候选并入，原文被编辑后自动失效。
  state.manualFindings.push({ type: item.type, start: item.start, end: item.end, confidence: 1, source: 'manual', sourceText: state.sourceText });
  runAnalysis();
}

// ---------- 手动补选：在原文中选中文字后隐藏 ----------

const TYPE_TERM_KEYS = Object.freeze({
  company: '公司', person: '姓名', mobile: '手机', landline: '固定电话', idcard: '身份证', uscc: '信用代码',
  email: '邮箱', bankcard: '银行卡', address: '地址', ipv4: 'IPv4', secret: '密码', custom: '自定义'
});

function currentSelection() {
  const editor = elements.sourceEditor;
  if (!state.sourceText || elements.sourceEditorWrap.classList.contains('hidden') || state.restoreEntry) return null;
  if (editor.value !== state.sourceText) return null;
  let start = editor.selectionStart;
  let end = editor.selectionEnd;
  if (!(end > start)) return null;
  // 去掉选区首尾的空白，避免把空格换行也隐藏进去。
  while (start < end && /\s/u.test(state.sourceText[start])) start += 1;
  while (end > start && /\s/u.test(state.sourceText[end - 1])) end -= 1;
  if (!(end > start)) return null;
  return { start, end, value: state.sourceText.slice(start, end) };
}

const COMMON_SURNAMES = new Set([...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明佘池查麻苑迟邝'].filter(Boolean));
const COMPOUND_SURNAMES = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '令狐', '长孙', '宇文', '司徒', '夏侯', '端木', '轩辕'];

function guessSelectionType(value) {
  const probe = analyzeText(value, { propagateRepeats: false });
  const whole = probe.findings.find((item) => item.start === 0 && item.end === value.length);
  if (whole) return whole.type;
  if (/(?:有限公司|有限责任公司|集团|公司|事务所|研究院|银行|医院|学校|大学)$/u.test(value)) return 'company';
  const compact = value.replace(/[\s\u3000\u00A0]/gu, '');
  if (/^[\p{Script=Han}·]{2,4}$/u.test(compact) &&
      (COMMON_SURNAMES.has(compact[0]) || COMPOUND_SURNAMES.some((surname) => compact.startsWith(surname)) || /^[老小阿]/u.test(compact))) return 'person';
  if (/(?:省|市|区|县|镇|乡|路|街|号|室|楼|栋|单元)/u.test(value) && value.length >= 6) return 'address';
  return 'custom';
}

function renderSelectionTypeOptions() {
  if (elements.selectionType.options.length) return;
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = label;
    elements.selectionType.append(option);
  }
}

let lastSelectionKey = '';
function updateSelectionBar() {
  const selection = currentSelection();
  const active = Boolean(selection);
  elements.selectionBar.classList.toggle('active', active);
  elements.selectionBar.classList.toggle('idle', !active);
  elements.selectionActions.classList.toggle('hidden', !active);
  elements.selectionHint.classList.toggle('hidden', active);
  if (!active) { lastSelectionKey = ''; return; }
  renderSelectionTypeOptions();
  const key = `${selection.start}:${selection.end}`;
  if (key !== lastSelectionKey) {
    // 只在选区变化时重新猜类型，避免覆盖用户刚改的类型。
    lastSelectionKey = key;
    elements.selectionType.value = guessSelectionType(selection.value);
  }
  const chars = [...selection.value];
  elements.selectionPreview.textContent = chars.length > 24 ? `${chars.slice(0, 24).join('')}…（${chars.length} 字）` : selection.value;
  elements.selectionPreview.title = selection.value;
  const singleLine = !selection.value.includes('\n');
  elements.selectionHideAllButton.disabled = !singleLine || chars.length < 2;
  elements.selectionKeepButton.disabled = !singleLine || chars.length < 2;
}

function appendTermLine(textarea, line) {
  const existing = textarea.value.split(/\r?\n/).map((item) => item.trim());
  if (existing.includes(line)) return false;
  textarea.value = `${textarea.value.replace(/\s*$/u, '')}${textarea.value.trim() ? '\n' : ''}${line}`;
  return true;
}

function hideSelectionOnce() {
  const selection = currentSelection();
  if (!selection) return;
  const type = elements.selectionType.value || 'custom';
  state.manualFindings = state.manualFindings.filter((item) =>
    !(item.sourceText === state.sourceText && item.start < selection.end && selection.start < item.end));
  state.manualFindings.push({ type, start: selection.start, end: selection.end, confidence: 1, source: 'manual', sourceText: state.sourceText });
  runAnalysis();
  elements.sourceEditor.setSelectionRange(selection.end, selection.end);
  updateSelectionBar();
  showToast(`已补选隐藏：${TYPE_LABELS[type]}`);
}

function hideSelectionEverywhere() {
  const selection = currentSelection();
  if (!selection || selection.value.includes('\n') || [...selection.value].length < 2) return;
  const type = elements.selectionType.value || 'custom';
  // 写进“类型化隐藏词”，以后重新识别也会生效，并且用户能看到、能删。
  appendTermLine(elements.typedTerms, `${TYPE_TERM_KEYS[type] || '自定义'}：${selection.value}`);
  // 若该词之前被设为“总是保留”，一并移除。
  elements.alwaysKeepTerms.value = elements.alwaysKeepTerms.value.split(/\r?\n/).filter((line) => line.trim() !== selection.value).join('\n');
  runAnalysis();
  const count = state.findings.filter((item) => item.value === selection.value).length;
  elements.sourceEditor.setSelectionRange(selection.end, selection.end);
  updateSelectionBar();
  showToast(`全文已隐藏 ${count} 处“${selection.value}”，已加入左侧类型化隐藏词`);
}

function keepSelection() {
  const selection = currentSelection();
  if (!selection || selection.value.includes('\n') || [...selection.value].length < 2) return;
  appendTermLine(elements.alwaysKeepTerms, selection.value);
  state.manualFindings = state.manualFindings.filter((item) => !(item.sourceText === state.sourceText && item.start === selection.start && item.end === selection.end));
  runAnalysis();
  elements.sourceEditor.setSelectionRange(selection.end, selection.end);
  updateSelectionBar();
  showToast(`“${selection.value}”已设为不隐藏（加入左侧总是保留词）`);
}

function removeManualFinding(finding) {
  state.manualFindings = state.manualFindings.filter((item) =>
    !(item.sourceText === state.sourceText && item.start === finding.start && item.end === finding.end));
  runAnalysis();
  showToast('已撤销这一处手动补选');
}

// ---------- 原文高亮 ----------
const HIGHLIGHT_LIMIT = 600000; // 超长文档不做高亮，避免界面卡顿

function renderSourceHighlight() {
  const layer = elements.sourceHighlight;
  if (!layer) return;
  const text = elements.sourceEditor.value;
  if (!text || text !== state.sourceText || text.length > HIGHLIGHT_LIMIT) {
    layer.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  const findings = state.findings.slice().sort((left, right) => left.start - right.start);
  for (const finding of findings) {
    if (finding.start < cursor) continue;
    if (finding.start > cursor) fragment.append(text.slice(cursor, finding.start));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(finding.start, finding.end);
    mark.className = !finding.enabled ? 'hl-off' : finding.source === 'manual' ? 'hl-manual' : finding.reviewRequired ? 'hl-review' : '';
    fragment.append(mark);
    cursor = finding.end;
  }
  // 末尾补一个零宽字符，保证最后一行换行时高度一致。
  fragment.append(`${text.slice(cursor)}\u200b`);
  layer.replaceChildren(fragment);
  syncHighlightScroll();
}

function syncHighlightScroll() {
  elements.sourceHighlight.scrollTop = elements.sourceEditor.scrollTop;
  elements.sourceHighlight.scrollLeft = elements.sourceEditor.scrollLeft;
}

// ---------- 导出栏 ----------
function primaryExportKind() {
  if (state.quickEntryMode === 'image-to-text') return 'txt';
  if (state.office && state.officeMappingValid) return state.office.kind;
  if (state.csv && state.csvMappingValid) return 'csv';
  if (state.image && state.imageMappingValid) return state.image.kind === 'pdf' ? 'pdf' : 'image';
  return 'txt';
}

const EXPORT_FORMAT_LABELS = { txt: 'TXT 文本', docx: 'Word（DOCX）', xlsx: 'Excel（XLSX）', csv: 'CSV', pdf: 'PDF', image: 'PNG 图片（涂黑）' };

function exportIsReversible(kind = primaryExportKind()) {
  return state.style === 'token' && kind !== 'image';
}

function renderExportBar() {
  if (!elements.exportSummary) return;
  const kind = primaryExportKind();
  const count = state.findings.filter((item) => item.enabled).length;
  const reversible = exportIsReversible(kind);
  elements.exportSummary.textContent = reversible
    ? `${count.toLocaleString('zh-CN')} 处将换成代号 · 导出为 ${EXPORT_FORMAT_LABELS[kind]}`
    : `${count.toLocaleString('zh-CN')} 处将隐藏（不可逆）· 导出为 ${EXPORT_FORMAT_LABELS[kind]}`;
  elements.exportSummaryDetail.textContent = reversible
    ? '对照表先加密存入文件仓库并得到编号，AI 返回后可换回原文'
    : kind === 'image'
      ? '图片只能涂黑导出，无法换回原文'
      : '当前在保护设置里选了不可逆方式，导出后无法换回原文';
  elements.exportPrimaryButton.disabled = !state.sourceText || !count || !elements.exportConfirm.checked || Boolean(state.restoreEntry);
  elements.exportPrimaryButton.title = !count ? '没有要隐藏的内容' : !elements.exportConfirm.checked ? '请先勾选“我已核对要隐藏的信息”' : '';
}

function refreshPreview() {
  renderExportBar();
  renderSourceHighlight();
  renderExportAudit();
  elements.redactedEditor.value = redactedText();
  elements.findingCount.textContent = String(state.findings.length);
  elements.enabledCount.textContent = String(state.findings.filter((item) => item.enabled).length);
  renderTypes();
  renderImageOverlay();
  if (state.image?.kind === 'pdf') elements.exportImageButton.textContent = state.style === 'token' ? '导出可逆代号 PDF' : '导出涂黑 PDF';
  if (state.csv) elements.exportCsvButton.textContent = state.style === 'token' ? '导出可逆代号 CSV' : '导出原格式 CSV';
}

function runAnalysis() {
  const previousEnabled = new Map(state.findings.map((item) => [`${item.type}:${item.start}:${item.end}`, item.enabled]));
  const result = analyzeText(state.sourceText, {
    style: state.style,
    enabledTypes: [...state.enabledTypes],
    customTerms: customTerms(),
    typedTerms: typedTerms(),
    alwaysKeepTerms: alwaysKeepTerms(),
    externalFindings: [
      ...(state.nerText === state.sourceText ? state.nerFindings : []),
      ...state.manualFindings.filter((item) => item.sourceText === state.sourceText)
    ]
  });
  state.findings = result.findings.map((item) => ({
    ...item,
    enabled: previousEnabled.get(`${item.type}:${item.start}:${item.end}`) ?? item.enabled
  }));
  elements.sourceEditor.value = state.sourceText;
  renderFindings();
  refreshPreview();
}

function applyDocumentResult(result, message = '文档已在本机解析完成') {
  state.sourceName = result.name;
  state.sourceText = result.text;
  state.sourceToken = result.sourceToken || null;
  state.vaultAttachmentToken = null;
  state.vaultAttachmentFiles = 0;
  state.quickEntryMode = result.quickEntry || null;
  state.image = result.image || null;
  state.imageMappingValid = Boolean(result.image);
  state.office = result.office || null;
  state.officeLongTailReport = result.officeLongTailReport || result.office?.longTailReport || null;
  state.officeMappingValid = Boolean(result.office);
  state.csv = result.csv || null;
  state.csvMappingValid = Boolean(result.csv);
  state.currentPage = 0;
  state.reversibleNonce = createTokenNonce();
  state.reversibleCache = null;
  state.manualFindings = [];
  state.unexported = true;
  state.lastExport = null;
  if (elements.exportConfirm) elements.exportConfirm.checked = false;
  state.restoreEntry = null;
  setActiveModule('redact');
  renderWorkflowProgress('review');
  state.restoreResult = null;
  clearNerFindings();
  elements.documentName.textContent = result.name;
  const pdfFeatures = result.image?.kind === 'pdf' ? result.image.pdfFeatures : null;
  const structureMeta = pdfFeatures
    ? ` · 表单 ${pdfFeatures.formFields} · 批注 ${pdfFeatures.annotations} · 字体 ${pdfFeatures.fontResources} · 旋转页 ${pdfFeatures.rotatedPages || 0} · 裁剪页 ${pdfFeatures.croppedPages || 0}`
    : '';
  const signatureMeta = pdfFeatures?.signedSignatures
    ? ` · 已签名 ${pdfFeatures.signedSignatures} 处（导出将使签名失效）`
    : '';
  const compatibilityMeta = pdfFeatures
    ? `${pdfFeatures.pdfaDeclared ? ` · PDF/A-${pdfFeatures.pdfaPart || '?'}${pdfFeatures.pdfaConformance || ''} 声明` : ''}${pdfFeatures.hasXfa ? ' · XFA（保留但未验证）' : ''}`
    : '';
  const csvMeta = result.csv
    ? ` · ${result.csv.encoding.toUpperCase()}${result.csv.bom ? '+BOM' : ''} · ${result.csv.delimiterName}分隔 · ${result.csv.lineEndingName} · ${result.csv.rows} 行 × ${result.csv.columns} 列`
    : '';
  const officeReport = state.officeLongTailReport;
  const officeMeta = officeReport
    ? ` · 长尾 ${officeReport.detectedFeatures?.length || 0} 项 · 降级 ${officeReport.degradationCount || 0} 项`
    : '';
  elements.documentMeta.textContent = `${result.extension.toUpperCase().slice(1)} · ${result.sourceBytes.toLocaleString('zh-CN')} bytes · 本地解析${csvMeta}${structureMeta}${compatibilityMeta}${signatureMeta}${officeMeta}`;
  elements.charCount.textContent = result.characters.toLocaleString('zh-CN');
  elements.emptyState.classList.add('hidden');
  elements.editorState.classList.remove('hidden');
  elements.findingsPanel.classList.remove('hidden');
  elements.imagePreview.classList.toggle('hidden', !state.image);
  elements.exportImageButton.classList.toggle('hidden', !state.image);
  elements.exportOfficeButton.classList.toggle('hidden', !state.office);
  elements.exportCsvButton.classList.toggle('hidden', !state.csv);
  elements.exportOcrTextButton.classList.toggle('hidden', state.quickEntryMode !== 'image-to-text');
  if (state.office) elements.exportOfficeButton.textContent = `导出原格式 ${state.office.kind.toUpperCase()}`;
  if (state.csv) {
    elements.exportCsvButton.disabled = false;
    elements.exportCsvButton.textContent = state.style === 'token' ? '导出可逆代号 CSV' : '导出原格式 CSV';
  }
  if (state.image) {
    elements.previewTitle.textContent = state.image.kind === 'pdf' ? 'PDF 原版式预览' : '图片原版式预览';
    elements.exportImageButton.textContent = state.image.kind === 'pdf' ? '导出涂黑 PDF' : '导出涂黑图片';
    elements.mappingState.textContent = '坐标映射有效';
    elements.mappingState.classList.remove('stale');
    renderImagePage();
  }
  runAnalysis();
  renderNerState();
  renderVaultState();
  showToast(message);
}

const BATCH_STATUS = {
  queued: ['等待中', 'queued'],
  processing: ['处理中', 'processing'],
  done: ['已完成', 'done'],
  failed: ['失败', 'failed'],
  canceled: ['已取消', 'canceled']
};

function renderBatchJobs() {
  const jobs = [...state.batchJobs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  elements.batchPanel.classList.toggle('hidden', jobs.length === 0);
  updateModuleBadges();
  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'processing').length;
  const done = jobs.filter((job) => job.status === 'done').length;
  elements.batchSummary.textContent = state.batchExport
    ? `正在导出 ${state.batchExport.exported || 0}/${state.batchExport.total || done} · ${state.batchExport.failed || 0} 失败`
    : `${jobs.length} 个任务 · ${active} 进行中 · ${done} 完成`;
  elements.batchExportButton.textContent = state.batchExport
    ? state.batchExport.cancelRequested ? '停止中…' : '停止导出'
    : '批量导出';
  elements.batchExportButton.disabled = state.batchExport?.cancelRequested || (!state.batchExport && done === 0);
  elements.batchClearButton.disabled = Boolean(state.batchExport);
  elements.batchList.replaceChildren();
  for (const job of jobs) {
    const row = document.createElement('div');
    row.className = `batch-row batch-${BATCH_STATUS[job.status]?.[1] || 'queued'}`;
    const icon = document.createElement('span');
    icon.className = 'batch-status-dot';
    const details = document.createElement('div');
    details.className = 'batch-details';
    const name = document.createElement('strong');
    name.textContent = job.name;
    const meta = document.createElement('span');
    const resultMeta = job.result ? ` · ${job.result.characters.toLocaleString('zh-CN')} 字符` : '';
    meta.textContent = `${BATCH_STATUS[job.status]?.[0] || job.status}${resultMeta}${job.error ? ` · ${job.error}` : ''}`;
    const progress = document.createElement('div');
    progress.className = 'batch-progress';
    const progressValue = document.createElement('i');
    progressValue.style.width = `${job.progress || 0}%`;
    progress.append(progressValue);
    details.append(name, meta, progress);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button button-small button-ghost';
    if (job.status === 'done') {
      action.textContent = '打开复核';
      action.addEventListener('click', () => openBatchJob(job.id));
    } else if (job.status === 'queued') {
      action.textContent = '取消';
      action.addEventListener('click', () => cancelBatchJob(job.id));
    } else {
      action.textContent = BATCH_STATUS[job.status]?.[0] || job.status;
      action.disabled = true;
    }
    row.append(icon, details, action);
    elements.batchList.append(row);
  }
}

async function openBatchJob(id) {
  try {
    const result = await window.veilforge.openBatchResult(id);
    applyDocumentResult(result, '批处理结果已载入，可继续人工复核');
  } catch (error) {
    showToast(`载入任务失败：${friendlyError(error)}`, 'error');
  }
}

async function cancelBatchJob(id) {
  try {
    const response = await window.veilforge.cancelBatchJob(id);
    state.batchJobs.set(id, response.job);
    renderBatchJobs();
  } catch (error) {
    showToast(`取消失败：${friendlyError(error)}`, 'error');
  }
}

async function enqueueDroppedFiles(files) {
  if (!files?.length) return;
  try {
    const jobs = await window.veilforge.enqueueDroppedFiles(files);
    for (const job of jobs) state.batchJobs.set(job.id, job);
    renderBatchJobs();
    showToast(`已加入 ${jobs.length} 个后台任务`);
  } catch (error) {
    showToast(`批量导入失败：${friendlyError(error)}`, 'error');
  }
}

async function pickBatchDocuments() {
  try {
    const jobs = await window.veilforge.pickBatchDocuments();
    if (!jobs?.length) return;
    for (const job of jobs) state.batchJobs.set(job.id, job);
    renderBatchJobs();
    setActiveModule('batch');
    showToast(`已选择 ${jobs.length} 个文件，正在本机依次处理`);
  } catch (error) {
    showToast(`批量选择失败：${friendlyError(error)}`, 'error');
  }
}

async function openDocument() {
  if (!confirmDiscardUnexported('导入新文档')) return;
  try {
    let result = await window.veilforge.pickDocument();
    if (!result) return;
    if (result.passwordRequired) {
      let error = '';
      while (result?.passwordRequired) {
        const password = await requestPdfPassword(result.name, error);
        if (password === null) return;
        try {
          result = await window.veilforge.openEncryptedPdf(result.passwordToken, password);
        } catch (passwordError) {
          const message = String(passwordError?.message || passwordError);
          if (message.includes('LOCAL_PDF_PASSWORD_INVALID')) {
            error = '密码错误，请重新输入。';
            continue;
          }
          throw passwordError;
        }
      }
    }
    applyDocumentResult(result);
  } catch (error) {
    const message = String(error?.message || error);
    showToast(`导入失败：${friendlyError(message)}`, 'error');
  }
}

async function openImageToText() {
  if (!confirmDiscardUnexported('导入新图片')) return;
  try {
    const result = await window.veilforge.pickImageForText();
    if (!result) return;
    applyDocumentResult(result, '图片文字已在本机识别，可人工校正后导出 TXT');
  } catch (error) {
    showToast(`图片转 TXT 失败：${friendlyError(error)}`, 'error');
  }
}

// ---------- 未导出内容保护 ----------
function confirmDiscardUnexported(action = '继续') {
  if (!state.unexported || !state.sourceText || state.restoreEntry) return true;
  return window.confirm(`当前文档还没有导出。${action}会清除这次的核对结果（包括手动补选）。\n\n确定要${action}吗？`);
}

function reset() {
  state.sourceName = '';
  state.sourceText = '';
  state.sourceToken = null;
  state.vaultAttachmentToken = null;
  state.vaultAttachmentFiles = 0;
  state.quickEntryMode = null;
  state.findings = [];
  state.image = null;
  state.imageMappingValid = false;
  state.office = null;
  state.officeLongTailReport = null;
  state.officeMappingValid = false;
  state.csv = null;
  state.csvMappingValid = false;
  state.currentPage = 0;
  state.reversibleNonce = createTokenNonce();
  state.reversibleCache = null;
  state.restoreEntry = null;
  state.restoreResult = null;
  state.unexported = false;
  state.manualFindings = [];
  setActiveModule('redact');
  renderWorkflowProgress('import');
  clearNerFindings();
  elements.sourceEditor.value = '';
  elements.redactedEditor.value = '';
  elements.documentName.textContent = '未导入文档';
  elements.documentMeta.textContent = '支持文档、图片 OCR 与多页 PDF 涂黑导出';
  elements.charCount.textContent = '0';
  elements.findingCount.textContent = '0';
  elements.enabledCount.textContent = '0';
  elements.emptyState.classList.remove('hidden');
  elements.editorState.classList.add('hidden');
  elements.findingsPanel.classList.add('hidden');
  elements.imagePreview.classList.add('hidden');
  elements.exportImageButton.classList.add('hidden');
  elements.exportOfficeButton.classList.add('hidden');
  elements.exportCsvButton.classList.add('hidden');
  elements.exportOcrTextButton.classList.add('hidden');
  elements.pageControls.classList.add('hidden');
  renderTypes();
  renderNerState();
  renderVaultState();
}

function currentVaultEntryPayload({ includeAttachments = false } = {}) {
  const enabled = state.findings.filter((item) => item.enabled);
  const reversible = state.style === 'token' ? reversiblePreview() : null;
  return {
    token: state.vault?.token,
    kind: reversible ? 'reversible-map' : 'redacted-text',
    name: `${state.sourceName || '脱敏结果'} · ${reversible ? '可逆副本' : '脱敏'}`,
    text: reversible?.tokenizedText || redactedText(),
    mapping: reversible?.mapping,
    findingCount: enabled.length,
    findingTypes: enabled.map((item) => item.type),
    attachmentToken: includeAttachments ? state.vaultAttachmentToken : undefined
  };
}

async function saveCurrentToVault({ notify = false, includeAttachments = false } = {}) {
  if (!state.vault || !state.sourceText || state.restoreEntry) throw new Error('LOCAL_VAULT_SAVE_NOT_READY');
  const reversible = state.style === 'token';
  const value = await window.veilforge.saveVaultEntry(currentVaultEntryPayload({ includeAttachments }));
  if (value.attachmentResult) {
    state.vaultAttachmentToken = null;
    state.vaultAttachmentFiles = 0;
  }
  await applyVaultStateAndFilters(value);
  if (notify) {
    const attachmentMessage = value.attachmentResult
      ? `，附件 ${value.attachmentResult.files} 个，新密文 ${value.attachmentResult.newBlobs} 个，内容去重 ${value.attachmentResult.deduplicated} 个`
      : '';
    showToast(`${reversible ? '可逆代号和映射已加密保存' : '当前脱敏结果已加密保存'}${attachmentMessage}`);
  }
  return value;
}

async function exportResult(kind, options = {}) {
  if (!state.sourceText) return null;
  try {
    const enabled = state.findings.filter((item) => item.enabled);
    const tokenAssignments = state.style === 'token'
      ? new Map(reversiblePreview().assignments.map((item) => [`${item.start}:${item.end}`, item.token]))
      : null;
    const result = await window.veilforge.exportResult({
      kind,
      imageToken: state.image?.token,
      officeToken: state.office?.token,
      csvToken: state.csv?.token,
      sourceToken: state.sourceToken,
      sourceName: state.sourceName,
      text: redactedText(),
      fileNameHint: options.fileNameHint,
      findings: enabled.map(({ type, label, start, end, replacement }) => ({
        type,
        label,
        start,
        end,
        replacement: tokenAssignments?.get(`${start}:${end}`) || replacement
      }))
    });
    if (result && !result.canceled) {
      state.vaultAttachmentToken = result.vaultAttachmentToken || null;
      state.vaultAttachmentFiles = Number(result.vaultAttachmentFiles || 0);
      renderVaultState();
      renderWorkflowProgress('complete');
      let vaultSuffix = '';
      let toastKind = 'ok';
      const autoSave = options.skipAutoSave ? { shouldSave: false } : autoVaultDecision({
        enabled: state.autoSaveToVault,
        vault: state.vault,
        exportResult: result,
        sourceText: state.sourceText,
        restoreEntry: state.restoreEntry
      });
      if (autoSave.shouldSave) {
        try {
          const includeAttachments = Boolean(state.vaultAttachmentToken);
          const saved = await saveCurrentToVault({ includeAttachments });
          vaultSuffix = saved.attachmentResult
            ? `，已自动写入加密仓库（附件 ${saved.attachmentResult.files}，去重 ${saved.attachmentResult.deduplicated}）`
            : '，已自动写入加密仓库';
        } catch (error) {
          vaultSuffix = `，自动入库失败：${vaultErrorMessage(error)}`;
          toastKind = 'error';
        }
      }
      const suffix = result.coordinatePath ? '，坐标与文本副本已同时保存' : '';
      const preserved = result.preservationMode === 'structure-preserving-raster' ? '，表单与批注已保留' : '';
      const geometry = result.rotationsPreserved && result.cropBoxesPreserved ? '，旋转与裁剪框已保留' : '';
      const pdfa = result.pdfaState === 'declared-source-modified-unvalidated' ? '，PDF/A 声明已保留但需重新校验' : '';
      const xfa = result.xfaState === 'preserved-unvalidated' ? '，XFA 已保留但需专用阅读器复核' : '';
      const signature = result.signatureState === 'invalidated-by-modification' ? '，原数字签名已标记失效' : '';
      const resigning = result.resigning?.required ? `，可交外部签章器重新签名（SHA-256 ${result.resigning.documentSha256.slice(0, 12)}…）` : '';
      const veraPdf = result.pdfaValidation?.compliant === true
        ? '，veraPDF 校验通过'
        : result.pdfaValidation?.compliant === false
          ? '，veraPDF 校验未通过'
          : result.pdfaValidation?.reason === 'VERAPDF_NOT_INSTALLED'
            ? '，未检测到 veraPDF CLI'
            : '';
      const csv = result.originalFormatPreserved
        ? `，CSV ${result.encoding.toUpperCase()} / ${result.delimiterName}分隔 / ${result.lineEndingName} 已保留${result.formulaCellsEscaped ? `，已阻断 ${result.formulaCellsEscaped} 个公式注入单元格` : ''}`
        : '';
      if (!options.quiet) showToast(`已导出${suffix}${preserved}${geometry}${pdfa}${xfa}${signature}${resigning}${veraPdf}${csv}${vaultSuffix}`, toastKind);
      if (kind !== 'json') state.unexported = false;
    }
    return result || null;
  } catch (error) {
    if (options.throwOnError) throw error;
    showToast(`导出失败：${friendlyError(error)}`, 'error');
    return null;
  }
}

// ---------- 主导出流程：先存仓库得到编号，再按“编号-原名-脱敏副本”导出，最后给出下一步 ----------
async function createVaultFlow() {
  const password = await requestVaultPassword('create');
  if (!password) return false;
  try {
    const value = await window.veilforge.createVault(password);
    if (value?.canceled) return false;
    state.batchAutoVault = false;
    state.vaultFilters = { query: '', kind: 'all', dateFrom: '', dateTo: '' };
    applyVaultState(value);
    showToast('文件仓库已创建并加密，请记住仓库密码');
    return true;
  } catch (error) {
    showToast(`新建失败：${vaultErrorMessage(error)}`, 'error');
    return false;
  }
}

async function openVaultFlow() {
  const password = await requestVaultPassword('open');
  if (!password) return false;
  try {
    const value = await window.veilforge.openVault(password);
    if (value?.canceled) return false;
    state.batchAutoVault = false;
    state.vaultFilters = { query: '', kind: 'all', dateFrom: '', dateTo: '' };
    applyVaultState(value);
    showToast('文件仓库已解锁');
    return true;
  } catch (error) {
    showToast(`打开失败：${vaultErrorMessage(error)}`, 'error');
    return false;
  }
}

let vaultGateResolve = null;
function requestVaultForExport() {
  if (state.vault) return Promise.resolve(true);
  elements.vaultGateDialog.showModal();
  return new Promise((resolve) => { vaultGateResolve = resolve; });
}
async function finishVaultGate(choice) {
  if (elements.vaultGateDialog.open) elements.vaultGateDialog.close();
  const resolve = vaultGateResolve;
  vaultGateResolve = null;
  let ok = false;
  if (choice === 'create') ok = await createVaultFlow();
  if (choice === 'open') ok = await openVaultFlow();
  resolve?.(ok && Boolean(state.vault));
}

function exportBaseName() {
  return (state.sourceName || '脱敏结果').replace(/\.[A-Za-z0-9]{1,5}$/u, '').replace(/[\\/:*?"<>|]+/gu, ' ').trim().slice(0, 80) || '脱敏结果';
}

async function exportPrimary() {
  if (!state.sourceText || state.restoreEntry) return;
  const kind = primaryExportKind();
  if (kind === 'txt' && state.quickEntryMode === 'image-to-text' && state.style !== 'token') {
    await exportRecognizedText();
    return;
  }
  if (!exportIsReversible(kind)) {
    const result = await exportResult(kind);
    if (result && !result.canceled) showToast(`已导出：${result.path || ''}`);
    return;
  }
  if (!(await requestVaultForExport())) {
    showToast('已取消导出：需要文件仓库保存代号对照表', 'error');
    return;
  }
  elements.exportPrimaryButton.disabled = true;
  let saved = null;
  try {
    const value = await saveCurrentToVault();
    saved = value.savedEntry;
    if (!saved?.fileNumber) throw new Error('LOCAL_VAULT_WRITE_INCOMPLETE');
    const result = await exportResult(kind, {
      fileNameHint: `${saved.fileNumber}-${exportBaseName()}-脱敏副本`,
      skipAutoSave: true,
      quiet: true,
      throwOnError: true
    });
    if (!result || result.canceled) {
      // 用户取消了“另存为”：撤销刚写入的仓库记录，避免留下没有副本的空编号。
      await window.veilforge.deleteVaultEntry(state.vault.token, saved.id).then(applyVaultStateAndFilters).catch(() => {});
      showToast('已取消导出，仓库未保留这次记录');
      return;
    }
    state.lastExport = { ...saved, path: result.path || '', kind, mapping: reversiblePreview().mapping };
    showNextSteps();
  } catch (error) {
    if (saved?.id && state.vault) await window.veilforge.deleteVaultEntry(state.vault.token, saved.id).then(applyVaultStateAndFilters).catch(() => {});
    showToast(`导出失败：${friendlyError(error)}`, 'error');
  } finally {
    renderExportBar();
  }
}

function currentAiPrompt() {
  const info = state.lastExport;
  if (!info) return '';
  const formatNames = { txt: '文本', docx: 'Word 文档', xlsx: 'Excel 表格', csv: 'CSV 表格', pdf: 'PDF 文档' };
  return buildAiPrompt({ fileNumber: info.fileNumber, mapping: info.mapping, formatLabel: formatNames[info.kind] || '' });
}

function showNextSteps() {
  const info = state.lastExport;
  if (!info) return;
  elements.nextStepsTitle.textContent = `已存为 文件 ${info.fileNumber}`;
  elements.nextStepsPath.textContent = info.path ? `副本保存在：${info.path}` : '';
  elements.nextStepsPrompt.value = currentAiPrompt();
  elements.nextStepsDialog.showModal();
  elements.nextStepsPrompt.scrollTop = 0;
}

function copyFromTextarea(textarea) {
  // 剪贴板权限在安全模式下被禁用，改用选中后复制。
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.setSelectionRange(0, 0);
  textarea.scrollTop = 0;
  return ok;
}

async function exportRecognizedText() {
  if (!state.sourceText || state.quickEntryMode !== 'image-to-text') return;
  try {
    const baseName = state.sourceName.replace(/\.[^.]+$/u, '') || '图片';
    const result = await window.veilforge.exportResult({
      kind: 'txt',
      sourceToken: state.sourceToken,
      sourceName: state.sourceName,
      fileNameHint: `${baseName}-识别文本.txt`,
      text: state.sourceText,
      findings: []
    });
    if (result && !result.canceled) {
      state.vaultAttachmentToken = result.vaultAttachmentToken || null;
      state.vaultAttachmentFiles = Number(result.vaultAttachmentFiles || 0);
      renderVaultState();
      showToast(`识别文本已导出 ${result.bytes.toLocaleString('zh-CN')} bytes${result.vaultAttachmentFiles ? `，${result.vaultAttachmentFiles} 个文件可加密入库` : ''}`);
    }
  } catch (error) {
    showToast(`导出识别 TXT 失败：${friendlyError(error)}`, 'error');
  }
}

window.veilforge.onBatchUpdate((job) => {
  state.batchJobs.set(job.id, job);
  renderBatchJobs();
});

window.veilforge.onBatchExportProgress((detail) => {
  state.batchExport = { ...(state.batchExport || {}), ...detail };
  renderBatchJobs();
});

window.veilforge.listBatchJobs().then((jobs) => {
  for (const job of jobs) state.batchJobs.set(job.id, job);
  renderBatchJobs();
}).catch(() => {});

for (const button of elements.moduleNav.querySelectorAll('[data-module]')) {
  button.addEventListener('click', () => setActiveModule(button.dataset.module));
  button.addEventListener('keydown', (event) => {
    let direction = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        direction = 'next';
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        direction = 'previous';
        break;
      case 'Home':
        direction = 'first';
        break;
      case 'End':
        direction = 'last';
        break;
      default:
        return;
    }
    event.preventDefault();
    setActiveModule(nextModuleId(state.activeModule, direction), { focus: true });
  });
}
elements.modulePrimaryAction.addEventListener('click', runModulePrimaryAction);
window.addEventListener('hashchange', () => setActiveModule(moduleIdFromHash(window.location.hash), { updateHash: false }));

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const index = Number(event.key) - 1;
  if (!Number.isInteger(index) || !MODULE_IDS[index]) return;
  event.preventDefault();
  setActiveModule(MODULE_IDS[index], { focus: true });
});

document.addEventListener('dragover', (event) => {
  if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('drag-active');
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('drag-active');
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer.files?.length) return;
  event.preventDefault();
  document.body.classList.remove('drag-active');
  elements.restoreDrop.classList.remove('dragging');
  // 在“逆脱敏”页拖入的是 AI 返回的文件；其他页面仍加入批处理队列。
  if (state.activeModule === 'restore') importReturnedFile(event.dataTransfer.files[0]);
  else enqueueDroppedFiles(event.dataTransfer.files);
});

elements.batchClearButton.addEventListener('click', async () => {
  try {
    const response = await window.veilforge.clearBatchJobs();
    state.batchJobs.clear();
    for (const job of response.jobs) state.batchJobs.set(job.id, job);
    renderBatchJobs();
  } catch (error) {
    showToast(`清理失败：${friendlyError(error)}`, 'error');
  }
});

elements.batchExportButton.addEventListener('click', async () => {
  if (state.batchExport) {
    try {
      const response = await window.veilforge.cancelBatchExport();
      if (response.canceled) state.batchExport.cancelRequested = true;
      renderBatchJobs();
    } catch (error) {
      showToast(`停止导出失败：${friendlyError(error)}`, 'error');
    }
    return;
  }
  const total = [...state.batchJobs.values()].filter((job) => job.status === 'done').length;
  state.batchExport = { status: 'starting', total, exported: 0, failed: 0 };
  renderBatchJobs();
  try {
    const result = await window.veilforge.exportCompletedBatch({
      autoVault: state.batchAutoVault,
      vaultToken: state.vault?.token || null
    });
    if (result.vaultState) await applyVaultStateAndFilters(result.vaultState);
    const vaultSuffix = state.batchAutoVault
      ? `，自动入库 ${result.vaultSave?.saved || 0} 个${result.vaultSave?.failed ? `、失败 ${result.vaultSave.failed} 个` : ''}`
      : '';
    if (result.canceled && result.exported === 0) showToast(`已取消批量导出${vaultSuffix}`);
    else if (result.canceled) showToast(`已停止导出：完成 ${result.exported} 个，清单已保存${vaultSuffix}`);
    else showToast(`批量导出完成：${result.exported} 个，失败 ${result.failed} 个${vaultSuffix}`, result.vaultSave?.failed ? 'error' : 'ok');
  } catch (error) {
    showToast(`批量导出失败：${friendlyError(error)}`, 'error');
  } finally {
    state.batchExport = null;
    renderBatchJobs();
  }
});

elements.openButton.addEventListener('click', openDocument);
elements.emptyOpenButton.addEventListener('click', openDocument);
elements.pasteTextButton.addEventListener('click', openPasteTextDialog);
elements.imageToTextButton.addEventListener('click', openImageToText);
elements.demoButton.addEventListener('click', loadDemo);
elements.pasteTextInput.addEventListener('input', updatePasteTextCounter);
elements.pasteTextForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const result = createPastedDocument(elements.pasteTextInput.value, elements.pasteTextName.value);
    closePasteTextDialog();
    applyDocumentResult(result, '粘贴文字已载入本地会话，可直接核对敏感信息');
  } catch (error) {
    const message = String(error?.message || error);
    elements.pasteTextError.textContent = message.includes('EMPTY')
      ? '请先粘贴文字内容'
      : message.includes('TOO_LARGE') ? '文字内容超过 100 MiB 上限' : '文字内容格式无效';
  }
});
elements.pasteTextCancel.addEventListener('click', closePasteTextDialog);
elements.pasteTextDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closePasteTextDialog();
});
elements.pdfPasswordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  finishPdfPassword(elements.pdfPassword.value);
});
elements.pdfPasswordCancel.addEventListener('click', () => finishPdfPassword(null));
elements.pdfPasswordDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  finishPdfPassword(null);
});
elements.resetButton.addEventListener('click', () => { if (confirmDiscardUnexported('清空')) reset(); });
for (const eventName of ['select', 'mouseup', 'keyup']) elements.sourceEditor.addEventListener(eventName, updateSelectionBar);
elements.sourceEditor.addEventListener('scroll', syncHighlightScroll);
new ResizeObserver(() => syncHighlightScroll()).observe(elements.sourceEditor);
document.addEventListener('selectionchange', () => { if (document.activeElement === elements.sourceEditor) updateSelectionBar(); });
elements.sourceEditor.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && currentSelection()) {
    event.preventDefault();
    hideSelectionOnce();
  }
});
// 工具栏按钮用 mousedown 阻止默认行为，点击时原文选区不会丢失。
for (const button of [elements.selectionHideOnceButton, elements.selectionHideAllButton, elements.selectionKeepButton]) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}
elements.selectionHideOnceButton.addEventListener('click', hideSelectionOnce);
elements.selectionHideAllButton.addEventListener('click', hideSelectionEverywhere);
elements.selectionKeepButton.addEventListener('click', keepSelection);
elements.sourceEditor.addEventListener('input', () => {
  state.sourceText = elements.sourceEditor.value;
  clearNerFindings();
  if (state.image) {
    state.imageMappingValid = false;
    elements.mappingState.textContent = '文本已编辑，图片坐标需重新导入';
    elements.mappingState.classList.add('stale');
    elements.exportImageButton.classList.add('hidden');
  }
  if (state.office) {
    state.officeMappingValid = false;
    elements.exportOfficeButton.classList.add('hidden');
  }
  if (state.csv) {
    state.csvMappingValid = false;
    elements.exportCsvButton.disabled = true;
    elements.exportCsvButton.title = '正文已经手工编辑；重新导入后才能保证原编码、分隔符和行尾结构';
  }
  elements.charCount.textContent = state.sourceText.length.toLocaleString('zh-CN');
  runAnalysis();
});
elements.customTerms.addEventListener('input', runAnalysis);
elements.typedTerms.addEventListener('input', runAnalysis);
elements.alwaysKeepTerms.addEventListener('input', runAnalysis);
elements.nerSelectButton.addEventListener('click', async () => {
  try {
    state.nerBusy = true;
    renderNerState();
    const value = await window.veilforge.selectNerModel();
    if (value?.canceled) return;
    state.ner = value;
    clearNerFindings();
    runAnalysis();
    showToast(`离线模型已加载：${value.name} · ${(value.modelBytes / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    showToast(`模型加载失败：${friendlyError(error)}`, 'error');
  } finally {
    state.nerBusy = false;
    renderNerState();
  }
});
elements.nerClearButton.addEventListener('click', async () => {
  try {
    state.nerBusy = true;
    renderNerState();
    await window.veilforge.clearNerModel();
    state.ner = null;
    clearNerFindings();
    runAnalysis();
    showToast('离线语义模型已卸载');
  } catch (error) {
    showToast(`模型卸载失败：${friendlyError(error)}`, 'error');
  } finally {
    state.nerBusy = false;
    renderNerState();
  }
});
elements.nerAnalyzeButton.addEventListener('click', async () => {
  if (!state.ner?.loaded || !state.sourceText || state.nerBusy) return;
  const inputText = state.sourceText;
  try {
    state.nerBusy = true;
    renderNerState();
    const value = await window.veilforge.analyzeNer(inputText, Number(elements.nerThreshold.value));
    if (inputText !== state.sourceText) return;
    state.nerFindings = value.entities;
    state.nerText = inputText;
    runAnalysis();
    showToast(`模型识别完成：采纳 ${value.accepted} 项，待复核 ${value.review} 项，${value.tokens} 个词元 / ${value.windows} 个窗口`);
  } catch (error) {
    const message = String(error?.message || error);
    showToast(`语义识别失败：${friendlyError(message)}`, 'error');
  } finally {
    state.nerBusy = false;
    renderNerState();
  }
});
elements.ocrRapidButton.addEventListener('click', async () => {
  try {
    state.ocrBackendBusy = true;
    renderOcrBackendState();
    const value = await window.veilforge.selectRapidOcrPython();
    if (value?.canceled) return;
    state.ocrBackend = value;
    showToast(`RapidOCR 已启用：${value.modelPack?.id || 'PP-OCRv6'}`);
  } catch (error) {
    showToast(`RapidOCR 启用失败：${friendlyError(error)}`, 'error');
  } finally {
    state.ocrBackendBusy = false;
    renderOcrBackendState();
  }
});
elements.ocrTesseractButton.addEventListener('click', async () => {
  try {
    state.ocrBackendBusy = true;
    renderOcrBackendState();
    state.ocrBackend = await window.veilforge.useTesseractBackend();
    showToast('已切换到 Tesseract.js');
  } catch (error) {
    showToast(`OCR 切换失败：${friendlyError(error)}`, 'error');
  } finally {
    state.ocrBackendBusy = false;
    renderOcrBackendState();
  }
});
elements.exportTextButton.addEventListener('click', () => exportResult('txt'));
elements.exportPrimaryButton.addEventListener('click', exportPrimary);
elements.exportConfirm.addEventListener('change', renderExportBar);
elements.vaultGateCreate.addEventListener('click', () => finishVaultGate('create'));
elements.vaultGateOpen.addEventListener('click', () => finishVaultGate('open'));
elements.vaultGateCancel.addEventListener('click', () => finishVaultGate(null));
elements.vaultGateDialog.addEventListener('cancel', (event) => { event.preventDefault(); finishVaultGate(null); });
elements.nextStepsCopy.addEventListener('click', () => {
  showToast(copyFromTextarea(elements.nextStepsPrompt) ? '已复制“给 AI 的要求”，粘贴到 AI 对话框即可' : '复制失败，请手动全选后复制', 'ok');
});
elements.nextStepsDownload.addEventListener('click', async () => {
  const info = state.lastExport;
  if (!info) return;
  try {
    const result = await window.veilforge.exportResult({ kind: 'txt', text: currentAiPrompt(), findings: [], fileNameHint: `${info.fileNumber}-给AI的要求` });
    if (result && !result.canceled) showToast('已下载“给 AI 的要求”');
  } catch (error) {
    showToast(`下载失败：${friendlyError(error)}`, 'error');
  }
});
elements.nextStepsRestore.addEventListener('click', () => {
  const info = state.lastExport;
  elements.nextStepsDialog.close();
  if (info?.id && state.vault) loadVaultEntry(info.id);
});
elements.nextStepsNew.addEventListener('click', () => {
  elements.nextStepsDialog.close();
  reset();
});
elements.nextStepsClose.addEventListener('click', () => elements.nextStepsDialog.close());
elements.exportJsonButton.addEventListener('click', () => exportResult('json'));
elements.exportOcrTextButton.addEventListener('click', exportRecognizedText);
elements.exportImageButton.addEventListener('click', () => exportResult(state.image?.kind || 'image'));
elements.exportOfficeButton.addEventListener('click', () => exportResult(state.office?.kind || 'docx'));
elements.exportCsvButton.addEventListener('click', () => exportResult('csv'));
elements.imageElement.addEventListener('load', renderImageOverlay);
elements.vaultPasswordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const password = elements.vaultPassword.value;
  if (password.length < 10 || password.length > 256) {
    elements.vaultDialogError.textContent = '密码至少 10 个字符，最多 256 个字符';
    return;
  }
  if (vaultDialogNeedsConfirmation && password !== elements.vaultPasswordConfirm.value) {
    elements.vaultDialogError.textContent = '两次输入的密码不一致';
    return;
  }
  finishVaultPassword(password);
});
elements.vaultDialogCancel.addEventListener('click', () => finishVaultPassword(null));
elements.vaultPasswordDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  finishVaultPassword(null);
});
elements.vaultCreateButton.addEventListener('click', async () => {
  clearRestoreSession();
  await createVaultFlow();
});
elements.vaultOpenButton.addEventListener('click', async () => {
  clearRestoreSession();
  await openVaultFlow();
});
elements.vaultSaveButton.addEventListener('click', async () => {
  if (!state.vault || !state.sourceText) return;
  try {
    await saveCurrentToVault({ notify: true });
  } catch (error) {
    showToast(`保存失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultBundleSaveButton.addEventListener('click', async () => {
  if (!state.vault || !state.sourceText || !state.vaultAttachmentToken) return;
  try {
    await saveCurrentToVault({ notify: true, includeAttachments: true });
  } catch (error) {
    showToast(`附件入库失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultAutoSave.addEventListener('change', () => {
  state.autoSaveToVault = Boolean(state.vault && elements.vaultAutoSave.checked);
  renderVaultState();
  showToast(state.autoSaveToVault ? '已开启：成功导出后自动写入当前仓库' : '已关闭导出后自动入库');
});
elements.batchAutoVault.addEventListener('change', () => {
  state.batchAutoVault = Boolean(state.vault && elements.batchAutoVault.checked);
  renderVaultState();
  showToast(state.batchAutoVault ? '已开启：批量导出成功项自动写入当前仓库' : '已关闭批量自动入库');
});

let vaultFilterTimer = null;
function scheduleVaultFilterRefresh() {
  clearTimeout(vaultFilterTimer);
  vaultFilterTimer = window.setTimeout(() => {
    refreshVaultEntries().catch((error) => showToast(`筛选失败：${vaultErrorMessage(error)}`, 'error'));
  }, 160);
}
elements.vaultSearchInput.addEventListener('input', () => {
  state.vaultFilters.query = elements.vaultSearchInput.value;
  scheduleVaultFilterRefresh();
});
for (const [element, field] of [
  [elements.vaultKindFilter, 'kind'],
  [elements.vaultDateFrom, 'dateFrom'],
  [elements.vaultDateTo, 'dateTo']
]) {
  element.addEventListener('change', () => {
    state.vaultFilters[field] = element.value;
    scheduleVaultFilterRefresh();
  });
}
elements.vaultFilterClearButton.addEventListener('click', () => {
  state.vaultFilters = { query: '', kind: 'all', dateFrom: '', dateTo: '' };
  refreshVaultEntries().catch((error) => showToast(`清除筛选失败：${vaultErrorMessage(error)}`, 'error'));
});
elements.vaultBackupButton.addEventListener('click', async () => {
  if (!state.vault) return;
  const password = await requestVaultPassword('backup');
  if (!password) return;
  try {
    const value = await window.veilforge.backupVault(state.vault.token, password);
    if (value?.canceled) return;
    await applyVaultStateAndFilters(value);
    showToast(`加密备份已导出：${value.backup.entries} 条记录`);
  } catch (error) {
    showToast(`备份失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultImportButton.addEventListener('click', async () => {
  if (!state.vault) return;
  const password = await requestVaultPassword('import');
  if (!password) return;
  try {
    const value = await window.veilforge.importVault(state.vault.token, password, elements.vaultImportPolicy.value);
    if (value?.canceled) return;
    await applyVaultStateAndFilters(value);
    const report = value.importReport;
    showToast(`备份导入完成：新增 ${report.imported} 条，跳过 ${report.skipped} 条，改名 ${report.renamed} 条`);
  } catch (error) {
    showToast(`导入失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultLoadMoreButton.addEventListener('click', async () => {
  if (!state.vault?.page?.hasMore) return;
  try {
    await refreshVaultEntries({ append: true });
  } catch (error) {
    showToast(`加载失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultCompactButton.addEventListener('click', async () => {
  if (!state.vault || state.vault.compacting) return;
  state.vault.compacting = true;
  renderVaultState();
  try {
    const value = await window.veilforge.compactVault(state.vault.token);
    await applyVaultStateAndFilters(value);
    showToast(`仓库压缩完成：回收 ${formatBytes(value.compaction.reclaimedBytes)}`);
  } catch (error) {
    state.vault.compacting = false;
    renderVaultState();
    showToast(`压缩失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultRotateButton.addEventListener('click', async () => {
  if (!state.vault) return;
  const password = await requestVaultPassword('rotate');
  if (!password) return;
  try {
    const value = await window.veilforge.rotateVaultPassword(state.vault.token, password);
    await applyVaultStateAndFilters(value);
    showToast('仓库密码已轮换，旧密码立即失效');
  } catch (error) {
    showToast(`轮换失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultLockButton.addEventListener('click', async () => {
  if (!state.vault) return;
  try {
    await window.veilforge.lockVault(state.vault.token);
    state.vault = null;
    clearRestoreSession();
    renderVaultState();
    showToast('加密仓库已锁定，内存密钥已清除');
  } catch (error) {
    showToast(`锁定失败：${vaultErrorMessage(error)}`, 'error');
  }
});
elements.vaultTimeout.addEventListener('change', async () => {
  if (!state.vault) return;
  try {
    const value = await window.veilforge.setVaultTimeout(state.vault.token, Number(elements.vaultTimeout.value));
    await applyVaultStateAndFilters(value);
    showToast(`自动锁定已设为 ${value.timeoutMinutes} 分钟`);
  } catch (error) {
    showToast(`设置失败：${vaultErrorMessage(error)}`, 'error');
  }
});
window.veilforge.onVaultLocked((detail) => {
  if (state.vault?.token !== detail?.token) return;
  state.vault = null;
  clearRestoreSession();
  renderVaultState();
  showToast('加密仓库已自动锁定，内存密钥已清除');
});

// ---------- 逆脱敏：找到记录、导入返回文件 ----------
function renderRestoreState() {
  if (!elements.restoreEntryLabel) return;
  const entry = state.restoreEntry;
  elements.restoreEntryLabel.replaceChildren();
  if (entry?.mapping) {
    elements.restoreEntryLabel.append('当前文件：');
    const strong = document.createElement('strong');
    strong.textContent = `${entry.fileNumber || ''} · ${entry.name || ''}`;
    elements.restoreEntryLabel.append(strong, `（${entry.mapping.length} 个代号）`);
  } else {
    elements.restoreEntryLabel.textContent = '还没有选择文件：导入 AI 返回的文件会按编号自动找到对应记录，也可以在下面查找。';
  }
  elements.restoreUnlockButton.classList.toggle('hidden', Boolean(state.vault));
  elements.restoreSearch.disabled = !state.vault;
  elements.restoreSearch.placeholder = state.vault ? '或按文件编号、文件名查找，例如 000001' : '文件仓库已锁定，先解锁才能查找';
  const file = state.restoreFile;
  elements.restoreFileState.textContent = !file ? ''
    : file.edited ? `已导入 ${file.name}，内容被手动修改过，将导出为 TXT`
      : `已导入 ${file.name}${['docx', 'xlsx', 'csv', 'pdf'].includes(file.kind) ? `，将按原格式（${file.kind.toUpperCase()}）换回` : ''}`;
  elements.restoreFileState.classList.toggle('stale', Boolean(file?.edited));
  elements.restoreExportButton.textContent = file && !file.edited && ['docx', 'xlsx', 'csv', 'pdf'].includes(file.kind)
    ? `下载逆脱敏结果（${file.kind.toUpperCase()}）` : '下载逆脱敏结果（TXT）';
}

async function ensureVaultUnlocked(reason) {
  if (state.vault) return true;
  showToast(reason || '需要先解锁文件仓库');
  return openVaultFlow();
}

async function findVaultEntryByNumber(fileNumber) {
  if (!state.vault) return null;
  const local = state.vault.entries.find((entry) => entry.fileNumber === fileNumber);
  if (local) return local;
  const value = await window.veilforge.listVaultEntries(state.vault.token, {
    pageSize: 5,
    filters: { query: fileNumber, kind: 'reversible-map', dateFrom: '', dateTo: '' }
  });
  return value.entries.find((entry) => entry.fileNumber === fileNumber) || null;
}

function detectFileNumber(name, text) {
  return String(name || '').match(/MI-\d{6}/u)?.[0] || String(text || '').slice(0, 800).match(/MI-\d{6}/u)?.[0] || '';
}

let restoreSearchTimer = 0;
async function runRestoreSearch() {
  const query = elements.restoreSearch.value.trim();
  elements.restoreSearchResults.replaceChildren();
  if (!state.vault || !query) return;
  try {
    const value = await window.veilforge.listVaultEntries(state.vault.token, {
      pageSize: 8,
      filters: { query, kind: 'reversible-map', dateFrom: '', dateTo: '' }
    });
    if (!value.entries.length) {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = '没有找到匹配的可逆记录';
      elements.restoreSearchResults.append(empty);
      return;
    }
    for (const entry of value.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${entry.fileNumber} · ${entry.name}`;
      button.addEventListener('click', async () => {
        await loadVaultEntry(entry.id, { keepInput: true });
        elements.restoreSearchResults.replaceChildren();
        elements.restoreSearch.value = '';
        if (elements.restoreInput.value.trim()) runRestore();
      });
      elements.restoreSearchResults.append(button);
    }
  } catch (error) {
    showToast(`查找失败：${vaultErrorMessage(error)}`, 'error');
  }
}

async function importReturnedFile(file = null) {
  try {
    const opened = await window.veilforge.openReturnedDocument(file);
    if (!opened || opened.canceled) return;
    state.restoreFile = { ...opened, edited: false };
    elements.restoreInput.value = opened.text;
    elements.restoreOutput.value = '';
    state.restoreResult = null;
    renderRestoreState();
    const fileNumber = detectFileNumber(opened.name, opened.text);
    if (fileNumber && state.restoreEntry?.fileNumber !== fileNumber) {
      if (!(await ensureVaultUnlocked(`这是 ${fileNumber} 的返回件，请先解锁文件仓库`))) {
        elements.restoreReport.textContent = `已认出编号 ${fileNumber}，解锁文件仓库后会自动载入对应记录。`;
        return;
      }
      const entry = await findVaultEntryByNumber(fileNumber);
      if (!entry) {
        elements.restoreReport.textContent = `仓库里没有找到 ${fileNumber}。如果换过电脑，请先在“加密仓库”导入备份；也可以在上方手动查找。`;
        renderRestoreState();
        return;
      }
      await loadVaultEntry(entry.id, { keepInput: true });
      showToast(`已按编号找到 ${fileNumber} · ${entry.name}`);
    }
    if (!state.restoreEntry?.mapping) {
      elements.restoreReport.textContent = '没有认出文件编号，请在上方查找并选择对应的记录。';
      if (!state.vault) renderRestoreState();
      return;
    }
    runRestore();
  } catch (error) {
    showToast(`导入失败：${friendlyError(error)}`, 'error');
  }
}

function selectRestoreRange(start, end) {
  const input = elements.restoreInput;
  input.focus();
  input.setSelectionRange(start, end);
  const before = input.value.slice(0, start).split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 18;
  input.scrollTop = Math.max(0, before * lineHeight - input.clientHeight / 3);
}

function checklistRow(parts, range) {
  const row = document.createElement('div');
  row.className = 'checklist-row';
  for (const part of parts) {
    if (typeof part === 'string') row.append(document.createTextNode(part));
    else {
      const node = document.createElement(part.tag || 'span');
      if (part.className) node.className = part.className;
      node.textContent = part.text;
      row.append(node);
    }
  }
  if (range) {
    const locate = document.createElement('button');
    locate.type = 'button';
    locate.className = 'mini-button';
    locate.textContent = '定位';
    locate.addEventListener('click', () => selectRestoreRange(range.start, range.end));
    row.append(locate);
  }
  return row;
}

function clipText(text, limit = 60) {
  const chars = [...String(text)];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}

function formatFact(value, kind) {
  const text = String(value);
  if (kind === 'amount') {
    const amount = text.match(/^(CNY|USD|EUR|HKD):(-?\d+(?:\.\d+)?)$/u);
    if (amount) return `${Number(amount[2]).toLocaleString('zh-CN')} ${{ CNY: '元', USD: '美元', EUR: '欧元', HKD: '港元' }[amount[1]]}`;
  }
  if (kind === 'date') {
    const date = text.match(/^(\*|\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/u);
    if (date) return `${date[1] === '*' ? '' : `${date[1]}年`}${date[2]}月${date[3] ? `${date[3]}日` : ''}`;
  }
  if (kind === 'percent') return `${text}%`;
  if (kind === 'negation') return `${text} 处否定词`;
  return text;
}

function renderRestoreChecklist(review, locatable = true) {
  const box = elements.restoreChecklist;
  const row = (parts, range) => checklistRow(parts, locatable ? range : null);
  box.replaceChildren();
  const section = (title, warn = false) => {
    const heading = document.createElement('h3');
    heading.textContent = title;
    if (warn) heading.className = 'warn';
    box.append(heading);
  };
  if (review.leakedOriginals.length) {
    section('AI 直接写出的原文（外部 AI 已经知道这些信息，仅在本机显示）', true);
    for (const item of review.leakedOriginals) {
      box.append(row([`${item.label}：`, { tag: 'code', text: item.value }, { className: 'muted', text: ` ${item.count} 处` }], item.positions[0]));
    }
  }
  if (review.changes.length) {
    section('事实发生变化，需要逐句核对', true);
    for (const change of review.changes.slice(0, 100)) {
      const labels = change.diffs.map((diff) => `${diff.label}：${diff.before.map((value) => formatFact(value, diff.kind)).join('、') || '无'} → ${diff.after.map((value) => formatFact(value, diff.kind)).join('、') || '无'}`).join('；');
      box.append(row([{ tag: 'code', text: clipText(change.returnedText) }, { className: 'muted', text: labels }], change));
    }
  }
  if (review.damagedTokens.length || review.foreignTokens.length || review.unknownTokens.length) {
    section('残缺、未知或属于其他文件的代号（不会被猜测换回）', true);
    for (const item of review.damagedTokens) {
      box.append(row([{ tag: 'code', text: item.text }, { className: 'muted', text: item.suggestion ? ` 可能是 ${item.suggestion}，请手动改正后重新逆脱敏` : ' 残缺代号' }], item));
    }
    for (const item of review.foreignTokens) box.append(row([{ tag: 'code', text: item.token }, { className: 'muted', text: ' 属于其他文件' }], item));
    for (const item of review.unknownTokens) box.append(row([{ tag: 'code', text: item.token }, { className: 'muted', text: ' 本文件没有这个编号' }], item));
  }
  if (review.newContent.length) {
    section('AI 新写的内容（原副本里找不到对应原句，不判断对错）');
    for (const item of review.newContent.slice(0, 100)) box.append(row([{ tag: 'code', text: clipText(item.text) }], item));
  }
  if (review.reworded.length) {
    section(`改写了措辞但金额、日期、代号等未变：${review.reworded.length} 句`);
  }
  if (review.stats.omittedSentences) {
    section(`原副本中有 ${review.stats.omittedSentences} 句没有出现在返回内容里（摘要省略的内容不会自动补回）`);
  }
  if (review.stats.truncated) section('文本过长，仅比对了前 60,000 句', true);
  box.classList.toggle('hidden', !box.childElementCount);
}

function updateRestoreExportState() {
  const needsConfirm = Boolean(state.restoreResult?.requiresReview);
  elements.restoreConfirmLabel.classList.toggle('hidden', !needsConfirm);
  elements.restoreExportButton.disabled = !state.restoreResult?.restoredText || (needsConfirm && !elements.restoreConfirm.checked);
}

elements.restoreConfirm.addEventListener('change', updateRestoreExportState);

function runRestore() {
  if (!state.restoreEntry?.mapping) return;
  try {
    const result = restoreTokens(elements.restoreInput.value, state.restoreEntry.mapping, { mode: elements.restoreMode.value });
    const review = reviewRestoration({ sentText: state.restoreEntry.text, returnedText: elements.restoreInput.value, mapping: state.restoreEntry.mapping });
    result.review = review;
    result.requiresReview = result.requiresReview || review.requiresReview;
    state.restoreResult = result;
    elements.restoreOutput.value = result.restoredText;
    const nonce = state.restoreEntry.mapping[0]?.token?.slice(4, 12);
    const foreignOnly = !result.restoredCount && /\[MI_[A-F0-9]{8}_/u.test(elements.restoreInput.value) && nonce && !elements.restoreInput.value.includes(`[MI_${nonce}_`);
    const parts = [`已恢复 ${result.restoredCount} 处`];
    if (foreignOnly) parts.unshift('这份内容里的代号不属于当前文件，请确认选对了文件编号');
    if (result.missing.length) parts.push(`未出现代号 ${result.missing.length} 个`);
    if (result.unknownTokens.length) parts.push(`未知代号 ${result.unknownTokens.length} 个`);
    if (result.repeated.length) parts.push(`重复代号 ${result.repeated.length} 个`);
    const reviewSummary = summarizeReview(review);
    if (reviewSummary) parts.push(reviewSummary);
    parts.push(result.requiresReview ? '需要人工核对' : '核对通过');
    elements.restoreReport.textContent = parts.join(' · ');
    elements.restoreReport.classList.toggle('needs-review', result.requiresReview);
    renderRestoreChecklist(review);
    elements.restoreConfirm.checked = false;
    updateRestoreExportState();
    showToast(result.requiresReview ? '逆脱敏完成，请按核对单逐项确认' : '逆脱敏完成，代号已在本机换回');
  } catch (error) {
    showToast(`逆脱敏失败：${friendlyError(error)}`, 'error');
  }
}
elements.restoreButton.addEventListener('click', runRestore);
elements.restoreImportButton.addEventListener('click', () => importReturnedFile());
elements.restoreUnlockButton.addEventListener('click', async () => { if (await openVaultFlow()) renderRestoreState(); });
elements.restoreSearch.addEventListener('input', () => {
  window.clearTimeout(restoreSearchTimer);
  restoreSearchTimer = window.setTimeout(runRestoreSearch, 250);
});
elements.restoreInput.addEventListener('input', () => {
  if (state.restoreFile && !state.restoreFile.edited && elements.restoreInput.value !== state.restoreFile.text) {
    state.restoreFile.edited = true;
    renderRestoreState();
  }
});
for (const eventName of ['dragenter', 'dragover']) {
  elements.restoreDrop.addEventListener(eventName, (event) => { event.preventDefault(); elements.restoreDrop.classList.add('dragging'); });
}
elements.restoreDrop.addEventListener('dragleave', () => elements.restoreDrop.classList.remove('dragging'));
elements.restoreExportButton.addEventListener('click', async () => {
  if (!state.restoreResult?.restoredText || !state.restoreEntry?.mapping) return;
  const file = state.restoreFile;
  const originalFormat = Boolean(file && !file.edited && file.kind !== 'txt' && file.kind !== 'md');
  try {
    const result = await window.veilforge.saveRestoredDocument({
      token: originalFormat ? file.token : null,
      asText: !originalFormat,
      mapping: state.restoreEntry.mapping,
      text: elements.restoreInput.value,
      nameHint: file?.name?.replace(/\.[^.]+$/u, '') || `${state.restoreEntry.fileNumber || ''}-${state.restoreEntry.name || 'AI返回内容'}`
    });
    if (!result || result.canceled) return;
    showToast(`逆脱敏结果已保存${originalFormat ? `（${String(result.kind).toUpperCase()} 原格式）` : ''}：${result.path}`);
  } catch (error) {
    showToast(`下载失败：${friendlyError(error)}`, 'error');
  }
});
elements.restoreOfficeButton.addEventListener('click', async () => {
  if (!state.restoreEntry?.mapping) return;
  try {
    const result = await window.veilforge.restoreOffice(state.restoreEntry.mapping, state.restoreEntry.text);
    if (!result || result.canceled) return;
    const notes = [`已恢复 ${result.restoredOccurrences} 处`, `${result.knownTokens} 个映射`];
    if (result.missingTokens.length) notes.push(`缺失 ${result.missingTokens.length} 个`);
    if (result.unknownTokens.length) notes.push(`未知 ${result.unknownTokens.length} 个`);
    if (result.repeatedTokens.length) notes.push(`重复 ${result.repeatedTokens.length} 个`);
    if (result.review) {
      const reviewSummary = summarizeReview(result.review);
      if (reviewSummary) notes.push(reviewSummary);
      renderRestoreChecklist(result.review, false);
    } else {
      elements.restoreChecklist.replaceChildren();
      elements.restoreChecklist.classList.add('hidden');
    }
    notes.push(result.complete ? '原格式核对通过' : '已保存，请按核对单逐项检查');
    elements.restoreReport.textContent = notes.join(' · ');
    elements.restoreReport.classList.toggle('needs-review', !result.complete);
    showToast(result.complete ? `原格式逆脱敏完成：${String(result.kind || 'document').toUpperCase()}` : '原格式逆脱敏完成，请核对报告');
  } catch (error) {
    showToast(`原格式逆脱敏失败：${friendlyError(error)}`, 'error');
  }
});
elements.pagePreviousButton.addEventListener('click', () => {
  if (state.currentPage > 0) {
    state.currentPage -= 1;
    renderImagePage();
  }
});
elements.pageNextButton.addEventListener('click', () => {
  if (state.image && state.currentPage < state.image.pageCount - 1) {
    state.currentPage += 1;
    renderImagePage();
  }
});
elements.ocrCorrectionApplyButton.addEventListener('click', async () => {
  const page = currentImagePage();
  if (!state.image?.token || !page) return;
  const corrections = [...elements.ocrCorrectionList.querySelectorAll('.ocr-correction-input')]
    .filter((input) => input.value.trim() && input.value.trim() !== input.dataset.original)
    .map((input) => ({ wordIndex: Number(input.dataset.wordIndex), text: input.value.trim() }));
  if (!corrections.length) {
    showToast('没有需要应用的文字变化');
    return;
  }
  elements.ocrCorrectionApplyButton.disabled = true;
  try {
    const result = await window.veilforge.correctOcr(state.image.token, page.pageNumber, corrections);
    state.sourceText = result.text;
    state.image = result.image;
    state.imageMappingValid = true;
    state.reversibleNonce = createTokenNonce();
    state.reversibleCache = null;
    clearNerFindings();
    elements.charCount.textContent = result.characters.toLocaleString('zh-CN');
    runAnalysis();
    renderImagePage();
    showToast(`已应用 ${result.changed} 项校正，剩余 ${result.remaining} 项待复核`);
  } catch (error) {
    showToast(`OCR 校正失败：${friendlyError(error)}`, 'error');
  } finally {
    elements.ocrCorrectionApplyButton.disabled = false;
  }
});

for (const button of document.querySelectorAll('[data-style]')) {
  button.addEventListener('click', () => {
    state.style = button.dataset.style;
    document.querySelectorAll('[data-style]').forEach((item) => item.classList.toggle('active', item === button));
    runAnalysis();
    renderExportBar();
    renderVaultState();
  });
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
    const sourceActive = button.dataset.tab === 'source';
    elements.sourceEditorWrap.classList.toggle('hidden', !sourceActive);
    elements.selectionBar.classList.toggle('hidden', !sourceActive);
    elements.redactedEditor.classList.toggle('hidden', sourceActive);
    if (sourceActive) renderSourceHighlight();
  });
}

state.activeModule = moduleIdFromHash(window.location.hash);
history.replaceState({ module: state.activeModule }, '', `#${state.activeModule}`);
renderModuleNavigation();
renderTypes();
renderNerState();
renderVaultState();
renderOcrBackendState();
void initializeBundledNer();
void initializeOcrBackend();

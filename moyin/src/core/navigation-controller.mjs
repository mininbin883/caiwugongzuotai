export const NAVIGATION_SCHEMA = 'VEILFORGE_MODULE_NAV_V1';

export const MODULE_IDS = Object.freeze(['redact', 'batch', 'vault', 'restore', 'protect']);

export const MODULE_DEFINITIONS = Object.freeze({
  redact: Object.freeze({
    label: '文件脱敏',
    kicker: '主工作流',
    title: '导入、核对、导出，一次完成',
    description: '可选择文档、粘贴文字或把图片转换为 TXT。常用类型和脱敏方式在左侧；高级识别选项集中到“保护设置”。',
    status: '三步闭环',
    action: '导入文档',
    checklist: Object.freeze(['选择文档、粘贴文字或使用图片转 TXT', '核对识别结果并决定是否隐藏', '导出副本；可选自动写入已解锁仓库'])
  }),
  batch: Object.freeze({
    label: '批处理',
    kicker: '多文件队列',
    title: '一次选择多个文件，后台依次处理',
    description: '队列、进度、失败原因和批量导出集中在这一页。仓库解锁时可把导出成功项自动加密入库。',
    status: '本机串行处理',
    action: '选择多个文件',
    checklist: Object.freeze(['选择多个支持的文件', '观察等待、处理和完成状态', '批量导出；可选把成功项自动写入仓库'])
  }),
  vault: Object.freeze({
    label: '加密仓库',
    kicker: 'AES 本地保险箱',
    title: '脱敏结果与可逆映射只留在本机',
    description: '创建或打开仓库后，可以搜索并按类型/日期筛选记录，查看当前会话备份历史，轮换密码以及回收空间。',
    status: '默认锁定',
    action: '打开或新建仓库',
    checklist: Object.freeze(['打开现有仓库或创建新仓库', '搜索、筛选并管理脱敏结果与可逆映射', '查看备份历史，使用后立即锁定'])
  }),
  restore: Object.freeze({
    label: '逆脱敏',
    kicker: '可逆工作流',
    title: '把 AI 返回内容中的代号换回原文',
    description: '先在“加密仓库”中载入一条可逆记录，再粘贴 AI 返回内容。本页会报告缺失、未知和重复代号。',
    status: '需要可逆记录',
    action: '前往加密仓库',
    checklist: Object.freeze(['从仓库载入可逆代号记录', '粘贴或编辑 AI 返回内容', '执行逆脱敏并核对完整性报告'])
  }),
  protect: Object.freeze({
    label: '保护设置',
    kicker: '识别与处理策略',
    title: '在一个地方管理所有识别规则',
    description: '配置敏感类型、自定义词、保留词、离线 NER、OCR 引擎和默认脱敏方式；设置会立即作用于当前文档。',
    status: '本机即时生效',
    action: '定位到自定义词',
    checklist: Object.freeze(['选择敏感信息类型和脱敏方式', '补充自定义词、类型化词与保留词', '确认离线 NER 与 OCR 引擎状态'])
  })
});

export function normalizeModuleId(value, fallback = 'redact') {
  const candidate = String(value || '').trim().toLowerCase().replace(/^#/, '');
  return MODULE_IDS.includes(candidate) ? candidate : fallback;
}

export function moduleIdFromHash(hash, fallback = 'redact') {
  return normalizeModuleId(String(hash || '').split(/[?&]/u, 1)[0], fallback);
}

export function nextModuleId(current, direction) {
  const index = MODULE_IDS.indexOf(normalizeModuleId(current));
  if (direction === 'first') return MODULE_IDS[0];
  if (direction === 'last') return MODULE_IDS.at(-1);
  const delta = direction === 'previous' ? -1 : 1;
  return MODULE_IDS[(index + delta + MODULE_IDS.length) % MODULE_IDS.length];
}

export function moduleVisibility(moduleId) {
  const active = normalizeModuleId(moduleId);
  return Object.freeze({
    active,
    showRedactionWorkflow: active === 'redact',
    showBatchQueue: active === 'batch',
    showVaultControls: active === 'vault',
    showRestoreWorkspace: active === 'restore',
    showProtectionControls: active === 'protect'
  });
}

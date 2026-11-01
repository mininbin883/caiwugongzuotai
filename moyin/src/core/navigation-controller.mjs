export const NAVIGATION_SCHEMA = 'VEILFORGE_MODULE_NAV_V1';

export const MODULE_IDS = Object.freeze(['redact', 'batch', 'vault', 'restore', 'protect']);

export const MODULE_DEFINITIONS = Object.freeze({
  redact: Object.freeze({
    label: '文件脱敏',
    kicker: '第一步 · 处理单个文件',
    title: '导入文件 → 核对 → 导出副本',
    description: '把文件里的公司名、人名、税号、证件号、电话、账号、地址换成代号，导出一份可以放心发给 AI 的副本。原文件不会被修改。',
    status: '三步完成',
    action: '导入文档',
    checklist: Object.freeze(['点“导入文档”，选择 Word、Excel、PDF 或 CSV', '在右侧核对：勾选的会被隐藏，漏掉的在原文里选中补上', '点“确认并导出副本”，把副本和“给 AI 的要求”发给 AI'])
  }),
  batch: Object.freeze({
    label: '批处理',
    kicker: '多个文件一起处理',
    title: '一批文件，一个编号，一次换回',
    description: '把一家企业的多份资料（余额表、发票导出、往来明细等）一起拖进来。同一家公司、同一个人在所有文件里用同一个代号，逆脱敏时选这一个编号就行。',
    status: '后台依次处理',
    action: '选择多个文件',
    checklist: Object.freeze(['点“选择多个文件”或直接把文件拖进窗口', '等全部显示“已完成”，选择导出模式（做税务筛查选“税务筛查”）', '点“导出为一个批次”，把整个文件夹发给 AI'])
  }),
  vault: Object.freeze({
    label: '加密仓库',
    kicker: '换回原文的钥匙',
    title: '代号对照表加密保存在本机',
    description: '每次导出时，“哪个代号对应哪个原文”会加密存进仓库，AI 返回后靠它换回原文。请记住仓库密码（忘记无法找回），并定期“导出备份”。',
    status: '默认锁定',
    action: '打开或新建仓库',
    checklist: Object.freeze(['第一次使用点“新建”并设置密码；以后点“打开”输入密码', '在这里查看、搜索、删除以前的记录', '每月“导出备份”一次，存到 U 盘；换电脑时“导入备份”'])
  }),
  restore: Object.freeze({
    label: '逆脱敏',
    kicker: '最后一步 · AI 返回后',
    title: '把 AI 返回内容里的代号换回原文',
    description: 'AI 返回的报告或文件里写的是代号。把它拖进来，墨隐按文件名里的编号找到对应记录，换回真实名称，并按原格式下载。',
    status: '需要先打开仓库',
    action: '导入 AI 返回的文件',
    checklist: Object.freeze(['把 AI 返回的文件拖进来，或粘贴 AI 的回复', '确认上方选中的是对应编号的记录', '点“开始逆脱敏”，核对提醒后下载结果'])
  }),
  protect: Object.freeze({
    label: '保护设置',
    kicker: '一般不用改',
    title: '调整要隐藏哪些信息',
    description: '默认设置已经适合大多数财务资料。需要时可以关闭某类识别（例如不隐藏地址），或补充一定要隐藏、一定不隐藏的词。改完点“应用并重新识别”。',
    status: '改动需点“应用”',
    action: '定位到自定义词',
    checklist: Object.freeze(['勾选要识别的信息类型', '补充一定要隐藏的词，或不需要隐藏的词', '点“应用并重新识别”生效'])
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

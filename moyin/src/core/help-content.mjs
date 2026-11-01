// 新手引导与“使用帮助”的文字。界面上的按钮名称要与这里一致。

/**
 * 新手引导的步骤。target：要高亮的元素（CSS 选择器，没有则居中显示）；module：显示这一步前切换到的页面。
 */
export const TOUR_STEPS = Object.freeze([
  Object.freeze({
    title: '欢迎使用墨隐',
    body: '墨隐帮你把文件里的公司名、人名、税号、证件号、电话、账号、地址换成代号，再交给 AI 处理；AI 返回后，一键换回原文。全程在这台电脑上完成，文件不上传。',
    steps: Object.freeze(['导出脱敏副本', '把副本发给 AI', 'AI 返回后换回原文']),
    module: 'redact'
  }),
  Object.freeze({
    target: '#moduleNav',
    title: '五个功能页',
    body: '常用的是前四个：“文件脱敏”处理单个文件，“批处理”处理一批文件，“加密仓库”保存换回原文用的对照表，“逆脱敏”把 AI 返回的内容换回原文。“保护设置”一般不用改。',
    module: 'redact'
  }),
  Object.freeze({
    target: '#emptyOpenButton',
    title: '第 1 步：导入文件',
    body: '点这里选择 Word、Excel、PDF 或 CSV 文件，也可以“粘贴文字”。不熟悉时先点“用示例试一试”，用示例文件走一遍。',
    module: 'redact'
  }),
  Object.freeze({
    target: '#workflowGuide',
    title: '第 2、3 步：核对，然后导出',
    body: '导入后右侧会列出识别到的信息：勾选的会被隐藏，误判的取消勾选；漏掉的，在左侧原文里用鼠标选中，点“全文同样的都隐藏”。核对好后点“确认并导出副本”。',
    module: 'redact'
  }),
  Object.freeze({
    target: '.module-nav-item[data-module="vault"]',
    title: '第一次导出时：建一个文件仓库',
    body: '导出时会请你新建仓库并设置密码。“哪个代号对应哪个原文”加密保存在这里，AI 返回后靠它换回原文。请记住密码（忘记无法找回），并定期“导出备份”。',
    module: 'redact'
  }),
  Object.freeze({
    target: '.module-nav-item[data-module="batch"]',
    title: '多个文件：用批处理',
    body: '一家企业的多份资料一起拖进来，导出为一个批次，整批只有一个编号。要用“建筑业税务风险筛查”技能时，导出模式选“税务筛查”。',
    module: 'redact'
  }),
  Object.freeze({
    target: '.module-nav-item[data-module="restore"]',
    title: 'AI 返回后：来这里换回原文',
    body: '把 AI 返回的文件拖进“逆脱敏”页，墨隐按文件名里的编号找到记录，换回真实名称；整个“筛查结果”文件夹也可以一次还原。',
    module: 'redact'
  }),
  Object.freeze({
    target: '#helpButton',
    title: '随时查看帮助',
    body: '忘了怎么做，点右上角的“使用帮助”：里面有每项操作的步骤和常见问题，也可以重新看这段引导。',
    module: 'redact'
  })
]);

/** “使用帮助”里的内容：常用操作（按步骤）与常见问题。 */
export const HELP_TASKS = Object.freeze([
  Object.freeze({
    title: '处理一份文件',
    module: 'redact',
    steps: Object.freeze([
      '左侧选“文件脱敏”，点“导入文档”，选择文件。',
      '在右侧核对：勾选的会被隐藏。表格文件点“按列”核对更快。',
      '漏掉的：在左侧原文里选中文字，点“全文同样的都隐藏”。',
      '勾选“我已核对要隐藏的信息”，点“确认并导出副本”。第一次会请你新建文件仓库。',
      '在弹出的“接下来”里点“复制要求”，把副本和要求一起发给 AI。'
    ])
  }),
  Object.freeze({
    title: '一次处理一批文件',
    module: 'batch',
    steps: Object.freeze([
      '左侧选“批处理”，点“选择多个文件”，或直接把文件拖进窗口。',
      '等所有文件显示“已完成”。',
      '选择导出模式：一般用“标准”；要做建筑业税务风险筛查选“税务筛查”。',
      '点“导出为一个批次”，选择保存位置，把导出的文件夹发给 AI。',
      '有失败的文件会标红并写明原因，可以单独打开核对后再导出。'
    ])
  }),
  Object.freeze({
    title: 'AI 返回后换回原文',
    module: 'restore',
    steps: Object.freeze([
      '左侧选“逆脱敏”，先打开文件仓库（输入密码）。',
      '把 AI 返回的文件拖进来，或粘贴 AI 的回复；整个文件夹点“还原整个文件夹”。',
      '确认上方选中的是对应编号的记录（文件名里有编号时会自动选中）。',
      '点“开始逆脱敏”，看一下核对单里的提醒，再下载结果。'
    ])
  }),
  Object.freeze({
    title: '备份与换电脑',
    module: 'vault',
    steps: Object.freeze([
      '左侧选“加密仓库”，点“打开”并输入密码。',
      '点“导出备份”，把备份文件存到 U 盘，建议每月一次。',
      '换电脑后：安装墨隐 → “加密仓库” → “导入备份”，不需要授权码。',
      '新电脑的设备码会变，请发给我们重新签发授权码。'
    ])
  })
]);

export const HELP_FAQ = Object.freeze([
  Object.freeze({ q: '导出时提示需要激活？', a: '点右上角的授权状态，复制设备码发给我们领取授权码。未激活时可以正常识别和预览，只是不能导出新副本。' }),
  Object.freeze({ q: '有些名字没识别出来？', a: '在左侧原文里选中它，点“全文同样的都隐藏”；表格里整列都是姓名时，用“按列”里的“整列隐藏”。' }),
  Object.freeze({ q: '做税务筛查该选哪种模式？', a: '批处理导出时选“税务筛查”。它保留地区、行业等特征，筛查结果与直接用原件一致；标准模式会把这些特征也隐藏掉。' }),
  Object.freeze({ q: '逆脱敏提示有代号不属于这条记录？', a: '通常是选错了编号。核对 AI 返回文件名里的编号（如 MI-000123），在下拉菜单里选对应的记录。' }),
  Object.freeze({ q: '忘记了仓库密码？', a: '无法找回，这是为了保护你的数据。原件不受影响；已发出的副本无法再换回原文。请新建仓库继续使用。' }),
  Object.freeze({ q: '图片可以处理吗？', a: '不可以。图片里的文字无法可靠识别，请改用原始的 Excel、Word 或 PDF；只有截图时请先手动打码。' }),
  Object.freeze({ q: '我的文件会上传到网上吗？', a: '不会。识别、导出、逆脱敏和激活都在本机完成。你发给 AI 的只有脱敏后的副本。' })
]);

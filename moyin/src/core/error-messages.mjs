// 把内部错误代码翻译成用户看得懂的话，并告诉用户下一步怎么办。
// 未收录的代码给出通用说明，同时保留代码便于反馈。

const MESSAGES = [
  // 文件与导入
  [/LOCAL_(?:FILE|OFFICE|PDF|CSV|IMAGE)_TOO_LARGE|LOCAL_OFFICE_TEXT_TOO_LARGE|LOCAL_SCAN_TEXT_TOO_LARGE|LOCAL_PASTED_TEXT_TOO_LARGE/, '文件太大，超出了能完整处理的范围。请拆成几份分别导入；墨隐不会只处理一部分冒充完整结果。'],
  [/LOCAL_(?:DOCUMENT|CSV|OCR|PASTED_TEXT)_EMPTY/, '没有读到任何文字。如果是扫描件或图片，请改用“图片转 TXT”。'],
  [/LOCAL_(?:DOCUMENT|OFFICE|PDF|IMAGE|IMAGE_TO_TEXT)?_?TYPE_UNSUPPORTED/, '不支持这种文件格式。支持 Word、Excel、PDF、CSV、TXT/Markdown 和常见图片。'],
  [/LOCAL_(?:DOCX|XLSX)_FORMAT_INVALID|LOCAL_XLSX_CELL_MAP_INVALID/, '文件内容损坏或不是标准的 Word/Excel 格式。请用 Office 或 WPS 打开后另存一份再导入。'],
  [/LOCAL_PDF_ENCRYPTED|LOCAL_PDF_PASSWORD_REQUIRED/, 'PDF 设有打开密码，请输入密码后再导入。'],
  [/LOCAL_PDF_PASSWORD_INVALID/, 'PDF 密码不正确，请重新输入。'],
  [/LOCAL_PDF_PAGE_COUNT_INVALID|LOCAL_SCAN_PAGE_COUNT_INVALID/, 'PDF 页数超过上限（原生 PDF 300 页，扫描件 100 页）。请拆分后再导入。'],
  [/LOCAL_PDF_PAGE_TOO_LARGE|LOCAL_IMAGE_DIMENSIONS_INVALID/, '页面或图片尺寸过大，无法可靠处理。请缩小后再导入。'],
  [/LOCAL_PDF_ROTATION_UNSUPPORTED/, '这份 PDF 的页面方向无法可靠处理。请先在 PDF 软件里旋转为正常方向后另存。'],
  [/LOCAL_PDF_STRUCTURE_PRESERVATION_FAILED/, 'PDF 的表单或批注无法安全保留，已停止导出。可以先另存为普通 PDF，或用“图片转 TXT”。'],
  [/LOCAL_NOT_A_FILE|LOCAL_(?:CSV_)?PATH_INVALID|LOCAL_CSV_NOT_A_FILE/, '找不到这个文件，或它不是普通文件。请确认文件还在原位置。'],
  // 会话与导出
  [/LOCAL_(?:OFFICE|CSV|IMAGE|PDF)_SESSION_(?:EXPIRED|INVALID)|LOCAL_PDF_PASSWORD_SESSION_EXPIRED/, '当前文档的处理会话已失效（可能是原文被编辑过，或停留时间过长）。请重新导入文档。'],
  [/LOCAL_(?:OFFICE|IMAGE)_SESSION_KIND_MISMATCH/, '导出格式和导入的文档不一致。请重新导入后再导出。'],
  [/LOCAL_CSV_STRUCTURE_CHANGED/, '原文被编辑后，表格的行列结构变了，无法按原格式导出。请撤销编辑或重新导入；漏项请用“选中文字补选”。'],
  [/LOCAL_(?:OFFICE|IMAGE)_NO_REDACTIONS/, '没有可以写回的隐藏项：要么一项都没勾选，要么识别到的内容都不在能改写的位置（例如只出现在图表、文本框里）。请打开这个文件核对一下。'],
  [/LOCAL_EXPORT_TOO_LARGE/, '导出内容太大，请拆分文档后再导出。'],
  [/LOCAL_EXPORT_INVALID/, '导出内容不完整，请重新识别后再导出。'],
  [/LOCAL_DISK_BUDGET_EXCEEDED|LOCAL_WORKSPACE_BUDGET_EXCEEDED/, '电脑磁盘空间不足。请清理一些空间后重试。'],
  [/LOCAL_MEMORY_BUDGET_EXCEEDED/, '内存不足。请关闭其他程序，或把文件拆小后重试。'],
  // 可逆与逆脱敏
  [/LOCAL_(?:OFFICE|PDF)_REVERSIBLE_TOKENS_NOT_FOUND/, '在这个文件里没有找到本记录的代号。请确认导入的是 AI 返回的、对应编号的文件。'],
  [/LOCAL_PDF_REVERSIBLE_SIDECAR_(?:REQUIRED|INVALID)/, 'PDF 逆脱敏需要导出时一起生成的坐标副本（.tokens.json），请把它和 PDF 放在同一文件夹。'],
  [/LOCAL_PDF_REVERSIBLE_COORDINATES_NOT_FOUND/, '这份 PDF 里找不到能写入代号的文字位置（常见于扫描件识别不完整），无法生成可逆副本。可以打开这个文件补选或校正识别文字后单独导出，或改用“图片转 TXT”。'],
  [/LOCAL_PDF_REVERSIBLE_FINDINGS_INVALID/, '这份 PDF 的隐藏项无法写成可逆代号（位置与识别文字对不上），请打开这个文件核对后单独导出。'],
  [/REVERSIBLE_MAPPING_INVALID|LOCAL_(?:OFFICE_REVERSIBLE|VAULT)_MAPPING_INVALID/, '代号对照表已损坏或不完整，无法逆脱敏。请从仓库备份恢复这条记录。'],
  // 仓库
  [/LOCAL_VAULT_PASSWORD_POLICY/, '仓库密码至少 10 个字符。'],
  [/LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID/, '密码不正确，或仓库文件已损坏。请检查密码；如果确认密码正确，请用备份恢复。'],
  [/LOCAL_VAULT_SESSION_(?:EXPIRED|INVALID)|VAULT_LOCKED/, '文件仓库已自动锁定。请重新打开仓库后再试。'],
  [/LOCAL_VAULT_SAVE_NOT_READY/, '还不能保存：请先打开文件仓库，并导入一份文档。'],
  [/LOCAL_VAULT_ENTRY_LIMIT|LOCAL_VAULT_TOO_LARGE/, '文件仓库已满。请先做一次备份，然后删除不再需要的记录并“压缩回收空间”。'],
  [/LOCAL_VAULT_ENTRY_NOT_FOUND/, '找不到这条仓库记录，它可能已被删除。'],
  [/LOCAL_VAULT_IMPORT_CONFLICT/, '备份里有和当前仓库重复的记录。请在“导入冲突”里选择“保留并自动改名”或“跳过冲突项”。'],
  [/LOCAL_VAULT_BACKUP_FORMAT_INVALID|LOCAL_VAULT_FORMAT_INVALID/, '所选文件不是墨隐的仓库或备份文件。'],
  [/LOCAL_VAULT_WRITE_INCOMPLETE/, '仓库没有完整写入（可能是磁盘空间不足或文件被占用）。原有内容不受影响，请重试。'],
  [/LOCAL_VAULT_ATTACHMENT_SESSION_EXPIRED/, '导出的附件已过期，请重新导出后再保存到仓库。'],
  [/LOCAL_VAULT_ATTACHMENT_TOO_LARGE/, '附件太大，无法存入仓库。'],
  [/EEXIST/, '同名文件已经存在，请换一个文件名。'],
  // 识别引擎
  [/LOCAL_RAPIDOCR_|LOCAL_RUNTIME_PACK_/, '本地 OCR 组件不完整。请确认完整包的三个分卷都已解压到同一文件夹；也可以在保护设置里切换到 Tesseract。'],
  [/LOCAL_NER_|LOCAL_MODEL_PACK_/, '本地识别模型不可用（规则识别不受影响）。请确认完整包的“识别模型”分卷已解压。'],
  [/LOCAL_OCR_/, '文字识别没有完成，请重试；若图片模糊，可先提高清晰度。'],
  // 批处理
  [/LOCAL_RESTORE_FOLDER_EMPTY/, '这个文件夹里没有可以还原的文件（支持 Word、Excel、CSV、Markdown、TXT）。'],
  [/LOCAL_RESTORE_FOLDER_EXPIRED/, '文件夹的还原会话已失效，请重新选择文件夹。'],
  [/LOCAL_BATCH_SCREENING_NO_TABLES/, '税务筛查模式只导出 Excel 和 CSV 表格（筛查脚本只读这两种），当前已完成的任务里没有表格文件。'],
  [/LOCAL_BATCH_LIMIT_EXCEEDED/, '一次加入的文件太多，请分批处理。'],
  [/LOCAL_BATCH_EXPORT_ACTIVE/, '批量导出正在进行，请等它完成。'],
  [/LOCAL_BATCH_(?:EMPTY|EXPORT_EMPTY)/, '没有可以导出的已完成任务。'],
  [/LOCAL_BATCH_CANCELED|LOCAL_JOB_ABORTED/, '已取消。'],
  // 安全
  [/LOCAL_SENDER_DENIED/, '安全检查拦截了这次操作。请关闭墨隐后重新打开。']
];

/** 返回给用户看的中文说明。 */
export function friendlyError(error) {
  const raw = String(error?.message || error || '');
  for (const [pattern, message] of MESSAGES) if (pattern.test(raw)) return message;
  const code = raw.match(/\b(?:LOCAL|REVERSIBLE|VAULT)_[A-Z0-9_]+\b/u)?.[0];
  if (code) return `操作没有完成（代码 ${code}）。请重试；如果反复出现，请记下当时的步骤和这个代码反馈给我们，不需要发送原文件。`;
  // Electron 会把主进程错误包装成 “Error invoking remote method ...: Error: XXX”
  const plain = raw.replace(/^Error invoking remote method '[^']+':\s*/u, '').replace(/^Error:\s*/u, '').trim();
  return plain || '发生未知错误，请重试。';
}

export const errorMessageCount = MESSAGES.length;

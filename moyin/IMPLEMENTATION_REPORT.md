# 墨隐本地脱敏 0.5.0 · 实现报告

## 已交付闭环

`导入文档/图片/PDF → 离线识别 → 人工复核 → 原格式 Office 脱敏或像素涂黑 → AES 仓库保存`

Windows ZIP：

`D:/360安全浏览器下载/UCODE/yinye-cleanroom-clone/release8/VeilForge-0.5.0-win-x64.zip`

## 0.5.0 新增

- DOCX 原格式脱敏导出；
- 对 `document.xml`、页眉、页脚、脚注、尾注和批注进行文本映射；
- 敏感值跨多个 Word run 时只写入一次 replacement，并清除后续片段；
- 仅改写目标 `w:t` 文本，保留段落、字符样式、表格和其他 OOXML 部件；
- XLSX 原格式脱敏导出；
- 从工作簿关系文件解析工作表 part，建立单元格与全局文本偏移映射；
- 仅把命中单元格转换为 `inlineStr`，保留原样式编号和其他工作簿部件；
- 公式单元格不进入脱敏映射，防止公式被文本替换；
- 编辑提取文本后自动使原格式坐标失效，避免错误回写；
- 新增 DOCX/XLSX 集成、残留检测、公式保持和真实渲染验证。

## 既有能力

- PNG/JPG/WEBP/BMP/TIFF 中英文 OCR 与不可恢复黑块；
- 多页 PDF OCR、分页复核和栅格化涂黑 PDF；
- 手机号、身份证号、邮箱、银行卡、IPv4、固定电话与自定义词；
- AES-256-GCM 加密仓库、密码轮换和自动锁定；
- Electron sandbox、contextIsolation、CSP 与离线网络策略。

## 0.5.0 实测

- Node：21/21 tests passed；
- DOCX：7 个敏感信息命中、11 个 XML 文本节点修改、残留 0；
- XLSX：8 个敏感信息命中、8 个单元格修改、残留 0；
- Excel `G4:G6` 的 `LEN` 公式全部保持；
- XLSX 公式错误扫描匹配 0 项；
- DOCX 输出经 LibreOffice 渲染为 1 页，标题、段落、表格、页眉和页脚布局完整；
- XLSX 输出经 Artifact Tool 重新计算、检查和渲染，样式、列宽、冻结窗格及公式结果完整；
- Electron：`OFFICE_SMOKE_PASS docxFindings=7 docxUnits=11 xlsxFindings=8 xlsxUnits=8 residual=0`。

## 关键路径

- Office 服务：`D:/360安全浏览器下载/UCODE/yinye-cleanroom-clone/src/services/office-redaction-service.cjs`
- Office 测试：`D:/360安全浏览器下载/UCODE/yinye-cleanroom-clone/tests/office-redaction.test.mjs`
- DOCX 结果：`D:/360安全浏览器下载/UCODE/yinye-cleanroom-clone/output/office/phase5-redacted.docx`
- XLSX 结果：`D:/360安全浏览器下载/UCODE/yinye-cleanroom-clone/output/office/phase5-redacted.xlsx`
- 集成报告：`D:/360安全浏览器下载/UCODE/yinye-cleanroom-clone/output/office/phase5-integration.json`
- 三段验证：`D:/360安全浏览器下载/UCODE/yinye-cleanroom-clone/transaction-phase5/VERIFICATION.txt`

## 下一阶段

1. 拖拽批处理和后台任务队列；
2. 仓库条目删除、导出和恢复点；
3. 扫描版 Office 混合 OCR；
4. 品牌图标、安装/卸载程序与 Authenticode 签名。

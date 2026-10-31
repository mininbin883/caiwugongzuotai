# 墨隐 · 本地文档脱敏

独立编写的离线桌面文档脱敏应用。2.14.1 修复 hash 路由导致 `batch-enqueue` 等 IPC 被误判为 `LOCAL_SENDER_DENIED` 的问题；sender guard 现在按规范化本地入口路径校验，同时保留 `file:` 协议和子帧优先限制。

## 已实现

- Electron 安全基线：sandbox、contextIsolation、无 Node 注入、CSP，以及导航、弹窗和权限拦截；IPC sender guard 允许同一入口文件的 hash/query 路由，但拒绝其他文件和非 `file:` 来源。
- 导入 TXT、Markdown、CSV、JSON、PDF、DOCX、XLSX、PNG、JPG、WEBP、BMP、TIFF；所有模型与解析均离线运行。
- 规则、类型化自定义词和可选本地 ONNX NER 合并识别；覆盖手机号、身份证、邮箱、银行卡、IP、固定电话、姓名、公司、地址、统一社会信用代码等。
- OCR 支持方向校正、低分辨率增强、低置信度人工校正、表格/合并单元格和双栏阅读顺序；Tesseract 低置信度结果会尝试 ±90° 候选，普通横排页面不增加旋转识别。
- 随包中文 BERT NER 模型采用固定哈希 manifest 自动校验并后台加载；CPython 3.13.15、RapidOCR 3.9.2、ONNX Runtime 1.29.0 与 PP-OCRv6 Small 作为完整离线运行时逐文件校验并自动启用，界面仍可切换到 Tesseract.js。
- OCR 固定语料基准覆盖中文低分辨率、低对比度、合并表格和双栏；RapidOCR 当前 CER/WER 均为 0，Tesseract.js 为 CER 0.010526 / WER 0.037037。
- PDF 支持最多 100 MiB、300 页的流式工作区；原生文字页与扫描页统一映射坐标，并正确处理 0/90/180/270 度页面。
- PDF 不可恢复涂黑会替换旧内容流和旧 XObject；保留旋转、MediaBox/CropBox、AcroForm、Widget/Link 批注、嵌入字体、XFA 与 PDF/A 声明，并显式报告签章在修改后失效。
- 带密码 PDF 通过受控对话框导入，密码只进入当前任务内存；错误密码可重试，解密后的源文件不会落盘，最终结果走安全栅格重建。
- PDF 导出后自动调用可选 veraPDF CLI JSON 校验适配器；缺少 CLI 时明确报告未安装，不把“声明存在”误报成“规范通过”。
- 重新签名支持 PKCS#12 证书实签和 PKCS#11/HSM 异步回调适配器，使用 PAdES CAdES detached 子过滤器并生成有效 ByteRange/CMS。
- PDF/DOCX/XLSX 支持不可恢复脱敏及可逆令牌往返；DOCX/XLSX 保留 OOXML 其他部件、样式和公式。
- CSV 专用链保留 UTF-8/UTF-16LE/UTF-16BE/GB18030 编码、BOM、逗号/分号/TAB/竖线方言、原换行与引号/跨行字段；导出时阻断公式注入，可逆代号恢复后可与源文件逐字节一致。
- 批处理支持拖放、串行队列、取消、冲突安全命名、去敏审计清单，以及成功导出项可选自动加密入库。
- AES-256-GCM + scrypt 本地仓库使用 v3 分块认证容器和 v4 逻辑索引，支持 v2 原子迁移、备份导入、密码轮换、条目删除、游标分页和原子压缩回收。
- 原件和脱敏副本作为隐藏加密 file-blob 保存；SHA-256 内容寻址让跨记录相同文件只存一份，删除记录只清理失去全部引用的孤儿 blob。
- 单文件导出可显式保存“原件＋脱敏副本”，批处理自动入库也携带成功项的原件与副本；列表显示附件数并可逐项另存，解密导出后再次校验 SHA-256。
- 备份导出/导入活动写入 AES-256-GCM 认证索引，锁定或重启后仍可恢复；仅保存动作、时间、basename、计数和可选 SHA-256，不保存目录路径、密码或 token。
- 活动历史限制为 20 条，随仓库压缩、密码轮换和加密备份保持；导入时合并来源与本地历史并按 ID 去重。
- 仓库已验证 256 MiB 对齐容量和 1 GiB 长跑；2 GiB 写入边界在处理前拒绝。
- 所有解析与脱敏均在本机完成；应用没有联网业务代码。
- 五个一级任务入口分别提供三步清单、状态徽标和唯一主操作；支持 URL hash、方向键/Home/End、Ctrl+1～5，并为批处理提供原生多文件选择器。
- 首屏可直接粘贴文字或选择图片转 TXT；粘贴内容保留换行并显示字符/字节计数，图片链复用 RapidOCR 与人工校正后提供独立识别文本出口。
- 已解锁仓库可按会话开启“导出后自动入库”；默认关闭，只在成功导出后执行，锁定、取消导出和逆脱敏会话不会触发。
- 仓库支持按编号、名称或敏感类型搜索，组合脱敏/可逆类型与起止日期筛选；备份导出和导入结果显示在当前解锁会话历史中。
- 首屏提供与隐页工作流一致的三步引导、格式范围、隐私说明和“用示例试一试”；本地虚构示例一次覆盖公司、姓名、手机号、邮箱、银行卡、地址、IPv4 与自定义词，并把流程推进到人工核对。

## 运行与验证

```powershell
npm install
npm test
npm run test:pdf
npm run test:pdf-reversible
npm run test:pdf-complex
npm run test:pdf-geometry
npm run test:pdf-security
npm run test:office
npm run test:office-reversible
npm run test:csv
npm run test:phase24
npm run test:phase25
npm run test:phase26
npm run test:ui-phase26
npm run test:phase27
npm run test:ui-phase27
npm run test:phase28
npm run test:ui-phase28
npm run test:phase29
npm run test:ui-phase29
npm run test:phase30
npm run test:ui-phase30
npm run test:phase31
npm run test:ui-phase31
npm run test:phase32
npm run test:phase33
npm run test:phase34
npm run test:phase35
npm run benchmark:ocr
npm start
```

## Windows 2.14.1 发布物

- 目录：`release39-v2.14.1/win-unpacked`
- 完整 ZIP：`release39-v2.14.1/VeilForge-2.14.1-win-unpacked.zip`
- 完整 ZIP：880,381,859 bytes，2,939 entries
- 完整 ZIP SHA256：`847B8B127617DAE73174D64C8A8756418011B5D58CC56817D8F75EDF11F72C3D`
- 独立运行时 ZIP：`release39-v2.14.1/VeilForge-RapidOCR-Runtime-1.0.0-win-x64.zip`
- 运行时 ZIP：111,237,646 bytes，2,513 entries
- 运行时 ZIP SHA256：`45898CAE9BC83A3359FA087910AF93CFECD8DD99C438B169E213531C76A5C76D`

## 当前边界

附件单文件上限 100 MiB、每条记录最多 8 个附件；当前读取受限文件后交给 1 MiB 分块加密容器。活动历史只记录备份动作的最小元数据并限制 20 条。Office 长尾报告覆盖透视表/缓存、外链、名称范围、数据验证、条件格式、SmartArt、嵌入对象和关系包，并对不重算/不执行的部件明确标记 `degraded`；报告位于 `output/office/phase31-long-tail-report.json`。Phase 34 报告位于 `output/ocr/phase34/ocr-vertical-report.json`；RapidOCR 与 Tesseract 六场景总召回均为 1.0，竖排恢复会记录方向、识别次数和所选分割模式。报告仍统计 CER/WER、平均/P95 耗时和父进程峰值 RSS。PDF 结构保真路径覆盖 0/90/180/270 度和非默认 CropBox；XFA 保留但不解释业务规则。旧式二进制 `.xls` 仍导出文本；受密码保护的 Office 文件需要先解除保护。








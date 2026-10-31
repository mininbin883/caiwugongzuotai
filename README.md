# 财务工作台软件发布仓库

本仓库保存两套本地文档脱敏软件的可复现源码、版本清单和发布包：

## 墨隐（VeilForge）v2.14.1

- 源码：[`moyin/`](moyin/)
- Windows 完整运行包：GitHub Releases 中的 `VeilForge-2.14.1-win-unpacked.zip`
- 源码快照：GitHub Releases 中的 `VeilForge-2.14.1-source.zip`
- 当前能力包括 Office/PDF/CSV/图片处理、RapidOCR/Tesseract、本地 NER、批处理和加密仓库。

## 隐页（Yinye）v1.0.0.9

- 包清单：[`yinye/PACKAGE-MANIFEST.json`](yinye/PACKAGE-MANIFEST.json)
- 使用说明：[`yinye/使用说明.txt`](yinye/使用说明.txt)
- Windows 干净运行包：GitHub Releases 中的 `Yinye-1.0.0.9-win-x64-clean.zip`
- 干净运行包严格按 `PACKAGE-MANIFEST.json` 收集，不包含本机 `data/history`、`data/license`、`data/session` 和 `data/settings`。

## 下载与校验

发布页：<https://github.com/mininbin883/caiwugongzuotai/releases/tag/software-bundle-2026.10.31>

SHA-256：[`releases/SHA256SUMS.txt`](releases/SHA256SUMS.txt)

详细上传清单：[`releases/UPLOAD-MANIFEST.json`](releases/UPLOAD-MANIFEST.json)

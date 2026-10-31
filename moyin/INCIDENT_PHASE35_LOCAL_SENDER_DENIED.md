# Phase 35：`LOCAL_SENDER_DENIED` 使用故障修复

## 现象

批量拖放调用 `veilforge:batch-enqueue` 时返回：

```text
LOCAL_SENDER_DENIED
```

开发 smoke 中 `veilforge:ner-bundled` 和 `veilforge:ocr-backend-state` 也曾出现同一拒绝，说明故障位于所有 IPC 共用的 sender guard，而不是批量队列本身。

## 根因

旧 guard 把 `event.senderFrame.url` 与不带路由片段的 `index.html` URL 做字符串全等比较。界面使用 `#redact`、`#batch` 等 hash 路由后，实际 sender URL 仍是同一个本地入口文件，但字符串多出 hash，因此被误判为不同来源。

## 修复

- 使用标准 `fileURLToPath()` 解析 sender URL。
- 比较规范化后的入口文件绝对路径，忽略同文件的 query/hash 状态。
- 保持协议限制：仅接受 `file:`。
- `senderFrame.url` 缺失时，回退到顶层 `WebContents.getURL()`。
- `senderFrame` 存在时始终优先使用，避免子帧借顶层 URL 通过检查。

## 验证

```text
sender guard accepts exact entry URL: PASS
sender guard accepts #batch route: PASS
sender guard rejects another local file: PASS
sender guard rejects https origin: PASS
senderFrame takes priority over top-level fallback: PASS
SMOKE_OK secure-window-loaded sender-hash=1 batch-list=1 ocr-state=1
```

修复后 hash 路由状态下的批量列表与 OCR 状态 IPC 均成功；所有使用相同 guard 的 `batch-enqueue`、导出、仓库和 NER IPC 同步恢复。

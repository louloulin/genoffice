---
title: 无头 PDF 导出
---

# 无头 PDF 导出

GenOffice 的每条"导出 PDF"路径都可以不打开可见编辑器窗口，仅通过一个入口驱动：

```
<app binary> --headless-export <input-file> --to pdf --out <path> [--json]
```

应用不创建可见窗口、隐藏 macOS dock 图标，写入恰好一个字节（PDF）或 JSON
状态行（`--json` 模式）。同一管道驱动 PDF / Markdown / HTML 输出，可在 CI / 批处理中复用。

## 用例

- 流水线 PDF 渲染（CI / 定时任务）
- 邮件附件预生成
- 服务端 PDF 转换（web-server 配合 `--headless-export`）

## 详细说明

完整规范参见英文版 [`/headless-pdf-export`](/headless-pdf-export)。

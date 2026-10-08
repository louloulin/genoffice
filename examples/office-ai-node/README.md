# `@genoffice/office-ai-node` — 无头 Office 文档引擎的真实运行示例

用 `@genoffice/office-ai` 在**一个普通 Node 进程内**完成读、编辑、转换、渲染四种
Office 能力：无 Electron、无 HTTP、无 SaaS、无模型调用。这就是宿主项目（如
`aiwork` 的 `apps/server/src/office/local.ts`）接入该库时写的全部代码的样子。

## 运行

```sh
# 仓库根目录，先构建库（已构建过可跳过）
npm run build:office-ai

# 跑示例
node examples/office-ai-node/run.mjs
```

## 它实际做什么（全部输入是仓库真实文件）

| 步骤 | 输入 | 做什么 | 产物 |
|---|---|---|---|
| 1 读取 | 真实**加密** PDF / kitchen-sink.docx / 真实 xlsx / 真实 pptx | `readDocument` 统一视图；PDF 无密码只看到 `encrypted:true`，带密码读到 1 页 | — |
| 2 编辑 | kitchen-sink.docx / xlsx | `openDocsFile` 追加段落；`writeDocument` 写 A1；保存后**重新打开验证** | `out/edited-kitchen-sink.docx`、`out/edited-kitchen-sink.xlsx` |
| 3 转换 | xlsx / docx / README.md / csv 字节 | `convert` 走进程内路由 | `out/converted.{csv,md,docx}`、`out/converted-stock.xlsx` |
| 4 渲染 | 真实加密 PDF | `render` 用 pdfium wasm 带密码光栅化 | `out/encrypted-page.png`（可直接打开看） |
| 5 Agent 工具面 | 真实 xlsx | `officeTools()` 的 14 个工具 → 本进程 MCP 服务器，aiwork 挂给专家用 | — |
| 6 错误面 | 空文档 / 无密码加密 PDF / csv→pdf | 类型化 `OfficeError.code`，宿主按 code 分支 | — |

## 宿主怎么接入

- **进程内函数**：`import { readDocument, writeDocument, convert, render } from '@genoffice/office-ai'` —— 字节进字节出。
- **编辑器语义**：`openDocsFile` / `openSheetsFile` —— 打开一次，`editor.*` 读写，`save()` 回写。
- **Agent 工具**：`officeTools()` + `openSession` —— 名字/描述/JSON Schema/execute 全是纯数据，任何 agent 宿主映射到自己的工具类型即可（aiwork 映射到 `@dfn/agent-kernel`）。

错误约定：解析失败、参数不合法、能力缺失分别映射为 `OFFICE_INTERNAL` /
`OFFICE_BAD_INPUT` / `OFFICE_NEEDS_APP` 等 code，`isOfficeError(e)` 可判别。
---
title: 更新日志
---

# 更新日志

GenOffice 所有重要变更都记录在此文件中。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

发布通过 git tag 标记；最近的 tag 即为 npm 上 `@genoffice/*` 包
的当前版本。

> 与根目录 `CHANGELOG.md` 保持同步。修改 `CHANGELOG.md` 后执行
> `node tools/sync-changelog.mjs` 重新生成本页。

## [未发布]

### 新增

- **公开开源发布。** 整个 monorepo 采用 Apache-2.0 许可。
- **REST API v1** (`@genoffice/web-server`)
  - `POST /api/v1/auth/jwt` · `POST /api/v1/auth/oauth/token`
  - `GET` / `POST` / `DELETE` `/api/v1/files[/:id]`
  - `POST /api/v1/files/:id/jwt` · `POST /api/v1/files/:id/callback`
  - `GET /api/v1/ai/capabilities` · `POST /api/v1/ai/{chat,translate,image,skill/:name}`
  - `GET /api/v1/kb/search` · `GET /api/v1/kb/entries`
  - `POST /api/v1/webhooks` · `DELETE /api/v1/webhooks`
  - v1 契约稳定，v1.x 内向后兼容。
- **`@genoffice/web-sdk`** — iframe 嵌入 SDK，提供 ESM / CJS / UMD
  三种产物，类型化事件（`ready` / `saved` / `dirtyChanged` /
  `selectionChange` / `error` / `closed`）和命令
  （`setTheme` / `setContent` / `getContent` / `insertImage` /
  `insertText` / `print` / `focus` / `aiRewrite` / `aiTranslate` /
  `aiSummarize`）。
- **iframe 嵌入端点** `GET /embed/:docId?token=…`，通过 v1.0
  `postMessage` 桥接宿主页面。
- **保存即触发 webhook。** `notifyFileSaved(path, { size, format })`
  在以下保存路径触发：`docs:save`、`web:save-file`、`markdown:save`、
  `html:save`、`html:save-file`、`workbook:save`、`slides:save`
  （字节分支）、`pdf:save`（最终路径来自 `publishPdfAfterSave`）。
- **Provider 插件接口**（`@genoffice/ai-provider/src/provider-plugin.ts`）。
  - `AiProviderPlugin` · `AiMediaPlugin` · `AiSearchPlugin`
  - `ProviderRegistry` · `MediaRegistry` · `SearchRegistry`
  - 第三方 provider 以 `@genoffice/provider-<name>` npm 包形式发布。
- **Skill 协议**（`@genoffice/agent-skills/src/skill-protocol.ts`）。
  - `SkillDefinition` · `SkillPackage` · `SkillContext`
  - JSON-Schema 风格的输入 / 输出类型
  - 带结构化错误码的 `SkillError`
  - 支持触发短语 / 标签匹配的注册表
- **KB / TM 开放格式**（`@genoffice/translation-core/src/kb-format.ts`）。
  - `.genkb` 归档（manifest + entries.jsonl + 可选 index.bin）
  - `.gentm` 归档（manifest + pairs.jsonl）
  - 带 `FormatError` 表面的校验器
- **Agent 协议 v1**（`@genoffice/agent-core/src/agent-protocol.ts`）。
  - `genoffice.agent.v1` 信封
  - `AgentRunner` 接口，用于第三方 agent 循环
  - `validateAgentRequest` 用于快速失败解析
- **IPC channel 参考生成器** — `tools/gen-ipc-docs.mjs` 扫描每个
  `registerHandle` 调用并输出 `apps/web-server/IPC_CHANNELS.md`
  （HEAD 时为 546 条通道）。
- **文档站** — VitePress 站点位于 `docs/`，包含 `guide/`、`api/`、
  `skills/`、`about/` 等章节，中英文双语。
- **示例** — `examples/embed-basic/`、`embed-react/`、
  `embed-vue/`、`custom-provider/`、`custom-skill/`。
- **社区文件** — `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、
  `SECURITY.md`。
- **GitHub Actions** — `release.yml`（npm + Docker 发布）、
  `docs.yml`（Pages 部署）、`security.yml`（CodeQL + npm audit +
  gitleaks）。
- **治理** — `GOVERNANCE.md`（指导委员会 + 5 个工作组 + RFC 流程）、
  `ROADMAP.md`（M0–M3 里程碑）。
- **官方 Skills（共 11 个）** — `doc-format`、`sheet-formula`、
  `slides-outline`、`markdown-format`、`text-summarize`、
  `text-translate`、`text-translate-pairs`、`text-diff`、
  `json-validate`、`yaml-validate`、`yaml-to-json`。
- **Provider 包（共 10 个）** — `anthropic`、`openai`、`gemini`、
  `openai-compatible`、`ollama`、`deepseek`、`moonshot-kimi`、
  `qwen-dashscope`、`zhipu-glm`、`doubao`。

### 变更

- **v1 分发器修复。** `apps/web-server/src/api/v1/index.ts` 现在能
  正确路由 `/api/v1/files/:id/jwt` 和 `/api/v1/files/:id/callback`
  （之前会落入 SPA fallback）。
- **`<meta name="genoffice-token">` 注入** —
  `apps/web-server/src/index.ts` 现在对大小写不敏感
  （`<HEAD>` 与 `</head>` 均可命中）。
- **`@genoffice/provider-anthropic`** — Claude provider 插件
  （`claude-opus-4-6`、`claude-sonnet-4-6`、`claude-haiku-4-5`）。
- **`@genoffice/provider-openai`** — OpenAI provider 插件
  （`gpt-4o`、`gpt-4o-mini`、`gpt-4-turbo`、`gpt-3.5-turbo`）。
- **`@genoffice/provider-gemini`** — Google Gemini provider 插件
  （`gemini-2.5-pro`、`gemini-2.0-flash`、`gemini-1.5-pro`、
  `gemini-1.5-flash`）。
- **`@genoffice/skill-markdown-format`** — 用于规范化 Markdown 的
  Skill（标题、列表、代码块、链接、空白）。
- **`@genoffice/skill-yaml-validate`** — 基于 JSON-Schema 子集规则
  校验 YAML 的 Skill。
- **`AiProviderPlugin` / `SkillDefinition` / `SkillPackage` 接口**
  在 `@genoffice/ai-provider` 与 `@genoffice/agent-skills` 中，
  便于将第三方 provider 插件和 Skills 作为 npm 包发布。
- **`AiMediaPlugin` / `AiSearchPlugin`** 接口 —— 用于图像生成、
  媒体分析以及 Web / 图像搜索后端。
- **Docker 镜像**（`Dockerfile`，多阶段 Node 22，非 root 的 `node`
  用户，`/health` 健康检查，`/data` 持久卷）。
- **GitHub 社区文件** — `ROADMAP.md`、`GOVERNANCE.md`、
  `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、
  `.github/CODEOWNERS`、`.github/dependabot.yml`、`.gitleaks.toml`。
- **GitHub Actions** — `release.yml`、`docs.yml`、`security.yml`。
- **VitePress 文档站** 位于 `docs/`，包含 guide / api / skills 章节，
  中英文内容。

## [0.8.0] — 内部预览版

- 6 个编辑器（docs、sheets、slides、pdf、markdown、html）以 Electron
  shell + 独立 web-server 形式发布。
- 546 条 IPC 通道。
- 12 个 LLM provider 通过 `@genoffice/ai-provider` 接入。
- 整个 monorepo 声明 Apache-2.0。

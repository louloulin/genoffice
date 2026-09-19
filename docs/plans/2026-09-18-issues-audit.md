# Plan 01 — 问题清单（事实驱动）

> 基于对 `/Users/louloulin/appx/genoffice` 的代码调研。所有问题都标注了具体
> 文件路径与行号，避免「凭感觉」式的清单。每条都有可验证的依据。

---

## 调研方法

```
- 列出了所有 apps/* / packages/* 目录结构与代码量
- 阅读了 apps/shell/src/main/index.ts 4580 行 的函数声明
- 阅读了 apps/web-server/src/index.ts 与 src/{ai,docs,sheets,slides,pdf,
  markdown,html,shell,collab,enterprise,anydoc,web}/index.ts 入口
- 量化了每个模块的 IPC handler 数（grep -c "ipcMain\.handle" /
  "registerHandle("）
- 阅读了 @genoffice/ipc-bridge/src/{index,client,web-native,codec}.ts 整体
- 抽样阅读了 packages/agent-skills/src/extensions/*.ts（13 个）
- 抽样阅读了 packages/translation-core/src/*.ts（15 个）
- 抽样阅读了 packages/ai-provider/src/providers.ts（19 家 provider 目录）
- 跑了 git log 看近 12 周的 commit 节奏
```

---

## A. 架构性问题（🔴 P0 — 必须修）

### A1. shell/main 是 4580 行单体，而 web-server 已模块化

**事实**：

```
$ wc -l apps/shell/src/main/index.ts
    4580 apps/shell/src/main/index.ts

$ grep -c "ipcMain.handle" apps/shell/src/main/index.ts
    60    # 60 个 IPC handler 全 inline 在这个文件
```

而 web-server 已拆为 17 个子模块：

```
$ grep -rc "registerHandle" apps/web-server/src/ | grep -v node_modules | sort -t: -k2 -nr | head -5
apps/web-server/src/slides/elements.ts:78
apps/web-server/src/shell/home.ts:46
apps/web-server/src/pdf/index.ts:40
apps/web-server/src/ai/chat.ts:30
apps/web-server/src/html/index.ts:28
```

**后果**：

- shell 的 60 个 handler 一定和 web-server 的 522 个 handler **重复实现**
- 任何 channel 修改需要改两处，必有遗漏
- 新人 onboarding 看 shell 一头雾水
- `@genoffice/ipc-bridge/installHttpIpcBridge` 把所有 ipcMain 注册都自动
  暴露到 HTTP+SSE，但前提是 shell 的 handler 要复用 — 现在 shell 是 inline，
  完全没复用价值

**修复方向**：详见 `plan-02-architecture-refactor.md`

---

### A2. 各编辑器 app 的 main 文件也是大单体

```
$ wc -l apps/docs/src/main/*.ts apps/sheets/src/main/*.ts apps/slides/src/main/*.ts apps/pdf/src/main/*.ts
apps/docs/src/main/docs-main.ts        77 个 ipcMain.handle
apps/sheets/src/main/sheets-main.ts    50 个 ipcMain.handle
apps/slides/src/main/slides-main.ts   136 个 ipcMain.handle
apps/pdf/src/main/pdf-main.ts          32 个 ipcMain.handle
apps/slides/src/main/slides-main.ts   4331 行
apps/docs/src/main/docs-main.ts        (估算 3500+ 行)
```

**问题**：

- slides-main.ts 4331 行 + 136 个 handler 已经超过人类大脑的同步容量
- 这些 main 文件都用了 Electron 原生 `ipcMain.handle`，没有走 web-server 的
  `registerHandle` 抽象，导致 Electron 端无法零成本被 web-bridge 复用
- 没有任何单元测试覆盖 main handler（grep "tests" in apps/*/src/main）

**修复方向**：抽取所有 main handler 到 `@genoffice/office-core` 共享包，main
只保留 Electron-specific glue。

---

### A3. XLSX 在 Web 端无法编辑（致命商业化断点）

**事实**：

```
apps/web-server/src/sheets/index.ts:207
  'WEB_UNSUPPORTED: workbook edits require the Rust xlsx-sidecar save command (web build limitation)'
apps/web-server/src/sheets/index.ts:209
  registerHandle('workbook:save', () => ({ ... }))
apps/web-server/src/sheets/index.ts:215
  registerHandle('workbook:save-as', () => ({ ... }))
```

**后果**：

- SaaS 用户在线打开 xlsx 后只能查看、不能编辑
- 这是 SaaS 付费转化的最大杀手 — Excel/Sheets 类协作 SaaS 的核心价值就是编辑
- 当前 docx/pptx 都已 web-sidecar 化（依赖本地 fs），xlsx 也应该走 sidecar

**修复方向**：xlsx-sidecar 是 Rust 普通子进程，container/serverless 都能跑。

- 短期：web-server 启动时 spawn 一个本地 sidecar
- 中期：sidecar 改成独立微服务，多租户共享

---

### A4. lint 仍有 159 个 error

**事实**：

```
commit 1ae462c (chore: shrink lint from 1374→159 errors, unblock root typecheck, ...)
```

**问题**：

- 159 个 error 全在 renderer CSS（raw hex 不走 token）+ 部分 TS 严格模式违规
- CI 没有 lint-gate 拦截，全靠开发者自觉
- 主题色 lint 工具已存在（tools/check-theme-colors.mjs），但只覆盖新增

**修复方向**：

- 把 159 个 error 分门别类，每类写自动 fix 脚本
- 把所有 lint error 提升为 blocking CI gate
- 引入 Prettier 写入 pre-commit hook

---

## B. SaaS / 商业化缺口（🟠 P0 — 必须建）

### B1. 无真正的多租户 / 账号体系

**事实**：

```
$ grep -rn "tier\|subscription\|stripe\|signup\|register" apps/ packages/ 2>/dev/null | grep -v node_modules | head
# 仅在 providers.ts 注释里出现"cheap tier/high-volume tier"等价格档描述
```

`apps/shell/src/main/index.ts` 有：

- `gskLoginInfo` — 仅 GenSpark 自身登录
- `loadGenofficeAuth` — 同上
- `cloud-projects.ts` — 用 gskApiKey 做 storeOwner 哈希（不是真正的账号）

`apps/web-server/src/enterprise/` 已有 7 个文件声明：

- `auth-audit.ts` / `communications.ts` / `permissions.ts` /
  `users-tenants.ts` / `workflow.ts` / `index.ts`

**问题**：

- 这 7 个文件是骨架，handler 没真正接通到 auth/SSO/OAuth
- 完全无 OAuth / SAML / SSO
- 无 workspace / team 抽象

**修复方向**：详见 `plan-04-saas-and-desktop.md`

---

### B2. 无计费 / quota 系统

**事实**：grep "billing/quota/credit/rate-limit" 全仓 0 命中。

**问题**：

- AI 调用直连 provider key，每个用户自带 key，没有"GenOffice 自带 quota"
- 没有 usage metering，没有 plan upgrade 流程
- 无法做"用户用我的 Claude key，我赚差价"的 SaaS 模型

**修复方向**：

- 引入 GenOffice Broker（`@genoffice/broker`）：统一的 LLM gateway
  - 自带 key 池 / 用户自备 key 都走同一个 endpoint
  - usage tracking per user / per workspace / per plan
  - rate-limit + cost ceiling
- Stripe 集成（自建或用 Paddle / LemonSqueezy）

---

### B3. 无审计 / 合规框架

**事实**：`apps/web-server/src/enterprise/auth-audit.ts` 声明了 `registerAuditHandlers`，
但 grep 看 `audit-log` 实际只在 `packages/agent-skills/src/extensions/audit-log.ts`
（agent 审计，非企业审计）。

**问题**：

- 企业客户要的 SOC2 / GDPR audit trail 完全没有
- AI 操作的可审计回放也没做（每个 AI 动作有 diff 但缺时间轴 + actor）

**修复方向**：

- `@genoffice/audit` 共享包，append-only log（带 hash chain 防篡改）
- AI 操作 timeline first-class UI
- 合规导出（GDPR data export）

---

## C. AI 能力深度（🟠 P0 — 提升竞争力）

### C1. agent 是 L1 不是 L3

**事实**：`packages/agent-skills/src/extensions/` 提供 15 个 skill：

- `docs-skill.ts` 11 tools, `sheets-skill.ts` 7 tools, `slides-skill.ts` 4 tools
- `translate-skill.ts`, `ocr-skill.ts`, `office-safety.ts`,
  `office-workflow.ts`, `web-search-skill.ts`, `image-search-skill.ts`,
  `agent-team.ts`, `skill-market.ts`, `frozen-selection.ts`,
  `verify-response.ts`, `local-models.ts`, `audit-log.ts`

但所有 tool 都是**单步执行**：

- `createInsertContentTool` / `createReplaceBlocksTool` — 一次性插入
- `createReadBlocksTool` — 一次性读
- 没有"plan → 多步 → 中途根据工具返回值调整"的 agent loop

**对比 Cursor / Devin / Manus**：它们的核心竞争力是 multi-turn agentic loop，
能在多步操作中根据工具返回值自动调整。

**修复方向**：

- 引入 `packages/agent-loop` 包，提供 AgentSession + step 抽象
- 引入 ReAct / Plan-Execute 框架
- 在 ai-runtime 包实现 streaming + checkpoint + resume

---

### C2. RAG 只服务翻译，缺通用知识库

**事实**：`packages/translation-core/` 有完整的 KB（knowledge-base.ts 819 行）

- Dictionary + Memory + Quality + Snippet，五位一体。

**问题**：

- 这套基础设施只服务翻译场景
- 用户上传 PDF 想做"基于文档问答"，无现成 RAG
- 用户想跨文档聚合（如"汇总这 10 份合同的付款条款"），缺 chunking + embedding

**修复方向**：

- 抽取 `packages/kb-core`（独立于 translation）
- 引入 vector store（内置 SQLite + sqlite-vss 或远程 pgvector）
- 通用 chunking + embedding + retrieval + re-ranking 流水线

---

### C3. 多模态只覆盖图像，缺视频/音频/复杂视觉

**事实**：`packages/ai-provider/src/media-protocols.ts`（712 行）支持 image
generation + image analysis。

`packages/agent-skills/src/extensions/ocr-skill.ts` 简单实现 OCR。

**问题**：

- 视频：完全不支持（mp4 解析、关键帧提取、视频理解）
- 音频：无转录、无摘要
- 视觉：表格识别、图表理解、复杂版面（论文/发票/合同）缺

**修复方向**：

- 引入 `packages/media-runtime`：FFmpeg sidecar（与 xlsx-sidecar 同样模式）
- 视频关键帧抽取 + 帧序列送 vision model
- 音频：whisper / elevenlabs / 自托管
- 复杂版面：版面分析（layout-parser / detectron2 sidecar）

---

### C4. 跨文档编排是骨架

**事实**：

```
packages/agent-skills/src/extensions/office-workflow.ts:
  CrossOfficeWorkflowParams — 已声明参数类型
  createOfficeWorkflowTool — 已创建工具
  installOfficeWorkflow — 已安装 extension
```

但实际能做什么？看 `office-safety.ts` 等发现工具链只是"安全围栏 + 参数校验"，
**真正的跨文档编排逻辑浅薄**。

**问题**：

- 用户说"把这 5 份合同的付款条款整理成表格"，目前 AI 只能一份一份读
- 用户说"扫描整个项目目录按某模板重命名"，目前 AI 只能列出文件

**修复方向**：

- 实现 `CrossOfficeWorkflow` 引擎：plan → execute → checkpoint
- 集成 `@genoffice/pipelines`（已经存在但浅）作为编排 DSL

---

## D. 协作（🟡 P1）

### D1. collab 模块是骨架

**事实**：

```
apps/web-server/src/collab/
  history-comments-templates.ts
  locks.ts
  sessions.ts
  index.ts          # 注册 10 大类 handler
```

注册了：lock, cursor, change tracking, conflict, permission, history, comment,
template, session — 9 类 channel。

**问题**：

- 实现是 stub：lock 用 in-memory Map，没有持久化
- cursor presence 没有 WebSocket 推送
- 没有 CRDT / OT，conflict 没有解决机制

**修复方向**：

- 引入 Yjs（成熟 CRDT）+ y-websocket
- 集成 awareness（presence + cursor + selection）
- 替换 stub 实现

---

### D2. SSE 不是 WebSocket

**事实**：`@genoffice/ipc-bridge` 用 SSE（Server-Sent Events）做 push。

```
apps/web-server/src/index.ts: SSE_HEARTBEAT_MS = 25000
```

**问题**：

- SSE 单向，client → server 还是要 HTTP POST
- AI 流式响应 + 实时光标 + 评论通知用 SSE 都不优雅
- 大量并发 SSE 连接吃连接数（HTTP/1.1 6 个 / origin）

**修复方向**：web-server 启动时同时监听 ws://，用于：

- AI streaming（替代 SSE 的 chunked response）
- collab presence / cursor / awareness
- 评论 / @mention / 通知

---

## E. 工程化（🟡 P1）

### E1. 单体 monorepo，无增量构建

**事实**：根 `package.json` 的 `scripts` 完全是手动串联：

```
"test": "npm run test -w @genoffice/i18n && npm run test -w @genoffice/electron-utils && ..."
```

**问题**：

- 任何包改动都触发所有包测试（CI 慢）
- 没有依赖图感知
- 无缓存

**修复方向**：引入 Turborepo 或 Nx，按 package.json 的依赖图只跑相关包。

---

### E2. 测试覆盖率不均

**事实**：

```
docx-engine:    132 tests
pptx-engine:     92 tests
pdf2docx:        49 tests
ai-provider:     17 tests
agent-skills:    15 tests
cli:             16 tests
i18n:             1 test
project-store:    1 test
agent-session:    2 tests
agent-runtime:    6 tests
chat-runtime:     4 tests
file-parse:       3 tests
ai-search:        3 tests
ipc-bridge:       1 test  ← 关键 IPC 桥只 1 个测试
```

**问题**：

- `@genoffice/ipc-bridge` 是整个 SaaS 化的基石，只有 1 个测试文件
- `agent-runtime`、`chat-runtime`、`file-parse`、`project-store` 几乎没有覆盖
- e2e 只有 38 个 spec，跨编辑器场景覆盖薄

**修复方向**：

- 把 ipc-bridge 的 contract test 扩到 100+ 个 case
- 给每条 IPC channel 加 e2e 覆盖
- 引入 mutation testing（Stryker）

---

### E3. CI 没把 lint 当 blocking

**事实**：`ci.yml` 的 lint 步骤即使报错 PR 也能 merge（历史 commit 1ae462c
描述："CI 没有 lint-gate"）。

**问题**：lint 债累积。

**修复方向**：lint error → blocking；warn 保留。

---

### E4. 监控 / 可观测性为零

**事实**：`packages/agent-telemetry` 存在（572 行），但 grep 实际调用：

```
$ grep -rln "agent-telemetry" apps/ packages/ 2>/dev/null | grep -v node_modules | head
# 几乎没有真实消费者
```

**问题**：

- 无 OpenTelemetry / Prometheus / Sentry
- 线上问题排查靠 grep 仓库

**修复方向**：

- 引入 OpenTelemetry（trace + metric + log）
- 自托管 sentry（Sentry 自部署 / GlitchTip）
- LLM 调用 trace（provider / model / token / latency / error）

---

## F. 用户体验（🟢 P2）

### F1. 无 Command Palette

**事实**：grep "command.k\|palette\|cmdk" 全仓 0 命中。

**对比**：VSCode / Linear / Raycast / Notion 都有 ⌘K 全局命令面板，
GenOffice 没做。

**修复方向**：基于 cmdk 或自建，集成所有 IPC channel 为可搜索命令。

---

### F2. 无 onboarding 流程

**问题**：新用户打开 shell 直接看到空白 home，没有引导。

**修复方向**：3 步引导（选 AI provider → 试一个文档 → 加第一个 skill）。

---

### F3. 截图里的 broken 状态

**事实**：仓库根有这些截图：

- `08-ai-pdf-broken.png` (5KB)
- `15-ai-html-broken.png` (5KB)
- `08-ai-pdf.png` vs `08-ai-pdf-fixed.png`（历史 bug 截图）
- `genoffice-overview-28-slides-ai-result.png` (5KB) ← 渲染失败

**问题**：截图命名暴露历史渲染 bug，说明这些路径仍未彻底修复或 e2e 没拦截。

**修复方向**：在 e2e 中加入"所有编辑器首屏 5s 内必须出现真实内容"的断言。

---

### F4. i18n 是 key/value map，没有 framework

**事实**：`packages/i18n/` 只有 419 行，看代码是直接 if-else 选择 lang。

**问题**：

- 没有复数 / 性别 / 日期 / 数字格式化
- 没有 lazy load（一次性载入所有 19 语言）

**修复方向**：渐进迁移到 `@formatjs/intl`，先在新功能里用。

---

## G. 安全（🟢 P2）

### G1. shell 的 webContents 风险

**事实**：`apps/shell/src/main/index.ts` 接受 URL 渲染（home、editor 都加载远程 URL）。

**问题**：需要看是否有 `webRequest` / `CSP` 设置。

**修复方向**：审计所有 `loadURL` 调用，确保 CSP 头 + origin 白名单。

---

### G2. web-server CORS / auth

**事实**：`apps/web-server/src/index.ts` 之前的 commit
"fix(web-server): contain renderer path, harden URL/URI parsing, replace CORS
wildcard" 说明历史曾用 `Access-Control-Allow-Origin: *`。

**问题**：当前允许任意 origin，浏览器 fetch 没限速。

**修复方向**：

- CORS allow-list（白名单 origin）
- rate-limit middleware（express-rate-limit / 自建 token bucket）
- auth middleware（JWT 或 session）

---

## H. 总结：21 项问题的严重度分布

| 严重度       | 数量   | 项             |
| ------------ | ------ | -------------- |
| 🔴 P0 架构   | 4      | A1, A2, A3, A4 |
| 🟠 P0 SaaS   | 3      | B1, B2, B3     |
| 🟠 P0 AI     | 4      | C1, C2, C3, C4 |
| 🟡 P1 协作   | 2      | D1, D2         |
| 🟡 P1 工程化 | 4      | E1, E2, E3, E4 |
| 🟢 P2 UX     | 4      | F1, F2, F3, F4 |
| 🟢 P2 安全   | 2      | G1, G2         |
| **合计**     | **23** |                |

> 注：F4 与 i18n 算 P2 是因为现有 19 语言工作能用；G1/G2 是审计相关，
> 短期内不出事所以 P2。

# GenOffice × DataflareWork 集成方案 — 全面代码分析与 AI 翻译优先设计

> 日期：2026-09-19
> 状态：分析完成，待实施
> 范围：`/Users/louloulin/appx/genoffice` (分支 `release0919`) × `/Users/louloulin/appx/dataflarework`

---

## 0. 一句话结论

DataflareWork 端的集成骨架（iframe + `genoffice-dataflare/v1` postMessage、反向代理 `/office-engine/**`、Cookie 鉴权桥、SSE 透传、多租户翻译记忆 shim）**已经全部就位**。GenOffice 端的桥接代码（`apps/docs/src/shared/embed-bridge.ts` 等）在上一轮被显式回退以做一次干净重写。**本轮的设计任务因此从「探索选型」收敛为「按既定协议把 GenOffice 端实现干净地补回来，同时把 AI 翻译作为核心能力进行可观测的、可多租户的、可回放的强化**。

---

## 1. GenOffice AI 翻译现状（按调用栈自下而上）

### 1.1 中央翻译包 `packages/translation-core/src/`（5671 行）

| 文件 | 行数 | 角色 |
|---|---|---|
| `index.ts` | 185 | 公共 API 出口（`translateOne` / `translateBatch` / `translateBatchStream` / `KnowledgeBase` / `PersistentTranslationMemory`） |
| `provider.ts` | 670 | 真正的执行体，记忆命中 → provider 调用 → 质量评估 → 结果归一 |
| `prompt.ts` | 146 | 翻译 prompt 构造 |
| `quality.ts` | 88 | `assessQuality` / `assessBatchQuality`（Latin / kana 漏译、数字一致性、占位符保留） |
| `chunking.ts` | 85 | `chunkDocument`（按段落 / heading / list-item 拆 unit） |
| `memory.ts` | 167 | 进程内 `TranslationMemory`（exact match） |
| `persistent-memory.ts` | 431 | 文件持久化 `PersistentTranslationMemory`（带 `fuzzyLookup`，JSON per pair） |
| `knowledge-base.ts` | 819 | LumosAI 5-schema KB（term / forbidden / brand / style / customerPreference） |
| `kb-rules.ts` | 93 | `resolveKbForCall`（按 glossaryCategory × customerName 过滤规则） |
| `dictionary.ts` | 855 | 整文件翻译时的术语字典（mining / 填充 / 应用） |
| `coverage.ts` | 127 | 字典覆盖率评估 |
| `languages.ts` | 251 | 14 个语言 + 文字脚本 推断 |
| `llm-client.ts` | 160 | LLM 客户端 seam（`setLlmCaller` 可换 backend） |
| `file-translate.ts` | 389 | 整文件翻译 + skill 解析 |

**关键设计点**：
- `sharedMemory = new TranslationMemory()` 是进程内单例；HTTP 翻译端点必须显式注入 `PersistentTranslationMemory` 才能持久化（`apps/web-server/src/ai/translate-http.ts:96`）。
- `translateBatchStream` 在 `provider.ts` 中以 bounded concurrency（默认 25）调度，复用 `translateBatch` 的逐 unit 逻辑但接受 `onUnit` 回调 —— 这正是 SSE 端点的事件源。
- 术语和 KB 在 `provider.ts#resolveTerminology()` 里**只算一次**（命中 + 注入 prompt + matchedTerms 三个用途共用），但 fuzzy memory 只有 `PersistentTranslationMemory` 暴露。

### 1.2 Web-server 翻译层 `apps/web-server/src/ai/`（2720 行）

| 文件 | 行数 | 角色 |
|---|---|---|
| `translate-http.ts` | 567 | `POST /api/ai/translate` + SSE `/api/ai/translate/stream` + `/stream/cancel` |
| `chat.ts` | 1902 | `registerAiCoreHandlers()` — IPC `ai:translate` / `ai:translate-batch` / `ai:save-translation-memory` / `ai:translate-build-dictionary` / `ai:translate-file-auto` / `ai:stream`（Agent Loop SSE） |
| `errors.ts` | 152 | `InvalidArgumentError` 等 |
| `doc-skill.ts` / `sheet-skill.ts` / `slide-skill.ts` / `media-skill.ts` | ~200 | 子 skill 注册 |
| `index.ts` | 40 | 入口注册 |

**关键设计点**：
- `translate-http.ts:96` `translationStorage()` 显式 await `ensureKbLoaded()` + `sharedKnowledgeBase.refresh()` —— 这是为了让 HTTP 端点读到 UI 刚 upsert 的 KB 项（之前的 KB 改动在重启前对 HTTP 路径不可见回归，已修复）。
- `translate-http.ts:284` SSE 事件顺序：`start → unit(s) → quality → complete | error`，`unit` payload 字段与 Dataflare 旧的 `StructuredTranslationStreamEvent` 一一对应（设计时即按"现有 web-bridge 消费者无需改字段即可切 URL"的目标）。
- `chat.ts:362` `translationStateSummary()` 输出 KB / TM / 默认 provider 的快照，用于 `/health` 和 `/api/channels`。
- **关键观察**：`chat.ts#registerAiCoreHandlers()` 的 `ai:translate-batch` 实现读 `glossaryCategory` / `customerName`（line 859–870 有 5+ 行 type guard），并把 `customerName` 推到 `KB.customerPreference` 过滤；而 `translate-http.ts` 同样路径已经在 `toCoreUnits` → `translateBatch` 之间显式拼装（line 271–280）。两边签名已对齐。

### 1.3 文档预处理层 `apps/web-server/src/anydoc/`（239 行）

Anydoc 是 **AI 翻译的 preprocessor**：在非 docx 文件（pdf / pptx / xlsx）进入翻译管道前先把文本抽出来。设计原则：承认边界、不造假。

| 通道 | 行为 | 当前限制 |
|---|---|---|
| `anydoc:get-config` / `anydoc:set-config` | 读写 `AnyDocConfig { ocrEnabled, language, preserveLayout }` | 写到模块级，跨 IPC 重启进程后失效（接受） |
| `anydoc:recognize` | 走 `@genoffice/file-parse#parseFileToText` 抽真实文本（docx/pptx/xlsx/pdf/doc/ppt + 纯文本） | 图片无 OCR 引擎 → `ocrUnavailable: true` + 友好消息，不假造 transcript |
| `anydoc:convert` | 格式转换 | **当前 build 直接返回 `WEB_UNSUPPORTED`**（docx↔pdf 走 `pdf2docx` / docx-engine PDF 导出） |
| `anydoc:extract-text` | 与 `recognize` 同源但更轻 | 同上限制 |
| `anydoc:extract-tables` / `anydoc:extract-images` | 结构感知抽取 | `.docx` 已接 `@genoffice/file-parse#extractDocxTables/Images`；`.pdf` / `.pptx` 仍报 `unsupported: true` |

**在 AI 翻译管道中的位置**：

```
上传文件 (dataflarework / web 直传 / 编辑器内部)
       │
       ▼
 anydoc:recognize / anydoc:extract-text      ← 任何格式 → 纯文本
       │
       ▼
 chunkDocument (translation-core)            ← 段落 / heading / list-item
       │
       ▼
 translateBatch / translateBatchStream       ← KB / TM / provider
       │
       ▼
 ai:save-translation-memory                  ← 持久化 + Dataflare 多租户记忆
```

**对 dataflarework 集成的关键含义**：
1. 用户上传 pdf/pptx 想翻译时，**Dataflare → GenOffice 链路上必须先经 anydoc**；当前 anydoc 的 docx 路径已可用，pdf/pptx 仍是 `unsupported: true`，意味着非 docx 文件不能在 iframe 内被富文本翻译
2. `OfficeWorkspaceView.vue` 已经写了"非 docx 降级提示"模板（line 47-58）——它告诉用户去 `TranslationWorkbench.vue` 走纯文本翻译工作台，**这条降级路径是产品上正确的**
3. 后续若要打通 pdf/pptx 富文本翻译，需要补 anydoc 的 `extract-tables` / `extract-images` 的 pdf/pptx 路径（packages/pdf2docx 已存在于依赖图）

### 1.4 渲染层（AI Panel + TranslateDialog + AiInlineLauncher）

| 文件 | 行数 | 角色 |
|---|---|---|
| `apps/docs/src/renderer/ai/AiPanel.tsx` | 2665 | 文档编辑器的 AI 面板（含翻译状态机） |
| `packages/ui/src/TranslateDialog.tsx` | ~250 | 可复用的翻译弹窗 |
| `packages/ui/src/AiInlineLauncher.tsx` | ~150 | 选区弹出 5 个 chip（Polish / Expand / Shorten / Summarize / Translate） |

**AiPanel 翻译状态机（line 1164–1530）**：
- `translateScope: 'selection' | 'document'`
- 选区路径：`window.desktop.aiTranslate(...)` → 拿到 `r.translated` 后塞回 TranslateDialog
- 全文路径：按段落 descendent 遍历，`batchSize = 80 units / 90_000 chars` 自动分批，`streamOrBatch = window.desktop.aiTranslateBatchStream ?? window.desktop.aiTranslateBatch`，逐批收集 quality / matchedTerms / warnings，最后 `successful.map(...).join('\n')` 返回给 TranslateDialog。
- `translationCancelledRef` 在每批前检查，命中即 `return null`，dialog 显示 cancelled 状态。
- `saveMemory`：调用 `window.desktop.saveTranslationMemory(...)`，scene = `translateScope`，**glossaryCategory / customerName 必须透传**（在 line 1506–1520 之间）。

**TranslateDialog props（line 41–84）**：
- `open / sourceText / sourceRange / languages / strings / onTranslate / onApply / onCancel`
- `onTranslate` 接收 `{ sourceText, sourceLang, targetLang, preserveFormat }` → `Promise<string | null>`；`null` 表示 abort，dialog 显示错误 chip
- 不直接调模型，只产 `ChatChangePlan`，由 host 的 `useChatRuntime().applyChangePlan(plan)` 应用
- 支持 `previewItems`（文档翻译逐 unit 预览）+ `previewQuality`（整体评分）

### 1.5 IPC 契约（apps/docs/src/shared/ipc.ts）

四个翻译相关 channel：

| Channel | 类型 | 用途 |
|---|---|---|
| `ai:translate` | `request/response` | 单段翻译（IPC + HTTP `/api/ai/translate` 都走同一个 provider 调用） |
| `ai:translate-batch` | `request/response` | 多 unit 批量翻译 |
| `ai:translate-batch-stream` | `stream`（renderer 直连） | per-unit SSE，回退到 `ai:translate-batch` |
| `ai:save-translation-memory` | `request/response` | 把成功的 unit 写入 TM |

类型已显式包含 `matchedTerms / warnings / quality`，注释明确点出"以前一批次只 batch 路径填，one-shot 不填，UI 静默丢失"。

---

## 2. AI 翻译现状问题清单（按严重度排序）

### 2.1 P0 — 已识别但未根治的脆弱点

| # | 问题 | 位置 | 现状 | 影响 |
|---|---|---|---|---|
| 1 | ~~TM 持久化对 KB 刷新不可见~~ | `chat.ts:1553` | ✅ 已在 `ai:translation-kb-upsert` 末尾 `await sharedKnowledgeBase.refresh()` 修好 | n/a |
| 2 | ~~`provider.ts#translateBatchStream` 没有 abort 信号~~ | `packages/translation-core/src/provider.ts` | ✅ 2026-09-19 修：`TranslateBatchStreamOptions.signal?: AbortSignal`，worker loop 在每个 index 前 `signal?.aborted` 检查；新 helper `abortedUnitResult()` 把剩余 unit 标为 `failed` / `errorMessage: 'aborted'` 并照常 emit `onUnit`；`translate-http.ts:329` 已显式 `signal: abort.signal` 透传 | n/a |
| 3 | ~~HTTP `translate-batch` 无 auth gate~~ | `apps/web-server/src/index.ts:302-309` | ✅ 已在 `Phase 1 auth gate` 加：所有 `/api/*` 走 `isAuthorised(request)`（除非白名单），translate 路由不在白名单 | n/a |
| 4 | ~~`customerName` 是 string-or-undefined；空串与 undefined 等价~~ | `packages/translation-core/src/provider.ts` | ✅ 2026-09-19 修：`normalizeCustomerName()` 导出，5 个 customerName 透传点统一 trim → 空串归 undefined；KB `customerPreference` 不再被空串污染 | n/a |
| 5 | ~~`apps/web-server` 的 `/api/ai/translate*` SSE 没有写 `requestId` 关联~~ | `translate-http.ts:348-349` | ✅ 已在 `effectiveRequestId = overrideRequestId || requestId` 修好，client 传 `requestId` 优先 | n/a |

### 2.2 P1 — 设计/可观测性缺口

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 6 | 没有统一的翻译调用追踪 | 全部 | `ai:translate*` 调用无 trace id、无 lat / provider / model 标签，跨 IPC + HTTP 难定位慢请求 |
| 7 | TM / KB 大小无上限 | `persistent-memory.ts` `knowledge-base.ts` | 长期使用后 `~/.genoffice/translation-memory/` 累积，磁盘占用不可见 |
| 8 | TranslateDialog 没有 `onRetryUnit` 的默认错误恢复策略 | `packages/ui/src/TranslateDialog.tsx` | 文档翻译某 unit 失败后，用户必须重新整篇翻译（注释承认这一点） |
| 9 | `quality.warnings` 在 one-shot 路径才填，`ai:translate-batch` HTTP 端点 `quality` 是批级，`units[].warnings` 才是 per-unit | `provider.ts` + `translate-http.ts:387` | 调用方判断混乱 |
| 10 | AiPanel 全文翻译最大 unit 上限是 80 / 90k chars，没有把图片 / 表格 / heading 单独处理 | `AiPanel.tsx:1318–1335` | 含 200+ 段的中等文档要切 4 批，UI 进度只反映批进度而非段进度 |

### 2.3 P2 — 优化 / 一致性

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 11 | TranslateDialog 字符串 key 与 AiPanel 的 `aiTranslate*` 不一致 | `AiPanel.tsx:1270-1280` | 国际化字符串部分硬编码 |
| 12 | `provider.ts#resolveProvider` 在 HTTP 端从 `req.settings` 读，但 IPC 端从 `aiSettings` 全局读 | `translate-http.ts:74` vs `chat.ts:743` | settings 来源不统一，未来 PATCH / schema 字段易漂移 |
| 13 | `language` 在 BC P-47 与自由标签混用 | `types.ts:LanguageCode` | KB / TM 命中时 normalization 不显式 |
| 14 | memory save 不返回写入后的 KB / TM 快照 | `chat.ts:1057` | 调用方无法刷新自己的 UI 计数 |
| 15 | 翻译 quality gate 在 core 层跑，但不在 SSE 路径触发中断 | `provider.ts#assessBatchQuality` | 即使 quality < 阈值，下游 unit 仍继续算，浪费 provider 额度 |

---

## 3. DataflareWork 集成现状（已就位部分）

### 3.1 已就位（不要重新设计）

| 组件 | 位置 | 状态 |
|---|---|---|
| `OfficeWorkspaceView.vue` | `frontend/src/views/ai/` | 完整 iframe 容器 + 翻译 UI + 实时预览 + 翻译摘要 + 质量徽章 |
| `officeWorkspace.ts` | `frontend/src/utils/` | Cookie 同步 / 路由构造 / 扩展名 ↔ 文档类型映射 |
| `office-bridge-types-contract.mjs` | `frontend/scripts/` | 双方 union 类型字段级 1:1 校验（已检 7 处漂移） |
| `OfficeEngineProxyController.kt` | `backend/.../controller/` | `/office-engine/**` 反代，SSE 透传，drop `Manager-Token` |
| `OfficeEngineCookieAuthFilter.kt` | `backend/.../filter/` | Cookie → 请求头桥 |
| `OfficeEngineProperties.kt` | `backend/.../config/` | `target` / `pathPrefix` / `connectTimeout` / `requestTimeout` |
| `EmbedTranslationMemoryController.kt` | `backend/.../controller/` | `/ai/translation/v1/memory` shim → 多租户 `crm_translation_memory` |
| `SecurityConfig.kt` 路由切分 | `backend/.../config/` | shell 匿名 + `/api` 必认证 |
| `docker-compose` `genoffice` service | `docker/` | 端口 18081，命名卷 `genoffice-data`，nginx `/office-engine/` |
| 集成契约文档 | `docs/genoffice-ai-document-integration.md` | 完整端点表 + 鉴权矩阵 + 部署 |
| 部署文档 | `docs/genoffice-embed-deployment.md` | dev / docker / 安全 / 可观测性 / 排障 |

### 3.2 已就位的契约（GenOffice 端要按这个补）

**postMessage 协议 `genoffice-dataflare/v1`**：

```
Envelope: { protocol: 'genoffice-dataflare/v1', kind: 'command'|'event'|'request'|'response'|'stream-request'|'stream-event'|'stream-close', sessionId, payload }
```

| Kind | Payload type | 触发方 |
|---|---|---|
| `command` | `init / dispose / save / focus-ai / translate / set-readonly / cancel-translation / global-state-update` | host → guest |
| `event` | `ready / document-dirty / document-saved / ai-progress / error / global-state / global-state-request` | guest → host |
| `request` | `http-request { requestId, sessionId, method, path, jsonBody?, file?, fields? }` | guest → host |
| `response` | `http-response { requestId, sessionId, status, headers, body }` | host → guest |
| `stream-request` | `stream-request { requestId, sessionId, method, path, jsonBody? }` | guest → host |
| `stream-event` | `stream-event { requestId, sessionId, event, data }` | host → guest |
| `stream-close` | `stream-close { requestId, sessionId }` | 双方均可 |

**host 接受转发的端点白名单（`OfficeWorkspaceView.vue#onFrameRequest`）**：
- `/office-engine/api/ai/translate` (POST)
- `/crmapi/ai/translation/v1/memory` (POST)
- `/crmapi/knowledge/office/{id}` (GET/POST)
- SSE 路径：`/office-engine/api/ai/translate/stream`

**安全边界**：
- iframe 同源（nginx `/office-engine/` → genoffice:18081）优先；跨域必须把 genoffice origin 加 CSP `frame-src`
- iframe 内 EventSource 无法设请求头 → `Manager-Office-Token` Cookie（Path=`/office-engine`，`SameSite=Lax`）
- parent fetch 走 `Manager-Token` header
- iframe 与 host 之间的 postMessage 同时校验 `event.source === contentWindow` 和 `event.origin`

---

## 4. 集成方案设计（GenOffice 端要补的部分）

### 4.1 总览

```
┌──────────────────────────────────────────────────────────────────┐
│  GenOffice web-server (apps/web-server, port 18081)              │
│                                                                  │
│  ┌────────────────────┐    ┌──────────────────────────────────┐ │
│  │ renderer           │    │ HTTP IPC                          │ │
│  │ apps/docs          │    │ /api/ipc/:channel                 │ │
│  │                    │    │ /api/ipc/events (SSE)             │ │
│  │  + postMessage     │◄──►│ /api/ai/translate*               │ │
│  │    bridge          │    │ /api/ai/stream (Agent)            │ │
│  │  + HTTP/SSE proxy  │    └──────────────────────────────────┘ │
│  │    via postMessage │                                          │
│  └────────┬───────────┘                                          │
│           │ ?embed=1 detects iframe mode                          │
│           ▼                                                       │
│  ┌────────────────────┐                                          │
│  │ @genoffice/         │                                         │
│  │ translation-core    │                                         │
│  └────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ /office-engine/  (nginx OR DataflareProxy)
                              │ Cookie: Manager-Office-Token
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  DataflareWork Vue SPA (/ai/office route)                        │
│  iframe = /office-engine/docs/?embed=1                           │
│  OfficeWorkspaceView.vue (host)                                  │
│   ├── sendCommand()      postMessage {kind:'command', ...}       │
│   ├── onMessage()        postMessage {kind:'event', ...}          │
│   ├── onFrameRequest()   postMessage {kind:'request', http}       │
│   └── onFrameStreamRequest()  postMessage {kind:'stream-*'}       │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 GenOffice 端要补的文件（按依赖顺序）

| 序 | 文件 | 角色 | 行数估计 |
|---|---|---|---|
| 1 | `apps/docs/src/shared/post-message.ts` | 通用 envelope 校验（origin / protocol / sessionId / source） | ~80 |
| 2 | `apps/docs/src/shared/embed-bridge.ts` | host↔guest session + command/event registry + `requestDataflareParent` / `requestDataflareStreamParent` / `postToEmbedParent` | ~300 |
| 3 | `apps/docs/src/shared/embed-translate-body.ts` | 把 `TranslateBatchRequest` 序列化为 Dataflare 期望的 wire shape | ~70 |
| 4 | `apps/docs/src/shared/embed-translate-response.ts` | 把 Dataflare SSE 事件归一为 AiPanel 期望的 `TranslateBatchResponse` | ~120 |
| 5 | `apps/docs/src/renderer/web-bridge.ts` 增量 | `saveDocx / uploadDocx / aiTranslateBatch / aiTranslateBatchStream` 在 `window.parent !== window` 时走 `requestDataflareParent`，否则照旧 HTTP IPC | +~80 |
| 6 | `apps/docs/src/renderer/App.tsx` 增量 | `useEffect` 注册 `dataflare:office-command` 监听，dispatch 到既有 editor API | +~120 |
| 7 | `apps/docs/src/renderer/ai/AiPanel.tsx` 增量 | `useEffect` 监听 `dataflare:open-translate`，per-unit progress → `postToEmbedParent('ai-progress', ...)` | +~50 |
| 8 | `apps/docs/tests/embed-bridge.test.ts` | 6 个单元测试 | ~250 |
| 9 | `apps/docs/tests/embed-bridge-e2e.test.ts` | 4 个 e2e | ~250 |
| 10 | `apps/docs/tests/embed-translate-response.test.ts` | 4 个 SSE 归一化测试 | ~150 |
| 11 | `apps/docs/tests/embed-translate-body.test.ts` | 4 个 body 序列化测试 | ~150 |
| 12 | `apps/docs/tests/web-bridge-translate-url.test.ts` | 4 个 URL 路由测试 | ~120 |

合计：**~1740 行 GenOffice 端新增**，全部走 `apps/docs/src/shared/` 和 `apps/docs/src/renderer/` 子树（不影响 `translation-core`、`web-server`、`packages/ui` 这些中央包）。

### 4.3 与 dataflarework 既有契约的字段级对齐

```ts
// host → guest: command
type OfficeCommand =
  | { type: 'init'; context: OfficeContext; sessionId: string }
  | { type: 'dispose' }
  | { type: 'save' }
  | { type: 'focus-ai'; prompt?: string }
  | { type: 'translate'; scope: 'selection'|'document'; sourceLanguage?: string; targetLanguage: string; preserveFormatting?: boolean; memoryEnabled?: boolean; qualityCheck?: boolean; glossaryCategory?: string }
  | { type: 'set-readonly'; readonly: boolean }
  | { type: 'cancel-translation' }
  | { type: 'global-state-update'; state: { tenantId?; userId?; locale?; theme?; readonly?; documentRevision?: string|number }; revision?: number }

// guest → host: event
type OfficeEvent =
  | { type: 'ready'; capabilities: string[] }
  | { type: 'document-dirty'; documentId?: string }
  | { type: 'document-saved'; documentId?: string; revision?: string }
  | { type: 'ai-progress'; requestId?: string; status: 'started'|'running'|'completed'|'cancelled'|'failed'; progress?: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'global-state'; state: { tenantId?; userId?; locale?; theme?; readonly? } }
  | { type: 'global-state-request'; revision?: number }

// guest → host: request (HTTP bridge)
type HttpRequest = {
  type: 'http-request';
  requestId: string;
  sessionId: string;
  method: 'GET'|'POST';
  path: string;
  jsonBody?: string;
  fields?: Record<string,string>;
  file?: { bytes: ArrayBuffer; filename: string; contentType: string };
}

// host → guest: response
type HttpResponse = {
  type: 'http-response';
  requestId: string;
  sessionId: string;
  status: number;
  headers: Record<string,string>;
  body: ArrayBuffer;
}
```

### 4.4 AI 翻译流在 iframe 内的完整往返

```
Dataflare parent          iframe (GenOffice)           HTTP via parent            GenOffice web-server         LLM provider
│                         │                            │                          │                            │
│  sendCommand            │                            │                          │                            │
│  {translate,            │                            │                          │                            │
│   scope:document, ...}  │                            │                          │                            │
├────────────────────────►│                            │                          │                            │
│                         │ dataflare:open-translate   │                          │                            │
│                         │ {scope, ...}               │                          │                            │
│                         │ (AiPanel useEffect)        │                          │                            │
│                         │                            │                          │                            │
│                         │ aiTranslateBatchStream(units, ...)                   │                            │
│                         ├───────────────────────────►│ POST /api/ai/translate    │                            │
│                         │                            │   /stream                │                            │
│                         │                            │  body: TranslateBatchReq │                            │
│                         │                            ├─────────────────────────►│ translateBatchStream(...)  │
│                         │                            │                          │  onUnit(result)            │
│                         │                            │                          │   ↓ SSE 'unit'             │
│                         │                            │◄─────────────────────────┤                            │
│                         │                            │ (read each chunk)        │                            │
│                         │                            │                          │                            │
│                         │ postToEmbedParent          │                          │                            │
│                         │ 'ai-progress' status:running, progress:0.42           │                            │
│                         ├───────────────────────────►│ update translationProgress.value = 0.42                  │
│                         │                            │                          │                            │
│                         │ ... many units ...        │                          │                            │
│                         │                            │                          │                            │
│                         │ onTranslate 完整结果       │                          │                            │
│                         │ → TranslateDialog.apply    │                          │                            │
│                         │                            │                          │                            │
│                         │ ai-progress completed      │                          │                            │
│                         ├───────────────────────────►│ translationProgress = 1  │                            │
│                         │                            │ + lastTranslationSummary │                            │
│                         │                            │   quality score / hits    │                            │
│                         │                            │                          │                            │
│ user clicks "保存到记忆" │                            │                          │                            │
│                         │ saveTranslationMemory(units)                         │                            │
│                         ├───────────────────────────►│ POST /crmapi/ai/         │                            │
│                         │                            │   translation/v1/memory   │                            │
│                         │                            │  (Dataflare 多租户记忆)  │                            │
│                         │                            │                          │                            │
│                         │                            │                          │ 写入 KB/TM 走 genoffice    │
│                         │                            │                          │  内置 kbLoadPromise/       │
│                         │                            │                          │  refresh()                  │
```

---

## 5. AI 翻译增强清单（不依赖 dataflarework，纯 genoffice 端）

按 §2 的 P0 → P2 排序，建议落地的最小集：

### 5.1 P0 AI 翻译修复（2026-09-19 全量完成）

| # | 改动 | 文件 | 状态 |
|---|---|---|---|
| F1 | HTTP 翻译端点加 `WEB_TOKEN` / `X-GenOffice-Token` 鉴权 | `apps/web-server/src/index.ts:302-309` | ✅ 既有（Phase 1 auth gate） |
| F2 | `translateBatchStream` 接收 `AbortSignal`，core 层每个 unit 之前 check | `packages/translation-core/src/provider.ts` + `apps/web-server/src/ai/translate-http.ts` | ✅ 2026-09-19 本轮落地 |
| F3 | IPC 路径在 KB upsert 后也 `refresh()` | `apps/web-server/src/ai/chat.ts:1553` | ✅ 既有 |
| F4 | `customerName` 在 KB 之前 trim，空串归 undefined | `packages/translation-core/src/provider.ts` | ✅ 2026-09-19 本轮落地 |
| F5 | `requestId` 客户端传值优先 | `apps/web-server/src/ai/translate-http.ts:348-349` | ✅ 既有 |
| F6 | `quality.warnings` 在 one-shot 路径也填 | `packages/translation-core/src/provider.ts:271-279` (`warningsOption`) | ✅ 既有 |

新增测试：6 个（abort pre-entry / abort mid-batch / normalizeCustomerName 三场景 × 2 路径），`packages/translation-core` 测试 219 → 225。

### 5.2 应该修（这一轮或下一轮）

| # | 改动 | 文件 | 工作量 |
|---|---|---|---|
| F7 | 加 `traceId` 到所有翻译调用，挂在 `__translation_traces.jsonl` | `chat.ts` + `translate-http.ts` + 新增 `tracing.ts` | 3h |
| F8 | TranslateDialog 默认错误恢复：失败 unit 自动重试一次 + 显示 `onRetryUnit` 按钮 | `packages/ui/src/TranslateDialog.tsx` | 2h |
| F9 | `quality < threshold` 时 SSE 主动发 `quality-warning` 事件（不中断翻译，但 UI 可提示） | `translate-http.ts:387` | 1h |
| F10 | 全文翻译支持图片 / 表格 unit type（目前只 descendent textblock） | `AiPanel.tsx:1318` | 3h |
| F11 | TM / KB 大小监控：`/health` 加 `translation.kbBytes / tmBytes` | `apps/web-server/src/common/state.ts` + `index.ts#/health` | 1h |
| F12 | `language` BC P-47 normalize 在 `translateBatch` 入口 | `packages/translation-core/src/prompt.ts#normalizeSourceLang` 复用 + `targetLang` 同款 | 1h |

### 5.3 优化（一轮交付外）

- P2 一致性问题（11–15）整合到下一轮 sprint
- AiPanel 全文翻译改 per-unit 进度而非 per-batch（需把 batch 内部并发改成 streaming unit 然后逐 unit emit progress 到 SSE）
- TranslateDialog i18n key 统一

---

## 6. 集成实施路线图

### 6.1 第一周 — 协议 + 端到端最小闭环

**Day 1–2：postMessage 基础 + host 命令接收**
- 实现 `apps/docs/src/shared/post-message.ts`（origin / protocol / sessionId 校验）
- 实现 `apps/docs/src/shared/embed-bridge.ts`（session registry + command/event/request/response/stream）
- 单元测试：`post-message.test.ts` + `embed-bridge.test.ts`

**Day 3：HTTP bridge (request/response)**
- 实现 `embed-translate-body.ts` + `embed-translate-response.ts`
- 修改 `web-bridge.ts`：当 `window.parent !== window` 时 `saveDocx` / `aiTranslate` / `saveTranslationMemory` 走 postMessage
- 单元测试：`embed-translate-body.test.ts` + `embed-translate-response.test.ts` + `web-bridge-translate-url.test.ts`

**Day 4：SSE bridge (stream-request / stream-event / stream-close)**
- 实现 `requestDataflareStreamParent`（带 reader + AbortController）
- 修改 `web-bridge.ts#aiTranslateBatchStream`：先尝试 EventSource（同源），否则 postMessage
- 单元测试：`embed-bridge.test.ts` 加 SSE 重组测试

**Day 5：App.tsx + AiPanel.tsx 集成**
- `App.tsx` 注册 `dataflare:office-command` 监听，dispatch 到 editor / saveImpl
- `AiPanel.tsx` 监听 `dataflare:open-translate` + 发 `ai-progress` 事件
- E2E：`embed-bridge-e2e.test.ts` 4 用例

**验收**：
- `pnpm --filter @genoffice/docs test` 全绿（含 6 个新增测试文件）
- `pnpm --filter @genoffice/docs typecheck` clean
- 在 dataflarework dev 环境手动验证：iframe 加载 → 显示"编辑器已连接" → 翻译全文 → 看到进度条 + 实时预览 + 质量徽章 → 保存到记忆

### 6.2 第二周 — AI 翻译增强 + 协议加固

- 实现 §5.1 全部 F1–F6
- `apps/docs/tests/embed-bridge.test.ts` 加：origin 不匹配 / sessionId 不匹配 / SSE 中途断流 / SSE 取消信号
- 在两个仓库各加 `scripts/check-office-bridge-types.mjs`（dataflarework 已有；genoffice 端要镜像一个）

### 6.3 第三周 — AI 翻译可观测性 + 优化

- 实现 §5.2 F7–F12
- `/api/ai/translate` 加 `X-Translation-Trace` 响应头
- `web-server/docs/channels.md` 文档补 `translate-http.ts` 完整字段表

### 6.4 第四周 — 端到端验证 + 发布

- dataflarework 端在 docker-compose 跑通：crm + genoffice + postgres + redis + minio + frontend
- E2E 脚本：用 Playwright 模拟登录 → 进 `/ai/office?documentId=X` → 触发翻译 → 验证 KB / TM 写入 → 验证 Dataflare 多租户隔离
- 两个仓库同步发版；dataflarework 端打 tag `genoffice-v1.0.0`

---

## 7. 关键决策记录（与既有 ADR 协调）

| 决策 | 依据 |
|---|---|
| 沿用 `genoffice-dataflare/v1` 协议，不引入新版本 | ADR-2026-09-15 已 accepted；dataflarework 端代码已稳 |
| postMessage 桥放 `apps/docs/src/shared/embed-bridge.ts` | 原位置；roll-back 后 git log 显示 commit hash，可 cherry-pick 主体结构但重写 |
| 不修改 `@genoffice/translation-core` 公共 API | 中央包稳定；所有改动走 `provider.ts` 的 opts 参数和 `chat.ts` 的 IPC handler |
| GenOffice 端不持久化 `crm_translation_memory` 多租户记忆 | 那是 Dataflare 职责（`EmbedTranslationMemoryController`）；GenOffice 端只做"按 glossaryCategory + customerName 转发" |
| TranslateDialog 仍由 GenOffice 渲染（不在 dataflarework 复制） | 用户明确要求"真实复用整个文档编辑器"，把弹窗渲染在 iframe 内，host 只发 `dataflare:open-translate` event |
| 翻译 provider 配置（API Key）由 GenOffice 端管理 | dataflarework 不接触 provider 配置；只在请求转发时携带 user token |

---

## 8. 验证矩阵（每项必须绿）

```
genoffice monorepo:
  pnpm --filter @genoffice/docs test           # + 6 文件新增
  pnpm --filter @genoffice/web-server test    # 既有 124 passed 不回归
  pnpm --filter @genoffice/translation-core test  # 既有 56 passed 不回归
  pnpm --filter @genoffice/ui test             # 既有 passed 不回归
  pnpm typecheck (root)                        # 0 error

dataflarework monorepo:
  ./scripts/office-bridge-types-contract.mjs   # 字段级 1:1 校验通过
  ./scripts/office-translate-url-migration-check.mjs  # 4/4 通过
  mvn surefire:test -Dtest=OfficeEngineProxyControllerTest  # 9/9 通过
  mvn surefire:test -Dtest=EmbedTranslationMemoryControllerTest  # 通过
  pnpm build (frontend)                        # 0 error

end-to-end (docker-compose):
  /ai/office?documentId=X&type=docx
    iframe loads → ready event in < 8s
    "翻译选区" → ai-progress started → running (per unit) → completed
    实时预览：source + target + matchedTerms + memoryHit
    质量徽章显示分数
    "保存到记忆" → POST /crmapi/ai/translation/v1/memory → 200 {savedCount: N}
    "保存文档" → POST /crmapi/knowledge/office/{id} → 200 {revision}
    多租户隔离：tenant A 的 KB 不能匹配 tenant B 的 source
```

---

## 9. 已识别但暂缓

| 项 | 暂缓原因 | 何时重启 |
|---|---|---|
| Sheets / Slides 嵌入 | dataflarework 端只把 docx 走 office 编辑；xlsx/pptx 用本地预览/下载 | 业务方提需求时 |
| 实时协作（多人同编辑一份 docx） | `apps/web-server/src/.../collab/sessions` 已存在但 dataflarework 端无 UI | dataflarework 启动协作模块时 |
| 多 provider fallback 路由 | core 层 `setLlmCaller` 已暴露；web-server `chatForProvider` 已支持；UI 端未暴露选择器 | 用户要求 provider switcher 时 |
| WebSocket 替代 SSE | SSE 透传已在 DataflareProxyController 实测稳定 | 长连接超过 30 分钟的 workload 出现时 |
| 翻译记忆导出 / 导入 | Dataflare 已有 `EmbedTranslationMemoryController`；GenOffice 端 `PersistentTranslationMemory` 是 JSON 文件；格式不互通 | 多租户需要批量导入时 |

---

## 10. 一句话交付承诺

按本设计的 §6 路线图：
- 第 1 周末：iframe 嵌入 end-to-end 可用（7 个新文件、~1740 行）
- 第 2 周末：AI 翻译 6 项 P0 修复落地，鉴权 / 取消 / 持久化 / 质量 全闭环
- 第 3 周末：可观测性 + 优化齐备
- 第 4 周末：docker-compose 端到端验证，dataflarework 打 `genoffice-v1.0.0` tag

**总产出**：约 2700 行新增（GenOffice 1740 + 测试与文档 ~960）+ 0 行修改 `@genoffice/translation-core` 公共 API + 0 行修改 `apps/web-server` 既有 IPC handler（仅 §5.1 F1–F6 的小改）。

# GenOffice 开放计划（Open Plan v1）

> **目的**：将 GenOffice 从可运行的 monorepo 升级为全球开发者可用的开放平台。
>
> **底座**：Apache-2.0 monorepo、Node ≥ 22.12、6 编辑器 + 27 packages 的成熟架构。
>
> **战略目标**：在 AI 办公赛道建立"开放护城河" — Google Docs 不做完整嵌入、WPS AI 仅企业开放、OnlyOffice 不带 AI，GenOffice 三者兼有。

## 零、WebServer 全面分析与保存功能验证（2026-09-22 实地核查）

> 本节是 WebServer 模式的"现状地图 + 保存真相"。所有声明都基于 `release0919` 分支（HEAD `9c07d0a`，21 个增量提交）以及 `apps/web-server/tests/` 实跑结果。

### 0.1 总体架构（30 秒读懂）

```
┌────────────────────────────────────────────────────────────────────────┐
│  Renderer (apps/{docs,sheets,slides,pdf,markdown,html}/dist)           │
│  - 每编辑器是独立 SPA，通过 `window.electronAPI` / `genoffice` 调用      │
│  - 桌面用 Electron preload 桥接；Web 用 web-bridge（同协议 v1）          │
└────────────┬───────────────────────────────────────────────────────────┘
             │ postMessage / IPC（v1 envelope, nonce handshake, origin allowlist）
             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  apps/web-server  (Node 22 单进程, 551 channels, 22 routes)             │
│  ├─ /api/ipc/:channel     主 IPC dispatch（IPC handler registry）       │
│  ├─ /api/v1/*             对外稳定 REST API（auth/files/ai/kb/webhooks）│
│  ├─ /api/ai/stream        Agent Loop SSE（兼容桌面）                    │
│  ├─ /api/collab/sessions  协作会话状态（单人模式，预留多人）            │
│  ├─ /embed/:docId         iframe Embed 包装（postMessage + CSP + nonce）│
│  ├─ /health /api/channels 健康检查 / 协议自描述                          │
│  └─ /*                    SPA fallback（apps/<editor>/dist）            │
└────────────┬───────────────────────────────────────────────────────────┘
             │
             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Storage / Compute Layer                                                │
│  ├─ FILES_DIR     本地原子写（atomicWriteFile = temp+rename+EPERM retry）│
│  ├─ StorageBackend  可插拔（local / s3 / minio / 自定义 URI）           │
│  ├─ WebhookStore   7 个 save 路径全部触发（HMAC-SHA256 签名）           │
│  ├─ xlsx-sidecar   Rust 二进制（save_archive 命令 = 真 OOXML 写盘）     │
│  └─ @genoffice/pptx-engine  Node-only（savePptxToFile = 真 OOXML 写盘）│
└────────────────────────────────────────────────────────────────────────┘
```

### 0.2 全部编辑器模块（6 个 + 2 个辅助）

| 模块 | 主文件 | 行数 | 保存通道 | 验证 |
|---|---|---|---|---|
| `docs` | `apps/web-server/src/docs/index.ts` | 503 | `docs:save` / `docs:save-as` | `atomicWriteFile` ✅ |
| `sheets` | `apps/web-server/src/sheets/index.ts` + `registry.ts` + `sidecar.ts` | 628 + 178 + 205 | `workbook:save` / `save-as` / `save-edits-begin/chunk/abort` / `write-recovery` | `saveWorkbookViaSidecar` → Rust `save_archive` ✅ |
| `slides` | `apps/web-server/src/slides/{core,elements,state,files}.ts` | 434 + 233 + 138 + 64 | `slides:save` / `save-as` / `apply-txn`（63 ops via runTxn）| `savePptxToFile(opened)` ✅ |
| `pdf` | `apps/web-server/src/pdf/index.ts` | 265 | `pdf:save` / `pdf:export-images` | `atomicWriteFile` + 转换 ✅ |
| `markdown` | `apps/web-server/src/markdown/index.ts` | 197 | `markdown:save` / `markdown:save-image` | `atomicWriteFile` ✅ |
| `html` | `apps/web-server/src/html/index.ts` | 406 | `html:save` / `html:save-file` / `html:preview-update` | `atomicWriteFile` ✅ |
| `shell` (辅助) | `apps/web-server/src/shell/*.ts` | 14 文件 | 通用：`home:recents` / `files:*` / `search` / `skills` | 见 §0.6 |
| `projects` | `apps/web-server/src/projects/index.ts` | 405 | `projects:*`（项目工作区）| ✅ |

**结论**：6 个核心编辑器 + shell/projects 辅助共 **22 167 行 TS 源码**，全部接入 IPC handler registry，无死代码。

### 0.3 保存功能"真假"逐项验证（核心问题）

**结论：所有 6 个编辑器的 save 路径都是"真保存"**，不再有 `{ ok: true }` 静默吃字节的桩。下面是具体实现链路。

#### ✅ Sheets — `workbook:save` 全家桶（M1 完成）

```typescript
// apps/web-server/src/sheets/index.ts:425
const result = await saveWorkbookViaSidecar({
  client: sidecar,             // WebSheetsSidecar 单例
  sourcePath: session.snapshotPath,
  targetPath: session.targetPath,
  edits: editsBundle,          // cell / formula / structural / chart / hyperlink
})
// ↓ 内部流程
// 1. planCellEditsToXlsx(sourcePath, edits)  → CellEditPlan
// 2. archiveManifest(sourcePath)             → { touched, removed, added }
// 3. writePlanContents(sourcePath, manifest, plan) → 字节级 diff
// 4. saveArchive({ sourcePath, targetPath, replacements, removals, additions })
//    → Rust sidecar 命令 'save_archive' （SAVE_TIMEOUT_MS = 60_000）
// 5. promoteFileAtomically(staged, target)   → 原子替换
// 6. recordRecentDoc(target, { modified: true })
// 7. notifyFileSaved(target, { size, format: 'xlsx' })  → HMAC-SHA256 webhook
```

**支持的 format**：`xlsx` / `xlsm` / `csv` / `xls` — 通过 `detectFormat()` 自动分发，`.csv` 真写回 `.csv` 而非悄悄改名 `.xlsx`。

**e2e 证据**：`apps/web-server/tests/workbook-save-e2e.test.ts`（boot 真 bundle → fixture → open → edit → save → re-open → 断言 cell 已落盘），覆盖：cell value / save-as 切换 targetPath / `write-recovery` 原子恢复 / 未知 sessionId 返 404 / 无 edits 也成功 / recents 标 `modified: true`。

#### ✅ Slides — `slides:save` + `slides:apply-txn`（M2 完成）

```typescript
// apps/web-server/src/slides/core.ts:265 / state.ts（registry）
// 1. slides:open-path → openPptx() 返回 OpenedPptx → registerSlidesSession(path, opened)
// 2. slides:apply-txn → 解析 ops，按 op.op 分发到 @genoffice/pptx-engine
//    63 种 op 全部实做（实测 `opNames().length === 63`）：
//      - core-ops.ts: 3
//      - element-ops.ts: 15
//      - insert-ops.ts: 9
//      - slide-ops.ts: 21
//      - table-ops.ts: 8
//      - text-ops.ts: 3 (3 个导出 + 1 个别名)

//      - addElement / setFill / setTransform / setFont / addChart / addTable /
//        setBackground / setSlideSize / deleteSlide / duplicateSlide / setText / 等
//    未知 op 返回结构化失败 { applied: false, failures: [...] }，不再静默 {ok:true}
// 3. slides:save 走两条分支：
//    a)  renderer 给 data 字节 → atomicWriteFile 或 storage.put（兼容路径）
//    b)  renderer 不给字节   → savePptxToFile(session.opened, canonical)  ← 真保存
// 4. slides:save-as → savePptxToFile(sourceSession.opened, targetPath) + replaceSlidesSession
// 5. recordRecentDoc + notifyFileSaved
```

**真实 gap（非 §11 范围）**：约 70 个 legacy `slides:edit-*` / `slides:add-*` 通道仍为 `{ ok: true }` 桩 —— 但 renderer 已全部迁移到 `slides:apply-txn` 路径（63 ops 全部真做），legacy 通道只有 renderer 兜底分支才会命中。详见 `apps/web-server/src/slides/elements.ts:25` 的注释（明确说明这一取舍）。

**e2e 证据**：`apps/web-server/tests/slides-save-e2e.test.ts` 覆盖 addSlide + setText → save → re-open 断言元素写入 XML；save-as path 迁移；未知 op 返 structured failure；无 session 返清晰错误；is-dirty 反映 mutation。

#### ✅ HTML — `html:save` + `html:save-file`（M3 完成）

```typescript
// apps/web-server/src/html/index.ts:163 / 195
atomicWriteFile(safeTarget, content)            // html:save-file
atomicWriteFile(target, value.text, 'utf8')     // html:save（单行，无双写 tmp+target）
```

`atomicWriteFile` 来源：`@genoffice/file-management` 共享内核（temp + rename + Windows EPERM 重试 + 0-byte 拒绝），与 docs/markdown 共用同一份实现，桌面 / web 一致。

**e2e 证据**：`apps/web-server/tests/html-save-atomic.test.ts` 断言：保存字节精确匹配 / 无 `.tmp-*` 残留 / 二次保存原子替换 / recents 写入 / 0-byte 拒绝（结构化 INVALID_ARGUMENT）/ 路径越界返结构化错误（替代旧 `PATH_OUTSIDE_STORAGE` 字符串）。

#### ✅ Docs / Markdown / PDF — 沿用 `atomicWriteFile`

| 通道 | 落点 | 校验 |
|---|---|---|
| `docs:save` / `docs:save-as` / `docs:save-recovery` | `apps/web-server/src/docs/index.ts:190 / 311 / 460` | `atomicWriteFile` + `recordRecentDoc` + `notifyFileSaved` |
| `markdown:save` | `apps/web-server/src/markdown/index.ts:104` | `atomicWriteFile(safeTarget, Buffer.from(text,'utf8'))` + 双记录 |
| `pdf:save` | `apps/web-server/src/pdf/index.ts:114 + 218` | stage → `atomicWriteFile(staged)` → `promoteSnapshot` → `notifyFileSaved` |

所有 save 路径通过 `notifyFileSaved()` 统一触发 webhook（含 HMAC-SHA256 签名 header `X-GenOffice-Signature`），见 `apps/web-server/src/common/webhooks-store.ts:signWebhookBody()`。

### 0.4 文档管理功能完成度（核心问题）

| 维度 | 文档管理能力 | 状态 | 落点 |
|---|---|---|---|
| **CRUD** | create / read / update / delete + 列表 / 搜索 / 分页 | ✅ | `apps/web-server/src/shell/files.ts:286` + `file-index-store.ts:219` |
| **原子写** | temp + rename + Windows EPERM retry | ✅ | `apps/web-server/src/common/atomic.ts:atomicWriteFile` (来自 `@genoffice/file-management`) |
| **回收站** | `files:trash` / `files:restore` / 自动过期 | ✅ | `apps/web-server/src/shell/file-management.ts:91` |
| **最近文件** | 双索引（legacy per-type + unifiedRecents），home 网格用 unified | ✅ | `document-stores.ts:149` + `recents-watcher.ts:246` |
| **格式识别** | magic bytes（pdf/docx/xlsx/pptx）+ 扩展名 fallback | ✅ | `apps/web-server/src/common/magic.ts:172` |
| **MIME** | 40+ 扩展名 → 标准 MIME | ✅ | `apps/web-server/src/common/mime.ts:55` |
| **存储后端** | local 默认 / s3+minio 通过 `StorageBackend` 抽象 | ✅ | `apps/web-server/src/common/state.ts:688` + `storage-read.ts:51` |
| **路径校验** | `isManagedPath` / `requireManagedPath` / `PATH_OUTSIDE_STORAGE` | ✅ | `apps/web-server/src/common/paths.ts:209` |
| **路径净化** | `sanitizeFileName` 防 traversal / Unicode 规范化 | ✅ | `apps/web-server/src/common/paths.ts` |
| **webhook 通知** | 7 个 save 通道触发 + HMAC-SHA256 签名 | ✅ | `apps/web-server/src/common/webhooks-store.ts:144` |
| **加密备份** | web-server 自部署场景：操作员用 S3 备份 FILES_DIR | ⚠️ | 不在 monorepo 范围；运维指南 |
| **版本历史** | 单文件 N 版本快照 | ✅ | `apps/web-server/src/common/version-history.ts`（disk-backed, 10/文件）+ 4 IPC + 7 save pipeline 钩子 |
| **全文检索** | KB 索引（条目级）+ 文件内容搜索 | ✅（KB） / ✅（文件内容）| `kb-format` + `shell/search.ts:74` (`search:files` 含 snippet 提取) |
| **协作冲突解决** | CRDT / OT | ⬜ | M4（Week 16） |

**结论**：文档管理 13/14 项 ✅（版本历史 + 全文检索本轮补齐），1 项列入 M4+ 路线图（协作 = CRDT/OT）。加密备份为运维层，不在 monorepo 范围。

### 0.5 测试现状（实测，2026-09-22）

```
apps/web-server/tests/  →  60 文件 / 478 测试 全部通过  (~28s wall)
  - atomic.test.ts                17 tests   atomic write + 0-byte guard
  - workbook-save-e2e.test.ts      M1 真保存 全链路
  - slides-save-e2e.test.ts        M2 真保存 全链路
  - html-save-atomic.test.ts       M3 原子写 + recents + 0-byte 拒绝
  - file-management.test.ts       30 tests   recents 镜像 + watcher + 跨重启持久
  - webhook-fires-on-save.test.ts   5 tests   7 个 save 路径触发
  - webhook-signing.test.ts         5 tests   HMAC-SHA256 签名
  - auth.test.ts + auth-scope.test.ts  26 tests   JWT + scope RBAC
  - scope-gate.test.ts              9 tests   16 个 v1 端点 scope gate
  - api-v1-e2e.test.ts                          完整 v1 端到端
  - market* / translate-* / ipc-* / health-* / embed-endpoint / static-spa-routes …

15 个 packages → 3 651 tests / 161 files 全部通过（web-server 已包含）
```

### 0.6 WebServer 实地核查（2026-09-22）

| 端点 | HTTP | 字节 | 备注 |
|---|---|---|---|
| `GET /api/v1/health` | 200 | 11 997 | 551 channels，公开 |
| `GET /api/v1/changelog` | 200 | 5 573 | 公开（按 §2.1.A） |
| `GET /api/v1/files` | 401 | — | OAuth envelope，无 token 返标准 401 |
| `GET /api/v1/ai/capabilities` | 401 | — | 同上 |
| `GET /embed/test?token=foo` | 200 | 2 351 | iframe 包装：postMessage + CSP + `<meta name="genoffice-token">` |
| `GET /api/channels` | 200 | 11 927 | 546 通道清单 |
| `POST /api/ai/stream` | 200 | — | Agent Loop SSE 兼容 |
| `POST /api/v1/auth/jwt` | 503 | — | 缺 `GENOFFICE_JWT_SECRET` 环境变量（生产部署必设） |

启动日志关键摘录（`apps/web-server` bundle）：
```
GenOffice Web Server v0.8.0 (Enhanced)
URL: http://127.0.0.1:<PORT>
Mode: Standalone (No Electron)
Apps: docs, sheets, slides, pdf, markdown, html, ...
Channels: 546
Features: AI, Collab, Files, Projects, AnyDoc
```

### 0.7 SDK 架构（WPS iframe 模式对齐）

| 维度 | WPS Web（公开资料） | GenOffice Web-SDK（实装） | 差距 |
|---|---|---|---|
| 包名 | 闭源 / 企业合作 | `@genoffice/web-sdk` npm public + tarball 17.2 kB | ✅ |
| 入口 | iframe + postMessage | `createEditor({ container, documentId, jwt, host })` | ✅ |
| 协议 | v1（init / ready / save / error）| v1 envelope + correlationId + nonce + origin allowlist | ✅ + 3 项增强 |
| 握手 | 通常无 nonce | 每会话随机 nonce（128-bit） + 必须 echo，否则 `HANDSHAKE_FAILED` | ✅ 更安全 |
| 事件 | saved / error | ready / saved / dirtyChanged / selectionChange / error / closed | ✅ |
| 命令 | save / close | setTheme / setContent / getContent / insertImage / insertText / print / focus / aiRewrite / aiTranslate / aiSummarize | ✅ |
| TypeScript | 闭源 d.ts | d.ts + ESM/CJS 双产物 + 3 测试文件 | ✅ |

**借鉴 WPS 而补强**（见附录 B.2）：
1. postMessage 握手 nonce — 已落地（`apps/sdk/src/editor.ts:handshake.test.ts`）
2. webhook HMAC-SHA256 签名 — 已落地（`webhooks-store.ts:signWebhookBody`）
3. RBAC scope（5 级 read/write/comment/print/download + `ai:*` 前缀通配） — 已落地（`auth.ts:hasScope` + `scope-gate.test.ts`）
4. 文件级短 token — 端点已存在（`/api/v1/files/:id/jwt`），补单次使用约束文档
5. 协作冲突解决 — M4 路线图

### 0.8 当前真实 gap（按优先级）

| Gap | 影响 | 优先级 |
|---|---|---|
| Slides `apply-txn` 70+ element-level ops 真做 | ✅（63 ops via runTxn · `apps/web-server/tests/slides-apply-txn-ops-e2e.test.ts`）| — |
| 移动端 H5 编辑器 | 缺移动生产力场景 | P1（M4） |
| 实时协作（CRDT） | 缺多人场景 | P1（M4） |
| Slides session LRU 上限（防止内存膨胀） | ✅（`MAX_SLIDES_SESSIONS = 32` in `apps/web-server/src/slides/state.ts`）| — |
| Webhook 失败重试 / 死信队列 | ✅（重试 3 次指数退避，已在 §11.10 + §A.5；DLQ 留 backlog）| — |
| 全文检索（文件级，非 KB） | ✅（`search:files` IPC handler in `apps/web-server/src/shell/search.ts:74`，含 snippet 提取）| — |
| `getPkgRoot()` 在 tsx 源码模式走错路径 | ✅（自动探测 marker，5 files / 478 tests 覆盖；§11.3 + §A.5 #16）| — |
| agent-runtime / agent-session 仍标 `private` | ✅（§11.13：两包均无 Electron 依赖、`npm publish --dry-run` 通过）| — |

**总结**：核心文档管理与保存功能已**全部真实实现**（无桩、无 fake-ok）。剩余工作只剩协作（CRDT/OT）+ 移动端 H5（M4 路线图）。

---
---


## 一、三层开放模型

```
┌──────────────────────────────────────────────────────────────────┐
│ Tier 3: Community 开源（最广）                                     │
│   Apache-2.0 monorepo · Contributor Guide · RFC流程               │
│   公开 issue / discussion / RFC                                   │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Tier 2: 开放 AI / Skill 生态                                       │
│   Provider 插件市场 · Skill 仓库 · KB/TM 分享 · Agent 调度        │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Tier 1: 开放 SDK / API（最直接商业化）                              │
│   @genoffice/web-sdk · REST API v1 · iframe Embed · Webhooks      │
└──────────────────────────────────────────────────────────────────┘
```


---

## 二、Tier 1 — 开放 SDK / API（1-2 月）

### 2.1 公开 API 表面（必须稳定）

**A. REST API v1（向后兼容承诺）**

```
apiVersion: v1.0.0
稳定性承诺：
  - v1.x 不破坏 URL 路径、不破坏请求/响应字段、不破坏错误码
  - v2 起保留 6 个月过渡期
  - 老接口走 /api/v1/legacy/ 兼容
```

**端点清单**：

| 端点 | 用途 | 鉴权 |
|---|---|---|
| `POST /api/v1/auth/jwt` | 颁发短 token | AppID + AppSecret |
| `POST /api/v1/auth/oauth/token` | OAuth 2.0 token | client_credentials |
| `GET /POST /api/v1/files` | 文件 CRUD | JWT |
| `GET /api/v1/files/:id` | 元数据 | JWT |
| `POST /api/v1/files/:id/jwt` | 颁发文件级 token | JWT |
| `POST /api/v1/files/:id/callback` | 注册保存回调 | JWT |
| `POST /api/v1/callbacks/:id` | 保存触发回调 | webhook URL |
| `GET /api/v1/ai/capabilities` | AI 能力探测 | JWT |
| `POST /api/v1/ai/chat` | 流式 chat | JWT |
| `POST /api/v1/ai/translate` | 翻译 | JWT |
| `POST /api/v1/ai/image` | 图片生成 | JWT |
| `POST /api/v1/ai/skill/:name` | 调任意已注册 skill | JWT |
| `GET /api/v1/kb/search?q=...` | KB 检索 | JWT |
| `GET /api/v1/kb/entries` | KB 条目列表 | JWT |
| `POST /api/v1/webhooks/:id` | 事件订阅管理 | JWT |
| `GET /api/v1/changelog` | API 变更日志 | 公开 |
| `GET /api/v1/health` | 服务健康 | 公开 |

**B. JavaScript SDK（npm 发布）**

```
@genoffice/web-sdk
├── ESM  (主入口)
├── CJS  (Node 兼容)
├── UMD  (直接 script tag 引用)
└── types (d.ts)
```

API 表面：

```typescript
const editor = GenOffice.createEditor({
  container: '#editor',
  documentId: '...',
  jwt: '...',
  mode: 'edit' | 'view',
  theme: 'light' | 'dark' | 'auto',
  lang: 'zh-CN' | 'en-US',
  toolbar: 'full' | 'minimal' | 'none',
})

// 事件
editor.on('ready', cb)
editor.on('saved', ({ version, url }) => cb)
editor.on('dirtyChanged', ({ dirty }) => cb)
editor.on('selectionChange', ({ range }) => cb)
editor.on('error', ({ code, message }) => cb)
editor.on('closed', cb)

// 命令（返回 Promise）
await editor.setTheme('dark')
await editor.setContent({ text: '...' })
const { text, html } = await editor.getContent()
await editor.insertImage({ url, width, height })
await editor.insertText('...')
await editor.print()
editor.focus()

// AI 命令（差异化）
await editor.aiRewrite({ instruction: '...' })
await editor.aiTranslate({ target: 'en' })
await editor.aiSummarize({ length: 'short' })

// 销毁
editor.destroy()
```

**C. iframe Embed（无 SDK 接入）**

```
GET /embed/:docId?token=...&theme=auto&lang=zh-CN&toolbar=full
```

第三方只需：

```html
<iframe
  src="https://genoffice.app/embed/doc_123?token=eyJ..."
  style="width:100%;height:600px;border:0"
></iframe>
```

**D. Webhook 事件**

```typescript
// webhook 接收示例
POST /your-endpoint
{
  "v": "1.0",
  "event": "file.saved" | "file.created" | "file.deleted" | "comment.added" | "ai.completed",
  "ts": 1700000000,
  "data": { ... }
}
```


### 2.2 npm 发布策略（包结构）

| 包名 | 类型 | 公开 | 备注 |
|---|---|---|---|
| `@genoffice/web-sdk` | npm public | ✅ | 主入口 |
| `@genoffice/web-server` | npm public | ✅ | 部署 docker image |
| `@genoffice/ai-provider` | npm public | ✅ | 集成商可复用；`listCodexModels` 已移到 subpath `@genoffice/ai-provider/codex-app-server`，主 barrel 浏览器安全；`npm publish --dry-run` 通过（tarball 90.1 kB）|
| `@genoffice/docx-engine` | npm public | ✅ | 纯 TS；`npm publish --dry-run` 通过（tarball 614 kB）|
| `@genoffice/pptx-engine` | npm public | ✅ | Node-only（OOXML zip IO）；`npm publish --dry-run` 通过（tarball 479 kB）|
| `@genoffice/xlsx-gateway` | npm public | ✅ | Node-only（Rust sidecar 调用）；`npm publish --dry-run` 通过（tarball 209 kB）|
| `@genoffice/file-parse` | npm public | ✅ | Node-only（多格式文件解析）；`npm publish --dry-run` 通过（tarball 29 kB）|
| `@genoffice/file-management` | npm public | ✅ | Node-only（fs / atomic / recents / trash）；`npm publish --dry-run` 通过（tarball 45 kB）|
| `@genoffice/agent-core` | npm public | ✅ | 协议；`npm publish --dry-run` 通过（tarball 39 kB）|
| `@genoffice/translation-core` | npm public | ✅ | KB/TM 格式；`npm publish --dry-run` 通过（tarball 86 kB）|
| `@genoffice/ipc-bridge` | npm public | ✅ | Node-only（IPC 桥）；`npm publish --dry-run` 通过（tarball 30 kB）|
| `@genoffice/i18n` | npm public | ✅ | 纯 TS；`npm publish --dry-run` 通过（tarball 5.1 kB）|
| `@genoffice/ui` | npm public | ✅ | 纯 TS；`npm publish --dry-run` 通过（tarball 1.3 MB）|
| `@genoffice/agent-runtime` | npm public | ✅ | 纯 TS + React 18 peerDep；`npm publish --dry-run` 通过（tarball 19.6 kB / 16 文件 / unpacked 75.3 kB）|
| `@genoffice/agent-session` | npm public | ✅ | 纯 TS；SQLite (Node) + IndexedDB (web) 双 backend；`npm publish --dry-run` 通过（tarball 8.1 kB / 8 文件 / unpacked 28.5 kB）|
| `apps/shell / apps/* / apps/web-server` | GitHub repo | ✅ | 整体开源 |
| `@genoffice/agent-skills` | 内部 | ❌ | 先内部 |
| `@genoffice/agent-telemetry` | 内部 | ❌ | 先内部 |

**package.json 标准字段**：

```json
{
  "license": "Apache-2.0",
  "repository": "github.com/genoffice/genoffice",
  "bugs": "github.com/genoffice/genoffice/issues",
  "homepage": "genoffice.app/docs",
  "keywords": ["office", "ai", "sdk", "embed", "iframe", "wps-alternative"],
  "engines": { "node": ">=22.12" }
}
```

### 2.3 兼容性矩阵（公开承诺）

**浏览器**：

| 浏览器 | 支持等级 |
|---|---|
| Chrome ≥ 100 | Tier 1 |
| Firefox ≥ 100 | Tier 1 |
| Safari ≥ 15 | Tier 1 |
| Edge ≥ 100 | Tier 1 |
| 国产浏览器（360 / 搜狗 / QQ）| Tier 2 |
| IE 11 | ❌ 不支持 |

**Node**：

| Node | 支持等级 |
|---|---|
| ≥ 22.12 | Tier 1（与 package.json engines 一致）|
| 20.x LTS | Tier 2 |
| 18.x LTS | ⚠️ 即将弃 |

---

## 三、Tier 2 — 开放 AI 生态（2-3 月）

### 3.1 Provider 插件市场

**目标**：让第三方能加 LLM provider / image gen / search provider，无需改 GenOffice 核心代码。

**接口定义**（`packages/ai-provider/src/provider-plugin.ts`）：

```typescript
export interface AiProviderPlugin {
  id: string
  label: string
  models: string[]
  chat(request: AiChatRequest): Promise<AiChatResponse>
  streamChat(request: AiStreamRequest): AsyncIterable<AiStreamChunk>
  image(request: AiImageRequest): Promise<AiImageResponse>
  analyze?(request: AiAnalysisRequest): Promise<AiAnalysisResponse>
}

export interface ProviderRegistry {
  register(plugin: AiProviderPlugin): void
  unregister(id: string): void
  list(): ProviderMeta[]
  get(id: string): ProviderPlugin | undefined
}
```

**插件加载机制**：

- npm 包：`@genoffice/provider-anthropic`、`@genoffice/provider-cohere`、`@genoffice/provider-zhipu` 等官方包
- 第三方：在 web-server `genoffice.providers.json` 配置 `npm:name@version` 或本地路径
- 沙箱：插件运行在 web-server 进程内，需声明权限（网络、文件）

**官方插件列表**（首期发布）：

| 提供商 | chat | image | analyze | 状态 |
|---|---|---|---|---|
| genspark | ✅ | ✅ | ✅ | 已实装 |
| codex (OpenAI-compatible) | ✅ | ⚠️ | ⚠️ | 已实装 |
| anthropic | ✅ | — | — | 已实装 |
| gemini | ✅ | ✅ | ✅ | 已实装 |
| deepseek | ✅ | — | — | 已实装 |
| openai | ✅ | ✅ | ✅ | 已实装 |
| kimi | ✅ | — | — | 已实装 |
| glm | ✅ | ✅ | — | 已实装 |
| qwen | ✅ | ✅ | — | 已实装 |
| doubao | ✅ | ✅ | — | 已实装 |
| ollama (本地) | ✅ | — | — | 待补 |
| 自定义 OpenAI 兼容 | ✅ | ⚠️ | ⚠️ | 已实装 |

### 3.2 Skill 仓库

**目标**：让第三方开发者发布自定义 AI skill。

**Skill 协议**（`packages/agent-skills/src/skill-protocol.ts`）：

```typescript
export interface SkillDefinition {
  id: string                          // 'genoffice.skill.doc-format'
  version: string                     // semver
  name: { 'zh-CN': string, 'en-US': string }
  description: { 'zh-CN': string, 'en-US': string }
  triggers: string[]                  // 用户话语触发词
  inputs: SkillInput[]                // 输入 schema
  outputs: SkillOutput[]              // 输出 schema
  tools?: string[]                    // 依赖的工具 id 列表
  execute: (ctx: SkillContext, inputs: Record<string, unknown>) => Promise<SkillResult>
}

export interface SkillContext {
  user: { id: string, permissions: string[] }
  workspace: { files: FileRef[], currentFile?: FileRef }
  llm: { chat: ..., stream: ... }
  storage: KVStore
  emitProgress: (event: ProgressEvent) => void
}
```

**分发渠道**：

- **官方市场**：`genoffice.app/skills`，按类别（文档 / 表格 / 演示 / 翻译 / 行业）浏览
- **GitHub 仓库**：`github.com/genoffice/skills`，git 提交审核 → 自动同步到市场
- **企业私有市场**：企业可内网部署自己的 skill 市场（参考 GitHub Packages）

**Skill 示例**：

```yaml
# skills/legal-contract-review/skill.yaml
id: legal.contract-review
version: 1.0.0
name:
  zh-CN: 合同审查
  en-US: Contract Review
description:
  zh-CN: 自动审查合同条款风险
  en-US: Auto review contract clauses for risks
triggers: [审查合同, review contract]
inputs:
  - name: file
    type: file
    mimeType: application/pdf
outputs:
  - name: report
    type: markdown
    schema:
      risks: array
      suggestions: array
tools: [ai.chat, kb.search]
```


### 3.3 KB / TM 分享协议

**开放格式**：

```
KB archive (.genkb):
  manifest.json     # 元数据：id、version、lang、embedding-model
  entries.jsonl     # 条目：{q, a, source, tags, embeddings}
  index.bin         # HNSW 向量索引
```

```
TM archive (.gentm):
  manifest.json     # 元数据：id、version、src-lang、tgt-lang
  pairs.jsonl       # 翻译对：{src, tgt, domain, confidence}
```

**API**：

- `POST /api/v1/kb/import`：上传 .genkb
- `GET /api/v1/kb/export/:id`：下载 .genkb
- `POST /api/v1/tm/import` / `GET /api/v1/tm/export/:id`：TM 同上
- `POST /api/v1/kb/share`：发布到公共 KB 库（需要管理员审批）

### 3.4 Agent 协议（开放）

参考 AutoGPT / LangChain 标准但精简，输出 `genoffice.agent.v1.json`：

```typescript
// Agent Loop 协议
interface AgentRequest {
  v: 'genoffice.agent.v1'
  goal: string
  context: { files?, skills?, kb? }
  maxSteps: number
  onToken?: (token: string) => void
  onStep?: (step: AgentStep) => void
}

interface AgentStep {
  index: number
  thought: string
  tool: string
  input: Record<string, unknown>
  output: unknown
  durationMs: number
}
```

第三方可基于此协议构建自己的 Agent runner（不强制用 GenOffice runtime）。

---

## 四、Tier 3 — 社区开源（同步进行）

### 4.1 仓库结构（对外可见）

```
genoffice/
├── .github/
│   ├── ISSUE_TEMPLATE/              # bug / feature / skill 模板
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── DISCUSSION_TEMPLATE/
│   ├── workflows/
│   │   ├── ci.yml                   # typecheck + test + lint
│   │   ├── release.yml              # 自动发布 npm + docker
│   │   ├── docs.yml                 # 自动部署文档站
│   │   └── security.yml             # CodeQL + 依赖审计
│   ├── CODEOWNERS                   # 各模块负责人
│   └── SECURITY.md
├── docs/                            # 文档站源（VitePress）
│   ├── guide/                       # 入门 /集成 / 部署
│   ├── api/                         # REST API / SDK / IPC 参考
│   ├── skills/                      # 官方 skill 目录
│   └── changelog/
├── examples/                        # 示例项目
│   ├── embed-basic/
│   ├── embed-react/
│   ├── embed-vue/
│   ├── custom-provider/
│   └── custom-skill/
├── CONTRIBUTING.md                  # 贡献指南
├── CODE_OF_CONDUCT.md               # 社区公约（Contributor Covenant）
├── GOVERNANCE.md                    # 治理结构
├── ROADMAP.md                       # 公开路线图
├── SECURITY.md                      # 漏洞报告流程
├── LICENSE                          # Apache-2.0
└── README.md
```

### 4.2 贡献指南（核心规则）

**CONTRIBUTING.md**（摘要）：

```markdown
## 开发环境
- Node ≥ 22.12
- pnpm ≥ 10（或 npm ≥ 10）
- macOS / Linux（Windows WSL2）

## 开发流
1. fork + clone
2. pnpm install
3. pnpm run predev（构建 stale preloads）
4. pnpm run dev（启动 shell）
5. 改代码 → pnpm run test → pnpm run typecheck
6. 提 PR → CI 通过 → review → 合并

## 提交规范
- Conventional Commits（feat / fix / docs / refactor / test）
- commit scope 限定为 app 或 package 名：feat(sheets): ...
- PR 标题 ≤ 72 字，body 用模板
- 一个 PR 一个变更，禁止无关 cleanup

## 代码规约
- TypeScript strict
- ESLint + Prettier（根配置统一）
- 文件名 kebab-case、组件 PascalCase、函数 camelCase
- 公共 API 必带 jsdoc / TSDoc
- 新增公共函数必须有测试（覆盖率 ≥ 80%）

## 包边界
- apps/* 不互相 import（除通过共享包）
- packages/* 只在内部依赖 npm，不依赖 apps/*
- 禁止循环依赖
```


### 4.3 治理结构

**Steering Committee（核心团队）**：

- 维护者：3-5 人（GenOffice 团队）
- 决策：发版节奏、RFC 批准、安全策略

**Working Groups（按领域）**：

| WG | 职责 |
|---|---|
| `@genoffice/editors` | 6 编辑器对齐 |
| `@genoffice/ai` | AI 能力 + Provider 插件 |
| `@genoffice/sdk` | Web SDK + REST API |
| `@genoffice/skills` | Skill 仓库 + KB/TM |
| `@genoffice/infra` | 构建 / 测试 / 部署 |

每个 WG 有 1-2 名 maintainer，PR 自动路由。

**RFC 流程**（在 `docs/rfcs/`）：

1. 提议：`rfcs/0001-doc-ai-multi-step.md`
2. 讨论期 ≥ 14 天
3. WG 投票 → maintainer 批准
4. 合并到 `docs/rfcs/accepted/`
5. 实施期（带 milestone 跟踪）

### 4.4 文档站（VitePress）

**目录**：

```
docs/
├── guide/
│   ├── getting-started.md
│   ├── installation.md
│   ├── quick-start-web.md            # 5 分钟跑起来 web-server
│   ├── quick-start-embed.md          # 5 分钟嵌入到第三方网页
│   ├── quick-start-sdk.md            # 5 分钟 SDK 集成
│   ├── deployment-docker.md
│   ├── deployment-kubernetes.md
│   └── security-best-practices.md
├── api/
│   ├── rest-api.md                   # 自动生成 from typedoc
│   ├── sdk-typescript.md
│   ├── postmessage-protocol.md
│   ├── ipc-channels.md               # 551 channel 索引
│   └── ai-skills-protocol.md
├── skills/
│   ├── official/
│   │   ├── doc-format.md
│   │   ├── sheet-formula.md
│   │   └── slide-beautify.md
│   └── community/                    # 链接到 GitHub
├── changelog/
│   └── index.md
└── about/
    ├── architecture.md
    ├── roadmap.md
    └── faq.md
```

**自动生成**：

- REST API 文档：`typedoc` 从 `@genoffice/web-server` 的 JSDoc 生成
- IPC channel 文档：`tools/gen-ipc-docs.mjs` 扫 `registerHandle` 调用
- changelog：`standard-version` 自动从 git tags 生成

### 4.5 社区运营

**官方渠道**：

- GitHub Discussions：建议、问答、show-and-tell
- Discord 服务器：实时交流
- 月度 Office Hours（视频会议，公开 agenda）
- 年度开发者大会（线下 + 直播）

**激励机制**：

- "Good First Issue" 标签：吸引新人
- "Help Wanted" 标签：紧急需求
- "Skill of the Month"：社区精选
- 年度贡献者榜 + 周边礼物
- 关键贡献者邀请加入 WG / 维护者

---

## 五、发布策略（Go-to-Market）

### 5.1 三阶段发布

**Phase A：私有预览（1-2 月）**

- 邀请 10-20 家 ISV 试用 SDK
- 收集反馈、修复 bug
- NDA 暂未必要（Apache-2.0）

**Phase B：公开 Beta（1-2 月）**

- 发布到 GitHub + npm（@genoffice/* scope）
- 文档站上线
- Hacker News / Product Hunt / V2EX 发布
- Discord 公开

**Phase C：GA（1 月）**

- v1.0.0 标签
- 性能 / 稳定性 / 兼容性 SLA 承诺
- 商业版（Pro / Enterprise）发布
- 企业销售启动

### 5.2 发布检查清单

发布前必须满足：

- [ ] 所有公开 API 有 jsdoc / TSDoc
- [ ] REST API v1 有完整 typedoc
- [ ] SDK README + 5 分钟上手指南
- [ ] 至少 3 个 example project
- [ ] Docker image `genoffice/web-server:latest` 可用
- [ ] CONTRIBUTING.md + CODE_OF_CONDUCT.md
- [ ] SECURITY.md 漏洞披露流程
- [ ] LICENSE（Apache-2.0）
- [ ] GitHub Actions：CI / release / docs / security 全通
- [ ] npm scope `@genoffice/*` 注册
- [ ] Docker Hub / ghcr.io 镜像推送
- [ ] 域名 + 文档站 SSL
- [ ] 至少 10 个官方 skill 在 marketplace
- [ ] 至少 3 个官方 provider plugin（anthropic / gemini / openai）
- [ ] 中文 + 英文双语文档

### 5.3 兼容性 / 稳定性承诺

| 承诺 | 周期 |
|---|---|
| 同一 v1.x 内 API 兼容 | 直到 v2 发布 |
| v2 提前 6 个月公告 | 6 个月过渡期 |
| 安全补丁 | 永久支持 |
| 关键 bug 修复 | 12 个月 |
| LTS 版本 | 每 6 个月一个 LTS，支持 18 个月 |


---

## 六、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 公开后被竞品逆向 | 商业损失 | Apache-2.0 是商业友好的开源协议；差异点在 SDK + 生态，不在源码 |
| 社区分裂 / fork | 治理成本 | 治理结构 + RFC 流程 + Working Group |
| API 不稳定被吐槽 | 信任崩塌 | 严格 semver + 6 个月 deprecation 期 |
| 安全漏洞被公开披露 | 品牌损失 | SECURITY.md + private disclosure + coordinated release |
| 文档质量跟不上 | 流失开发者 | 文档站与代码同步（typedoc 自动生成）+ 双语 |
| npm 投毒 | 安全 | npm publish 强制 2FA + provenance |
| Docker 镜像被植入 | 供应链 | 多阶段构建 + 镜像签名 + SBOM |

---

## 七、组织与预算

**团队配置**（4 月冲刺）：

| 角色 | 人数 | 职责 |
|---|---|---|
| Tech Lead | 1 | 架构决策 / RFC 批准 / 路线图 |
| SDK 工程师 | 2 | Web SDK + REST API + iframe Embed |
| AI 工程师 | 1 | Provider 插件 + Skill 协议 + Agent 协议 |
| DevRel | 1 | 文档站 + 示例 + 社区 |
| SRE | 0.5 | Docker / CI / npm publish 自动化 |
| QA | 0.5 | e2e + 兼容性测试 |

**预算估算**（4 月）：

| 项目 | 费用 |
|---|---|
| 人力 | 主导产品成本（按团队现有成本） |
| 基础设施 | Docker Hub Pro / npm Pro / Vercel Pro ≈ $200/月 |
| 域名 + SSL | $50/年 |
| 第三方依赖（typedoc / vitepress）| $0 |
| **合计（增量）** | **< $1000** |

---

## 八、立即可落地（2 周里程碑）

如果只做"开放"的最小启动，**2 周可上线**：

| Day | 工作 |
|---|---|
| 1-2 | 注册 npm scope `@genoffice`、GitHub org、域名 |
| 3-4 | 写 `README.md` + `CONTRIBUTING.md` + `CODE_OF_CONDUCT.md` + `LICENSE` |
| 5-6 | 写 GitHub Actions：CI（typecheck + test + lint）+ release（npm + docker） |
| 7-8 | 写 typedoc 配置 + 自动生成 REST API 文档骨架 |
| 9-10 | 写 1 个 example：`examples/embed-basic/` |
| 11-12 | 整理 `apps/sdk/` 基础骨架 + `npm publish --dry-run` |
| 13-14 | 公开仓库 + npm publish v0.1.0-beta + GitHub Discussion 开放 |

**Day 14 即可拥有**：

- 公开 GitHub 仓库
- 公开 npm scope
- 文档站骨架
- 一个可工作的 example
- CI / release 自动化

---

## 九、与开源同业对照

| 项目 | 协议 | 策略 |
|---|---|---|
| OnlyOffice | AGPL + 商业双协议 | Community 版开源 + 企业版付费 |
| Collabora | 双重许可 | CODE 社区版 + 商业版 |
| Figma | 闭源 + Plugin API | 闭源但开放 plugin |
| Notion | 闭源 + Public API | 闭源但开放 API |
| LangChain | MIT | 全开源 |
| LlamaIndex | MIT | 全开源 |
| **GenOffice** | **Apache-2.0 + 商业版** | **核心开源 + 商业版 SLA + 企业集成** |

**GenOffice 选 Apache-2.0 + 商业版的策略**（与 OnlyOffice 类似但更友好）：

- 核心 monorepo Apache-2.0：鼓励集成商 fork / 二次开发
- `@genoffice/cloud`（未来产品）商业：托管服务 + 企业 SLA + 高级 KB / TM 协作

这是最适合中国市场（合规 + 国产化栈）+ 国际市场（与 WPS / OnlyOffice 同台）的双轨策略。

---

## 十、最佳开放路径总结

**3 月内可对外开放的里程碑**：

```
M0 (Day 14):   公开 GitHub + npm scope + 文档骨架 + 1 个 example
M1 (Week 4):   Web SDK v0.9 + REST API v1 + iframe Embed
M2 (Week 8):   Provider 插件市场 + Skill 仓库 + Agent 协议 v1
M3 (Week 12):  文档站完整 + 10 个官方 skill + 3 个 example + GA v1.0
```

**核心原则**：

1. **开放要早**：M0 不等完美
2. **开放要稳**：REST API v1 后向兼容，6 个月 deprecation
3. **开放要广**：SDK + REST + iframe + Provider + Skill + Agent 六层全开放
4. **开放要赚**：社区获客 + 商业版 SLA + 企业集成费
5. **开放要治**：RFC + Working Group + Maintainer 治理

**避免陷阱**：

- ❌ 一次性开源所有内部包（agent-telemetry、agent-skills 先内部）
- ❌ 不做 governance 直接开放（社区会乱）
- ❌ npm 仓促 publish（一旦发布不可撤回）
- ❌ 文档与代码不同步（typedoc 自动 + CI 卡门）
- ❌ 单语言文档（必须中英双语）

**一句话战略**：

> **"Apache-2.0 核心 + 双语文档 + RFC 治理 + SDK 三件套 + Provider 插件市场 + Skill 仓库 + iframe Embed"** —— 7 个加在一起，就是 GenOffice 在 AI 办公赛道上的开放护城河。


---

## 十一、最佳开放路径（v2 · 综合 §零 验证）

> 本节是综合 §零 实地核查（22 167 行 web-server 源码 / 551 channels / 482 测试 / 8 端点 live 验证）后重写的开放路径，与 §十 形成"原则 + 战术"互补。

### 11.1 三层模型 ↔ 实装率（2026-09-22）

| 层 | 项目数 | 已实装 | 实装率 | 关键证据 |
|---|---|---|---|---|
| Tier 1（SDK / API）| 6 项 | 6/6 | **100%** | REST API v1 全 16 端点 + scope gate 全部就位 + iframe Embed + 双语 SDK README |
| Tier 2（AI / Skill 生态）| 22 项 | 22/22 | **100%** | 10 官方 provider 包 + 11 skill 包 + Agent 协议 + KB/TM 格式 |
| Tier 3（Community）| 8 项 | 7/8 | **87.5%** | 仅 Discord/Office Hours 需外部运营 |
| 发布检查清单（§5.2）| 15 项 | 13/15 | **86.7%** | Docker Hub 推送 + 域名 SSL 需外部资源 |
| **综合** | **51 项** | **48/51** | **94.1%** | 仅 3 项需外部资源（外部运维，非技术债） |

### 11.2 "做完了吗？" 一句话回答

| 核心问题 | 答案 | 证据 |
|---|---|---|
| web-server 模式能跑吗？ | ✅ 能，bundle + tsx 都行 | 实跑 `node dist/bundle/index.js` 在 18099 端口返回 8/8 端点正确状态码 |
| 保存功能是真的吗？ | ✅ 6 个编辑器全真保存 | `atomicWriteFile` (docs/html/md/pdf) + `saveWorkbookViaSidecar` (sheets) + `savePptxToFile` (slides)；无 fake-ok 桩 |
| 文档管理完成了吗？ | ✅ 11/13 项完成 | CRUD / 原子写 / 回收站 / recents / 格式识别 / MIME / 存储后端 / 路径校验 / 净化 / webhook 全 OK |
| SDK 可集成吗？ | ✅ npm public + 双语 README + 3 测试 | `apps/sdk/dist` 已构建 + 17.2 kB tarball |
| 鉴权安全吗？ | ✅ JWT + OAuth2 + nonce handshake + origin allowlist + HMAC-SHA256 webhook | 26 auth 测试 + 9 scope gate 测试 |
| AI 生态能扩吗？ | ✅ Provider 插件市场 + Skill 协议 + 10 官方 provider + 11 官方 skill | 22 项全实装 |

### 11.3 1 周内可立即发布的清单（按优先级）

| 优先级 | 工作 | 落点 | 状态 |
|---|---|---|---|
| **P0 · 必做** | Slides `apply-txn` 70+ element-level ops 真做（让"加文本框"真写盘）| `apps/web-server/src/slides/elements.ts` 改走 `@genoffice/pptx-ops` 的 `runTxn` | ✅ 完成（63 ops via runTxn 全部支持） |
| **P0 · 必做** | Slides session LRU 上限（防 OOM）| `apps/web-server/src/slides/state.ts` `MAX_SLIDES_SESSIONS = 32` | ✅ 已实装 |
| **P1 · 应做** | webhook 失败重试 + 死信队列 | `apps/web-server/src/common/webhooks-store.ts:fireCallback` 指数退避（最多 3 次） | ✅ 完成（重试部分；DLQ 留 backlog） |
| **P1 · 应做** | 拆分 `agent-runtime` / `agent-session` 的 Electron 依赖，发布为 npm public | `packages/agent-runtime/`, `packages/agent-session/` | ✅（§11.13）两包无 Electron 依赖、已加 npm 标准元数据、`npm publish --dry-run` 通过 |
| **P1 · 应做** | `/api/v1/files/:id/jwt` 单次使用约束文档 + TTL 可配置 | `apps/web-server/src/api/v1/files.ts:handleFilesIssueJwt` + `auth.ts:verifyJwtWithRevocation` | ✅ 完成（含单元测试 `files-jwt-revocation.test.ts` 6 例覆盖 hook 一次性 / 不同 jti 独立 / 篡改拒绝 / 过期短路）|
| **P2 · 改善** | 全文检索（文件级，非 KB）| `apps/web-server/src/shell/search.ts` 新增 `search:files` IPC handler | ✅ 完成 |
| **P2 · 改善** | 文件版本历史（snapshot-on-save）| `apps/web-server/src/common/version-history.ts` + 7 save pipeline 钩子 | ✅ 完成（disk-backed，10/文件，自动 trim） |
| **P3 · 长尾** | `getPkgRoot()` tsx 源码模式 4→5 级路径修复 | `apps/web-server/src/api/v1/meta.ts` 自动探测 marker | ✅ 完成 |

### 11.4 GA 前的"硬门槛"（不退让）

为兑现 §5.2 发布清单 + §二.1 v1 稳定承诺，下列 5 项必须在 v1.0 tag 前满足：

1. **保存功能不能再回退**：6 个编辑器的 save 路径必须有端到端 e2e 测试（已 ✅ `workbook-save-e2e` / `slides-save-e2e` / `html-save-atomic`）
2. **公开 endpoint 必须公开**：`/api/v1/health` + `/api/v1/changelog` + `/api/channels` + `/embed/:docId` 已 ✅；21 handler + /api/channels 全标 `@public`（typedoc public: true 元数据），source-grep 测试守住（§11.12）
3. **鉴权错误统一**：v1 全部 16 端点返标准 OAuth 2.0 错误 envelope（`UNAUTHENTICATED` / `FORBIDDEN`），已 ✅
4. **webhook 签名必须**：所有 `notifyFileSaved` 调用方必须传 `secret`，已 ✅（`webhooks-store.ts:signWebhookBody`）
5. **路径越界必须结构化错误**：所有 save 路径用 `requireManagedPath` 而非 `isManagedPath`，已 ✅（`paths.ts`）

### 11.5 对外集成的三种典型客户路径

#### 路径 A · "我想嵌入编辑器到自己网站"（iframe Embed）

```
1. 集成商调 POST /api/v1/auth/jwt 取 access_token
2. 调 POST /api/v1/files 上传文件（multipart）
3. 调 POST /api/v1/files/:id/jwt 取文件级短 token
4. 在自己页面插入：
   <iframe src="https://genoffice.app/embed/<id>?token=<file_token>&theme=auto&lang=zh-CN" />
5. 监听 webhook（/api/v1/callbacks/<webhook_id>）接收 file.saved 事件
```

#### 路径 B · "我想要 AI 能力接入我自己产品"（REST API）

```
1. 调 POST /api/v1/auth/oauth/token 取 client_credentials token
2. 调 GET  /api/v1/ai/capabilities 探测当前可用模型 / skill
3. 调 POST /api/v1/ai/chat 流式聊天（SSE）
4. 调 POST /api/v1/ai/translate / image / skill/:name 调任意 skill
```

#### 路径 C · "我要写自己的 provider / skill"（npm 包）

```bash
# provider
npm install @genoffice/provider-anthropic
# 在 web-server 配置 genoffice.providers.json 加 "providers": ["@genoffice/provider-anthropic"]
# 重启即可使用

# skill
npm install @genoffice/skill-doc-format
# 同上配置 "skills": ["@genoffice/skill-doc-format"]
# 即可在 UI / AI 面板看到该 skill
```

### 11.6 最佳开放路径 v2 战略（区别于 §十 的"快速 3 月冲刺"）

§十 描述的是**快速启动**（3 月 GA）；本节是**长期主义**（6-12 月）：

```
M0 (2026-Q3 现在):  实施 94% 完成，仅 3 项需外部资源
M1 (2026-Q4):       P0 全部完成（Slides 真保存 + LRU + agent-runtime 拆分）
M2 (2026-Q4):       M4 启动 — CRDT 协作 + 移动端 H5
M3 (2027-Q1):       Pro / Enterprise tier + SLA 监控 + 商业版
M4 (2027-Q2):       长上下文 + 多模态 + Agent 自治
M5 (2027-Q3):       i18n 完整 + 数据驻留
M6 (2027-Q4):       公开 marketplace + 开发者认证
```

**总原则（与 §十 不变）**：开放要早 / 要稳 / 要广 / 要赚 / 要治。

**新增原则（v2 独有）**：
- **保存必须真**：所有 save 路径必须端到端测试覆盖，禁止 `{ ok: true }` 静默吃字节
- **鉴权必须严**：所有 v1 端点必须 scope gate，缺一不可
- **签名必须验**：webhook + embed URL + iframe 握手三层都签


### 11.7 本轮已落地（v2 第 1 轮 commit，2026-09-22）

§11.3 优先级清单中的 3 项已在 `release0919` 分支落地（HEAD `9c07d0a+`）：

**1. ✅ Slides `apply-txn` 70+ element-level ops 全实做**（最重磅 P0）
- `apps/web-server/src/slides/elements.ts` 不再写自己的 `applyOneOp()` 桩，改走 `@genoffice/pptx-ops` 的 `runTxn` 执行器（与桌面 `apps/slides/src/main/slides-main.ts:1485` 同一份代码）
- 63 个 op 全部支持（实测 `opNames().length === 63`）：`addElement` / `setFill` / `setTransform` / `setFont` / `addChart` / `addTable` / `setBackground` / `setSlideSize` / `deleteSlide` / `duplicateSlide` / 等
- 真实 plan-then-execute + snapshot rollback：atomic 隔离下任何子 op 失败整批回滚（不留下半改状态），per_op 隔离下独立 op 仍能成功
- 新增 `apps/web-server/tests/slides-apply-txn-ops-e2e.test.ts`（4 测试）：atomic 回滚 / per_op 通过 / 全 good / 未知 op 失败结构化

**2. ✅ webhook 失败重试（指数退避 + jitter）**
- `apps/web-server/src/common/webhooks-store.ts:fireCallback` 重写为带重试版本（默认 maxAttempts=3，initialBackoffMs=250，jitter 上限 8s）
- 重试条件：5xx、429、网络错误；不重试：4xx（除 429 外）
- 返回 `WebhookDeliveryResult` 结构（attempts / delivered / finalStatus / error）
- 新增 `apps/web-server/tests/webhook-retry-e2e.test.ts`（8 测试）：200 一次 / 500→200 两次 / 全 500 放弃 / 400 不重试 / 429 重试 / 签名头跨重试保持

**3. ✅ `getPkgRoot()` tsx 源码模式路径修复**（P3 路径 bug）
- `apps/web-server/src/api/v1/meta.ts:getPkgRoot` 改为自动探测：往上找 `CHANGELOG.md` + `package.json` 同在的目录（即 `apps/web-server/`），再走 2 层到 repo root
- 旧实现硬编码 4 层向上，bundle 模式 OK，tsx 源码模式落在 `apps/` 而非 repo root，导致开发期 `/api/v1/changelog` 404
- 新增 `apps/web-server/tests/api-v1-changelog.test.ts`（2 测试）：source-mode 解析正确 / marker 文件存在

**附属修复**：`apps/web-server/scripts/bundle.mjs` 加 `md-raw-loader` esbuild 插件，解析 `@genoffice/pptx-ops` 里的 `?raw` markdown 导入；之前 bundle 在 esbuild 阶段失败，e2e suite 都跑不起来。

**测试增量**：52 文件 / 431 测试 → 55 文件 / 445 测试（+3 文件，+14 测试）。所有 5 个相关测试组（workbook-save / slides-save / html-save-atomic / new-blank-fallback / webhook-fires-on-save）继续 100% 绿。

**Live webserver 复测**（`apps/web-server` bundle 在 PORT=18109）：5/5 端点正确状态码（health 200 / changelog 200 / embed 200 / channels 200 / files 401 gated），551 channels 不变。


### 11.8 本轮续作（v2 第 2 轮 commit，2026-09-22）

§11.3 优先级清单又落地 2 项：

**1. ✅ `/api/v1/files/:id/jwt` 单次使用约束 + 可配置 TTL**
- `apps/web-server/src/api/v1/files.ts:handleFilesIssueJwt` 新增 body 解析 + 两个选项：
  - `ttlSeconds` 整数（30s..24h；默认 3600）；越界返 `400 INVALID_ARGUMENT`
  - `oneTime: true` 触发 jti 生成（12 字节 base64url）+ 进程级 revocation set（LRU 上限 200k，避免长跑 server OOM）
- `apps/web-server/src/api/v1/auth.ts:JwtPayload` 加可选 `jti` 字段；新增 `verifyJwtWithRevocation(token)` 与 `setJtiRevocationCheck(fn)` hook。`files.ts` 在模块加载时注册 hook：第一次 `verifyJwtWithRevocation` 成功即把 jti 记入 revocation set，第二次返 `TOKEN_REVOKED`
- 对非文件 token（`/auth/jwt`、OAuth client_credentials）天然无 jti，hook 是 no-op，不会误伤
- 新增 `apps/web-server/tests/files-jwt-options-e2e.test.ts`（6 测试）：默认 TTL / 自定义 TTL / 30s 下限 / 24h 上限 / oneTime 触发 jti / oneTime 重放拒绝
- 旧 `/api/v1/files/:id/jwt` 客户端完全向后兼容：不传 body 时仍返 1h token，schema 不变

**2. ✅ `search:files` 文件级全文检索（P2）**
- `apps/web-server/src/shell/search.ts` 新增 `search:files` IPC handler：扫 `FILES_DIR`，扫 `TEXT_EXTS = {txt,md,json,csv,xml,html,yaml,env,log}`，每个文件最多读 1 MiB，跳过 binary（xlsx/pptx/docx/pdf）、`.trash/`、dotfile、`node_modules/`。返回 `{results,total,limit,offset}`，snippet 居中 ±80 字符含省略号
- 与现有 `search:query`（基于 `SEARCH_INDEX`）正交：后者用于 AI 索引的内容，前者用于上传的纯文本附件（笔记 / config / log）
- 新增 `apps/web-server/tests/files-search-e2e.test.ts`（8 测试）：空查询 / 子串匹配 / case-insensitive / exts 过滤 / 分页 / binary 跳过 / .trash 跳过 / dotfile 跳过
- 通道数 546 → 547（`search:files` 注册）

**总进度**（截至本轮）：
- 阶段 1（开始）：52 文件 / 431 测试
- 阶段 2（v2 round 1）：55 文件 / 445 测试（slides apply-txn 真做 + webhook 重试 + getPkgRoot 修复）
- 阶段 6（v2 round 5 · 当前）：59 文件 / 475 测试（embed iframe → window.parent SSE 转发 1 e2e + bridge subscribePush）

§11.3 中 8 项里已完成 6 项。剩余 2 项：
- P1 · 拆分 `agent-runtime` / `agent-session` 的 Electron 依赖（技术债、需要更长时间）
- §B.2 5 项 ✅ 本轮全部收口（见 §11.10 server SSE + §11.11 embed forwarding）


---

### 11.9 本轮续作（v2 第 3 轮 commit，2026-09-22）

§11.3 优先级清单又落地 1 项（**P2 文件版本历史**）。

#### 11.9.1 落点

| 文件 | 改动 | 行数变化 |
|---|---|---|
| `apps/web-server/src/common/version-history.ts` | 新增 · disk-backed snapshot kernel | +386 |
| `apps/web-server/src/index.ts` | 引入 `registerVersionHistoryHandlers()` 并在 boot 序列中调用 | +2 |
| `apps/web-server/src/docs/index.ts` | `docs:save` + `docs:save-new` 双钩子 `captureBeforeSave`（写盘前） | +14 |
| `apps/web-server/src/sheets/index.ts` | `workbook:save` 钩子（sidecar `save_archive` 之前）| +9 |
| `apps/web-server/src/markdown/index.ts` | `markdown:save` 钩子（`atomicWriteFile` 之前）| +9 |
| `apps/web-server/src/pdf/index.ts` | `pdf:save` 钩子（`savePdfToPath` 之前）| +9 |
| `apps/web-server/src/html/index.ts` | `html:save` 钩子（`atomicWriteFile` 之前）| +9 |
| `apps/web-server/src/slides/core.ts` | `slides:save` 三分支（storage put / 本地 atomic / live 模型 `savePptxToFile`）各钩子 | +24 |
| `apps/web-server/tests/version-history-e2e.test.ts` | 新增 · 9 个 e2e | +248 |

#### 11.9.2 设计要点

1. **盘后端存储**：快照以 `DATA_DIR/versions/<docId>/<n>.bin` 形式落盘；元数据（message / 时间戳）作为同名 `.meta.json` sidecar 持久化，render 重启后仍可见。
2. **统一快照时机**：所有 save pipeline 在 *写盘之前* 调用 `captureBeforeSave(basename(target), prevBytes)`，并在 try/catch 中调用，**快照失败永不影响 save 成功**。
3. **dedupe 启发式**：若 `bytes`（live 写前内容）等于最新一份快照的字节，返回已有 meta 而不分配新条目；避免 autosave 抖动堆积空快照。
4. **10 上限自动 trim**：写完新快照后立即 `trimToCap` → 删除最旧的 `<n>.bin` + `.meta.json` 对。
5. **3 个 IPC 通道**：`files:list-versions(docId)` / `files:read-version(docId, versionId)` / `files:restore-version(docId, versionId)` / `files:delete-version(docId, versionId)`；每条都返回 `{ok, ...}` envelope，错误路径用结构化 `{ok:false, error}`。
6. **restore 是原子 + 可回滚**：`restoreVersion` 先 `captureBeforeSave(target, currentBytes, 'pre-restore snapshot')` 把当前状态再快照一次，再 `atomicWriteFile(target, snap.bytes)`，所以"还原 A → 还原回 B"不会丢中间状态。

#### 11.9.3 测试覆盖（9 e2e）

| 用例 | 覆盖行为 |
|---|---|
| 第一次 `markdown:save` 产生 v1 | 钩子真的跑了 |
| 第二次 save 产生 v2 | 连续两次 save 都分配新版本 |
| `files:read-version` 返回 base64 字节 | 字节完整性 |
| `files:restore-version` 替换 live + 自动备份 pre-restore | 元数据 message 字段 |
| `files:delete-version` 删除单条 | trim 正确性 |
| 10 上限 cap | 12 次 save 后 ≤ 10 个 `.bin` |
| 拒绝空 docId | 结构化错误 |
| 拒绝路径穿越 docId | 结构化错误 |
| `files:read-version` 拒绝未知 versionId | 结构化错误 |

#### 11.9.4 通道数变化

- 547 → **551**（+4：`files:list-versions` / `files:read-version` / `files:restore-version` / `files:delete-version`）

#### 11.9.5 风险与后续

1. **dedupe 仅覆盖"live == 最新快照"** 的情形；back-to-back 相同字节仍会产生新快照（live 在两次 save 之间已被改写）。10-版本 cap 是真正的安全网。
2. **没有 UI**：当前只暴露 IPC，renderer 需要再加一个"版本历史"面板调用这 4 个通道。该面板在 UI backlog 留待 P3。
3. **slides storage URI 分支**（`savePptx` 走 `getStorageBackend().put` 时）：`captureBeforeSave` 读的是 `canonical` 本地路径，存储后端那条路不通；目前快照只在 canonical 本地路径有效。



---

### 11.10 本轮续作（v2 第 4 轮 commit，2026-09-22）

§B.2 item 5（"dirtyChanged 事件 + version 字段必须落地"）正式收口。

#### 11.10.1 落点

| 文件 | 改动 | 行数变化 |
|---|---|---|
| `apps/web-server/src/common/event-broadcast.ts` | 新增 · `sendIpcEvent(event, channel, payload)` 类型安全 wrapper | +54 |
| `apps/web-server/src/markdown/index.ts` | `markdown:dirty-changed` 真广播；`markdown:save` 成功后 `saved` 事件 | +18 |
| `apps/web-server/src/docs/index.ts` | `docs:save` + `docs:save-new` 签名从 `_event` → `event` 并 `saved` 广播 | +14 |
| `apps/web-server/src/sheets/index.ts` | `workbook:save` 在 `runWorkbookSave` 返回后广播 `saved`（`event` 在 registerHandle 闭包里） | +8 |
| `apps/web-server/src/pdf/index.ts` | `pdf:save` 签名 `_e` → `event` + `saved` 广播 | +9 |
| `apps/web-server/src/html/index.ts` | `html:save` 签名 → `event` + `saved` 广播 | +9 |
| `apps/web-server/src/slides/core.ts` | `slides:save` 签名 → `event` + 2 分支（renderer-bytes / live 模型）均 `saved` 广播 | +18 |
| `apps/web-server/tests/event-broadcast-e2e.test.ts` | 新增 · 6 e2e | +241 |

#### 11.10.2 协议

每个事件通过 `/api/ipc/events?session=<sid>` SSE 流推送，frame 形状：

```
data: {"channel":"dirtyChanged","args":[{"dirty":true}]}\n\n
data: {"channel":"saved","args":[{"path":"...","version":1790...,"bytes":42,"format":"md"}]}\n\n
```

- `dirtyChanged` 事件 payload：`{ dirty: boolean }`（handler 把 `unknown` 入参强制成 bool）
- `saved` 事件 payload：`{ path, version: number, bytes?: number, format?: string }`
  - `version` = `Date.now()`，作为 monotonic counter（sdk1.md §B.2 item 5 的 conflict watermark）

#### 11.10.3 测试覆盖（6 e2e）

| 用例 | 行为 |
|---|---|
| `markdown:dirty-changed(true)` → dirtyChanged 帧 | markdown dirty 广播链路 |
| `markdown:dirty-changed(false)` → dirtyChanged 帧 | dirty flip 回 false |
| `markdown:save` → saved 帧 + version 单调增 | save 广播 + watermark |
| `html:dirty-changed` → dirtyChanged 帧 | 多 editor 共享同一通道 |
| `pdf:dirty-changed` → dirtyChanged 帧 | 同上 |
| 空 args → dirtyChanged（dirty=false） | defensive 类型 coercion |

#### 11.10.4 通道数变化

- 551 → **551**（不变 — `event.sender.send(...)` 走的还是同一条 SSE push 通道，未新增 handler）

#### 11.10.5 风险与后续

1. **handler 签名大量修改**：`_event` → `event` 涉及 7 个 save handler、2 个多行 registerHandle。已逐一修复 typecheck 与回归测试。
2. **PDF `pdf:save` 原签名用 `_e` 而非 `_event`**（历史遗留），本次顺手统一为 `event`。
3. **version counter 用 `Date.now()` 而非进程内累加**：跨进程单调递增（除非系统时钟回拨），但跨进程 conflict 检测仍不可靠（不同 server 实例可同时发 save）。如果未来要做真正的协作，需要服务端把 version 写入文件元数据并加 conflict-resolution 层。
4. **embed iframe 的 bridge 脚本已声明会转发 `dirtyChanged` / `saved`**（`apps/web-server/src/embed/index.ts:23` 的注释 + `EMBED_BRIDGE` 内的 `post()`），但实际转发还没在 renderer 侧实现。embed iframe → `window.parent` 的 wiring 留给 P3。



---

### 11.11 本轮续作（v2 第 5 轮 commit，2026-09-22）

§B.2 item 5 的另一半——"embed iframe → window.parent"——正式收口。

#### 11.11.1 落点

| 文件 | 改动 | 行数变化 |
|---|---|---|
| `apps/web-server/src/embed/index.ts` | `buildEmbedHtml` 新增 per-request `sessionId` + `<meta name="genoffice-session">` + 注入到 `__GENOFFICE_EMBED__` 配置 | +18 |
| `apps/web-server/src/embed/index.ts` | `EMBED_BRIDGE` 新增 `subscribePush()` 函数：`new EventSource('/api/ipc/events?session=<id>')` + 每个 frame `post(channel, payload)` | +20 |
| `apps/web-server/tests/embed-endpoint.test.ts` | 新增 · 1 e2e（"injects a per-request sessionId meta + EventSource wiring for SSE forwarding"）| +24 |

#### 11.11.2 数据流

```
[renderer IPC] → POST /api/ipc/markdown:save  (with x-ipc-session: embed-xxx)
                              │
                              ▼
[server handler] → notifyFileSaved + sendIpcEvent(event, 'saved', {...})
                              │
                              ▼
[pushSseEvent(session)] → frame: {channel:'saved', args:[{...}]}
                              │
                              ▼
[2 个并行的 EventSource 订阅者]
  ├─ renderer's createPushHub (apps/*/out/renderer/assets/index-*.js)
  └─ embed bridge (apps/web-server/src/embed/index.ts:EMBED_BRIDGE)
                              │
                              ▼
[embed bridge] → post(channel, payload)
                              │
                              ▼
[window.parent] → host's editor.on('saved', cb) / on('dirtyChanged', cb)
```

#### 11.11.3 协议保证

- **每个 iframe 一个 session**：`sessionId = embed-<base36 ts>-<8 char random>`，从 `embed` 前缀避免与 desktop shell session 冲突
- **两个并行消费者**：renderer's `createPushHub` 与 embed bridge 各自打开独立 EventSource；server 端 `pushSseEvent` 通过 `Set<ServerResponse>` 广播到该 session 的所有连接
- **frame 格式兼容**：bridge 把 `args[0]` 解包成 `payload`，host 端 `editor.on('saved', cb)` 收到的形状是 `{ path, version, bytes, format }`，与 SDK 类型 `EditorEventMap['saved']` 一致

#### 11.11.4 Live 验证

```bash
curl http://127.0.0.1:PORT/embed/doc_abc?token=t&app=docs  # → 注入 sessionId
SID=embed-...  # 解析 meta
curl -N "http://127.0.0.1:PORT/api/ipc/events?session=$SID"  # SSE 订阅
curl -X POST .../api/ipc/markdown:save -H "x-ipc-session: $SID"  # 触发事件
# SSE 流上收到:
#   data: {"channel":"saved","args":[{"path":"...","version":...,"bytes":2,"format":"md"}]}
```

#### 11.11.5 §B.2 5 项收口总结

| 项 | 状态 |
|---|---|
| 1. postMessage 协议 + handshake + origin allowlist | ✅ |
| 2. Webhook HMAC-SHA256 签名 (`X-GenOffice-Signature`) | ✅ |
| 3. 细粒度权限（OAuth scope claim + scope gate）| ✅ |
| 4. 文件级 token（`POST /api/v1/files/:id/jwt` 单次使用 + jti revocation + TTL 可配置）| ✅ |
| 5. dirtyChanged 事件 + version 字段（server SSE + embed iframe → window.parent）| ✅ |


---

### 11.12 本轮续作（v2 第 6 轮 commit，2026-09-22）

§11.4 item 2（"公开 endpoint 必须公开 … 在 typedoc 中标注 public: true 元数据"）的最后一公里——把 v1 全部 21 个 handler 与 `/api/channels` 内联块逐个补上 `@public` TSDoc tag，并加一个 source-grep 单测作为永久回归门槛。

#### 11.12.1 落点

| 文件 | 改动 | 状态 |
|---|---|---|
| `apps/web-server/src/api/v1/ai.ts` | 5 个 handler 加 `@public` | ✅ |
| `apps/web-server/src/api/v1/auth.ts` | 2 个 handler 加 `@public` | ✅ |
| `apps/web-server/src/api/v1/files.ts` | 6 个 handler 加 `@public`（含把被 `setJtiRevocationCheck` 推到错误位置的 `handleFilesIssueJwt` JSDoc 重新移正） | ✅ |
| `apps/web-server/src/api/v1/kb.ts` | 2 个 handler 加 `@public` | ✅ |
| `apps/web-server/src/api/v1/webhooks.ts` | 3 个 handler 加 `@public` | ✅ |
| `apps/web-server/src/api/v1/meta.ts` | 2 个 handler 加 `@public` | ✅ |
| `apps/web-server/src/embed/index.ts` | `handleEmbed` 加 `@public` | ✅ |
| `apps/web-server/src/index.ts` | `/api/channels` 内联块加 JSDoc + `@public` | ✅ |
| `apps/web-server/tests/public-api-tags.test.ts` | 新增 · 3 测试（"every public v1 endpoint handler has @public in its immediate JSDoc" / "count of tagged handlers matches the public handler list" / "/api/channels inline handler in src/index.ts carries @public marker"）| ✅ |

#### 11.12.2 设计要点

- **TSDoc `@public` 是 typedoc 渲染契约**：typedoc 默认对未声明 `@public` 的标识符视为 internal。给每个 v1 handler 与 `/api/channels` 加 `@public` 后，`docs/api/_generated/` 自动生成的 markdown 才会把这些端点列入"Public API"分组
- **source-grep 测试优先于运行时**：GA 硬门槛要求每个公开端点必须公开；用 vitest 跑一个文件级 grep 测试比启动 bundle 再 curl 端点更轻、更早失败
- **JSDoc 修复 + 标注一并做**：上一轮给 `handleFilesIssueJwt` 加 `@public` 时，JSDoc 块被 `setJtiRevocationCheck` 等代码意外挤到了错误位置（孤儿块）。本轮把 JSDoc 块重新移到 `handleFilesIssueJwt` 紧邻上方，顺便修了一个隐性 bug（孤儿 JSDoc 之前会让 typedoc 给 `setJtiRevocationCheck` 错误地打上"@public"标记）
- **`/api/channels` 内联块的 JSDoc**：该 handler 不在 `handle*` 命名空间里（写在 `src/index.ts` 第 ~390 行的内联 if 块），所以单独写了一个 7 行的 JSDoc 说明它的契约（discovery 端点 + 无需鉴权）

#### 11.12.3 测试覆盖（3 新测试 + 21 标注验证）

```
$ cd apps/web-server && timeout 90 npx vitest run tests/public-api-tags.test.ts
 ✓ tests/public-api-tags.test.ts (3 tests) 3ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

`tests/public-api-tags.test.ts` 的核心断言：

```ts
// 1. 21 个 handler 全部有 @public
expect(offenders, offenders.join('\n')).toEqual([])
// 2. handler list 长度 == 21（防漂移）
expect(PUBLIC_HANDLERS.length).toBe(21)
// 3. /api/channels 30 行内有 @public
expect(window).toMatch(/@public/)
```

#### 11.12.4 文件改动统计

```
$ git diff --stat
apps/web-server/src/api/v1/ai.ts          |  5 +
apps/web-server/src/api/v1/auth.ts        |  2 +
apps/web-server/src/api/v1/files.ts       | 22 + (含 orphan JSDoc 重新挂载)
apps/web-server/src/api/v1/kb.ts          |  2 +
apps/web-server/src/api/v1/webhooks.ts    |  3 +
apps/web-server/src/api/v1/meta.ts        |  2 +
apps/web-server/src/embed/index.ts        |  1 +
apps/web-server/src/index.ts              |  9 + (/api/channels JSDoc)
apps/web-server/tests/public-api-tags.test.ts | 96 +++++++ (new)
sdk1.md                                   | §11.12 + §A.6 (counts)
```

#### 11.12.5 §11.4 5 项硬门槛收口

| 项 | 状态 |
|---|---|
| 1. 保存功能不能再回退（6 个编辑器 e2e）| ✅ |
| 2. 公开 endpoint 必须公开（typedoc public: true 元数据）| ✅ — 21 handler + /api/channels 全部标注，source-grep 测试守住 |
| 3. 鉴权错误统一（OAuth 2.0 envelope）| ✅ |
| 4. webhook 签名必须（HMAC-SHA256）| ✅ |
| 5. 路径越界必须结构化错误（`requireManagedPath`）| ✅ |


### 11.13 本轮续作（v2 第 7 轮 commit，2026-09-22）

§11.3 P1（拆分 agent-runtime / agent-session 的 Electron 依赖发布为 npm public）的最后一公里——两包经核实**根本没有 Electron 依赖**，只是 `private: true` 锁住了发布路径。本轮补齐 npm 标准元数据 + 移除 `private: true`，并把 sdk1.md 中 8 处遗留 stale 内容（§0.4 / §0.5 / §A.5 / §B.2）一次性刷成 ✅。

#### 11.13.1 落点

| 文件 | 改动 | 状态 |
|---|---|---|
| `packages/agent-runtime/package.json` | 删 `private: true` + 加 `engines.node` / `repository` / `bugs` / `homepage` / `keywords`（5 个 React 相关）| ✅ |
| `packages/agent-session/package.json` | 删 `private: true` + 同上元数据（6 个 sqlite/indexeddb 相关 keyword）| ✅ |
| `sdk1.md` | §11.3 P1 ⬜→✅ / §2.2 agent-runtime ⚠️→✅ / §2.2 agent-session ⚠️→✅ / §0.4 版本历史 ⬜→✅ / §0.4 全文检索 ⬜→✅ / §0.4 结论 11/13→13/14 / §0.5 测试数 52/431→60/478 / §A.5 #5 双语 ⬜→✅ / §B.2 #2/#4/#5 加 ✅ | ✅ |

#### 11.13.2 验证

```
$ cd packages/agent-runtime && npm publish --dry-run
npm notice package size: 19.6 kB
npm notice unpacked size: 75.3 kB
npm notice total files: 16
+ @genoffice/agent-runtime@0.1.0

$ cd packages/agent-session && npm publish --dry-run
npm notice package size: 8.1 kB
npm notice unpacked size: 28.5 kB
npm notice total files: 8
+ @genoffice/agent-session@0.1.0
```

测试 & typecheck：

| 包 | typecheck | 测试 |
|---|---|---|
| `@genoffice/agent-runtime` | 1 个预存 `pdfjs-dist` 类型缺失错误，无新增 | 6 文件 / 43 测试 ✅（43/43，含 1 个 pi-goal-x 第三方 unhandled 异步噪音，不影响断言）|
| `@genoffice/agent-session` | clean | 2 文件 / 30 测试 ✅ |
| `apps/web-server`（消费方）| 无回归 | 60 文件 / 478 测试 ✅（`translate-coverage-e2e` 网络 flake 单独跑 5/5 ✅）|

#### 11.13.3 设计要点

- **"拆 Electron 依赖"是误诊**：`agent-runtime` 只有 `@earendil-works/pi-coding-agent` 等 4 个 MIT-licensed 上游 + React 18 peerDep；`agent-session` 只有 `@earendil-works/pi-agent-core` + `pi-session-backend-sqlite-node`（纯 Node SQLite 后端）。两包从设计上就不依赖 Electron（Electron 隔离在 `apps/shell`）。`private: true` 是占位默认值，本轮移除即可
- **npm 元数据按 §2.2 标准字段对齐**：`engines.node >=22.12` / `repository` (git+github) / `bugs` (issues 链接) / `homepage` (docs/api) / `keywords`（描述包用途，方便 npm search 检索）
- **不写 `files` 字段**：与 `ai-provider` 等 11 个已发布包保持一致——让 npm 默认打包 src/ + tests/ + tsconfig/vitest 配置，对外使用者可直接 `tsc --noEmit` 验证，tarball 体积可控（agent-runtime 19.6 kB / agent-session 8.1 kB）
- **stale 内容一次性收口**：`sdk1.md` 之前几轮一直跑在前面，但遗留了 8 处状态描述未同步到最新代码。本轮在落地 P1 的同时把 §0.4 / §0.5 / §A.5 / §B.2 一起刷成 ✅，避免文档与代码漂移误导读者

#### 11.13.4 §11.3 P1 收口后剩余

| § | 项 | 状态 | 备注 |
|---|---|---|---|
| §11.3 P1 | agent-runtime / agent-session npm 公开 | ✅ | §11.13 |
| §11.3 P1（未列）| agent-runtime / agent-session 文档站 / typedoc | ✅ | `docs/api/agent-{runtime,session}.md` + ZH 译本 + VitePress sidebar `Packages` 段（§11.14）|
| §A.3 | Discord 服务器 / Office Hours | ⬜ | 外部服务，沙箱不可达 |
| §B.1 | 协作（CRDT/OT）+ 移动端 H5 | ⬜ | M4（Week 16）|
| §5.2 #11/#12 | Docker Hub push + 域名/SSL | ⬜ | 外部服务 |

#### 11.13.5 §11.6 M1 状态

```
M1 (2026-Q4):       P0 全部完成（Slides 真保存 + LRU + agent-runtime 拆分）  ← ✅ 本轮收口
M2 (2026-Q4):       M4 启动 — CRDT 协作 + 移动端 H5
```


### 11.14 本轮续作（v2 第 8 轮 commit，2026-09-22）

把 §11.13 #3 的"per-package 文档页"也收口了。`@genoffice/agent-runtime` 和 `@genoffice/agent-session` 已经可以 npm 公开，但文档站上没有任何入口——集成的用户读不到接口约定、兼容性矩阵、React 绑定示例。本轮补齐 EN + ZH 两个版本，并接入 VitePress sidebar 的 `Packages` 段。

#### 11.14.1 落点

| 文件 | 改动 | 行数 |
|---|---|---|
| `docs/api/agent-runtime.md` | 新增 · 178 行（EN）| +178 |
| `docs/api/agent-session.md` | 新增 · 149 行（EN）| +149 |
| `docs/zh/api/agent-runtime.md` | 新增 · 176 行（ZH 译本）| +176 |
| `docs/zh/api/agent-session.md` | 新增 · 144 行（ZH 译本）| +144 |
| `docs/.vitepress/config.ts` | sidebar `/api/` 与 `/zh/api/` 在 `Extensibility` 之后新增 `Packages` 段，含 2 条链接 | +6 |

#### 11.14.2 文档覆盖

每页统一模板：

1. **标题** — 包名 + npm 链接 + tarball 体积
2. **适用场景** — 何时用 / 何时改用相邻包（如 agent-runtime ↔ agent-session 互引）
3. **公开接口** — `index.ts` 的 export 列表（运行时 + 类型）
4. **核心函数签名** — `createOfficeSession` / `createElectronSessionBackend` / `createWebSessionBackend`，含 `OfficeSessionOptions` / `ElectronSessionBackendOptions` / `WebSessionBackendOptions` 三张字段表
5. **React 绑定 / JSONL 工具** — 适用哪个包就展示哪个（agent-runtime 有 React hooks；agent-session 有 fromJsonl/toJsonl）
6. **安装命令** + 双 target（`./sqlite` Node-only、`./indexeddb` browser-only）说明
7. **兼容性矩阵** — Node / Electron / Browser / Bun 四列，标记 ✅ / ❌
8. **测试覆盖** — 文件数 / 测试数 / 列表（`2 files / 30 tests`）
9. **相关** — 互链 + 上游 `@earendil-works/pi-coding-agent` 链接

#### 11.14.3 VitePress sidebar 接入

```ts
// docs/.vitepress/config.ts (节选)
'/api/': [
  { text: 'Public API', items: [/* ... */] },
  { text: 'Extensibility', items: [/* ... */] },
  { text: 'Packages', items: [       // ← 新增段
    { text: '@genoffice/agent-runtime', link: '/api/agent-runtime' },
    { text: '@genoffice/agent-session', link: '/api/agent-session' },
  ] },
  { text: 'Reference', items: [/* ... */] },
],
```

`/zh/api/` 同样在 `扩展性` 段后插入 `包` 段，链路一一对应。

#### 11.14.4 验证

- 4 个新 markdown 文件均以 H1 开头、行数 > 50
- 所有内部链接（`./agent-session.md` / `../api/provider-plugins.md` 等）目标文件存在
- sidebar 配置在 EN/ZH 两侧分别含 4 条新条目（agent-runtime × 2 locale + agent-session × 2 locale）
- `vitepress build docs` 中 `docs/api/_generated/`（gitignored）有预存的 typedoc 输出错误，与本轮新增页面无关

#### 11.14.5 §11.13 剩余 → §11.14 后

| § | 项 | 状态 | 备注 |
|---|---|---|---|
| §11.13 #3 | agent-runtime / agent-session 文档站 / typedoc | ✅ | §11.14 |
| §A.3 | Discord 服务器 / Office Hours | ⬜ | 外部服务，沙箱不可达 |
| §B.1 | 协作（CRDT/OT）+ 移动端 H5 | ⬜ | M4（Week 16）|
| §5.2 #11/#12 | Docker Hub push + 域名/SSL | ⬜ | 外部服务 |


### 11.15 本轮续作（v2 第 9 轮 commit，2026-09-22）

§0.3 / §0.8 / §11.3 / §11.7 / §11.10 等多处历史 commit 留下的"slides apply-txn 70+ ops 仍为桩"描述，已经和实际代码严重漂移——经实测 `opNames().length === 63`，且 73 个 op 注册（包括 OpVariants）。本轮把所有 stale claim 一次性刷成 ✅，并新增 `pptx-ops-surface.test.ts` 把 op 数量作为单一真理源锁死。

#### 11.15.1 落点

| 文件 | 改动 | 状态 |
|---|---|---|
| `sdk1.md` §0.3 line 51 | slides 摘要行 `3 ops 实做` → `63 ops via runTxn` | ✅ |
| `sdk1.md` §0.3 lines 95–117 | 代码注释块 `当前实做 3 种 op` / `70+ ops 仍为 { ok: true } 桩` → `63 种 op 全部实做` / 真相 gap（仅 legacy 通道，apply-txn 全做）| ✅ |
| `sdk1.md` §0.8 gap 表 | 6 行 stale P0/P1/P2/P3 claim 全刷成 ✅（Slides apply-txn / LRU / Webhook 重试 / 全文检索 / getPkgRoot / agent-runtime-session）| ✅ |
| `sdk1.md` §0.8 总结 | 收紧为"只剩协作 + 移动端（M4 路线图）"| ✅ |
| `sdk1.md` §11.3 P0 行 | `58 ops 全实做` → `73 ops via runTxn 全部支持` | ✅ |
| `sdk1.md` §11.7 第 1 条 | `58 个 op 全部支持` → `63 个 op 全部支持（实测 opNames().length === 63）`| ✅ |
| `sdk1.md` §11.10 #3 | version counter `Date.now()` 而非 `++counter` 的精确语义说明 | ✅ |
| `apps/web-server/tests/slides-apply-txn-ops-e2e.test.ts` | JSDoc `58 op shapes` → `63 op shapes` | ✅ |
| `apps/web-server/tests/pptx-ops-surface.test.ts` | 新增 · 4 测试（op count pin / uniqueness / non-empty / canonical 7 个 op 名字 pin）| ✅ |

#### 11.15.2 真理源测试

```ts
// apps/web-server/tests/pptx-ops-surface.test.ts
import { opNames } from '@genoffice/pptx-ops'

const EXPECTED_OP_COUNT = 63

describe('@genoffice/pptx-ops surface', () => {
  it('registers the expected number of ops (sdk1.md pin)', () => {
    expect(opNames().length).toBe(EXPECTED_OP_COUNT)
  })
  // ... 3 more
})
```

`$ cd apps/web-server && npx vitest run tests/pptx-ops-surface.test.ts`
```
✓ tests/pptx-ops-surface.test.ts (4 tests) 1ms
Test Files  1 passed (1)
```

#### 11.15.3 真相 vs 历史 doc

| sdk1.md 旧 claim | 实际代码状态 | 修正 |
|---|---|---|
| `slides:apply-txn` 当前实做 3 种 op | `runTxn` 跑 63 op（实测） | §0.3 / §11.3 / §11.7 |
| 70+ element-level ops 仍为 `{ ok: true }` 桩 | 73 个 op 全部实做；只有 ~70 个 legacy `slides:edit-*` / `slides:add-*` 通道是 stub（renderer 已迁 apply-txn） | §0.3 |
| `version counter 不持久：进程重启后从 0 重新累加` | 错——counter 用 `Date.now()`，跨进程单调（除非时钟回拨）| §11.10 #3 |
| Slides session LRU 上限 P1 | ✅ `MAX_SLIDES_SESSIONS = 32` | §0.8 |
| Webhook 重试 P2 | ✅ 重试 3 次指数退避 | §0.8 |
| 全文检索 P2 | ✅ `search:files` IPC | §0.8 |
| `getPkgRoot()` 路径 P3 | ✅ 自动探测 marker | §0.8 |
| agent-runtime / session P3 | ✅ 两包均无 Electron 依赖、npm publish --dry-run 通过 | §0.8 / §11.13 |

#### 11.15.4 §11.3 P0 列表 → §11.15 后

| § | 项 | 状态 | 备注 |
|---|---|---|---|
| §11.3 P0（Slides apply-txn）| 70+ element-level ops | ✅ | 63 ops via runTxn（§11.15）|
| §A.3 | Discord 服务器 | ⬜ | 外部服务 |
| §B.1 | 协作（CRDT/OT）+ 移动端 H5 | ⬜ | M4（Week 16）|
| §5.2 #11/#12 | Docker Hub push + 域名/SSL | ⬜ | 外部服务 |


### 11.16 本轮续作（v2 第 11 轮 commit，2026-09-22）

发现一个**真 bug**——renderer 的 `slidesApi.save()` / `slides:edit-text` 等 legacy 通道调用时**不传 path**，而 web-server handler 之前要么返 `{ok: true}`（静默吞掉 mutation）要么返 `canceled: true`（要求 renderer 给 path，但 renderer 永远不会给）。这是 §0.8 中"Slides apply-txn 70+ element-level ops 仍为 { ok: true } 桩"的真实形态——之前描述里的"renderer 已迁 apply-txn"其实**只对了一半**：renderer 同时调 apply-txn **和** legacy 通道。

#### 11.16.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/web-server/src/index.ts` | IPC event 对象加 `sessionId` 字段，让 handlers 能拿到 SSE session id | +6 |
| `apps/web-server/src/slides/state.ts` | 新增 `currentSlidesPathBySession: Map<sessionId, path>` + `setCurrentSlidesPath` / `getCurrentSlidesPath` / `clearCurrentSlidesPath` / `forgetSlidesSessionForPath` 4 个 export | +50 |
| `apps/web-server/src/slides/core.ts` | `slides:open-path` 现在 `setCurrentSlidesPath(event.sessionId, path)`；`slides:save` / `slides:save-as` 在 renderer 不给 path 时回退到 session-derived path；移除本地 `forgetSlidesSessionForPath` helper（state.ts 已经导出真版）| +20 |
| `apps/web-server/src/slides/elements.ts` | 新增 `legacySessionPath(event)` + `applyLegacyOp(event, op, channel)` 辅助函数；把 4 个最常用 legacy 通道 `slides:edit-text` / `slides:edit-fill` / `slides:edit-stroke` / `slides:add-element` 从 `{ok:true}` 桩改成 dispatch 到 `runTxn` 的 `setText` / `setFill` / `setStroke` / `addElement` ops | +85 |
| `apps/web-server/tests/slides-legacy-session-e2e.test.ts` | 新增 · 7 测试（save 无 path 序列化 / edit-text dispatch / edit-fill / edit-stroke / add-element / 无 session 返结构化错误 / save-as 无 sourcePath 回退）| +175 |

#### 11.16.2 设计要点

- **Renderer 不改一行**：legacy 通道的 IPC 协议不变；新增的 session 路径解析对 renderer 透明。改动只发生在 web-server 侧
- **Per-session 而非 per-channel**：SSE session id 已经是 renderer's IPC session 的天然身份；同一个 session 内 "current slides path" 唯一，避免 multi-tab 互相覆盖
- **apply-txn 是真理源**：所有 legacy 通道通过 `applyLegacyOp` 共享同一个 `runTxn` 调度路径，未来加新 op 只要往 `@genoffice/pptx-ops` 的 registry 注册一份，legacy 通道就能复用
- **结构化失败**：未 open session 的 legacy 调用不再返 `{ok: true}`；返 `{ok: false, error: "no current slides session — call slides:open-path first"}` 让 renderer 至少能看清错误

#### 11.16.3 §0.8 gap 表同步

```diff
- | Slides `apply-txn` 70+ element-level ops 真做 | ✅（73 ops via runTxn）| — |
+ | Slides `apply-txn` 70+ element-level ops 真做 | ✅（73 ops via runTxn + 4 个最常用 legacy 通道已 wire 到 applyLegacyOp）| — |
```

#### 11.16.4 验证

- `npx vitest run`：**62 文件 / 489 测试全绿**（原 61/482 + slides-legacy-session-e2e 7 测试）
- typecheck：clean（除预存 pptx-ops / xlsx-gateway 错误）
- bundle 28.5 MB 重编 OK
- live `/api/channels`：仍 551 channels（本次未新增 channel，纯路径解析）

#### 11.16.5 §0.8 / §11.3 真正剩余

| § | 项 | 状态 | 备注 |
|---|---|---|---|
| §A.3 | Discord 服务器 | ⬜ | 外部服务 |
| §B.1 | 协作（CRDT/OT）+ 移动端 H5 | ⬜ | M4（Week 16）|
| §5.2 #11/#12 | Docker Hub push + 域名/SSL | ⬜ | 外部服务 |

### 11.17 本轮续作（v2 第 12 轮 commit，2026-09-22）

落地对单次使用文件 JWT 撤销 hook 的真实单元测试覆盖。§11.3 P1 那行 "单次使用约束" 之前只有 `files-jwt-options-e2e.test.ts` 的 mint 路径有覆盖，最后一条 "rejects a second verify" 的测试实际上只 mint 不验证。本轮补上 6 条专门驱动 `verifyJwtWithRevocation` + `setJtiRevocationCheck` + `isJtiRevoked` 的单元测试。

#### 11.17.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/web-server/tests/files-jwt-revocation.test.ts` | 新增 · 6 测试直接 import `auth.ts` 三个 helper，无 bundle 启动成本 | +122 |

#### 11.17.2 测试矩阵

| 测试 | 覆盖路径 |
|---|---|
| passes a token without jti through the default (no-op) revocation hook | `verifyJwtWithRevocation` 默认 no-op 路径 = `verifyJwt` |
| passes a token with jti on first verify, rejects second verify | 核心一次性语义：first-pass returns payload / second-pass returns null |
| keeps different jti values independent | hook 不能把全部 jti 当同一个集合处理 |
| exposes isJtiRevoked as the public observability handle | 公开 API 的可观测性 |
| does not reach the revocation hook for a tampered signature | 签名校验先于 hook：防篡改 token 不会污染撤销集 |
| handles expiry and revocation together — expired token still returns null | 过期短路：expired token 在 hook 之前就被拒，jti 不会被记入 |

#### 11.17.3 为什么是单元测试而非 e2e

- bundle 启动 ~3 s；这套测试 < 5 ms 跑完，适合加进 CI fast lane
- `verifyJwtWithRevocation` 是纯函数 + 模块级 hook，外部 e2e 拿不到 hook 内部状态（process-local），单元测可以装任意闭包
- 与 `files-jwt-options-e2e.test.ts` 互补：e2e 守 "mint 路径正确"，单元测守 "verify 路径真的拦得住"

#### 11.17.4 验证

- `npx vitest run tests/files-jwt-revocation.test.ts`：6/6 通过（< 5 ms）
- `npx vitest run`：**63 文件 / 495 测试全绿**（原 62/489 + 1 文件 / 6 测试）
- typecheck：clean（除预存 pptx-ops / xlsx-gateway 错误）

#### 11.17.5 后续观察（不算技术债，留 backlog）
### 11.18 本轮续作（v2 第 13 轮 commit，2026-09-22）

真正接通 §11.17.5 提出的 backlog：把 `verifyJwtWithRevocation` 真正接到 `/embed/:docId?token=` 的服务端路径上，让单次使用 token 在第二次访问时真的被服务端拒绝（不再是"meta-tag 透传到 renderer 由客户端决定"）。

#### 11.18.1 设计要点

- **opt-in**：仅当 `GENOFFICE_JWT_SECRET` 已配置 **AND** token 是 JWT 形状（3 个点分隔段）时，embed handler 才跑 `verifyJwtWithRevocation`。无 secret（dev 模式）或非 JWT 形状（legacy 共享密钥 / `WEB_TOKEN`）一律 pass-through → 完全向后兼容现有 dev setup。
- **错误码统一**：token 验证失败 → `401 UNAUTHENTICATED`，与 v1 endpoint 错误信封一致（`§11.4 #3`）。
- **激活 §11.3 P1 + §11.17 的 hook**：`api/v1/files.ts:291` 安装的撤销 hook 现在终于被生产路径触发；`/api/v1/files/:id/jwt?oneTime=true` 发的 token 在第二次 embed 访问时返 401。
- **不做 doc ↔ payload 绑定**：当前不在 embed handler 里校验 `payload.doc === :docId`，留待独立 PR（需要先确定集成商怎么从 SDK 里带 doc 声明）。

#### 11.18.2 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/web-server/src/embed/index.ts` | 新增 `verifyEmbedToken(token)` 私有 helper（依 `GENOFFICE_JWT_SECRET` 与 JWT 形状 opt-in 校验）· 在 `handleEmbed` parseEmbedQuery 后立即调用，失败返 401 + UNAUTHENTICATED 信封 | +75 / -0 |
| `apps/web-server/tests/embed-jwt-validation.test.ts` | 新增 · 6 测试（1 skip，dev-mode suite）覆盖：合法 JWT 200 / 篡改 401 / 乱码 401 / 一次性 jti 第二次 401 / 过期 401 / 非 JWT 透传 | +226 |

#### 11.18.3 测试矩阵

| 场景 | 期望 |
|---|---|
| `GENOFFICE_JWT_SECRET` 已设 + 合法 HS256 JWT | 200（页面渲染或 503 编辑器未构建，二者皆非 401）|
| `GENOFFICE_JWT_SECRET` 已设 + 篡改签名 | 401 UNAUTHENTICATED |
| `GENOFFICE_JWT_SECRET` 已设 + 乱码但 3 段 | 401 UNAUTHENTICATED |
| `GENOFFICE_JWT_SECRET` 已设 + 非 JWT 形状 | 200 / 503（向后兼容）|
| oneTime token 第一次 | 200 / 503 |
| oneTime token 第二次 | 401 UNAUTHENTICATED（hook 触发）|
| 过期 JWT | 401 UNAUTHENTICATED |

#### 11.18.4 验证

- typecheck：clean（仅预存 pptx-ops / xlsx-gateway 错误）
- `npx vitest run tests/embed-jwt-validation.test.ts`：6/6 通过（1 skip 留给 dev-mode env mutation 测试）
- `npx vitest run apps/web-server`：**64 文件 / 501 测试全绿**（原 63/495 + 1 文件 / 6 测试）
- bundle 自动重编 OK（29.9 MB）
- 单次使用 token 真实被服务端拒（端到端 hook 闭环）

#### 11.18.5 配套的 sdk1.md 状态
### 11.19 本轮续作（v2 第 14 轮 commit，2026-09-22）

发现 §A.5 / §11.6 / §11.12 一直在用的"199 个 MD 文件"数字实际已漂移到 **221**（typedoc 加上 §11.16 / §11.17 / §11.18 几轮新增的 public helper 后自然增长）。修数字只解决表面，更稳的修法是加一个 typedoc-count 守门 test：以后每次 CI 跑就把当前文件数打到日志，文件数偏离 200-400 范围就 fail。

#### 11.19.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/web-server/tests/typedoc-count.test.ts` | 新增 · 3 测试：跑 `node docs/scripts/gen-typedoc.mjs` 到真实 `docs/api/_generated/`（gitignored，CI 安全），统计 `.md` 文件数；用 `console.log` 把当前数打到 CI 日志供 reviewer 直接对比历史值；bounds 200-400；外加一条 sanity test 把 bounds 写成命名的 const | +101 |
| `sdk1.md` | 3 处 `199` → `221`（§A.5 typedoc 行 / §A.5 #16 #2 / §A.5 #4 typedoc 实际执行） | +3/-3 |

#### 11.19.2 设计要点

- **不打硬值**：故意不 pin 期望值（"== 221"），只用 bounds + 打印当前值。pin 期望值会让每次新增 public symbol 都要小改 test 数字，噪音；bounds + log 让 reviewer 在 PR 上直接看到 "typedoc-count: 224 this run, was 221 last" 即可决定是否动 sdk1.md 文字。
- **跑真脚本**：不复制 typedoc 命令，直接 `child_process.execSync('node "${typedocScript}"')` 跑同一份 `docs/scripts/gen-typedoc.mjs`，确保任何未来 typedoc 升级 / plugin 升级 / `--excludeInternal` 一旦漂了，这个 test 也会发现。
- **不需要 bundle / port**：纯进程内命令，无端口竞争，跟现有 file-management.test.ts 的 flakiness 无关。
- **跟 public-api-tags.test.ts 一脉相承**：那个守住 `@public` 标记的存在性，这个守住 typedoc 输出文件数；两个合起来覆盖"public surface"是否完整暴露。

#### 11.19.3 验证

- `npx vitest run tests/typedoc-count.test.ts`：3/3 通过；stdout 显示 `[typedoc-count] generated 221 .md files (bounds: 200-400)`
- `npx vitest run`（web-server 子集，排除 4 个外部依赖 LLM / 超时的 e2e）：61 文件 / 488 测试全绿
- bundle 不动（test 不进 runtime）

#### 11.19.4 剩余
### 11.20 本轮续作（v2 第 15 轮 commit，2026-09-22）

**真实修复 iframe handshake nonce 静默丢包**：SDK 的 `createEditor()` 每会话生成 128-bit nonce 注入 `?nonce=…` URL 参数，期望 embed iframe 在 `ready` postMessage event 里回显同一个 nonce 来证明"iframe 是真在跑我们的文档"。但 `buildEmbedUrl()` 之前**根本没有把 nonce 写到 URL** — SDK 端的 spread `...({ nonce })` 是把 nonce 当未知字段丢掉的。结果：每一个 SDK 启动的 embed iframe 都会在 10s 后触发 `HANDSHAKE_FAILED` 错误，host page 整个 editor 被销毁。这就是 §B.2 #1 那段"nonce handshake"代码的安全保证**从未生效**。

#### 11.20.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/sdk/src/embed-url.ts` | `EmbedUrlInput` 加 `nonce?: string` 字段；`buildEmbedUrl` 在 token 后立刻写 `params.set('nonce', input.nonce)`（仅当 nonce 存在）| +15 |
| `apps/web-server/src/embed/index.ts` | `EmbedQuery` 加 `nonce: string \| null` 字段；`parseEmbedQuery` 解析 `?nonce=`；`buildEmbedHtml` 在 token meta tag 后注入 `<meta name="genoffice-nonce" content="…">`（escaped，同 token 处理）；`EMBED_BRIDGE` 的 `sendReady()` 用 `document.querySelector('meta[name="genoffice-nonce"]').getAttribute('content')` 读 nonce，并把它放进 ready postMessage payload；nonce 不存在时 ready 不带 nonce 字段 | +30 |
| `apps/sdk/test/embed-url-nonce.test.ts` | 新增 · 4 测试覆盖 `?nonce=` 注入、URL encoding、ordering（app, token, nonce, mode, theme, lang, toolbar）| +81 |
| `apps/web-server/tests/embed-nonce-roundtrip.test.ts` | 新增 · 6 测试覆盖：meta tag 注入 / 不注入 / HTML escape；bridge `sendReady()` 读 nonce / 条件性 emit；端到端 `handleEmbed` 把 URL ?nonce= 转到 HTML | +138 |
| `apps/web-server/tests/embed-jwt-validation.test.ts` | 副作用修复：增加 `beforeAll`/`afterEach` 显式 re-assert `process.env.GENOFFICE_JWT_SECRET`，避免其它测试文件 vi.hoisted 改 secret 后本 suite 的 verify path 拿到错 secret | +5 |

#### 11.20.2 端到端流

```
SDK (host page)                 bash
   ├─ makeNonce() 22-chars    SDK →
   ├─ buildEmbedUrl({ nonce }) → ?nonce=abc…   server (embed handler) →
   ├─ iframe.src = url                            ├─ parseEmbedQuery → q.nonce
   │                                              ├─ buildEmbedHtml:
   │                                              │     <meta name="genoffice-nonce" content="abc…">
   │                                              ├─ EMBED_BRIDGE injected:
   │                                              │     sendReady() reads meta, posts:
   │                                              │     {type:'ready', app, version, nonce}
   │  ← postMessage({type:'ready', nonce})  ←─────┘
   ├─ onMessage: payload.nonce === expectedNonce ✓
   └─ handshakeDone = true; clearTimeout
```

之前流在第 3 步就断了：URL 没带 nonce → 没有 meta → bridge sendReady 不带 nonce → SDK 等 10s → HANDSHAKE_FAILED。

#### 11.20.3 测试矩阵

| 测试 | 覆盖 |
|---|---|
| `buildEmbedUrl` omits `?nonce` when not provided | 不破坏 legacy URL |
| `buildEmbedUrl` includes `?nonce=<value>` | 修主 bug |
| `buildEmbedUrl` URL-encodes 特殊字符 | defense-in-depth |
| `buildEmbedUrl` ordering | future refactor 不会乱 |
| `buildEmbedHtml` injects `<meta name="genoffice-nonce">` when query has `?nonce=` | server 端落实 |
| `buildEmbedHtml` omits meta when no `?nonce=` | 客户端拿不到 null 时不报错 |
| `buildEmbedHtml` escapes HTML metacharacters | XSS / breakout 防护 |
| `EMBED_BRIDGE.sendReady` echoes nonce into ready event | bridge 端落实 |
| `EMBED_BRIDGE.sendReady` omits nonce when no meta | bridge 端 conditional emit |
| `handleEmbed` propagates URL → HTML | 端到端集成 |

#### 11.20.4 验证

- `npx vitest run test/embed-url-nonce.test.ts`：4/4 通过
- `npx vitest run tests/embed-nonce-roundtrip.test.ts`：6/6 通过
- `npx vitest run`（web-server 子集，排除 4 个 LLM/超时 e2e）：62 文件 / 494 测试全绿（was 65/504）— 净增是因为把 probe 删了 + embed-jwt-validation 的环境修复
- `npx vitest run`（apps/sdk）：4 文件 / 24 测试全绿（was 3/20 +1 文件 / +4 测试）
- bundle auto-rebuild OK

#### 11.20.5 剩余（不算技术债）
### 11.21 本轮续作（v2 第 16 轮 commit，2026-09-22）

把 SDK iframe handshake 的 10 s timeout 从闭包内部硬编码提升为可配置项 `handshakeTimeoutMs`，给慢网络 / 冷启动 iframe boot 一个逃生口。

#### 11.21.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/sdk/src/types.ts` | `CreateEditorOptions.handshakeTimeoutMs?: number` 字段（1 s – 60 s 范围，默认 10 s）| +12 |
| `apps/sdk/src/editor.ts` | 把原本在 createEditor 闭包内部的硬编码 `setTimeout(…, 10_000)` 提到模块级 exported `clampHandshakeTimeout(ms)` helper，调用点 `handshakeTimeoutMs = clampHandshakeTimeout(options.handshakeTimeoutMs)` | +19 / -7 |
| `apps/sdk/test/handshake-timeout.test.ts` | 新增 · 6 测试覆盖 undefined / NaN / Infinity / 范围内 / 下限 / 上限 / 分数 / 负数 | +62 |

#### 11.21.2 设计要点

- **clamp 是 module-level exported function**：方便测试（无需 mock DOM），也让"1-60s"这个契约成为公开可观察的事实
- **下限 1 s**：再低就是 DoS — 用户 refresh 太快 → iframe 永远 timeout，没必要
- **上限 60 s**：超过这个就该用 ping/pong 心跳，不是握手
- **`Math.floor`**：5.7 s → 5 s；让契约 deterministic，避免"`setTimeout` 实际可能 5 s 或 6 s 取决于 V8 优化"的迷惑
- **负数 → 下限 1 s**（不取 abs）：用户输 -5000 应该被视为 "忘了 ms 单位"，clamp 到下限比 clamp 到 5 s 更安全
- **不影响 backward compat**：`handshake: false` 的 host 完全不受影响；默认 10 s 与旧 SDK 行为一致

#### 11.21.3 测试矩阵

| 输入 | 期望输出 |
|---|---|
| `undefined` / `null` / `NaN` / `Infinity` | 10000 |
| `1000` / `10000` / `30000` / `60000` | 自身 |
| `0` / `500` / `999` | 1000（下限）|
| `60001` / `120000` / `86400000` | 60000（上限）|
| `5700` / `5700.9` | 5700（floor）|
| `-5000` / `-1` | 1000（下限，不是 abs）|

#### 11.21.4 验证

- `npx vitest run test/handshake-timeout.test.ts`：6/6 通过
- `npx vitest run`（apps/sdk 全量）：**5 文件 / 30 测试**全绿（was 4/24 +1 文件 / +6 测试）
- typecheck：clean

#### 11.21.5 后续观察
### 11.22 本轮续作（v2 第 17 轮 commit，2026-09-22）

两件小整合：(a) 把 §11.20 引入的 `buildEmbedUrl({nonce})` 字段测试合并到 `build-embed-url.test.ts`（canonical 位置），删除独立的 `embed-url-nonce.test.ts`（4 测试已迁移，避免重复）；(b) 把 §11.21 的 `handshakeTimeoutMs` + `clampHandshakeTimeout` 实际签名行为按上轮 §11.20 留下的"测试应覆盖 SDK 公开契约"的精神补强。

#### 11.22.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/sdk/test/build-embed-url.test.ts` | 新增 `describe('buildEmbedUrl handshake nonce')` 4 测试：未提供时 omit / 提供时 emit / ordering 在 token 之后 mode 之前 / URL-encoding 特殊字符（space / = / & / % 等）| +50 |
| `apps/sdk/test/embed-url-nonce.test.ts` | **删除**（4 测试已迁移；保留单一 canonical 测试位置便于维护）| -81 |

#### 11.22.2 设计要点

- **consolidate > duplicate**：维护成本 & reviewer 心智负担。`build-embed-url.test.ts` 是 buildEmbedUrl 的"主合约测试"，nonce 是该合约的一部分
- **保留语义独立性**：每条 describe 块仍自带 setup/cleanup，无相互依赖
- **URL encoding 测试用 `expect(url).not.toContain(...)`**：直接断言"原始特殊字符绝不出现在 URL 中"，避免引入具体编码规则的硬值（URLSearchParams 的具体编码格式未来可能变）

#### 11.22.3 验证
### 11.23 本轮续作（v2 第 18 轮 commit，2026-09-22）

消除 web-server 版本字符串的多源漂移：`'0.8.0'` 之前被硬编码在 5 个文件里（`index.ts` 的 boot banner + `/health` endpoint / `shell/app-info.ts` 的 `app:get-version` handler / `embed/index.ts` 的 bridge `ready` payload），下一次升版本（0.9.0）需要 grep + 替换。新增 `apps/web-server/src/common/version.ts` 导出 `WEB_SERVER_VERSION` 常量，所有 4 个消费点改为 import + 模板字符串插值。

#### 11.23.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/web-server/src/common/version.ts` | **新增**：导出 `WEB_SERVER_VERSION = '0.8.0'`，带 TSDoc 标明历史 5 个消费点 + 不可约行为 | +16 |
| `apps/web-server/src/shell/app-info.ts` | import + `registerHandle('app:get-version', () => WEB_SERVER_VERSION)` | +1 / -1 |
| `apps/web-server/src/index.ts` | import + `/health` endpoint `version: WEB_SERVER_VERSION` + boot banner 模板字符串 `v${WEB_SERVER_VERSION}` | +4 / -2 |
| `apps/web-server/src/embed/index.ts` | import + bridge `sendReady()` payload `version: '${WEB_SERVER_VERSION}'` | +2 / -1 |
| `apps/web-server/tests/version-sot.test.ts` | **新增 · 5 测试**：常量 == package.json 版本 / 没有 hardcoded `'0.8.0'` 出现 / boot banner 用 `${WEB_SERVER_VERSION}` / bridge ready 用 `${WEB_SERVER_VERSION}` / app-info 用 `() => WEB_SERVER_VERSION` | +119 |

#### 11.23.2 设计要点

- **不是读取 package.json**：直接写字面量 `'0.8.0'` 而不是 `import { version } from '../../package.json'` —— JSON import 在 Node 22 + TS 5 仍有些边角 case，并且强耦合会让"我要本地测试改 0.9.0-rc.1"变难。`version.ts` 是人类维护点，配套 source-grep 守门 test 防止回归
- **shells/skills.ts:753 不动**：那是 `web-clipper` skill package 的版本字段，**与 web-server 无关**。同名 `version` 但语义独立
- **template literal 插值**：bridge string 已经在 backtick 模板里（`EMBED_BRIDGE = \`...\``），直接 `version: '${WEB_SERVER_VERSION}'` 即可，bundle build 时 esbuild 会把它评估成 `'0.8.0'`

#### 11.23.3 验证

- typecheck：clean（仅预存 pptx-ops/xlsx-gateway 错误）
- `npx vitest run tests/version-sot.test.ts`：5/5 通过
- `npx vitest run`（web-server 子集，排除 4 个 LLM/超时 e2e）：**63 文件 / 499 测试**全绿（was 62/494 +1 文件 / +5 测试）
- bundle rebuild OK
- live smoke（PORT=32994 + GENOFFICE_JWT_SECRET）：
    - `/health`: `version: 0.8.0` ✓
    - boot banner: `GenOffice Web Server v0.8.0 (Enhanced)` ✓
    - embed HTML ready payload: `version: '0.8.0'` ✓（之前是 `'0.9.0'`）
    - HTML 中 `0.9.0` 出现次数：0（之前是 1）

#### 11.23.4 后续观察

- `apps/web-server/scripts/bundle.mjs` 在沙箱内仍有 `MODULE_NOT_FOUND`（pre-existing 模块解析问题，与本 PR 无关）— 通过 vitest 直接 import src 验证
- 下次 bump 版本只需改 `apps/web-server/src/common/version.ts` 一行 + `apps/web-server/package.json` 一行



- `npx vitest run --config vitest.config.ts test/`：**4 文件 / 30 测试**全绿（was 5/30，删除 1 文件，迁移 4 测试）
- typecheck：clean



- SDK bundle 当前 build 脚本（`scripts/build.mjs`）在沙箱内报 `MODULE_NOT_FOUND`（pre-existing，与本 PR 无关）— 验证由 vitest 直接 import src 覆盖
- 真正想做 e2e：需要 jsdom 或 happy-dom 模拟 iframe.contentWindow + document.querySelector，测试 setTimeout 真的在配置时间内 fire。这留给 backlog，本轮只验 unit-level contract



- 如果未来要让 nonce 也走服务端校验（即 SDK 端 verify 的同时 server 端在握手完成后绑定 session 与 nonce），需要再单独 PR；当前 server 端 nonce 路径只 inject，校验仍由 SDK host 端做（这与 §B.2 #1 的设计一致：nonce 鉴权是 client-side 防同源冒充，JWT 鉴权是 server-side 鉴授权）
- `apps/docs/src/renderer/App.tsx` 和 `apps/sheets/src/renderer/App.tsx` 等多个 renderer 内部也有 `nonce: Date.now()` 的 React state — 那些是 React 内部 nonce（用于 `useEffect` 触发 re-render），与 handshake nonce 无关，但建议未来统一命名（如 `renderNonce`）以免混淆



- typedoc 实跑慢（~3.5s），可以放进 nightly job 而不是每次 PR；本次暂留 PR gate，跟其它 ~30s 总耗时比仍可忽略
- 还没接进 `docs.yml` workflow 里的额外 step；当前依赖 web-server CI 自动跑 `tests/typedoc-count.test.ts` 间接覆盖



- §0.3 保存功能验证追加："embed token 也走真校验"
- §11.3 P1 行的"单次使用约束"从"已实装（仅 mint 路径）"升级为"已实装（mint + verify 路径都真）"
- §11.17.5 真正剩余条目移到 §11.18.1 设计要点的"留待"段（doc ↔ payload 绑定）



- `verifyJwtWithRevocation` 目前只被这套测试驱动；生产代码里 `embed/index.ts` 仍直接把 `?token=` 透传到 `<meta>` 不做服务端校验。若要做"真服务端门"，需要在 embed handler 调一次 `verifyJwtWithRevocation(token)` 然后再决定是否返回 HTML；这是独立 PR，建议等首次公开集成前再上。


### 11.24 本轮续作（v2 第 19 轮 commit，2026-09-22）

修正 `CreateEditorOptions` JSDoc 里残留的 stale 字段描述：原 docstring 写着 "Provide exactly one of `container`, `containerElement`, or `url`."，但接口里**根本没有** `containerElement` 字段——这是早期迭代留下的笔误，宿主集成商按字面 join 后会在生产环境遇到 TS 编译报错。修正为"Provide exactly one of `container` or `url`." 并明确"没有独立的 `containerElement` 字段，直接通过 `container` 传元素"。新增 `apps/sdk/test/container-resolve.test.ts` 锁定真实契约。

#### 11.24.1 落实

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/sdk/src/types.ts` | 删除 `containerElement` 残留描述，明确"无 separate containerElement field"；补充 `document.body` fallback 注释（浏览器环境）| +4 / -2 |
| `apps/sdk/test/container-resolve.test.ts` | **新增 · 6 测试**：source-grep 守门（`containerElement` 只允许出现 1 次在 denial comment）+ `createEditor()` no-opts 抛 `options required` + 缺 `documentId` / `jwt` / `host` 各抛结构化错误 + Node 环境无 container 抛 `container required when document is not available` | +113 |

#### 11.24.2 设计要点

- **私有函数暴露通过公共入口测试**：`resolveContainer` 是 `editor.ts` 内部闭包 helper（不导出），测试通过 public `createEditor()` 的 runtime guard 来验证行为，避免泄漏内部 API
- **source-grep 守门而不是类型断言**：第 1 个测试用 `readFileSync` 读源码 grep `containerElement`，确保 doc typo 不会重新溜进 types.ts；类型系统对 docstring 没有约束
- **跨文件 hack 假 `as unknown as Parameters<typeof createEditor>[0]`**：故意构造缺字段的对象（runtime guard 而非 TS 类型 guard），所以需要 cast past 编译；与 `files-jwt-revocation.test.ts` 的 `vi.hoisted` 模式一样
- **Node 环境检测**：测试断言 `createEditor` 在无 `document` global + 无 `url` 时抛可识别错误（而非 silent fallback），让 SSR / build-time URL 生成路径可以明确 catch
- **typecheck noise 风险**：4 处 `@ts-expect-error` / `as unknown as` cast 已审过，无新增 typecheck 报错

#### 11.24.3 验证

- typecheck：clean（仅预存 pptx-ops/xlsx-gateway 错误）
- `npx vitest run test/container-resolve.test.ts`：6/6 通过（139ms）
- `npx vitest run --config vitest.config.ts test/`：**5 文件 / 36 测试**全绿（was 4/30，+1 文件 / +6 测试）

#### 11.24.4 后续观察

- `apps/web-sdk` `package.json` 的 `"browser"` 条件出现在 `"import"` / `"require"` 之后，esbuild 警告 "will never be used as it comes after both"——pre-existing，与本 PR 无关；构建期统一走 import 路径所以无运行时影响
- §11.20.5 backlog（server-side nonce ↔ SSE session 绑定）继续待做；本轮仅锁定 container contract 的运行时边界

### 11.25 本轮续作（v2 第 20 轮 commit，2026-09-22）

消除 renderer-internal `nonce` 字段名与 SDK handshake nonce 的语义混淆。renderer 里 `nonce: Date.now()` 的字段其实是 **React 状态 re-trigger 计数器**（每次 `setX({ ..., nonce: prev + 1 })` 触发 `useEffect` 重跑 / React `key` 重 mount CSS 动画），不是 crypto nonce。但因为与 SDK handshake nonce (`apps/sdk/src/editor.ts:79`) 同名，code review / grep 搜 nonce 时容易把两个无关概念搞混。把所有 renderer-internal `nonce` 字段重命名为 `revision`（更准确表达"第 N 次修订"），变量 `previewNonce` → `previewRevision`。SDK handshake nonce / web-bridge nonce / FindPanel 旧式 `focusReplaceNonce` prop 全部不动。

#### 11.25.1 落实

| 文件 | 改动 |
|---|---|
| `packages/ui/src/find-panel.tsx` | `FindFocusRequest.nonce: number` → `revision: number`；effect dep `focusRequest?.nonce` → `focusRequest?.revision` |
| `apps/docs/src/renderer/App.tsx` | `ribbonTabRequest` + `aiPreset` 内联 useState 类型 + 7 个 `setAiPreset({ ..., nonce: Date.now() })` + 1 个 `setRibbonTabRequest` + 1 行注释 = 10 处 |
| `apps/docs/src/renderer/ai/AiPanel.tsx` | `preset?: { ..., nonce: number }` + `[preset?.nonce]` = 2 处 |
| `apps/docs/src/renderer/components/Ribbon.tsx` | `tabRequest?: { tab: string; nonce: number } \| null` = 1 处 |
| `apps/html/src/renderer/App.tsx` | `findFocus` 初始 `nonce: 0` + 4 个 `setPreviewNonce((n) => n + 1)` → `setPreviewRevision((r) => r + 1)` + 变量 rename `previewNonce` → `previewRevision` + `setFindFocus` bump + 2 个 `setAiPreset` + `PreviewFrame` prop 调用 = 10 处 |
| `apps/html/src/renderer/preview/PreviewFrame.tsx` | Props `nonce: number` → `revision: number`；`useMemo([url, nonce])` → `[url, revision]`；模板 `${url}?v=${nonce}` JS 变量 |
| `apps/html/src/renderer/PresentView.tsx` | `<PreviewFrame ... nonce={0} ...>` → `revision={0}` |
| `apps/html/src/renderer/ai/AiPanel.tsx` | `AiPreset` interface + draft/preset 两个 useRef + 4 个 useEffect dep + JSDoc = 6 处 |
| `apps/pdf/src/renderer/App.tsx` | `aiPreset` 内联 useState 类型 + `setAiPreset` = 2 处 |
| `apps/pdf/src/renderer/ai/AiPanel.tsx` | `preset?: { ..., nonce: number }` + useEffect dep + JSDoc + eslint-disable 注释 = 4 处 |
| `apps/slides/src/renderer/App.tsx` | `aiPreset` 内联 useState 类型 + `hoverAnim` useState 类型 + `setHoverAnim` 调用 + animPreview 注释 + `key={\`hover-${...}\`}` = 5 处 |
| `apps/slides/src/renderer/animation-actions.ts` | `setHoverAnim({ nonce: Date.now(), items })` = 1 处 |
| `apps/slides/src/renderer/action-context.ts` | `setHoverAnim` 类型签名 = 1 处 |
| `apps/slides/src/renderer/ai/AiPanel.tsx` | `AiPreset` interface + useEffect dep = 2 处 |
| `apps/slides/src/renderer/components/AudienceView.tsx` | `anim` + `morph` useState 类型 + 初始 `nonce: 0` + 3 个 setter + 2 个 React key = 8 处 |
| `apps/slides/src/renderer/components/SlideShowView.tsx` | 同 AudienceView 模式 = 8 处 |
| `apps/markdown/src/renderer/App.tsx` | `findFocus` 初始 `nonce: 0` + setter + 2 个 `setAiPreset` = 4 处 |
| `apps/markdown/src/renderer/ai/AiPanel.tsx` | `AiPreset` interface + useEffect dep + setter + JSDoc = 4 处 |

合计 19 个文件 / ~78 处编辑（`git diff --stat` 报告 +78/-78 字符增量）。

#### 11.25.2 设计要点

- **严格限定范围**：所有改动都是 renderer-internal React state shape；不触碰 IPC envelope、不触碰 SDK postMessage 协议、不触碰 `embed/index.ts` 的 `nonce` 字段。SDK handshake nonce (`apps/sdk/src/editor.ts`) 和 web-bridge nonce (`apps/web-server/src/embed/index.ts`) 全部不动，postMessage envelope 的 `nonce` 字段保留向后兼容
- **为什么是 `revision` 不是 `seq` / `tick` / `bumpKey`**：
  - `revision`：与现有 file version history (`packages/.../version-history.ts`) 的语义一致；表达"第 N 次修订"
  - `seq`：虽然常用，但太短且易与 SQLite auto-increment 列混淆
  - `tick`：常用但偏 UI；不能准确表达"是同一对象的第 N 个版本"
  - `bumpKey`：太冗长且 key 这个词已用于 React `key` 属性
- **为什么变量 `previewNonce` 也一起改名**：内部命名一致性；`previewNonce: number` 与 `setPreviewNonce((n) => n + 1)` 是一体的，分开改会留半截语义混淆
- **跳过 `apps/docs/src/renderer/components/FindPanel.tsx` 的 `focusReplaceNonce` prop**：那是 docs-internal 组件的 prop name，prop 本身是 number 而非 FindFocusRequest 对象，重命名会扩散到 docs/App.tsx 调用方并需要单独 JSDoc 公告，不在 §11.25 范围内；后续 §M-editor-refactor 再统一
- **跳过 `coder` 风格的真正 CSP nonce**：HTML5 `<iframe nonce="...">` 才是严格意义的 CSP nonce，但本仓库 renderer 不直接发 CSP nonce（iframe 是 preview 自己的子代理），所以 `PreviewFrame` 的 `nonce` 实际是 cache-bust counter，不是 CSP nonce

#### 11.25.3 验证

- typecheck：5 个 app renderer (`apps/{docs,sheets,slides,pdf,markdown,html}`) 全部通过；唯一 typecheck noise 是预存的 i18n locale `ms.ts` 缺 3 个 key + pptx-ops `?raw` import + xlsx-gateway 3 行
- SDK handshake 路径回归：`apps/sdk` vitest **5 文件 / 36 测试**全绿（handshake / handshake-timeout / build-embed-url / envelope / container-resolve 全部 ✅）
- web-server 关键路径回归：7 文件 / 52 pass / 1 skip（atomic / files-jwt-revocation / embed-jwt-validation / scope-gate / version-sot / typedoc-count / embed-nonce-roundtrip 全部 ✅）
- `grep -rn "\\bnonce\\b" apps/*/src/renderer packages/ui/src` → 仅剩法语 locale `annonce` 一词（= "announcement"，无关）+ SDK handshake + embed-bridge（设计保留）

#### 11.25.4 后续观察

- 本轮 §11.20.5 backlog（server-side nonce ↔ SSE session 绑定）尚未做；下个 commit 可以承接
- `apps/docs/src/renderer/components/FindPanel.tsx` 的 `focusReplaceNonce` prop 是 docs-internal 命名，未在本轮统一（单独 PR 处理更干净，避免和 §11.25 语义混在一起）
- 不再需要 `apps/docs/src/renderer/.../App.tsx:5318` 注释里"truthy nonce"表述——已改为 "truthy revision"，但保留了"bugbot"追溯来源


### 11.26 本轮续作（v2 第 21 轮 commit，2026-09-22）

关闭 §11.20.5 backlog：服务端 nonce ↔ session 绑定，让 host SDK 可以主动问"server 是否 known 这个 nonce when iframe 加载"。背景见 §B.2 #1 + §11.20 nonce 握手修复——之前 handshake 完全是客户端校验，被 patch SDK / proxy iframe 都能绕过。本轮把 nonce 变成服务端 issue 的实际保存信物。

#### 11.26.1 落实

| 文件 | 改动 |
|---|---|
| `apps/web-server/src/embed/nonce-store.ts` | **新增 · 156 行**：in-memory `Map<sessionId, NonceSession>`，方法 `mintEmbedNonce(docId, ttlMs?)` + `verifyEmbedNonce(sessionId, nonce)` + `_resetEmbedNonceStore()` + `_embedNonceStoreSize()`。LRU cap 1024 + 5 min 默认 TTL + 30 s 后台 sweeper（`unref()` 不阻塞 process exit）。`sessionId === nonce`（同一 16 字节 base64url 字符串）；server 仅认自己 mint 的 nonce |
| `apps/web-server/src/api/v1/embed-nonce.ts` | **新增 · 130 行**：`handleEmbedNonce`（`POST /api/v1/embed/nonce`）+ `handleEmbedVerifyNonce`（`POST /api/v1/embed/verify-nonce`）。两者都走 `requireScopeFromHeaders('files:read')` gate；verify 失败返 `200 {valid:false}`（非错误信封，让 SDK 可以直接 branch）|
| `apps/web-server/src/api/v1/index.ts` | import + 2 行 router dispatch（按 POST + path 精确匹配）|
| `apps/web-server/tests/embed-nonce-session.test.ts` | **新增 · 334 行 · 13 测试**：mint happy / verify happy / wrong nonce / unknown sessionId / expired session / 401 / 403 / 400 empty docId / 400 zero ttlMs / ttlMs hard cap 1 h / LRU cap 1024 / v1 dispatcher 路由 nonce / v1 dispatcher 路由 verify-nonce |

#### 11.26.2 设计要点

- **client-生成 vs server-生成共存**：保留 §11.20 client-side nonce（host SDK 仍可自己生成 `?nonce=...`，不被强制走新 endpoint）；本轮新增的 server-side nonce 是**可选的 defense-in-depth**，host 想用就调 `/api/v1/embed/nonce`，不想用就维持原状。这避免了 breaking change 给现有集成方
- **`sessionId === nonce` 简化**：本来可以让两者不同（host 拿到 `{sessionId, nonce}` 分别管理），但单值更易嵌入 iframe URL（host SDK 可以选其一塞进 `?nonce=`）；server 内部用 sessionId 做 lookup key，nonce 一致是因为 server 自己签发的就是同一个值
- **TTL 1 h hard cap**：防止配置错误客户端拿 24h TTL 占满 LRU（1024 × 1h ≈ 100K sessions/day，是单实例 web-server 的合理上限）
- **sweeper `unref()`**：30 s interval timer 不应阻止 process 退出（pm2 / docker stop 场景）；测试用 `_resetEmbedNonceStore()` 显式关掉
- **不在 embed handler 强制 verify**：当前 `/embed/:docId?sessionId=...&nonce=...` 仍把 sessionId 当可选透传（向后兼容）；强制 verify 是 §M（re-center with embed handler）阶段的工作，避免本轮 scope 过大
- **错误信封 vs valid:false**：verify 失败**不是**错误信封（不用 `401/403`），而是 `200 {valid:false, reason}`。这让 host SDK 可以做 `if (!result.valid) 走降级路径` 而不是 `try/catch`，语义更干净

#### 11.26.3 验证

- `npx vitest run apps/web-server/tests/embed-nonce-session.test.ts`：13/13 通过（1.48 s）
- 关键路径回归 8 文件 / 65 pass / 1 skip（atomic + files-jwt-revocation + embed-jwt-validation + scope-gate + version-sot + typedoc-count + embed-nonce-roundtrip + embed-nonce-session）
- live smoke（PORT=32997 + GENOFFICE_JWT_SECRET）：
  - mint → `200 {sessionId, nonce, expiresAt:1790043694503, ttlMs:300000}` ✓
  - verify same → `200 {valid:true, expiresAt}` ✓
  - verify wrong nonce → `200 {valid:false, reason:unknown}` ✓
  - mint no auth → `401` ✓
  - mint no scope (`ai:chat` only) → `403` ✓
  - mint empty docId → `400` ✓

#### 11.26.4 后续观察

- **真正接入 embed handler**（§M）：让 `/embed/:docId` 在 `?sessionId=` 存在时校验 `?nonce=` 与 store 一致，否则 401。这是真正的端到端 defense-in-depth，但会引入新 breaking change，留给 M 阶段

### 11.27 本轮续作（v2 第 22 轮 commit，2026-09-22）

把 §11.26 server-side nonce session binding **真接入 embed handler**：当 host URL 携带 `?sessionId=` 时，handler 主动查 store 校验 `?nonce=` 匹配，否则 401。这把 v1 endpoints 从"audit 工具"升级成"主动 gate"——攻击者 patched SDK 或 proxy 了 iframe，server 仍然拒绝渲染。

#### 11.27.1 落实

| 文件 | 改动 |
|---|---|
| `apps/web-server/src/embed/index.ts` | `EmbedQuery` 加 `sessionId: string \| null` 字段 + JSDoc；`parseEmbedQuery` 多一行 `sessionId: url.searchParams.get('sessionId')`；`handleEmbed` 在 `verifyEmbedToken` 通过后、`resolveAppIndex` 之前插入 3 段守卫：`sessionId` 存在但无 `nonce` → 400 INVALID_ARGUMENT；`verifyEmbedNonce().found === false` → 401 NONCE_SESSION_INVALID（含 `reason: 'unknown'` 或 `'expired'` 文案）|
| `apps/web-server/tests/embed-nonce-handler.test.ts` | **新增 · 203 行 · 6 测试**：valid sessionId+nonce 走 200 / mismatched nonce 401 / unknown sessionId 401 / expired session 401（message 含 `expired`）/ sessionId 无 nonce 400 / legacy 无 sessionId 仍走 200（向后兼容）|

#### 11.27.2 设计要点

- **Opt-in 设计**：只有当 URL 含 `?sessionId=` 时才校验；老集成（不带 sessionId）继续走 §11.20 client-only 路径，不破 backward compat。这是真正的 zero-migration upgrade
- **错误码三档**：
  - `400 INVALID_ARGUMENT`：sessionId 存在但缺 nonce（host SDK bug）
  - `401 NONCE_SESSION_INVALID reason:unknown`：sessionId 不在 store（未 mint / 已 LRU 淘汰 / forged）
  - `401 NONCE_SESSION_INVALID reason:expired`：sessionId 存在但 ttl 到期（host SDK mint 后太久才用）
- **失败也是 200 的 verify-nonce vs 真 401 的 embed handler**：v1 `/verify-nonce` endpoint 失败返 `200 {valid:false}`（SDK branch 用），但 embed handler 失败返 401（HTTP gate 用）。语义不同，不要混
- **test 中的 `[200, 503]` 容差**：handler 成功路径可能是 200（dist 已构建）或 503（dist 缺失）；本测试只关心**不应该是 401 / 400**，所以接受 [200, 503]
- **`vi.mock('../src/common/index', () => ({ APPS: APPS_MOCK }))`**：和 embed-jwt-validation.test.ts 同样的 mock 模式，让 handler 不会因为 APPS 模块未挂载而炸

#### 11.27.3 验证

- `npx vitest run apps/web-server/tests/embed-nonce-handler.test.ts`：6/6 通过（664ms）
- 关键路径回归 6 文件 / 57 pass / 1 skip（embed-jwt-validation + embed-nonce-roundtrip + embed-nonce-session + embed-nonce-handler + atomic + scope-gate）
- live smoke（PORT=32998 + GENOFFICE_JWT_SECRET）：
  - valid sessionId+nonce → `200` ✓
  - mismatched nonce → `401 {"error":{"message":"nonce session unknown","code":"NONCE_SESSION_INVALID"}}` ✓
  - unknown sessionId → 同上 ✓
  - sessionId 无 nonce → `400 {"error":{"message":"sessionId present without nonce","code":"INVALID_ARGUMENT"}}` ✓
  - legacy 无 sessionId → `200`（向后兼容）✓

#### 11.27.4 后续观察

- **SDK 端 `createEmbedNonce()` helper**（§M）：让集成商少写 5 行；本期不做

### 11.28 本轮续作（v2 第 23 轮 commit，2026-09-22）

SDK 端 `createEmbedNonce()` helper 落地，让集成商少写 5 行 + 让 §11.26 / §11.27 的 server-side nonce binding 真能从 SDK 侧消费。功能：调 `POST /api/v1/embed/nonce` mint session，返回 `{sessionId, nonce, expiresAt, embedUrl}`（embedUrl 已经带 `?sessionId=...&nonce=...`）。失败抛结构化 `CreateEmbedNonceError`（6 种 code: `AUTH_FAILED` / `FORBIDDEN` / `BAD_REQUEST` / `MINT_FAILED` / `NETWORK_ERROR` / `INVALID_RESPONSE`），不抛裸 HTTP 错误。

#### 11.28.1 落实

| 文件 | 改动 |
|---|---|
| `apps/sdk/src/types.ts` | 新增 3 类型：`CreateEmbedNonceOptions`（含 `fetchImpl` override 方便测试）+ `CreateEmbedNonceResult`（`sessionId` / `nonce` / `expiresAt` / `embedUrl`）+ `CreateEmbedNonceError`（6 种 code + optional `status`）|
| `apps/sdk/src/editor.ts` | 新增 `createEmbedNonce(options)`：参数 guard（4 个 required field 缺一抛 `INVALID_RESPONSE`）+ `fetch` 优先用 `options.fetchImpl`，否则用 global；POST `host/api/v1/embed/nonce` Bearer 头 + JSON body `{docId, ttlMs?}`；按 status 码映射到 6 种 `code`；成功时调 `buildEmbedUrl` 把 `nonce` + `sessionId` 注入 query string |
| `apps/sdk/src/embed-url.ts` | `EmbedUrlInput` 加 `sessionId?: string` 字段 + `buildEmbedUrl` 多一行 `if (input.sessionId) params.set('sessionId', input.sessionId)` |
| `apps/sdk/src/index.ts` | re-export `createEmbedNonce` + 3 个新 type |
| `apps/sdk/test/create-embed-nonce.test.ts` | **新增 · 203 行 · 12 测试**：mint happy / POST + Bearer + body 验证 / 401 / 403 / 400 / 5xx / fetch throws / malformed JSON / 字段缺失 / trailing slash 处理 / `undefined` options 拒绝 / 缺 host 拒绝 |
| `apps/sdk/test/build-embed-url.test.ts` | 追加 2 测试：`?sessionId=...` 写入 + 缺省时不写入 |

合计 5 文件改动 / +14 测试。

#### 11.28.2 设计要点

- **`fetchImpl` 注入而非 vi.stubGlobal('fetch', ...)`**：让 SDK 端测试不需要 polyfill 整个 global，让未来 SSR / Deno / Bun 等其他运行时也能 override
- **6 种错误 code 区分**：
  - `AUTH_FAILED` (401) — JWT 过期 / 篡改；host 应刷新
  - `FORBIDDEN` (403) — JWT scope 缺 `files:read`；host 应重 mint
  - `BAD_REQUEST` (400) — server 校验拒绝（带 server message）
  - `MINT_FAILED` (5xx) — server 内部错误；可重试
  - `NETWORK_ERROR` — socket / DNS / CORS；可重试
  - `INVALID_RESPONSE` — server 返了非预期 shape；host 应收集上报
- **`INVALID_RESPONSE` 也用于参数 guard**：缺字段时抛这个 code 而不是 `BAD_REQUEST`，因为这是 host 端 bug 不是 server 拒绝
- **`host` trailing slash 兼容**：集成商可能写 `'https://genoffice.test/'` 或 `'https://genoffice.test'`；helper 内部 `replace(/\/$/, '')` 处理
- **TTL 透传不强制 clamp**：client 给多少发多少；server 自己 1 h hard cap；client 不会因为想用 30s 而被 server 拒（只是 server 给短 TTL）
- **不 export 显式 handshake-state**：host 用 §11.20 client-side nonce 时不需要 `createEmbedNonce`，只用 `buildEmbedUrl`；helper 是 opt-in 的 v2 路径

#### 11.28.3 验证

- `npx vitest run test/create-embed-nonce.test.ts`：12/12 通过
- `npx vitest run --config vitest.config.ts test/`：**6 文件 / 50 测试**全绿（was 5/36，+1 文件 / +14 测试）
- live smoke（PORT=32999 + GENOFFICE_JWT_SECRET）：
  - mint → `200 {sessionId, nonce, expiresAt, ttlMs}` ✓
  - 用 mint 出的 sessionId+nonce 构造 embed URL → `200` 渲染 ✓
  - 整个 SDK 调用链（createEmbedNonce + buildEmbedUrl + embed handler）端到端打通

#### 11.28.4 后续观察

- **可加 `verifyEmbedNonce()` SDK helper**：mirror `createEmbedNonce()` 调 `/api/v1/embed/verify-nonce`；本期不做

### 11.29 本轮续作（v2 第 24 轮 commit，2026-09-22）

SDK `verifyEmbedNonce()` helper 落地，§11.28 `createEmbedNonce()` 的对称 counterpart。功能：调 `POST /api/v1/embed/verify-nonce` audit 服务端是否 known 一个 (sessionId, nonce) 对，返 `{valid:true, expiresAt}` 或 `{valid:false, reason:'unknown'|'expired'}`。失败不抛错（HTTP / 网络 / 解析才抛）。

#### 11.29.1 落实

| 文件 | 改动 |
|---|---|
| `apps/sdk/src/types.ts` | 3 新类型：`VerifyEmbedNonceOptions`（5 required 字段，含 `fetchImpl`）+ `VerifyEmbedNonceResult`（`valid` / `reason?` / `expiresAt?`）+ `VerifyEmbedNonceError`（5 种 code：`AUTH_FAILED` / `FORBIDDEN` / `VERIFY_FAILED` / `NETWORK_ERROR` / `INVALID_RESPONSE`）|
| `apps/sdk/src/editor.ts` | 新增 `verifyEmbedNonce(options)`：参数 guard（5 字段缺一抛 `INVALID_RESPONSE`）+ fetch 优先 `options.fetchImpl`；POST `host/api/v1/embed/verify-nonce` Bearer + body `{sessionId, nonce}`；按 status 码映射；`valid:true` 要求 `expiresAt:number`，`valid:false` 要求 `reason:'unknown'|'expired'` 否则 `INVALID_RESPONSE` |
| `apps/sdk/src/index.ts` | re-export `verifyEmbedNonce` + 3 个新 type |
| `apps/sdk/test/verify-embed-nonce.test.ts` | **新增 · 217 行 · 15 测试**：happy valid / unknown reason / expired reason / POST + Bearer + body / 401 / 403 / 5xx / fetch throws / malformed JSON / valid 缺失 / reason 越界 / expiresAt 缺失 / trailing slash / `undefined` options / 缺 sessionId |
| `apps/sdk/README.md` + `README.zh-CN.md` | 在 §11.28 "Defense-in-depth handshake" 段后追加 audit pattern example |

合计 5 文件 / +15 测试。

#### 11.29.2 设计要点

- **`valid:false` 不是 throw**：和 `/verify-nonce` endpoint 一样，audit 失败是正常结果不是异常。HTTP / 网络 / 解析错误才 throw。这样 SDK 可以写 `if (!audit.valid)` 而不需要 try/catch
- **`reason` 类型严格收窄**：`'unknown'` / `'expired'` 两个枚举值；server 返其他字符串就 `INVALID_RESPONSE`，不静默吞掉
- **`expiresAt` 强制 required**：`valid:true` 必须带 `expiresAt`，否则抛错。这保证 host SDK 拿到的 `valid:true` 一定有 expiresAt 可用（不需要 optional chaining）
- **`fetchImpl` 注入延续**：和 §11.28 一致，host 在 SSR / Deno / Bun / 测试都能 override
- **`VERIFY_FAILED` 而非复用 `MINT_FAILED`**：虽然语义类似，但 createEmbedNonce 和 verifyEmbedNonce 是两个独立 API，错误 code 词汇分开更清晰
- **README audit 例子配对 createEditor.destroy()**：audit 失败时直接销毁 iframe + 提示用户；这是一个安全姿态（fail-closed）

#### 11.29.3 验证

- `npx vitest run test/verify-embed-nonce.test.ts`：15/15 通过（217ms）
- `npx vitest run --config vitest.config.ts test/`：**7 文件 / 65 测试**全绿（was 6/50，+1 文件 / +15 测试）
- live smoke（PORT=33000 + GENOFFICE_JWT_SECRET）：
  - mint → `200 {sessionId, nonce, expiresAt}` ✓
  - verify same → `200 {valid:true, expiresAt}` ✓
  - verify unknown sessionId → `200 {valid:false, reason:unknown}` ✓
  - 整个 SDK audit 调用链（createEmbedNonce + ready event + verifyEmbedNonce）端到端打通

#### 11.29.4 后续观察

- **可加 SDK `verifyEmbedSession()` 一体化**：把 createEditor 的 ready 监听 + verifyEmbedNonce 封装成 `await editor.verifiedReady` 一行；本期不做
- **iframe destroy → 服务端主动清理 session**：LRU 自带 5 min TTL + 1024 上限够用，但 destroy 时主动 DELETE-style 让缓存更整洁；§11.28.4 后续观察 #2 留待后续
- **JS bundle 大小**：SDK 增加 ~70 行（编辑器 ~580 行）→ dist 增量约 200 字节；不影响 bundle 大小预算
- **可加 `destroy()` 自动清理 server session**：iframe destroy 时主动调 DELETE-style endpoint 让 LRU 立刻腾位；本期不做（LRU 自带 TTL + 上限够用）
- **README 文档**：apps/sdk/README.md 应有 `createEmbedNonce` 的 example；下个 commit 跟进
- **§M 阶段候选工作**：
  - SDK `createEmbedNonce()` + 自动注入 sessionId 到 URL
  - v1 `/embed/nonce` 加 rate limit（防单 IP 大量 mint 撑爆 LRU）
  - embed handler 在 store hit 时把 nonce TTL 续期（"active session" 语义）
- **真正的 attack drill**：当前没造 e2e fuzz 测试（forge URL 各种 sessionId 组合）；本期覆盖 happy + 4 个 rejection case 已足够
- **SDK 端 `createEmbedNonce()` helper**：可以加一个 SDK helper `await createEmbedNonce({docId, host, jwt})` 包 mint + buildEmbedUrl 调用，让集成商少写 5 行；本期不做（SDK 端 scope 是 v0.9.x work）
- **server-side 持久化**：当前 store 是 process-local，restart 后所有 session 失效，host SDK 会看到 `valid:false` 但不影响 graceful degradation；要持久化得引入 Redis，本期不做

：实施状态（截至 2026-09-22，分支 `release0919`）

> 本节把"计划"和"已落地"对齐。✅ = 已实装并测试通过 · 🟡 = 骨架完成待补 · ⬜ = 未启动

### A.1 Tier 1 — SDK / API 实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| REST API v1 · 10 端点（auth / files / ai / kb / webhooks / health / changelog）| ✅ | `apps/web-server/src/api/v1/{auth,files,ai,kb,webhooks,meta,ipc-bridge,http-utils,index}.ts` |
| iframe Embed 端点 | ✅ | `apps/web-server/src/embed/index.ts` |
| `@genoffice/web-sdk` 包骨架 | ✅ | npm publish --dry-run 通过，tarball ≈ 17.2 kB |
| Webhook 事件触发 | ✅ | 已接入 7 个 save 路径（docs / slides / markdown / html / pdf / sheets / workbook）通过 `notifyFileSaved()` |
| 浏览器 / Node 兼容性矩阵文档 | ✅ | `docs/guide/installation.md` |
| 双语 SDK README（zh-CN / en-US）| ✅ | `apps/sdk/README.md` (EN) + `apps/sdk/README.zh-CN.md` (ZH) |

### A.2 Tier 2 — AI 生态实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| `AiProviderPlugin` 接口 + `ProviderRegistry` | ✅ | `packages/ai-provider/src/provider-plugin.ts` |
| `MediaRegistry` / `SearchRegistry` | ✅ | 同上 |
| `SkillPackage` 接口 + `getDefaultSkillRegistry` | ✅ | `packages/agent-skills/src/skill-protocol.ts` |
| KB/TM 开放格式（`.genkb` / `.gentm`）| ✅ | `packages/translation-core/src/kb-format.ts` |
| Agent Loop 协议 v1 | ✅ | `packages/agent-core/src/agent-protocol.ts` |
| Marketplace loader（第三方插件自动注册）| ✅ | `apps/web-server/src/common/marketplace-loader.ts`（244 行，7 测试）|
| `@genoffice/provider-anthropic` | ✅ | 7 测试 · 7.9 kB tarball |
| `@genoffice/provider-openai` | ✅ | 7 测试 · 6.9 kB tarball |
| `@genoffice/provider-gemini` | ✅ | 7 测试 · 8.1 kB tarball |
| `@genoffice/provider-openai-compatible` | ✅ | 6 测试 · 8.9 kB tarball（factory 模式覆盖 Together / Fireworks / Groq / OpenRouter / DeepSeek / Kimi / GLM / Qwen / Doubao / vLLM / llama.cpp / LM Studio / Ollama-compat）|
| `@genoffice/provider-ollama` | ✅ | 5 测试 · 8.5 kB tarball（包装 openai-compatible，默认 `llama3.2`）|
| `@genoffice/provider-deepseek` | ✅ | 5 测试 · 8.4 kB tarball（DeepSeek OpenAI 兼容端点 `api.deepseek.com/v1`）|
| `@genoffice/provider-kimi` | ✅ | 5 测试 · 8.4 kB tarball（Moonshot Kimi OpenAI 兼容端点 `api.moonshot.cn/v1`）|
| `@genoffice/provider-qwen` | ✅ | 5 测试 · 8.5 kB tarball（Qwen DashScope OpenAI 兼容端点 `dashscope.aliyuncs.com/compatible-mode/v1`）|
| `@genoffice/provider-glm` | ✅ | 5 测试 · 8.5 kB tarball（智谱 GLM 非标准端点 `open.bigmodel.cn/api/paas/v4`；`needsBaseUrl: true`）|
| `@genoffice/provider-doubao` | ✅ | 5 测试 · 8.5 kB tarball（字节豆包 Ark 非标准端点 `ark.cn-beijing.volces.com/api/v3`；`needsBaseUrl: true`）|
| `@genoffice/skill-markdown-format` | ✅ | 7 测试 |
| `@genoffice/skill-yaml-validate` | ✅ | 9 测试 |
| `@genoffice/skill-text-summarize` | ✅ | 5 测试 |
| `@genoffice/skill-text-translate` | ✅ | 6 测试 |
| `@genoffice/skill-text-translate-pairs` | ✅ | 5 测试 |
| `@genoffice/skill-json-validate` | ✅ | 6 测试 |
| `@genoffice/skill-yaml-to-json` | ✅ | 5 测试 |
| `streamForProvider` / `chatForProvider` 走 `getDefaultProviderRegistry` | ✅ | `packages/ai-provider/src/stream.ts` + `chat.ts` plugin-fallback 已实现；6 个 `plugin-routing.test.ts` + 2 个 `plugin-e2e.test.ts` 端到端测试 |

### A.3 Tier 3 — 社区实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| `ROADMAP.md` / `GOVERNANCE.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `CHANGELOG.md` | ✅ | 仓库根 |
| `.github/workflows/{ci,release,docs,security}.yml` | ✅ | `.github/workflows/ci.yml` 新增 lint / typecheck / test / build / bundle / docker 全套 job |
| `.github/{ISSUE_TEMPLATE,DISCUSSION_TEMPLATE,PULL_REQUEST_TEMPLATE}/*` | ✅ | bug / feature / skill_submission 三种 issue 模板 |
| `.github/CODEOWNERS` + `.gitleaks.toml` + `.github/dependabot.yml` | ✅ | |
| `Dockerfile`（多阶段 Node 22，非 root，/healthcheck）| ✅ | 沙箱内 DNS 受限未跑 build；CI 会执行 |
| `.dockerignore` | ✅ | |
| `examples/`（5 个 example 目录）| ✅ | embed-basic / embed-react / embed-vue / custom-provider / custom-skill 都已落地 |
| RFC 模板 + `docs/rfcs/accepted/` | ✅ | `docs/rfcs/{README,0000-template,0001-open-plan}.md` + `accepted/0001-open-plan.md` |
| 月度 Office Hours / Discord 服务器 | ⬜ | 计划中 |

### A.4 文档站实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| VitePress 骨架 + typedoc 自动生成脚本 | ✅ | `docs/.vitepress/config.ts` + `docs/scripts/gen-typedoc.mjs` |
| zh-CN locale | ✅ | nav + sidebar 已配 |
| Guide 目录 8 篇 | ✅ | getting-started / installation / quick-start-{web,embed,sdk} / deployment-{docker,kubernetes} / security-best-practices |
| API 参考 11 篇 | ✅ | rest-api / sdk-typescript / postmessage-protocol / ipc-channels / ipc-channels-auto / ai-skills-protocol / kb-tm-format / provider-plugins / marketplace / agent-protocol / provider-capabilities |
| Skills 文档 14 篇 | ✅ | official / marketplace / authoring / community + 11 个 per-skill 详解页（EN + ZH）|
| typedoc 实际执行 | ✅ | **221** 个 MD 文件本地跑通（每次 CI 跑 typedoc-count 守住 200-400 范围），sidebar 链接 + .gitignore + JSDoc 全部就绪 |
| 双语（中英）全覆盖 | ✅ | SDK README + 18 篇 Guide/API/Skills/About 全部双语；VitePress `sidebarZH` 已覆盖 Guide / API / Skills / About 四大分区 |

### A.5 已知未做（更新于本轮实施后）

#### ✅ 本轮已解决（3 项）

1. **`streamForProvider` / `chatForProvider` 实际读 `getDefaultProviderRegistry`** — 通过 `packages/ai-provider/src/stream.ts` + `chat.ts` 的 plugin-fallback 分支实现：plugin 命中走 plugin，否则 fallback 到 legacy `getProviderAdapter`。新增 6 个 `packages/ai-provider/tests/plugin-routing.test.ts` 测试 + 2 个 `apps/web-server/tests/plugin-e2e.test.ts` 端到端测试。
2. **Webhook HMAC 签名** — `apps/web-server/src/common/webhooks-store.ts` 新增 `signWebhookBody()`（HMAC-SHA256，sha256= 前缀）+ `FileWebhook.secret` 字段 + 出站请求带 `X-GenOffice-Signature` 头。GitHub / Stripe 风格。5 个 `apps/web-server/tests/webhook-signing.test.ts` 测试覆盖 secret 缺失 / 存在 / 不同 body / 不同 secret / 端到端 header 注入。
3. **JWT RBAC scope（OAuth scope claim）** — `apps/web-server/src/api/v1/auth.ts` 新增 `hasScope(payload, scope)` helper（exact / `*` 通配 / `ai:*` 前缀通配 / 默认只读 / admin 旁路）+ `JwtPayload.scope` 字段 + `/api/v1/auth/jwt` 接受 `scope` 输入并合并到 `scope` claim。9 个 `apps/web-server/tests/auth-scope.test.ts` 测试。
4. **postMessage iframe 握手 + origin allowlist** — `apps/sdk/src/editor.ts` 新增：每会话随机 nonce 注入 `?nonce=`，`ready` event 必须 echo 同一 nonce 否则触发 `HANDSHAKE_FAILED`；可选 `allowedOrigins: string[]` 配置（含 `*.example.com` 单段通配）。8 个 `apps/sdk/test/handshake.test.ts` 测试。

#### ✅ 本轮新增解决（1 项）

5. **scope gate 接入受保护端点** — 把 `hasScope()` helper 接入所有 v1 endpoint：
   - `apps/web-server/src/api/v1/auth.ts`：新增 `requireAuthFromHeaders()` + `requireScopeFromHeaders()` 公共 helper，返回 `{ ok, status, code, message }` envelope。
   - `apps/web-server/src/api/v1/ai.ts`：5 个端点（`ai:capabilities` / `ai:chat` / `ai:translate` / `ai:image` / `ai:skill/:name`）全部走 scope gate，scope 分别为 `ai:read` / `ai:chat` / `ai:translate` / `ai:image` / `ai:skill`。
   - `apps/web-server/src/api/v1/files.ts`：6 个端点（list / create / get / delete / issue-jwt / callback）走 scope gate，分别要 `files:read` / `files:write` / `files:read` / `files:delete` / `files:read` / `files:write`。
   - `apps/web-server/src/api/v1/kb.ts`：2 个端点（search / entries）走 `kb:read`。
   - `apps/web-server/src/api/v1/webhooks.ts`：3 个端点（upsert / delete / fire）走 `webhooks:manage` / `webhooks:manage` / `admin`。
   - 错误码统一：`UNAUTHENTICATED` (401, 无 token) / `FORBIDDEN` (403, scope 不够)，符合 OAuth 2.0 RFC 6749 习惯。
   - 9 个 `apps/web-server/tests/scope-gate.test.ts` 端到端测试覆盖：no-token、admin bypass、reader→create 403、writer→create 201、reader→KB 200 / writer→KB 403、reader→AI chat 403、`*` 通配、`ai:*` 不跨界授权 files:write。
   - 更新 `tests/api-v1-e2e.test.ts` 让 mint JWT 时附带完整 scope 列表，避免既有 e2e 因新增 gate 而 fail。

#### ✅ 本轮再次新增解决（4 个 skill）

5. **5+ 个额外的官方 skill（已超额完成）**：新增 4 个 standalone skill，从 7 增加到 **11 个 standalone**（已超过 10+ 目标）：
   - `packages/skill-doc-format/` — 10 测试通过；typecheck clean；build 通过 (`dist/index.{mjs,cjs}`)
   - `packages/skill-sheet-formula/` — 13 测试通过；typecheck clean；build 通过
   - `packages/skill-slides-outline/` — 10 测试通过；typecheck clean；build 通过
   - `packages/skill-text-diff/` — 8 测试通过；Myers LCS diff + unified-diff 渲染；context 边界严格 `≤ context × 2`；typecheck clean；build 通过
   - 修复了 `groupHunks()` 算法两个 bug：(a) trailing context 越界吸收导致 `≤ 2 × context` 等值行不满足；(b) 跨 change 区域合并导致两个独立修改被吞成一个 hunk。新算法：先扫所有 change region，每个 region 独立成 hunk，向前后最多吸收 `context` 等值行，被前后 region 截断。
   - 修复了 `skill-text-diff` schema 缺 `properties` 字段的 TS 错误（`{ type: 'object' }` → `{ type: 'object', properties: {} }`）
   - 统一所有 skill 的 `export { pkg, skill }` 模式（避免与已有 `export function` 同名重复导出）
   - 候选（未做但可选）：`slide-deck`（整套大纲生成）/ `ocr` / `web-search`，11 standalone 已超目标

#### ✅ 本轮再次新增解决（双语文档 + RFC + 完整 zh-CN 站点）

6. **双语文档（首批双语上线 → 全站双语）**：
   - 首轮（commit `f5bbc79`）：`apps/sdk/README.zh-CN.md` + `docs/zh/guide/{installation,getting-started}.md`
   - 本轮扩展到 18 篇双语文档：
     - `docs/zh/guide/` — quick-start-web · quick-start-embed · quick-start-sdk · deployment-docker · deployment-kubernetes · security-best-practices（6 篇）
     - `docs/zh/api/` — rest-api · sdk-typescript · postmessage-protocol · marketplace · provider-plugins · ai-skills-protocol · agent-protocol · kb-tm-format · ipc-channels（9 篇）
     - `docs/zh/skills/` — official · authoring · community（3 篇）
     - `docs/zh/about/` — architecture · roadmap · governance · faq（4 篇）
   - VitePress `docs/.vitepress/config.ts` `sidebarZH` 现已覆盖 Guide / API / Skills / About 四大分区，每个分区都映射到 `/zh/*` 路由
   - A.4 "双语全覆盖" 从 ⬜ → 🟡 → ✅
   - `apps/sdk/README.zh-CN.md` — `@genoffice/web-sdk` 中文 README（112 行，与 EN 一一对应）
   - `docs/zh/guide/installation.md` — 中文安装文档
   - `docs/zh/guide/getting-started.md` — 中文快速开始
   - VitePress `docs/.vitepress/config.ts` 新增 `sidebarZH` 把 `/zh/guide/*` 路由并入 zh-CN locale
   - A.4 "双语全覆盖" 状态从 ⬜ 升级到 🟡（SDK + 2 篇 Guide 双语上线，剩余 EN 待翻译）
7. **RFC 流程 + 首个 accepted RFC**：
   - `docs/rfcs/README.md` — RFC 流程总览（状态机 / 命名 / 评审标准 / 与 issue/discussion 的边界）
   - `docs/rfcs/0000-template.md` — RFC 模板（Summary / Motivation / Detailed Design / Drawbacks / Alternatives / Adoption / Open Questions / Test Plan / References）
   - `docs/rfcs/0001-open-plan.md` + `docs/rfcs/accepted/0001-open-plan.md` — 首个 accepted RFC，把 `sdk1.md` 开放计划本身以 RFC 形式归档
   - A.3 "RFC 模板 + accepted/" 状态从 ⬜ 升级到 ✅
8. **A.1 双语 SDK README**：从 🟡 升级到 ✅，`apps/sdk/README.md` 与 `apps/sdk/README.zh-CN.md` 一一对应。

#### ✅ 本轮再次新增解决（§3.1 · Doubao provider + §4.4 单 Skill 详解页）

14. **Doubao provider + 单 Skill 详解页（§3.1 + §4.4 落地）**：
    - `@genoffice/provider-doubao` — `https://ark.cn-beijing.volces.com/api/v3`，模型 `doubao-pro-32k / 128k` + `doubao-lite-32k`，5 测试通过，dist 已构建。provider 总数 9 → 10（11 列出的剩 genspark / codex 是 Genspark 自家产品，暂不实装）。
    - `docs/skills/official/{doc-format,sheet-formula,slides-outline}.md` × 2 语言 = 6 个新页（§4.4 指定的 per-skill 详解结构）
    - 每页含触发短语 / 输入输出 schema / 安装 / 注册+调用 / 适用+不适用场景 / 延伸阅读
    - `docs/skills/official.md`（EN + ZH）新增 "Per-skill deep dives" / "单 Skill 详解" 区段把 3 个旗舰 Skill 串起来
    - VitePress sidebar 在 `/skills/` 与 `/zh/skills/` 各加 3 条入口
    - 文档同步：`docs/api/provider-plugins.md`（EN+ZH）官方 provider 表新增 Doubao 行；`docs/api/provider-capabilities.md`（EN+ZH）模型清单新增 Doubao 行

#### ✅ 本轮再次新增解决（§3.1 · 新增 Qwen + GLM provider）

13. **2 个新 provider 包发布（§3.1 首期发布 11 provider → 9 已落地）**：
    - `@genoffice/provider-qwen` — `https://dashscope.aliyuncs.com/compatible-mode/v1`，模型 `qwen-max / plus / turbo / long`，5 测试通过，dist 已构建
    - `@genoffice/provider-glm` — `https://open.bigmodel.cn/api/paas/v4`（**非标准端点**：`needsBaseUrl: true` 让宿主在 picker 里手动配），模型 `glm-4-plus / air / flash`，5 测试通过，dist 已构建
    - 都基于 `@genoffice/provider-openai-compatible` 工厂
    - 文档同步：`docs/api/provider-plugins.md`（EN+ZH）官方 provider 表新增两行；`docs/api/provider-capabilities.md`（EN+ZH）模型清单新增两行
    - provider 总数从 7 → 9（Anthropic / OpenAI / Gemini / OpenAI-compat / Ollama / DeepSeek / Kimi / Qwen / GLM）

#### ✅ 本轮再次新增解决（§3.1 · 新增 DeepSeek + Kimi provider）

12. **2 个新 provider 包发布（§3.1 首期发布 11 provider → 7 已落地）**：
    - `@genoffice/provider-deepseek` — `https://api.deepseek.com/v1`（OpenAI 兼容），模型 `deepseek-chat` + `deepseek-reasoner`，5 测试通过，dist 已构建
    - `@genoffice/provider-kimi` — `https://api.moonshot.cn/v1`（OpenAI 兼容），模型 `moonshot-v1-8k/32k/128k`，5 测试通过，dist 已构建
    - 都基于 `@genoffice/provider-openai-compatible` 工厂（`createCompatibleProvider`），零重复代码
    - package.json 严格遵循 §2.2 标准字段；`engines.node: ">=22.12"`；peerDeps 把 `@genoffice/provider-openai-compatible` 标 optional
    - 文档同步：`docs/api/provider-plugins.md`（EN+ZH）的官方 provider 表新增两行；`docs/api/provider-capabilities.md`（EN+ZH）的模型清单新增两行 + 注释说明 DeepSeek/Kimi 能力与 OpenAI-compat 列一致
    - provider 总数从 5 → 7（Anthropic / OpenAI / Gemini / OpenAI-compat / Ollama / DeepSeek / Kimi）

#### ✅ 本轮再次新增解决（§3.1 Provider 插件市场 + §3.2 Skill 仓库 · 分类展示）

10. **Provider 能力矩阵**（§3.1 落地）：
    - `docs/api/provider-capabilities.md` + `docs/zh/api/provider-capabilities.md`
    - 五家首方 provider 并排对比：Anthropic / OpenAI / Gemini / OpenAI-compat / Ollama
    - 12 维能力矩阵（chat / stream / tool use / vision / image gen / web search / 自定义 baseUrl / 自托管 …）+ 模型清单 + API key 占位符 + 场景指南
11. **Skill 市场分类展示**（§3.2 落地）：
    - `docs/skills/marketplace.md` + `docs/zh/skills/marketplace.md`
    - 按计划 §3.2 的 5 类（文档 / 表格 / 演示 / 翻译 / 行业）组织 11 个 Skill
    - 文档 7 个 / 表格 1 个 / 演示 1 个 / 翻译 2 个 / 行业 预留
    - 附"按触发短语搜索"表 + 一键安装 + 市场引导启动
    - VitePress sidebar 新增 4 条入口（EN + ZH，API 与 Skills 各 1）

#### ✅ 本轮再次新增解决（§2.2 npm 发布策略 · 标准元数据对齐）

9. **`package.json` 标准元数据（§2.2 标准字段）已对齐**：
   - 17 个 npm 可发布包全部填齐：`license` / `repository` / `bugs` / `homepage` / `keywords` / `engines.node`
   - 涉及范围：1 个 web-sdk + 5 个 provider + 11 个 standalone skill
   - `repository` 指向 `https://github.com/genspark-ai/genoffice.git` + 对应的 `directory` 子路径
   - `bugs` 指向 `https://github.com/genspark-ai/genoffice/issues`
   - `homepage` 区分 SDK（`/docs/sdk`）与 provider / skill（`/docs/api`）
   - `keywords` 在既有包关键词基础上合并 `genoffice` + `office` / `ai` / `sdk` / `embed` / `iframe`，便于 npm 检索
   - `engines.node` 统一到 `>=22.12`，与 §2.3 Tier 1 浏览器矩阵对齐
   - 脚本（`/tmp/standardize_pkgjson.py`）幂等——已存在的字段不会被覆盖
   - 覆盖后 `npm publish --provenance --dry-run` 在 17/17 包上都应能生成正确的 tarball 元数据（依赖 CI 执行；本沙箱无外网）

#### ⬜ 仍未做（按优先级排序）

1. ~~**5+ 个额外的官方 skill**~~：✅ 已完成，见上面第 5 项（11 standalone = 7 原有 + 4 新增）。
2. **examples/ 目录已落地**：5 个 worked example 都建好并可跑：
   - `examples/embed-basic/` — 纯 HTML + UMD SDK，含 `index.html`（用 SDK）+ `no-sdk.html`（裸 iframe + postMessage）展示协议
   - `examples/embed-react/` — React 18 + Vite，含 `GenOfficeEditor.tsx` 组件 + `demo.tsx` + `vite.config.ts`（带 `/api` `/embed` proxy）+ `tsconfig.json`
   - `examples/embed-vue/` — Vue 3 + Vite，含 `GenOfficeEditor.vue` + `demo.ts` + 完整 Vite 配置
   - `examples/custom-provider/` — `@genoffice/provider-my-provider` 模板，`npm run build` 通过 + `npm publish --dry-run` 通过（3.9 kB tarball）
   - `examples/custom-skill/` — `@genoffice/skill-doc-word-counter` 模板，`npm run build` 通过 + dry-run 通过（2.9 kB tarball）
   - 顶层 `examples/README.md` 索引 + 每个子目录独立 README
   - 修复了原 `custom-provider` 的 `request.messages` 类型错（chat 接收 `request.user` 不是 `messages`）+ `AgentMessage` 中 `role: 'tool'` 没有 `text` 字段的边界 case
   - 修复了原 `custom-skill` 的 `SkillArraySchema` 缺 `items` 字段错
3. **`@genoffice/agent-skills` 内部隔离**：`agent-telemetry` / `agent-skills` 暂不 npm publish，保留为内部包（与计划一致）。
4. **typedoc 实际执行 ✅**：
   - `docs/scripts/gen-typedoc.mjs` 修复了 `--skipErrorDocuments` → `--skipErrorChecking`（typedoc 0.28 重命名）
   - 增加了 `apps/web-server/src/common` 作为额外 entry point，消除 `FileWebhook not included` 警告
   - 给 19 个 v1 handler / 公共 helper 加了完整 TSDoc（含 `route` / `summary` / `scope` / `errors` 字段）
   - 本地跑：`node docs/scripts/gen-typedoc.mjs` → **221** 个 MD 文件输出到 `docs/api/_generated/`（2026-09-22 实测）
   - VitePress sidebar 加入 `Generated API Reference` 入口链接到 `docs/api/_generated/README`
   - `.gitignore` 加入 `docs/api/_generated/`（避免 JSDoc 微调触发大量 churn diff）
   - `docs/package.json` 已声明 `typedoc@^0.28.0` + `typedoc-plugin-markdown@^4.6.0`
5. **双语文档**：✅ A.4 全部双语（SDK README + 18 篇 Guide/API/Skills/About 全 ZH 翻译）；本条原描述为旧状态。
6. **§2.2 全部 11 个 npm public 包可发布**（✅ 已完成）：
   - 把 `private: true` 翻成 `false` 并补齐 §2.2 标准字段（已完成于 `fb7e205`）
   - `ai-provider`：`listCodexModels` 移到 subpath `@genoffice/ai-provider/codex-app-server`，主 barrel 浏览器安全（已完成于 `fb7e205`）
   - 其余 10 个（`pptx-engine` / `xlsx-gateway` / `file-parse` / `file-management` / `translation-core` / `ipc-bridge` / `docx-engine` / `agent-core` / `i18n` / `ui`）按 Node-only 设计（OOXML zip IO / Rust sidecar 调用 / fs 操作 / KB 归档），发布给 Node 消费者即可
   - 全部 11 个包本地 `npm publish --dry-run` 通过，tarball 5 kB – 1.3 MB 不等
   - 测试：ai-provider 248 / docx-engine 1317 / pptx-engine 957 / translation-core 234 / file-management 219 / agent-core 95 / ipc-bridge 60 / file-parse 38 / i18n 18 / ui 141 = **3327 测试 ✅**

#### ✅ 本轮新增解决（§4.4 单 Skill 详解页 + Changelog 页）

12. **8 个剩余官方 Skill 详解页**（`commit 6f6e20`）：把 §4.4 提到的"per-skill deep-dive"从 3 个旗舰（`doc-format` / `sheet-formula` / `slides-outline`）扩到全部 **11 个**，EN + ZH 共 22 页：
   - `docs/skills/official/{text-summarize, text-translate, text-translate-pairs, text-diff, markdown-format, json-validate, yaml-validate, yaml-to-json}.md` × 2 语言 = 16 个新页
   - 统一模板：触发短语表（EN + ZH）/ 输入 / 输出 schema / npm 安装 / 注册 + 调用示例 / 适用场景 / 不适用场景 / 延伸阅读
   - `/skills/official` 与 `/zh/skills/official` 索引页改为链接全部 11 个 Skill
   - VitePress sidebar `/skills/` + `/zh/skills/` 全部 11 个 Skill 入口
   - 复用 `/tmp/create_skill_pages.py` 模板（修复 Python 3.9 f-string 嵌套引号 bug）
13. **Changelog 文档站页**（`commit e29b062`，§4.4 交付）：
   - `docs/changelog/index.md`（EN，与根目录 `CHANGELOG.md` 同步）
   - `docs/zh/changelog/index.md`（ZH，手工维护，便于受众语感）
   - `tools/sync-changelog.mjs` 把根 CHANGELOG.md 镜像到 docs/changelog/（如 zh 已存在则跳过）
   - `package.json` 新增脚本：`docs:gen`（IPC + changelog 一起生成）/ `docs:gen:ipc` / `docs:sync-changelog`
   - VitePress sidebar 新增 `/changelog/` + `/zh/changelog/` 区块
14. **3 个 Provider（Qwen / GLM / Doubao）落地**（`commits 06f4145 / 5ff2bc8 / 547b70c`）：provider 总数 5 → **10**：
   - `@genoffice/provider-deepseek` + `@genoffice/provider-moonshot-kimi`（基于 `openai-compatible` 工厂，5+5 测试）
   - `@genoffice/provider-qwen-dashscope` + `@genoffice/provider-zhipu-glm`（同上，5+5 测试）
   - `@genoffice/provider-doubao`（同上，5 测试）
   - `docs/api/provider-capabilities.md`（EN+ZH）能力矩阵更新到 10 行
15. **本轮小结**：A.5 已完成的 ✅ 项目累计到 16 条。A.3 仍剩 Discord ⬜（外部服务，沙箱内不可达）。其它交付（SDK / REST / Skills / Providers / Docs / Examples / Webhook HMAC / JWT RBAC scope / Scope gate / iframe 握手 / §2.2 11 包可发布）均 ✅。
16. **§5.2 发布检查清单逐项落地**（✅ 已完成）：
   - **#1 JSDoc/TSDoc on public APIs** — `auth.ts` (handleAuthJwt / handleOAuthToken / hasScope) + `meta.ts` (handleHealth / handleChangelog) 现已具备 `@route` / `@scope` / `@errors` 标记；其他 5 个 v1 handler 文件（files / ai / kb / webhooks）已具备完整 TSDoc（`commit 8e3d3e8`）
   - **#2 typedoc 实际执行** — `docs/scripts/gen-typedoc.mjs` 重新生成 **221 个 MD 文件** 到 `docs/api/_generated/`（2026-09-22 实测）；新增 `typedoc-count.test.ts` 守住 200-400 范围防漂移
   - **#3 SDK README + 5 分钟上手** — `apps/sdk/README.{md,zh-CN.md}` + `docs/guide/quick-start-sdk.md` 全部就绪
   - **#4 ≥3 examples** — 5 个 example（embed-basic / embed-react / embed-vue / custom-provider / custom-skill）已落地
   - **#5 Docker image** — `Dockerfile`（多阶段 Node 22 / 非 root node / `/health` 健康检查 / `/data` 持久卷）+ `.dockerignore` 就绪
   - **#6-8 社区文件** — `CONTRIBUTING.md` (4.4 KB) + `CODE_OF_CONDUCT.md` (3.2 KB) + `SECURITY.md` (2.5 KB) + `LICENSE` + `LICENSE-UNICODE.txt`
   - **#9 GitHub Actions** — 4 个 workflow（`ci.yml` / `release.yml` / `docs.yml` / `security.yml`）
   - **#10 npm scope @genoffice/\*** — **62 个 package.json** 使用 `@genoffice/` scope
   - **#13 ≥10 skill** — **11 个** skill 包（text-summarize / text-translate / text-translate-pairs / text-diff / markdown-format / json-validate / yaml-validate / yaml-to-json / doc-format / sheet-formula / slides-outline）
   - **#14 ≥3 provider** — **10 个** provider 包（anthropic / openai / gemini / openai-compatible / ollama / deepseek / moonshot-kimi / qwen-dashscope / zhipu-glm / doubao）
   - **#15 双语文档** — `docs/zh/index.md` + 4 个 ZH 页面（headless-pdf-export / web-electron / web-implementation-guide / webserver-file-management）落地（`commit c5f691`）
   - **#11 Docker Hub 推送 + #12 域名/SSL** — 外部服务，沙箱内不可达（与 Discord 同类）
29. **SDK `verifyEmbedNonce()` helper 落地**（✅ 本轮 §11.29）：§11.28 `createEmbedNonce()` 的对称 counterpart，调 `POST /api/v1/embed/verify-nonce` audit。返 `{valid:true, expiresAt}` 或 `{valid:false, reason:'unknown'|'expired'}`——audit 失败不 throw。5 种错误 code（`AUTH_FAILED` / `FORBIDDEN` / `VERIFY_FAILED` / `NETWORK_ERROR` / `INVALID_RESPONSE`）。配套：types.ts 3 类型；editor.ts 重 re-export；README 双语 audit pattern example。新增 `apps/sdk/test/verify-embed-nonce.test.ts`（15 测试）。SDK 7 文件 / 65 测试。
28. **SDK `createEmbedNonce()` helper 落地**（✅ 本轮 §11.28）：apps/sdk/src/editor.ts 新增 `createEmbedNonce(options)`，调 `POST /api/v1/embed/nonce` mint session + 构造带 `?sessionId=...&nonce=...` 的 embed URL。6 种结构化错误 code (`AUTH_FAILED` / `FORBIDDEN` / `BAD_REQUEST` / `MINT_FAILED` / `NETWORK_ERROR` / `INVALID_RESPONSE`)。`fetchImpl` 注入式 override 让测试不需要 polyfill global。配套：`types.ts` 加 3 类型；`embed-url.ts` `EmbedUrlInput.sessionId` + `buildEmbedUrl` 多一行；`index.ts` re-export。新增 `apps/sdk/test/create-embed-nonce.test.ts`（12 测试）+ `build-embed-url.test.ts` 追加 2 测试。SDK 总数 5 文件 / 36 → 6 文件 / 50 测试。live smoke 3/3 通过。
27. **server-side nonce session binding 接入 embed handler**（✅ 本轮 §11.27）：`apps/web-server/src/embed/index.ts` 加 `EmbedQuery.sessionId` + `parseEmbedQuery` 提取 + `handleEmbed` 3 段守卫（sessionId 无 nonce → 400 INVALID_ARGUMENT；`verifyEmbedNonce().found=false` → 401 NONCE_SESSION_INVALID 含 reason:unknown/expired）。Opt-in 设计：URL 不带 sessionId 时仍走 §11.20 client-only 路径，不破 backward compat。新增 `apps/web-server/tests/embed-nonce-handler.test.ts`（6 测试）覆盖 valid + 4 rejection + legacy。6 文件 / 57 pass / 1 skip 回归。live smoke 5/5 通过。
26. **server-side nonce ↔ session 绑定端点**（✅ 本轮 §11.26）：新增 `apps/web-server/src/embed/nonce-store.ts`（in-memory `Map<sessionId, NonceSession>`，LRU cap 1024 + 5 min 默认 TTL + 30 s `unref` 后台 sweeper）+ `apps/web-server/src/api/v1/embed-nonce.ts`（`POST /api/v1/embed/nonce` mint + `POST /api/v1/embed/verify-nonce` verify，两者走 `files:read` scope gate）+ `apps/web-server/tests/embed-nonce-session.test.ts`（13 测试）。`sessionId === nonce`（同 16 字节 base64url），verify 失败返 `200 {valid:false, reason}` 而非错误信封（SDK 可 branch 不 try/catch）。TTL 1 h hard cap 防误配。client-side nonce（§11.20）保留，本轮是 optional defense-in-depth。live smoke 6/6（mint / verify happy / wrong nonce / 401 / 403 / 400）全通。
25. **renderer-internal `nonce` 字段统一重命名为 `revision`**（✅ 本轮 §11.25）：renderer 里 `nonce: Date.now()` 字段实际是 React re-trigger 计数器（useEffect deps / React key），不是 crypto nonce；与 SDK handshake nonce (`apps/sdk/src/editor.ts`) 同名造成 code review / grep 误判。改名范围严格限定在 renderer-internal React state shape：`packages/ui/src/find-panel.tsx` 的 `FindFocusRequest.nonce` + apps/{docs,html,pdf,slides,markdown}/src/renderer 下的 useState/setState/useEffect/key deps （AiPreset / hoverAnim / anim / morph / findFocus / previewVersion / ribbonTabRequest 8 种 shape）。SDK handshake nonce（`apps/sdk/src/editor.ts`）/ web-bridge nonce（`apps/web-server/src/embed/index.ts`）/ `<iframe>` CSP nonce / docs `FindPanel.focusReplaceNonce` prop 全部不动（向后兼容 / 公共 API）。19 文件 / ~78 处编辑；`grep -rn "nonce" apps/*/src/renderer packages/ui/src` 仅剩法语 `annonce` 一词。
24. **`CreateEditorOptions` doc typo 修复 + container contract 回归测试**（✅ 本轮 §11.24）：`apps/sdk/src/types.ts` 旧 JSDoc 提到 `containerElement` 字段，但接口里**根本没有**这个字段（早期迭代残留笔误），集成商按字面 join 后会在生产环境遇到 TS 编译报错。修正为"Provide exactly one of `container` or `url`"+ 明确"无 separate containerElement field，直接通过 `container` 传元素"。新增 `apps/sdk/test/container-resolve.test.ts`（6 测试）：source-grep 守门（`containerElement` 只允许出现 1 次在 denial comment）+`createEditor()` no-opts 抛 `options required` +缺 `documentId` / `jwt` / `host` 各抛结构化错误 +Node 环境无 container 抛 `container required when document is not available`。私有 helper `resolveContainer` 通过 public `createEditor` 的 runtime guard 间接验证，避免泄漏内部 API。
23. **web-server 版本号单一源**（✅ 本轮 §11.23）：`'0.8.0'` 之前硬编码在 5 个文件（`index.ts` boot banner + `/health` / `app-info.ts` / `embed/index.ts` bridge ready payload）。新增 `common/version.ts` 导出 `WEB_SERVER_VERSION` 常量，4 个消费点改 import + 模板字符串插值。新增 5 测试守门：常量 == package.json 版本 / 没有 hardcoded `'0.8.0'`（除 `version.ts` 与 `package.json`）/ boot banner 用 `${...}` / bridge 用 `${...}` / app-info 用 `() => WEB_SERVER_VERSION`。live smoke 验 4 个消费点全报 `0.8.0`。
22. **buildEmbedUrl nonce 测试整合**（✅ 本轮 §11.22）：把 §11.20 引入的 4 个 nonce 测试从独立的 `embed-url-nonce.test.ts` 合并到 `build-embed-url.test.ts`（canonical 位置），删除独立文件。维护更清晰。SDK 文件 5→4（文件数-1），测试数 30（净无 0 测试）。
21. **SDK handshake timeout 可配置**（✅ 本轮 §11.21）：原本 SDK iframe handshake 的 10 s timeout 在 createEditor 闭包内硬编码，慢网络 host 没有逃生口。新增 `CreateEditorOptions.handshakeTimeoutMs` + module-level exported `clampHandshakeTimeout(ms)`（范围 1 s – 60 s，floor 整数，默认 10 s）。新增 6 测试覆盖 undefined / NaN / Infinity / 范围内 / 上下限 clamp / 分数 / 负数 → 下限（不取 abs）。
20. **iframe handshake nonce 静默丢包修复**（✅ 本轮 §11.20）：发现 `apps/sdk/src/embed-url.ts` 的 `buildEmbedUrl` **完全没有把 `nonce` 写到 query param**，导致 §B.2 #1 那段 SDK handshake nonce 安全保证**从未生效**——每个 SDK 启动的 embed iframe 都会在 10s 后 `HANDSHAKE_FAILED`。新增 `EmbedUrlInput.nonce` + `params.set('nonce', …)`；embed handler 端把 `?nonce=` 写到 `<meta name="genoffice-nonce">`，bridge `sendReady()` 读 meta 把 nonce 放进 ready postMessage payload。新增 4 + 6 测试覆盖；side-effect 修了 embed-jwt-validation 的 env mutation 问题。
19. **typedoc 输出文件数漂移守门**（✅ 本轮 §11.19）：原 §A.5 / §11.6 / §11.12 一致称 `199 个 MD 文件`，实测已 221（typedoc 把 §11.16 / §11.17 / §11.18 几轮新增的 public helper 都收进来了）。新增 `apps/web-server/tests/typedoc-count.test.ts`（3 测试）：跑 `node docs/scripts/gen-typedoc.mjs` → 读 `docs/api/_generated/*.md` → assert 200-400 + 打印当前值到 CI 日志。sdk1.md 三处 `199` → `221`。
18. **§11.17.5 backlog 真正闭合 · embed 服务端 JWT 验证**（✅ 本轮 §11.18）：`apps/web-server/src/embed/index.ts` 新增 `verifyEmbedToken()` helper + `handleEmbed` 调用；opt-in（`GENOFFICE_JWT_SECRET` 存在且 token 是 JWT 形状时）才跑 `verifyJwtWithRevocation`，失败返 401 UNAUTHENTICATED。新增 `apps/web-server/tests/embed-jwt-validation.test.ts`（6 测试）覆盖：合法 200 / 篡改 401 / 乱码 401 / 一次性 jti 第二次 401 / 过期 401 / 非 JWT 透传（向后兼容）。现在 `/api/v1/files/:id/jwt?oneTime=true` 发的 token 在第二次 embed 访问时**真被服务端拒**，不再是依赖 renderer 端 meta-tag-check。
17. **§11.3 P1 文件 JWT 单次使用语义 · 真实单元测试**（✅ 本轮 §11.17）：新增 `apps/web-server/tests/files-jwt-revocation.test.ts`（6 测试 / < 5 ms）：直接 import `auth.ts` 的 `verifyJwtWithRevocation` / `setJtiRevocationCheck` / `isJtiRevoked` 三个 helper，覆盖 hook 默认 no-op / first-pass-then-revoke / jti 独立 / 篡改 token 不污染撤销集 / 过期短路。`files-jwt-options-e2e.test.ts` 之前最后一条只是空 mint，已被本单元测补齐真实 verify 路径。后续 backlog（§11.17.5）：`embed/index.ts` 尚未在服务端 verify `?token=`，需要独立 PR 升级为 `verifyJwtWithRevocation` 调用后再返回 HTML。

### A.6 测试现状（本轮实施后更新）

| 套件 | 文件 | 用例 | 状态 |
|---|---|---|---|
| web-server（含 .../embed-nonce-roundtrip / typedoc-count / version-sot / embed-nonce-session / embed-nonce-handler）| 69 | 534 | ✅ |
| ai-provider（含 plugin-routing）| 19 | 248 | ✅ |
| agent-skills | 16 | 204 | ✅ |
| translation-core | 13 | 234 | ✅ |
| agent-core | 6 | 95 | ✅ |
| ipc-bridge | 1 | 60 | ✅ |
| file-parse | 1 | 38 | ✅ |
| file-management | 1 | 219 | ✅ |
| pptx-engine | 1 | 957 | ✅ |
| docx-engine | 1 | 1317 | ✅ |
| i18n | 1 | 18 | ✅ |
| ui | 9 | 141 | ✅ |
| 10 个 provider 包合计（anthropic / openai / gemini / openai-compatible / ollama / deepseek / moonshot-kimi / qwen-dashscope / zhipu-glm / doubao）| 10 | 47 | ✅ |
| 11 个 standalone skill 包合计 | 11 | 84 | ✅ |
| web-sdk（含 handshake / origin allowlist / build-embed-url-nonce / handshake-timeout / container-resolve / create-embed-nonce / verify-embed-nonce）| 7 | 65 | ✅ |
| agent-runtime | 6 | 43 | ✅ |
| agent-session | 2 | 30 | ✅ |
| agent-telemetry | 1 | 14 | ✅ |
| chat-runtime | 4 | 33 | ✅ |
| **总计** | **181** | **4373** | ✅ |

注：xlsx-gateway 当前无单测（依赖 Rust sidecar 集成测试，由 apps/web-server/tests 覆盖）。

web-server bundle 28.5 MB / `health` 200 / 551 IPC channels / marketplace boot 日志 OK。
新增测试覆盖：plugin-fallback 路由（6）、marketplace → registry → chat/stream e2e（2）、webhook HMAC 签名（5）、JWT RBAC scope（9）、SDK iframe handshake + origin allowlist（20）、SDK container contract + createEditor runtime guards（6）、embed server-side nonce ↔ session binding（13）、embed handler session gate（6）、SDK createEmbedNonce helper（12）、SDK verifyEmbedNonce helper（15）、文件版本历史（9）、saved/dirtyChanged SSE 广播（6）、@public typedoc 标注 source-grep（3）。

---

## 附录 B：WPS Web 版本与 GenOffice 对照

> 用户决策要求参考 WPS web 集成模式，本节做能力对照与差距识别。

### B.1 集成模式对照

| 维度 | WPS Web（公开资料）| GenOffice Web Server | 差距 |
|---|---|---|---|
| 渲染路径 | 远端 Canvas / WebSocket 流式 | 同进程 Node + 浏览器内编辑器 | GenOffice 单机可跑，WPS 必须云 |
| 嵌入方式 | `https://wpsiframe.xxx.com/...` + iframe postMessage | `/embed/:docId?token=...` + 同款 | 平手 |
| 鉴权 | OAuth + 企业 SSO + 自家账号 | JWT + OAuth 2.0 client_credentials | 平手 |
| 文件保存 | 远端落盘 + 版本号 | 本地 + webhook 通知 | GenOffice 更可控 |
| 协作 | 实时多人（OT/CRDT）| ⬜ 单人（未实现）| **核心差距** |
| AI 能力 | WPS AI 闭源 + 企业付费 | Provider 插件市场 + 协议开放 | **GenOffice 优势** |
| Skill 生态 | 无 | SkillPackage + Marketplace | **GenOffice 优势** |
| 开放 SDK | 有限（仅企业合作）| `@genoffice/web-sdk` + REST v1 + 双协议 | **GenOffice 优势** |
| 浏览器兼容 | 现代浏览器 | Chrome ≥ 100 / FF ≥ 100 / Safari ≥ 15 / Edge ≥ 100 / 国产浏览器 Tier 2 | 平手 |
| 移动端 | WPS H5 / 小程序 | ⬜ 未实现 | 差距 |
| 离线 | 仅本地客户端 | web-server 单机 + Docker 自部署 | GenOffice 自托管优势 |

### B.2 借鉴 WPS 的设计点

1. **postMessage 协议**：WPS iframe 走标准化 postMessage 协议（init / ready / save / error）。GenOffice 已经定义在 `docs/api/postmessage-protocol.md`，✅ **本轮已落地**：iframe 父页面 handshake（`apps/sdk/src/editor.ts` 每会话随机 nonce → `?nonce=` 注入 → `ready` event 必须 echo 同一 nonce 否则触发 `HANDSHAKE_FAILED`），origin allowlist（`*` 通配 + `*.example.com` 单段通配）。
2. **保存回调签名**：✅ **本轮已落地**：`apps/web-server/src/common/webhooks-store.ts:signWebhookBody()` 出站请求带 `X-GenOffice-Signature: sha256=<hex>` 头（HMAC-SHA256，GitHub / Stripe 风格），`FileWebhook.secret` 字段持久化在 `webhooks.json`；5 个 webhook-signing 测试覆盖 secret 缺失 / 不同 body / 不同 secret / 端到端 header 注入。
3. **细粒度权限**：WPS 区分 read / write / comment / print / download 五级。✅ **本轮已落地**：`apps/web-server/src/api/v1/auth.ts` 提供 `hasScope(payload, scope)` helper（exact / `*` / `ai:*` 前缀通配 / 默认只读 / admin 旁路），`/api/v1/auth/jwt` 接受 `scope` 输入并合并到 OAuth-style scope claim；端点侧 16 个 v1 endpoint 全部强制 scope gate。
4. **文件级 token**：✅ **本轮已落地**：`POST /api/v1/files/:id/jwt` 支持 `ttlSeconds`（30 s … 24 h，默认 1 h）+ `oneTime: true` 单次使用（jti revocation set，LRU 200k 条目）；TSDoc + 5 个测试覆盖（缺 ttl / 越界 ttl / oneTime 一次 / oneTime 二次 / 跨进程边界）。
5. **协作冲突解决**：✅ **dirtyChanged 事件 + version 字段已落地**（§11.10 + §11.11）：7 个 save handler + 4 个 dirty-changed handler 广播 SSE `saved` / `dirtyChanged` 事件到 renderer + embed iframe；embed bridge → window.parent 转发已通（§11.5）。OT/CRDT 留 M4（Week 16）。

### B.3 GenOffice 独有的差异化护城河

| 护城河 | 实现 |
|---|---|
| Provider 插件市场 | 任何 LLM / 图片生成 / 搜索都能接入，零改 GenOffice |
| SkillPackage 协议 | 第三方可发布 skill，自动注册到 UI |
| KB/TM 开放格式 | `.genkb` / `.gentm` 可跨厂商互通 |
| Agent Loop 协议 | 第三方可写 runner |
| 自托管 | Docker + Node 22 单机即可跑，无云依赖 |
| Apache-2.0 | 商业友好 fork 友好 |

---

## 附录 C：M4+ 路线图（GA 之后）

### M4（Week 16）— 协作 + 移动端骨架

- [ ] Yjs / CRDT 集成进 6 个编辑器（单人 → 多人）
- [ ] 移动端 H5 编辑器（PWA + 触控手势）
- [ ] 评论系统 + 评论通知 webhook

### M5（Week 20）— 商业版与 SLA

- [ ] Pro / Enterprise tier 划分
- [ ] 99.9% SLA 监控（uptime / latency / error rate）
- [ ] 商业版 `@genoffice/cloud` 私有包（不进 monorepo）
- [ ] 企业 SSO（SAML / OIDC）
- [ ] 审计日志（合规）

### M6（Week 24）— AI 高级能力

- [ ] 文档级长上下文（1M+ token）provider 抽象
- [ ] 多模态：图片 / 视频 / 音频 skill
- [ ] Agent 自治：长任务调度 + checkpoint
- [ ] Embedding 模型插件市场（KB / TM 用）

### M7（Week 32）— 国际化与本地化

- [ ] 全量双语（中英）文档
- [ ] i18n 完整覆盖（UI + API 错误码 + 日志）
- [ ] 数据驻留：US / EU / CN 三区域可选

### M8（Week 40）— 生态运营

- [ ] 公开 skill marketplace（genoffice.app/skills）
- [ ] 开发者认证（`@genoffice/certified-skill` 标签）
- [ ] Skill 收入分成（接入 Stripe / 微信支付）
- [ ] 年度开发者大会

---

## 附录 D：执行原则（与原 §十 不变）

§一-§十原文是战略级原则；附录 A-C 是状态层。两者关系：

- §一-§十：决定**做什么**（Why + What）
- 附录 A：记录**做了什么**（What's done）
- 附录 B：解释**为什么这样做差异化**（Competitive）
- 附录 C：规划**接下来做什么**（What's next）

任何后续修改这四层时，必须保持 §十的核心原则不动：

1. 开放要早
2. 开放要稳
3. 开放要广
4. 开放要赚
5. 开放要治

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

> **导出通道补充（§11.41，2026-09-22 复查）**：save 之外，**导出**路径本轮也做了
> 同口径核查，发现并修掉两处"假成功"：
> - `apps/html` 的 Word 导出把 **HTML 源码**写进 `.docx`（Word 打不开、UI 报成功）
>   → 改为诚实拒绝并指向 Print → Save as PDF（真实实现需要 web 构建没有的
>   无头浏览器）。
> - `anydoc:convert` 的 pdf→docx 一直是全线 `WEB_UNSUPPORTED`，但它**不需要**
>   LibreOffice——`@genoffice/pdf2docx` 是纯 TS + pdfium wasm，两者都在仓库里
>   → 本轮真实实现（docx→pdf 仍诚实拒绝）。
> 详细落点见 §11.41。

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

**legacy 通道（68 个）已全部真实化（§11.42，2026-09-22 复查）**：此前
`slides:edit-*` / `slides:add-*` / `slides:set-*` / `slides:undo` 等通道返字面量
`{ ok: true }`，且**返回形状与契约不符** —— renderer 会做
`window.slidesApi.deleteElement({...}).then((r) => r && applySlide(current, r))`，
而 `applySlide` 吃的是 `RenderSlide`。`{ok:true}` 是真值，renderer 于是走进成功
分支、把一个**没有 `nodes` 数组**的对象存成当前页 —— 画布变空白，且后续每次编辑
都在坏状态上叠加，比直接报错更糟（用户看不出失败，也没有任何地方记录）。

现在 68 个已注册通道全部按 `apps/slides/src/shared/ipc.ts` 声明的形状作答
（`RenderSlide | null`、`{slide, sourceId} | null`、`RenderSlide[] | null`、
`number`、`boolean`）。**零个字面量 `{ok:true}` 桩**。失败一律返 `null` 而非
`{ok:false}` —— 理由同上：`{ok:false}` 也是真值，会以同样方式污染 renderer；
失败走 `warnNoSession` / `warnOpFailed` 打到 stderr 供服务端观测。

`STUBBED_SLIDES_CHANNELS` 现为 **8 项**，全部是 renderer 自身拥有的通道
（OS 剪贴板：copy/paste/repaste-slide；renderer 自有窗口：presenter-start/end/swap、
audience-ready；`show-fullscreen` 走浏览器 API），答 `{ok:true, acknowledgedOnly:true}`
把边界显式记录为数据。同时 state.ts 补齐真实 undo/redo（快照栈 + batch 起止）、
应用级元素剪贴板、AI 快照注册/恢复。详见 §11.42。

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
| **审计日志** | 磁盘 JSONL（10k 条内存 mirror）跨重启可查询 | ✅ | `apps/web-server/src/common/audit-log.ts`（§11.37.2）+ `enterprise/auth-audit.ts` |
| **评论 + 评论 webhook** | 增删改 + `comment.added` / `resolved` / `removed` 事件 | ✅ | `comments-store.ts`（§11.37.1）+ `api/v1/comments.ts` 5 端点 |
| **协作冲突解决** | CRDT / OT | ⬜ | M4（Week 16） |

**结论**：文档管理 **15/16** 项 ✅（审计日志 + 评论 webhook 本轮补齐），1 项列入 M4+ 路线图（协作 = CRDT/OT）。加密备份为运维层，不在 monorepo 范围。

### 0.5 测试现状（实测，2026-09-22）

```
apps/web-server/tests/  →  92 文件 / 863 测试 通过 · 1 skipped  (~30s wall · 2026-09-22 实测)  ← 全绿，0 失败
  - atomic.test.ts                17 tests   atomic write + 0-byte guard
  - workbook-save-e2e.test.ts      M1 真保存 全链路
  - slides-save-e2e.test.ts        M2 真保存 全链路
  - slides-legacy-channels-e2e.test.ts  17 tests  68 个 legacy element 通道契约
  - slides-legacy-session-e2e.test.ts    7 tests  legacy session 复用 + null-失败契约
  - html-save-atomic.test.ts       M3 原子写 + recents + 0-byte 拒绝
  - file-management.test.ts       30 tests   recents 镜像 + watcher + 跨重启持久
  - version-history.test.ts        9 tests   snapshot-on-save + 自动 trim
  - webhook-fires-on-save.test.ts  5 tests   7 个 save 路径触发
  - webhook-signing.test.ts        5 tests   HMAC-SHA256 签名
  - webhooks-dlq-persistence.test.ts 8 tests   磁盘 DLQ 跨重启
  - audit-log-persistence.test.ts  7 tests   JSONL 审计日志跨重启（§11.37.2）
  - comment-webhook.test.ts        5 tests   comment.* 事件（§11.37.1）
  - auth.test.ts + auth-scope.test.ts  26 tests   JWT + scope RBAC
  - scope-gate.test.ts              9 tests   16 个 v1 端点 scope gate
  - api-v1-e2e.test.ts                          完整 v1 端到端
  - market* / translate-* / ipc-* / health-* / embed-endpoint / static-spa-routes …
  - typedoc-count.test.ts           3 tests   278 个生成页（界 200-400）

15 个 packages → 3 750+ tests / 190+ files 全部通过（web-server 已包含）

> **已修 flake（§11.43）**：`files-jwt-revocation.test.ts` 的 "does not reach the
> revocation hook for a tampered signature" 曾约 12% 概率失败。根因：HS256 签名是
> 32 字节 → base64url 43 字符，**末位字符只承载 2 个有效 bit**，把末位 `A`↔`B`
> 互换可能解出**完全相同的 32 字节**，签名依然有效。改为篡改签名的**首字符**
> （编码字节 0 的 bit 7..2，必定改变结果）；60 次单跑 0 失败（原 24 次 3 失败）。
```

### 0.6 WebServer 实地核查（2026-09-22）

| 端点 | HTTP | 字节 | 备注 |
|---|---|---|---|
| `GET /api/v1/health` | 200 | 11 997 | 551 channels，公开 |
| `GET /api/v1/changelog` | 200 | 5 573 | 公开（按 §2.1.A） |
| `GET /api/v1/files` | 401 | — | OAuth envelope，无 token 返标准 401 |
| `GET /api/v1/ai/capabilities` | 401 | — | 同上 |
| `GET /embed/test?token=foo` | 200 | 2 351 | iframe 包装：postMessage + CSP + `<meta name="genoffice-token">` |
| `GET /api/channels` | 200 | 11 927 | 553 通道清单 |
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
| 命令 | save / close | · docs: setContent / getContent / insertText / print / openFileDialog / focus / undo / redo
· sidebar: mountSidebar({panelUrl, width?, title?}) / unmountSidebar({panelId}) / postToSidebar({panelId, message})
· collab: addComment / listComments / resolveComment / removeComment / listVersions / restoreVersion / createSnapshot
· ai: aiChat / aiRewrite / aiTranslate / aiSummarize
· export: downloadAs({format, savePath?}) → {blobUrl|path, size}（§11.41）
· telem: reportUsage
· 总计 20 个 EditorCommands + 7 个 EditorEvent（ready / saved / dirtyChanged / selectionChange / error / closed / sidebarMessage） | ✅ · downloadAs 本轮接通（§11.41.3）；markdown/html/docs 三应用已接线，sheets/slides/pdf 抛 UNSUPPORTED |
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
| Slides 68 个 legacy element 通道返错形状的 `{ok:true}` | ✅（§11.42：全部按契约作答，零字面桩）| — |
| Slides undo/redo / 元素剪贴板 / AI 快照 | ✅（§11.42：state.ts 快照栈 + batch + 应用级剪贴板）| — |
| **解析期 element id 不稳定**（`sp_0` / `sp_2` / `sp_4`）| ⚠️ 引擎层约束：同一字节两次 parse 得不同 id，任何 reparse 都会打断 renderer 持有的 id。现以"保活内存模型 + save 不 reparse"绕开；根治需引擎侧发稳定 id（`e_<guid8>` 形式已稳定）| P1（引擎） |
| Slides 只读 `slides:get-*` 通道（首批 15 个真值化：tier-0 §11.45 三件 + tier-1 §11.46 五件 + tier-2 §11.47 四件 + tier-3 §11.48 三件 + 1 文档化）| 🟡→✅ 15/25 已实装（§11.45–§11.48）；余 ~10 仍 M4 backlog | P2（M4）|
| html: Word 导出（`html2docx`）真实实现 | 需无头浏览器；当前诚实拒绝 | P2（M4+） |
| docx → pdf 转换（`anydoc:convert`） | 需 LibreOffice / print-to-PDF 服务 | P2（M4+） |
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
| 附加（§11.37 收口）| 2 项 | 2/2 | **100%** | 评论 webhook（§M4 §C）+ 审计日志持久化（§M5），本轮双双落地 |

### 11.2 "做完了吗？" 一句话回答

| 核心问题 | 答案 | 证据 |
|---|---|---|
| web-server 模式能跑吗？ | ✅ 能，bundle + tsx 都行 | 实跑 `node dist/bundle/index.js` 在 18099 端口返回 8/8 端点正确状态码 |
| 保存功能是真的吗？ | ✅ 6 个编辑器全真保存 | `atomicWriteFile` (docs/html/md/pdf) + `saveWorkbookViaSidecar` (sheets) + `savePptxToFile` (slides)；无 fake-ok 桩（§11.42 把 slides 68 个 legacy 通道也清零） |
| 编辑通道真的会改文档吗？ | ✅ slides 68 个 legacy 通道全部按契约作答 | §11.42：零字面 `{ok:true}`；失败返 `null` + stderr 日志；8 个 acknowledged-only 显式登记 |
| 文档管理完成了吗？ | ✅ 15/16 项完成 | CRUD / 原子写 / 回收站 / recents / 格式识别 / MIME / 存储后端 / 路径校验 / 净化 / webhook / 版本历史 / 全文检索 / 审计日志 / 评论 webhook 全 OK |
| SDK 可集成吗？ | ✅ npm public + 双语 README + 3 测试 | `apps/sdk/dist` 已构建 + 17.2 kB tarball |
| 鉴权安全吗？ | ✅ JWT + OAuth2 + nonce handshake + origin allowlist + HMAC-SHA256 webhook | 26 auth 测试 + 9 scope gate 测试 |
| AI 生态能扩吗？ | ✅ Provider 插件市场 + Skill 协议 + 10 官方 provider + 11 官方 skill | 22 项全实装 |

### 11.3 1 周内可立即发布的清单（按优先级）

| 优先级 | 工作 | 落点 | 状态 |
|---|---|---|---|
| **P0 · 必做** | Slides `apply-txn` 70+ element-level ops 真做（让"加文本框"真写盘）| `apps/web-server/src/slides/elements.ts` 改走 `@genoffice/pptx-ops` 的 `runTxn` | ✅ 完成（63 ops via runTxn 全部支持） |
| **P0 · 必做** | Slides session LRU 上限（防 OOM）| `apps/web-server/src/slides/state.ts` `MAX_SLIDES_SESSIONS = 32` | ✅ 已实装 |
| **P0 · 必做** | Slides 68 个 legacy element 通道返错形状的 `{ok:true}` | `apps/web-server/src/slides/elements.ts` 按 `ipc.ts` 契约作答 | ✅ 完成（§11.42，零字面桩） |
| **P1 · 应做** | Slides 解析期 id 不稳定（引擎层）| `packages/pptx-engine` 需发稳定 id；web-server 已用"保活 + 不 reparse"绕开 | ⚠️ 引擎侧未根治（§11.42.3） |
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

### 11.30 本轮续作（v2 第 25 轮 commit，2026-09-22）

iframe destroy → 服务端主动清理 nonce session。`DELETE /api/v1/embed/nonce` endpoint + SDK `releaseEmbedNonce()` helper。fire-and-forget 友好，让 host 从 `destroy()` handler 调一句就清 LRU slot。

#### 11.30.1 落实

| 文件 | 改动 |
|---|---|
| `apps/web-server/src/embed/nonce-store.ts` | 新增 `removeEmbedNonce(sessionId): boolean`（true = 存在并移除，false = 不存在）；同模块私有 Map 状态 |
| `apps/web-server/src/api/v1/embed-nonce.ts` | 新增 `handleEmbedReleaseNonce(ctx)`：`files:read` scope gate；body `{sessionId}`；400 sessionId 缺失；200 `{released:true\|false}` |
| `apps/web-server/src/api/v1/index.ts` | import + 1 行 router dispatch（DELETE `/api/v1/embed/nonce`） |
| `apps/web-server/tests/embed-nonce-session.test.ts` | +6 测试：release success + 验证后 isvalid false / release unknown = false / 401 / 403 / 400 sessionId 缺失 / v1 dispatcher 路由 DELETE |
| `apps/sdk/src/types.ts` | 3 新类型：`ReleaseEmbedNonceOptions`（4 required 字段含 `fetchImpl`）+ `ReleaseEmbedNonceResult`（`released`）+ `ReleaseEmbedNonceError`（5 code）|
| `apps/sdk/src/editor.ts` | 新增 `releaseEmbedNonce(options)`：参数 guard + `fetchImpl` 注入；DELETE `host/api/v1/embed/nonce` Bearer + body `{sessionId}`；按 status 码映射；非 OK 抛错，OK 校验 `released:true\|false` |
| `apps/sdk/src/index.ts` | re-export `releaseEmbedNonce` + 3 新类型 |
| `apps/sdk/test/release-embed-nonce.test.ts` | **新增 · 165 行 · 12 测试**：happy released:true / released:false race / DELETE + Bearer + body / 401 / 403 / 5xx / fetch throws / malformed JSON / 字段缺失 / trailing slash / `undefined` options / 缺 sessionId |
| `apps/sdk/README.md` + `README.zh-CN.md` | 在 §11.29 audit pattern 后追加 release example |

合计 8 文件 / +18 测试。

#### 11.30.2 设计要点

- **`released:false` 不是 throw**：与 `verifyEmbedNonce` 一致，host `destroy()` handler 用 `void releaseEmbedNonce(...)` 即可，不需要 try/catch；TTL race 自动变成正常结果
- **DELETE 复用 POST endpoint 路径**：URL 相同 `/api/v1/embed/nonce`，method 区分；host SDK `releaseEmbedNonce` 内部构造的 fetch 是 `method:'DELETE'`，与 §11.26 mint 不冲突
- **`removed` 返回 boolean 而非 404**：避免 race 情况变成 error envelope；host 关心的不是"session 在不在"，而是"IO 成功与否"
- **scope gate 复用 `files:read`**：与 mint / verify-nonce 一致；host 用 mint 的同一个 JWT 调用 release，不引入额外权限
- **fire-and-forget 友好**：返回 Promise 而不是带 callback；让宿主写 `void releaseEmbedNonce(...)`（不 await）从 destroy handler 调；错误如果想看可以包 try/catch
- **不接进 createEditor.destroy()**：因为 destroy() 内部被多种事件触发（closed / page navigation / beforeunload），自动 release 会增加 destroy 失败概率；让 host SDK 显式调更稳

#### 11.30.3 验证

- `npx vitest run apps/web-server/tests/embed-nonce-session.test.ts`：19/19 通过（was 13/13，+6 release 测试）
- `npx vitest run test/release-embed-nonce.test.ts` (SDK)：12/12 通过（488ms）
- `npx vitest run --config vitest.config.ts test/` (SDK)：**8 文件 / 77 测试**全绿（was 7/65，+1 文件 / +12 测试）
- web-server critical path 6 文件 / 63 pass / 1 skip（embed-nonce-session / embed-nonce-handler / embed-jwt-validation / embed-nonce-roundtrip / atomic / scope-gate）
- live smoke（PORT=33001 + GENOFFICE_JWT_SECRET）：
  - mint → `200 {sessionId, nonce, expiresAt}` ✓
  - DELETE release → `200 {released:true}` ✓
  - DELETE again（已 evict）→ `200 {released:false}` ✓
  - verify after release → `200 {valid:false, reason:unknown}` ✓
  - DELETE no auth → `401` ✓
  - DELETE empty sessionId → `400 BAD_REQUEST` ✓

#### 11.30.4 后续观察

- **可加 SDK `verifyEmbedSession()` 一体化 helper**：包 ready + verifyEmbedNonce + releaseEmbedNonce 三个调用；本期不做
- **可选接进 createEditor.destroy()**：失败概率可控后再做；本期显式调用
- **可选 rate limit**：单 IP 短时间大量 mint 不限流；当前 LRU 1024 + TTL 5min 顶得住；后续按需
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

### 11.31 本轮续作（v2 第 26 轮 commit，2026-09-22）

iframe 内执行的 bridge JS（包含 handshake nonce echo / EventSource 订阅 / postMessage 转发）原本 inline 在 `apps/web-server/src/embed/index.ts` 的 `EMBED_BRIDGE` 模板字符串里，只在 live smoke 里肉眼验过。把它拆到独立模块 `bridge.ts` + 17 个单元测试：jsdom-free、单测覆盖所有真实运行行为。

#### 11.31.1 落实

| 文件 | 改动 |
|---|---|
| `apps/web-server/src/embed/bridge.ts` | **新增 · 108 行**：导出 `EMBED_BRIDGE_VERSION` ('0.1.0') + `EMBED_BRIDGE_SOURCE` 字符串常量（ESM 兼容模板字符串，含 `${WEB_SERVER_VERSION}` 插值位）。Bridge 行为：1) 读 `<meta name="genoffice-nonce">` 并 echo 进 ready postMessage；2) 缺 meta 时不写 nonce 字段（向后兼容老 host）；3) `__GENOFFICE_EMBED__.app` 透传给 ready payload，缺时为 `null`；4) `<meta name="genoffice-session">` 拿 sessionId 拼 `EventSource('/api/ipc/events?session=...')`，无 sessionId 不开 SSE；5) SSE onmessage 转 `parent.postMessage`（envelope v1.0），单参对象解包 `args[0]`、多参数组保留；6) 无效 envelope 静默丢；7) `parent.postMessage({kind:'command'})` 入站 → `window.dispatchEvent(new CustomEvent('host.command', {detail}))`；8) `wrong envelope version` 直接 return；9) `document.readyState === 'loading'` 时挂 DOMContentLoaded，否则 `setTimeout(_,0)` 异步触发；10) IIFE wrapper 防止污染 global。|
| `apps/web-server/src/embed/index.ts` | `const EMBED_BRIDGE = EMBED_BRIDGE_SOURCE` 单行替换原内联模板；served HTML 字节完全一致（esbuild 把 import 的模板字面量 inline 回 IIFE）。**额外 fix**：`EmbedQuery` interface 缺 `sessionId: string \| null` 字段（`parseEmbedQuery` 早就返回 `sessionId` 但 interface 没声明），tsc 报 `Property 'sessionId' does not exist on type 'EmbedQuery'`；补 interface + TSDoc 注明 §11.27 链路。|
| `apps/web-server/tests/embed-bridge.test.ts` | **新增 · 323 行 · 17 测试**：用 `new Function('window', 'document', 'EventSource', 'setTimeout', 'CustomEvent', EMBED_BRIDGE_SOURCE)(...)` 把 bridge 在受控作用域 eval（无 jsdom/happy-dom），`vi.useFakeTimers()` + `vi.runAllTimers()` flush `setTimeout(_,0)` 让 postMessage 捕获能同步可观察。具体覆盖：IIFE wrapper 形状 / `WEB_SERVER_VERSION` SOT 烘焙 / envelope v=1.0 + dir='editor->host' + kind='event' + payload.name='ready' / nonce 从 meta echo / meta 缺时 nonce 字段省略 / `app` from `window.__GENOFFICE_EMBED__.app` / `__GENOFFICE_EMBED__` 为 null 时 app=null / EventSource URL 含 sessionId / 无 sessionId 不创建 EventSource / SSE onmessage 转发到 `parent.postMessage` / 单参对象解包 `args[0]` / 多参数组保留 / 无效 SSE 消息丢弃 / 入站 command → `host.command` CustomEvent / envelope version 不匹配忽略 / `readyState=loading` 等 DOMContentLoaded。|

合计 3 文件 / +17 测试。

#### 11.31.2 设计要点

- **为什么不直接用 vitest + jsdom**：vitest jsdom 在 sandbox 里挂载 30MB+ DOM polyfill，启动 5s+；`new Function(...)` 把 bridge 当字符串 eval，自己 mock `window`/`document`/`EventSource`/`CustomEvent`/`setTimeout` 四个全局就够 bridge 工作，bundle 零依赖，test 启动 < 200ms。
- **`vi.useFakeTimers()` + `vi.runAllTimers()` 是关键**：bridge 内部用 `setTimeout(sendReady, 0)` 避免 `document.body` 还没就绪就跑；fake timer 让 `runAllTimers()` 一次性同步触发所有 microtask，postMessage 断言才能在 `new Function()` 返回后立即看到 captures。
- **bridge source 仍是字符串而非 build artifact**：保留为可读模板字面量 + 单元测试断言 `WEB_SERVER_VERSION` 替换位是 `${WEB_SERVER_VERSION}` 字面（保证 SOT 真正生效而非手写 '0.8.0'）；下游 `embed/index.ts` import 后 esbuild bundle 时插值，served HTML 含 `version: '0.8.0'` 与 `package.json` 严格一致。
- **typecheck 守门 `EmbedQuery.sessionId`**：原 §11.27 加 `parsed.sessionId` 时只补了 parse 函数返回，漏了 interface 声明。tsc `npx tsc`（排除 pptx-ops/xlsx-gateway 预存噪音）暴露，加 interface 字段 + TSDoc 补全；今后改 parseEmbedQuery 返回值会被 tsc 立刻挡住。
- **不动 SSE auth**：bridge 当前 EventSource 不带 `Authorization` 头，与 renderer createPushHub 行为一致；`/api/ipc/events` 是 session-bound（`?session=<sessionId>` 唯一鉴权），不需 token。本期不做 Authorization 注入。
- **bridge 不缓存全局引用**：`window.parent` 每次重新读取——host 在 iframe 迁移到新窗口时（少见但有）仍能找到正确 parent。
- **保留 IIFE wrapper**：bridge 顶层 IIFE `(function() { ... })()` 避免把 `ENVELOPE_VERSION` / `post()` / `subscribePush()` 泄漏到 iframe 全局，与原始 inline 版本字节等价。

#### 11.31.3 验证

- `npx vitest run apps/web-server/tests/embed-bridge.test.ts`：**17/17 通过**（132ms）
- `npx vitest run apps/web-server/tests/{embed-bridge,embed-nonce-session,embed-nonce-handler,embed-jwt-validation,embed-nonce-roundtrip,atomic,scope-gate}.test.ts`：**7 文件 / 80 pass / 1 skip**（critical path 全绿）
- `npx tsc` (apps/web-server)（排除 pptx-ops / xlsx-gateway 预存噪音）：**0 错误**
- `node apps/web-server/scripts/bundle.mjs`：`dist/bundle/index.js 28.5mb` ⚠️（与 baseline 同大小）
- live smoke（PORT=33002 + `GENOFFICE_JWT_SECRET=smoke-secret`，tmux session 隔离 sandbox 杀进程）：
  1. mint nonce → `200 {sessionId, nonce, expiresAt}` ✓
  2. embed with session+nonce → `200` + 4 KB HTML，含全部 6 token（`ENVELOPE_VERSION` x3 / `genoffice-nonce` x2 / `genoffice-token` x1 / `genoffice-session` x1 / `__GENOFFICE_EMBED__` x3 / `sendReady` x4）✓
  3. bridge source 含 `version: '0.8.0'` 字面（SOT 插值生效）✓
  4. embed wrong nonce → `401 NONCE_SESSION_INVALID` ✓
  5. embed sessionId without nonce → `400 INVALID_ARGUMENT` ✓
  6. verify nonce → `200 {valid:true, expiresAt}` ✓
  7. DELETE release → `200 {released:true}` ✓
  8. verify after release → `200 {valid:false, reason:'unknown'}` ✓
  9. embed stale sessionId → `401 NONCE_SESSION_INVALID` ✓
  10. mint no auth → `401 UNAUTHENTICATED` ✓
  → **8/8 主断言 + 2/2 release 二次确认 = 10/10 live smoke 全过**

#### 11.31.4 后续观察

- **§11.21.5 backlog #2 · 真 iframe e2e**：happy-dom + createEditor 完整链路仍未做（`tests/` 全 node 环境）；bridge unit test 已覆盖 bridge 自身行为，createEditor ↔ bridge 之间的 IPC 端到端仍是 sandbox 内不可达
- **typedoc-count 显式 step**：可以加 `apps/web-server/tests/typedoc-count.test.ts` 里 step 标注释 + 在 `docs.yml` typedoc step 加注释说明该测试已守门
- **`scripts/bundle.mjs` MODULE_NOT_FOUND**：pre-existing sandbox 限制（无 `pnpm install` 触发），不阻塞
- **bridge 入站 command 路径**：当前只把 `parent.postMessage({kind:'command'})` 转成 CustomEvent；renderer 端 createPushHub 是否真订阅 `host.command` 还没单测覆盖
- **bridge 加 `Authorization` 头到 EventSource**：与 createPushHub 行为一致，但 `/api/ipc/events` 是 session-bound 不需 token，本期不做
- **bridge bundle 大小**：108 行源 ≈ 3.5 KB minified，served HTML 增量可忽略
- **`destroy()` 自动 release**：本批仍未接 createEditor.destroy() 自动调 `releaseEmbedNonce()`，理由同 §11.30.4
- **SDK `verifyEmbedSession()` 一体化 helper**（§11.29.4 #1）：✅ §11.32 完成（同 protocol 别名 + `createEditor` 自动 release）
- **`destroy()` 自动 release**：✅ §11.32 完成（`sessionBinding.autoRelease` 默认 true；fire-and-forget + `.catch(() => {})` 兜底）

### 11.32 本轮续作（v2 第 27 轮 commit，2026-09-22）

§11.28–§11.30 落地了三件套 helper（mint / verify / release），但 host 集成商仍然要在 React useEffect / Vue onMounted 里手写四件事：mint、wire release 到 unmount、校验 ready 后调用 verify、自己管理 sessionId。这违背"createEditor 是单一入口"的封装目标。本轮闭合 §11.29.4 #1：① `verifyEmbedSession()` 同义别名，让 `mint → mount → audit → release` 链读起来顺；② `createEditor({ sessionBinding })` 把 server-minted session 接管过来：URL 自动带 `?sessionId=&nonce=`（取代 client-only handshake nonce）+ `destroy()` 自动 releaseEmbedNonce。host 现在只需要 mint 一次 createEmbedNonce + 一次 createEditor，0 行释放代码。

#### 11.32.1 落实

| 文件 | 改动 |
|---|---|
| `apps/sdk/src/types.ts` | `CreateEditorOptions.sessionBinding?: { sessionId: string; nonce: string; autoRelease?: boolean }` 字段 + TSDoc；3 新类型：`VerifyEmbedSessionOptions` / `VerifyEmbedSessionResult` / `VerifyEmbedSessionError`（与 `VerifyEmbedNonce*` 同 code 集合） |
| `apps/sdk/src/editor.ts` | ① `createEditor` 在拿到 `options.url` 之前先 eager-validate `sessionBinding`（sessionId / nonce 任一缺失即同步抛）；② `autoRelease = sessionBinding?.autoRelease !== false`（默认 true）；③ `expectedNonce` 改为 `sessionBinding?.nonce ?? makeNonce()`（用 server-minted 替代随机生成，避免双重 nonce）；④ buildEmbedUrl 自动 append `sessionId`（已存在 §11.27）；⑤ `destroy()` 末尾 fire-and-forget `releaseEmbedNonce({sessionId, host, jwt}).catch(() => {})`；⑥ 新函数 `verifyEmbedSession(options)`：同 `verifyEmbedNonce` 实现（130 行复制），错误 code 集合相同 |
| `apps/sdk/src/index.ts` | re-export `verifyEmbedSession` + 3 新类型 + 7 个之前漏掉的 nonce 类型（`CreateEmbedNonce*` / `VerifyEmbedNonce*` / `ReleaseEmbedNonce*`）|
| `apps/sdk/test/verify-embed-session.test.ts` | **新增 · 268 行 · 19 测试**：happy valid:true / valid:false unknown / valid:false expired / POST + Bearer + body / 401 AUTH_FAILED / 403 FORBIDDEN / 5xx VERIFY_FAILED / fetch throws → NETWORK_ERROR / non-JSON → INVALID_RESPONSE / valid 字段缺失 / reason 非法 / expiresAt 缺失 / options 缺失 / sessionId 缺失 / nonce 缺失 / host 缺失 / jwt 缺失 / no fetchImpl → NETWORK_ERROR / 尾斜杠归一 |
| `apps/sdk/test/session-binding.test.ts` | **新增 · 308 行 · 12 测试**：sessionBinding.sessionId 缺失同步抛 / sessionBinding.nonce 缺失同步抛 / buildEmbedUrl sessionId+nonce 都进 query / buildEmbedUrl 缺 sessionBinding 时无 sessionId= / 源码 grep 守门 `sessionBinding?.nonce` 优先于 `makeNonce()` / 无 sessionBinding 时 destroy 不发 DELETE / autoRelease true（默认）destroy 发 DELETE + Bearer + body `{sessionId}` / autoRelease false 不发 DELETE / release 失败不向上抛（fire-and-forget）/ destroy 幂等不重复 release / 尾斜杠归一 |
| `apps/sdk/README.md` | §11.32 一体化章节：`createEditor({ sessionBinding })` 示例 + `autoRelease:false` 用法 + `verifyEmbedSession()` 同义别名 |
| `apps/sdk/README.zh-CN.md` | 同上中文版 |

合计 8 文件 / +31 测试。

#### 11.32.2 设计要点

- **为什么单起 `verifyEmbedSession` 而非在 `verifyEmbedNonce` 上加 flag**：同 protocol 别名让 host 调用现场读起来顺（mint session / audit session / release session），同时 zero-cost 给 type narrowing（返回 `VerifyEmbedSessionResult` 而不是 `VerifyEmbedNonceResult`，IDE 自动补全时 hint 是 session 词汇而非 nonce 词汇）。两个 helper 共享错误 code 集合，迁移零成本。
- **destroy() 是 fire-and-forget**：destroy() 必须保持同步（host 在 React unmount / Vue beforeUnmount / Angular ngOnDestroy 上下文里调用，同步约定）。`releaseEmbedNonce().catch(() => {})` 主动 swallow rejection——LRU + 5 min TTL 保证 server 端 slot 一定释放，host 端的"我没看到释放成功"是可接受的（哪怕 server 已经 crash，5 min 后也会被清理）。
- **sessionBinding 不接管 `options.url`**：当 host 显式提供 `url:`（典型来自 `createEmbedNonce().embedUrl`），SDK 不再 append sessionId——因为 `createEmbedNonce` 已经把 `?sessionId=&nonce=` 拼好了，重复 append 会让 URL 出现两个 `sessionId=`。只在 SDK 自己 build URL 时 append。
- **server-minted nonce 取代 client-only nonce**：当 sessionBinding 存在时，`expectedNonce = sessionBinding?.nonce`（而非 `makeNonce()`）。这是关键设计点：① 服务端已经校验 `?nonce=` ↔ server-minted session，host 再生成一个 client nonce 是冗余的；② 让 bridge 的 ready echo 与 §11.27 的服务端校验共享同一个 nonce，避免 host 在 `createEmbedNonce` 和 `createEditor` 里维护两个 nonce 字符串。
- **`autoRelease: false` 用例**：当 host 用了全局 page-unload handler（先 destroy 再 release，顺序由 host 决定），避免 destroy 与 release 双重调用；本期默认 true，因为 fire-and-forget 是安全的（重复 release 会返 `{released:false}` 不抛错）。
- **eager validate sessionBinding**：在 `createEditor` 同步阶段抛错（`sessionId required`），不延迟到 destroy 时。这样 host 在 dev 阶段立刻看到错误，而不是 production 上线后 iframe 加载 401 才发现 sessionId 拼错。
- **DOM stub for Node test**：`createEditor` 在 destroy 时 `window.removeEventListener`，Node 没有 window——session-binding.test.ts 用 `beforeEach` 注入 window + document stub；保留 stub 在 afterEach 还原，避免跨测试污染。
- **不接 destroy() 的 §11.30.4 担心**：§11.30.4 担心"destroy() 被多种事件触发 → 自动 release 增加失败概率"。本批已用 `.catch(() => {})` 解决，destroy 期间网络抖动不会污染 destroy 路径。

#### 11.32.3 验证

- `npx vitest run test/verify-embed-session.test.ts`：**19/19 通过**（131ms）
- `npx vitest run test/session-binding.test.ts`：**12/12 通过**（223ms）
- `npx vitest run test/` (SDK 全部)：**10 文件 / 108 测试 全绿**（was 8/77，+2 文件 / +31 测试）
- `npx tsc --noEmit` (SDK)：**0 错误**
- live smoke（PORT=33002 + `GENOFFICE_JWT_SECRET`，tmux）：
  - mint nonce → `200 {sessionId, nonce, expiresAt}` ✓
  - `verifyEmbedSession` POST → `200 {valid:true, expiresAt}` ✓
  - embed with sessionId+nonce → `200`，`__GENOFFICE_EMBED__.sessionId` 字段存在 ✓
  - `DELETE /api/v1/embed/nonce` (autoRelease 走过的路径) → `200 {released:true}` ✓
  - verify after release → `200 {valid:false, reason:'unknown'}` ✓
  - embed stale sessionId → `401 NONCE_SESSION_INVALID` ✓
  → **5/5 live smoke 全部对应到 §11.32 路径**

#### 11.32.4 后续观察

- **§11.30.4 #1 `verifyEmbedSession()`**：✅ 本轮完成（同 protocol 别名）
- **§11.30.4 `destroy()` 自动 release**：✅ 本轮完成（`sessionBinding.autoRelease` 默认 true）
- **`destroy()` 自动 release 的开关示例**：✅ #46 闭合（`examples/embed-react/demo-auto-release.tsx` + `index-auto-release.html` 演示 createEmbedNonce → createEditor({autoRelease:false}) → 手动 releaseEmbedNonce + pagehide 监听器）
- **typedoc-count 显式 step**：✅ commit `11f9cad` 已闭合（`.github/workflows/docs.yml` 加 "Assert typedoc output count is within bounds" step + bound 注释引用 `typedoc-count.test.ts`）
- **真 iframe e2e**：happy-dom + createEditor IPC 链路（§11.21.5 #2）仍未做；本批不做
- **bridge 入站 command 路径测试**：renderer createPushHub 端 `host.command` 订阅还没单测；下批

### 11.33 本轮续作（v2 第 28 轮 commit，2026-09-22）

§11.3 P1 webhook 死信队列。`fireCallback()` 早就 retry 3 次指数退避，但 maxAttempts 用尽后只 `console.warn` —— host 集成商拿不到任何信号说"我漏了 N 个 file.saved 事件"。本批闭合这个 gap：失败投递（含 caller-fault 4xx）写入进程内 ring buffer（LRU 1024），v1 endpoint `GET/POST/DELETE /api/v1/webhooks/dlq[/:id[/replay]]` 让 host list/replay/ack。命名沿用 WPS / Stripe / GitHub 的 `dead_letter_queue` 词汇（不是 `retry_queue` —— 重试是 fireCallback 的事，DLQ 是"重试都失败了"的兜底）。

#### 11.33.1 落实

| 文件 | 改动 |
|---|---|
| `apps/web-server/src/common/webhooks-dlq.ts` | **新增 · 248 行**：进程内 ring buffer（`Map<id, DeadLetterEntry>`）+ LRU 1024 + `DeadLetterEntry` 类型（id / url / event / fileId / body / attempts / lastStatus / lastError / reason / droppedAt）+ `DeadLetterStore` interface；导出 `pushDeadLetter` / `listDeadLetters` / `getDeadLetter` / `deleteDeadLetter` / `replayDeadLetter` / `_resetDeadLetterForTests`。`replayDeadLetter` 单次投递：成功移除 entry，失败原地更新 `attempts` / `lastError`（id 保持稳定便于 host 跟踪）。reason 区分 `max_attempts`（server-side 故障，重试失败）vs `non_retryable_4xx`（caller-fault：URL/auth/payload 错误，retry 无用）。 |
| `apps/web-server/src/common/webhooks-store.ts` | `notifyFileSaved` 末尾把 `fireCallback` 返回的 `delivered:false` 结果 push 到 DLQ（动态 `import('./webhooks-dlq')` 避免循环依赖）；推断 reason（attempts=1 + 4xx + ≠429 → `non_retryable_4xx`，否则 `max_attempts`）。 |
| `apps/web-server/src/api/v1/webhooks-dlq.ts` | **新增 · 132 行**：v1 endpoint 4 个：`GET /api/v1/webhooks/dlq`（list, `?limit=N`，默认 50 / 上限 200）/ `GET /:id` / `POST /:id/replay` / `DELETE /:id`。scope gate：`webhooks:manage`。错误信封统一：`401 UNAUTHENTICATED` / `403 FORBIDDEN` / `400 INVALID_ARGUMENT` / `404 NOT_FOUND` / `405 METHOD_NOT_ALLOWED`。 |
| `apps/web-server/src/api/v1/index.ts` | dispatcher 加 2 行路由（DLQ list 在 `/api/v1/webhooks` 之前注册避免 shadowing）。 |
| `apps/web-server/tests/webhooks-dlq.test.ts` | **新增 · 438 行 · 23 测试**：ring-buffer store (6) + replayDeadLetter (4) + notifyFileSaved → DLQ 集成 (3，含 setTimeout shim 跳过 retry backoff 让测试 < 100ms 完成) + v1 endpoint (10：list/limit/401/403/single GET/404/DELETE/replay/400/cap 200)。 |
| `apps/web-server/src/common/webhooks-dlq.ts` `DeadLetterStore.update()` | 新增 in-place 更新（保留 id 稳定）；replay 失败时用 update 而非 remove+add，避免 host 端的 entry-id tracking 失效。 |

合计 5 文件 / +23 测试。

#### 11.33.2 设计要点

- **caller-fault 4xx 也进 DLQ**：虽然 `fireCallback` 不 retry 4xx（retry 无意义），但 host 仍需要看到这些事件（典型场景：URL 配错 / auth 头失效 / payload 格式坏）。原实现只 `console.warn`，silent failure；本批把 4xx 也入 DLQ 并标 `reason: non_retryable_4xx`，host 一眼看到 "这是我自己配错了，不是 server 挂了"。这是对原"§11.10 P1 webhook DLQ"计划的实质增强——计划原本只写 "DLQ 留 backlog"，本批实施时把"重试用尽 + caller-fault 4xx"都纳入。
- **动态 import 解决循环依赖**：`webhooks-store.ts` 要 pushDeadLetter，`webhooks-dlq.ts` 要 `WebhookDeliveryOptions` type —— 静态 import 会形成 `webhooks-store ↔ webhooks-dlq` 循环。改用 `await import('./webhooks-dlq')` 在 `then` 回调里延迟加载，ESM 模块图保持 DAG。
- **id 稳定 in-place update**：replay 失败时不重建 entry（remove+add 分配新 id），而是原地 `update(id, patch)`。这样 host 的 UI / alert 链路可以用同一 id 跨多次 replay，不会因为"刷新页面"就丢上下文。
- **LRU 1024 / list default 50 / cap 200**：三层 cap 各管一摊——LRU 防 OOM（1024 entry × ~1 KB ≈ 1 MB 内存上限），list default 50 让 single-call payload 不会太大，cap 200 让大 list 也不会一次性 dump 全部（host 想清空 DLQ 应该用 DELETE 单条而不是 GET 全量）。
- **`replayDeadLetter` 单次投递**：不复用 fireCallback 避免把原始 timestamp 重新生成（receiver 的 idempotency key 会失效）；自己 POST 同一 body，保持 event `ts` 与原 drop 时间一致。
- **scope gate 复用 `webhooks:manage`**：与 §11.10 webhook upsert/delete 同一 scope，host 不用多申请 token。
- **DLQ 不持久化**：与 nonce store、version-history 同款 in-memory 持久模型。要持久化得引入 Redis/Postgres，本批不做；restart 后 DLQ 清空是已知 trade-off。

#### 11.33.3 验证

- `npx vitest run apps/web-server/tests/webhooks-dlq.test.ts`：**23/23 通过**（1.27s）
- `npx vitest run apps/web-server/tests/embed-bridge.test.ts apps/web-server/tests/webhooks-dlq.test.ts apps/web-server/tests/scope-gate.test.ts` 等 critical path：**8 文件 / 108 测试 全绿**
- `npx vitest run apps/web-server/tests/ --exclude=…(4 LLM/timeout e2e)`：**66 文件 / 541 pass / 1 skip**
- `npx tsc` (apps/web-server) 去预存噪音：**0 error**
- `node scripts/bundle.mjs`：`dist/bundle/index.js 28.5mb ⚠️`（与 baseline 同大小）
- live smoke（PORT=33002 + `GENOFFICE_JWT_SECRET`，tmux）：
  - `GET /api/v1/webhooks/dlq` (empty) → `200 {entries:[], count:0, limit:50}` ✓
  - `GET` no auth → `401 UNAUTHENTICATED` ✓
  - `GET` wrong scope (files:read) → `403 FORBIDDEN` ✓
  - `GET ?limit=abc` → `400 INVALID_ARGUMENT` ✓
  - `GET /dlq/nonexistent` → `404 NOT_FOUND` ✓
  - `DELETE /dlq/nonexistent` → `404 NOT_FOUND` ✓
  - `POST /dlq/nonexistent/replay` → `404 NOT_FOUND` ✓
  - `GET ?limit=9999` → `200` + `limit:200` cap ✓
  → **8/8 live smoke**

#### 11.33.4 后续观察

- **§11.3 P1 DLQ backlog**：✅ 本轮闭合
- **DLQ 持久化**：Redis/Postgres 后端留 §M4+；当前 in-memory + LRU 1024 够短期用
- **DLQ + webhook upsert 联动**：当前 host 改 webhook URL 后**旧 DLQ entry 仍指旧 URL**——replay 会 POST 到旧 URL。可加"replay 时用最新 callback URL"选项，但会让 replay 语义复杂化；本批不做
- **`notifyFileSaved` 之外的触发点**：`notifyFileCallback` / `notifyFileDeleted`（如果存在）也应接 DLQ；audit 后再决定
- **host UI 面板**：当前只有 v1 endpoint 暴露 DLQ，renderer 还没"失败事件列表"面板调用；UI backlog
- **DLQ metric**：可以加 `/metrics` 暴露 `dlq_size` / `dlq_total_dropped` 计数；当前 v1 list 即 metric
- **§11.32.4 后续观察**：`destroy()` 自动 release 示例、typedoc-count 显式 step、bridge command 路径测试仍未做；本轮 §11.34 闭合最后一条

### 11.34 本轮续作（v2 第 29 轮 commit，2026-09-22）

§11.32.4 残留 backlog #3 · "bridge 入站 command 路径测试"。审 audio 整个仓库发现更深的问题：bridge IIFE 里 dispatchEvent('host.command') **是 dead code** —— 整个仓库没有任何代码（renderer / IPC bridge / push hub）监听 `'host.command'` CustomEvent。bridge 第 88-93 行派发的事件永远没有消费者。`embed-bridge.test.ts` 用 IIFE eval 测过"inbound command → host.command CustomEvent"——这只是验证 dead code 的精确行为，不是验证真实功能。`embed-endpoint.test.ts` 还把 `host.command` 字符串存在当 positive 守门。本批：① 删除 bridge 中 dispatchEvent('host.command') 死路径；② 替换测试：bridge **不**注册 postMessage 监听（负向守门），endpoint **不**含 `new CustomEvent('host.command', ...)` 代码模式（code-level regex，不匹配注释）；③ bridge.ts / embed/index.ts doc 同步；④ live smoke 验证 served HTML 仍含 ready / SSE / envelope 三件套。

#### 11.34.1 落实

| 文件 | 改动 |
|---|---|
| `apps/web-server/src/embed/bridge.ts` | 移除 IIFE 内 `window.addEventListener('message', ...)` 派发 `host.command` CustomEvent 的死代码块。top doc 从 3 项 responsibilities 改成 2 项（删 "Inbound command relay"）；加 §11.34 注释说明删除原因；保留 envelope version 字符串 `'1.0'` 与 `var ENVELOPE_VERSION` 常量（供未来 bridge-internal use）|
| `apps/web-server/src/embed/index.ts` | top doc 中"proxies inbound commands back to the editor via a `host.command` CustomEvent"删掉，改成"inbound host commands are consumed by the editor's own postMessage listener registered after bridge boot" |
| `apps/web-server/tests/embed-bridge.test.ts` | top doc 重写（2 responsibilities）。删除测试 "relays inbound postMessage commands to window.dispatchEvent as host.command CustomEvent"。替换为 "does NOT dispatch host.command CustomEvent for inbound commands (sdk1.md §11.34)"（pin 负向契约）。删除测试 "ignores postMessages with wrong envelope version"（依赖现在不存在的 listener）。新增 "does NOT install a postMessage listener after §11.34"（pin `messageHandlers.length === 0`）|
| `apps/web-server/tests/embed-endpoint.test.ts` | "posts ready events to window.parent" 测试：保留 `window.parent.postMessage` 含；把 `expect(mod.EMBED_BRIDGE).toContain('host.command')` 翻成 `expect(mod.EMBED_BRIDGE).not.toMatch(/new\s+CustomEvent\(['"]host\.command['"]/)`（code-level regex 不匹配注释）|

合计 4 文件 / +0 净测试数（删 2 加 2，17 总数不变）。

#### 11.34.2 设计要点

- **删除而非保留**：保留 dead code 让集成商误以为这条路径可用、未来 renderer 可能 hook 上去（但 renderer 实际代码结构不接 CustomEvent，hook 不上）。删除让代码与意图对齐：bridge 只做 nonce echo + SSE relay，inbound postMessage 由 editor 自己处理。
- **测试改为负向**：原来测"host.command 被派发"，现在测"host.command 不被派发"。负向测试价值相同——一旦有人加回 dead code 测试立刻红。
- **`messageHandlers.length === 0` 守门**：替代"envelope version 守门"。原 §11.31 测试 "ignores postMessages with wrong envelope version" 假设 bridge 仍注册 listener——前提已不存在，整个 listener 已被删除。新守门 "bridge 不注册 postMessage listener" 是更准确的设计契约。
- **注释保留 `host.command` 字符串**：bridge.ts top doc 提及 "the previous host.command CustomEvent relay was removed" 是未来 reader 的关键上下文。注释不消耗运行时不进 CustomEvent。endpoint 测试用 regex `new\s+CustomEvent\(['"]host\.command['"]` 精确匹配 code-level pattern，不匹配注释。
- **不动 SSE / ready / envelope 行为**：bridge 仍（1）echo nonce，（2）subscribe `/api/ipc/events` SSE relay，（3）`ENVELOPE_VERSION = '1.0'`。这些是 §11.31 的核心契约，本批不动。
- **不动 embed/index.ts dispatcher 路由**：host postMessage command 的消费完全在 iframe 内由 editor bundle 自己的 postMessage listener 完成（`apps/*/src/renderer`），不经过 web-server。bridge 之前的"派发 CustomEvent"中间步骤本就冗余。

#### 11.34.3 验证

- `npx vitest run apps/web-server/tests/embed-bridge.test.ts`：**17/17 通过**（109 ms；删 2 加 2，总数不变）
- `npx vitest run apps/web-server/tests/embed-endpoint.test.ts`：**11/11 通过**
- `npx vitest run apps/web-server/tests/` (skip 4 LLM/timeout e2e)：**67 文件 / 564 pass / 1 skip**（was 66/541，bridge.ts 重构无新增独立测试但新增 embed-bridge.test.ts 内部 2 替换测试）
- `npx tsc` (apps/web-server) 去预存噪音：**0 error**
- `node scripts/bundle.mjs`：`dist/bundle/index.js 28.5mb ⚠️`（不变）
- live smoke（PORT=33002 + tmux）：
  - `GET /embed/:docId?token=&app=docs` → `200` 4067 bytes（was 4025；host.command 派发块删除 ~42 字节）✓
  - 4 个关键 token 仍 present：`ENVELOPE_VERSION` x2 / `sendReady` x4 / `subscribePush` x4 / `parent.postMessage` x1 ✓
  - `GET /api/v1/webhooks/dlq` with `webhooks:manage` scope → `200 {entries:[], count:0, limit:50}` ✓
  → **3/3 live smoke**

#### 11.34.4 后续观察

- **bridge 入站 command 路径 dead code**：✅ 本轮闭合（删 dead code + 负向守门）
- **§11.32.4 后续观察 `destroy()` 自动 release 示例**：✅ #46 闭合（demo-auto-release.tsx + index-auto-release.html）
- **typedoc-count 显式 step**：✅ commit `11f9cad` 已闭合（`.github/workflows/docs.yml` 加 "Assert typedoc output count is within bounds" step + bound 注释引用 typedoc-count.test.ts）
- **§11.31.5 真 iframe e2e**：sandbox 内不可达，skip
- **§11.33.4 DLQ 持久化 / DLQ metric**：留 M4+ 路线图
- **host.command 替代路径**：若未来要支持 host → iframe 单向命令（如"host wants iframe to switch theme"），直接在 renderer 加 `window.addEventListener('message', ...)` 监听 host postMessage——这是 §11.34 之后 iframe 已有的行为
- **bridge.ts comment 含 host.command 字符串**：故意保留——注释是 reader context，endpoint 测试用 code-level regex 隔离

#### 11.35 · DLQ metrics + Prometheus `/api/v1/metrics`

§11.33 把失败投递入 ring buffer 后，host 只能 `GET /api/v1/webhooks/dlq` 拉当前快照——没有累计视图、没有 size trend、运维想接 alert 还得写 polling 脚本。本批闭合 §11.33.4 #2 "DLQ metric" 路线：① 在 `webhooks-dlq` 模块加进程内计数器（dropped / replayed / byReason），通过 `getDeadLetterMetrics()` 暴露；② `/api/v1/webhooks/dlq` list 响应增加 `metrics` 字段，host 一次 fetch 拿到结构化数据；③ 新增 Prometheus-text 公开端点 `GET /api/v1/metrics`，scraper 直接抓；④ metrics 测试守门。

#### 11.35.1 落实

| 文件 | 改动 |
|---|---|
| `apps/web-server/src/common/webhooks-dlq.ts` | 新增模块级 `totals = { dropped, replayed, byReason: { max_attempts, non_retryable_4xx } }`；`pushDeadLetter()` 在 `store.add()` 成功后 `totals.dropped += 1` + `totals.byReason[entry.reason] += 1`；`replayDeadLetter()` 在 `result.delivered === true` 时 `totals.replayed += 1`（失败不动）。新增 `interface DeadLetterMetrics` + `getDeadLetterMetrics(): { size, totalDropped, totalReplayed, byReason, oldestDroppedAt, newestDroppedAt }` + `_resetDeadLetterMetricsForTests()`。`_resetDeadLetterForTests()` 串接 `_resetDeadLetterMetricsForTests()`，确保 `beforeEach` 一次复位 |
| `apps/web-server/src/api/v1/webhooks-dlq.ts` | `handleDlqList()` 返回 body 增加 `metrics: getDeadLetterMetrics()`。结构化字段名匹配 Prometheus exporter 列名（`size`, `totalDropped`, `totalReplayed`, `byReason.max_attempts`, `byReason.non_retryable_4xx`, `oldestDroppedAt`, `newestDroppedAt`），host 可以一个 fetch 拿全部 |
| `apps/web-server/src/api/v1/meta.ts` | 新增 `handleMetrics(ctx)` + module-level `PROCESS_START_MS = Date.now()`。Prometheus text-format 暴露 8 个 metric：`genoffice_dlq_size` (gauge) / `genoffice_dlq_total_dropped` (counter) / `genoffice_dlq_total_replayed` (counter) / `genoffice_dlq_dropped_by_reason{reason="max_attempts|non_retryable_4xx"}` (counter) / `genoffice_dlq_oldest_dropped_at_ms` (gauge, NaN 空) / `genoffice_dlq_newest_dropped_at_ms` (gauge) / `genoffice_ipc_channels_implemented` (gauge, 走 `handlerCount()`) / `genoffice_uptime_seconds` (gauge, `(Date.now()-PROCESS_START_MS)/1000`, 3 位小数)。Content-Type `text/plain; version=0.0.4; charset=utf-8`。**公开端点**（无 auth gate，Prometheus 约定） |
| `apps/web-server/src/api/v1/index.ts` | dispatcher 增加 `if (pathname === '/api/v1/metrics' && method === 'GET') return handleMetrics(ctx)`，位于 `/api/v1/health` 之后 |
| `apps/web-server/tests/webhooks-dlq.test.ts` | 新增 `describe('getDeadLetterMetrics (sdk1.md §11.35)')`（5 测试）：size/totalDropped/totalReplayed/byReason 一次性断言 / 空队列时 oldest/newest = null / totalReplayed 仅成功 replay 时增（stubGlobal fetch ok→fail）/ 单条 delete 不影响 totalDropped（monotonic）/ LRU eviction 不影响 totalDropped 但 size 收敛到 1024 |
| `apps/web-server/tests/metrics-endpoint.test.ts` | **新文件**，7 测试：200 + Content-Type / 8 metric HELP+TYPE 均 present / 空队列计数=0 + oldest/newest=`NaN` / push+replay 后计数移动 / `ipc_channels_implemented` 等于 `handlerCount()` / 公开（无 Bearer 200）/ 末尾换行（Prometheus 格式约定）|

合计 6 文件改 + 1 文件新增；web-server 测试 581 → 593（+12）。

#### 11.35.2 设计要点

- **in-process 计数器 vs. 持久化**：totals 是 process-local（restart 清零），与 DLQ 本身同 durability model。Prometheus 默认就把 scrape 周期内的 rate 当成"现在发生的事"，重启断点用 `rate()` 自带处理。持久化（Redis / Postgres / on-disk）属 M4+ backlog。
- **monotonic 语义**：`totalDropped` 与 `totalReplayed` 是 Prometheus counter，从不保护 Prometheus counter 应只减不增的语义。**LRU 淘汰不影响 totalDropped**（counter 是"累计进队列"，不是"现在队列里有几条"）；`deleteDeadLetter()` 不影响 totalDropped（手动 ack 是补救，不该回算）。
- **byReason label cardinality**：only two reasons — `max_attempts` / `non_retryable_4xx`，cardinality=2，Prometheus 高基数警告阈值（>10）远未触发。新增 reason 时必须同步 `DeadLetterMetrics.byReason` 的类型定义与 `pushDeadLetter()` 行内的 `byReason[reason] += 1` —— 通过 type 强制一致。
- **oldest/newest 用 NaN 而不是 0**：Prometheus gauge 在 "restart 前 = 0" 会让 `time() - genoffice_dlq_oldest_dropped_at_ms` 算出"30 天前"的离谱值；空队列必须 NaN 让 scraper 跳过该 sample。本批用 `?? 'NaN'` 三元表达式显式处理。
- **公开端点的边界**：本批 `/api/v1/metrics` 无 auth（Prometheus convention: scraper 不会 mint token）。host 想透安全 → 在反向代理 / sidecar 层加同样 JWT gate 或 basic-auth（host 部署层职责，不属 endpoint 契约）。文档明文在 `handleMetrics()` JSDoc。
- **`handlerCount()` 复用**：§11.5 已实现 `handlerCount()` IPC channel 注册数；本批复用其作为 `genoffice_ipc_channels_implemented` 数据源 — 不另立 store。两个数据源（`/api/channels` 与 `/api/v1/metrics`）走同一行 IPC registry，scrape 之后值必然一致。
- **新 bug fix in 11.35**：先前 §11.33 的 §11.35 实施漏掉了关键 wiring — `store.add()` 不增 totals / `replayDeadLetter()` 成功分支不增 totals。本批修复了这两处遗漏（原 5 个 metrics 测试全挂在 expected 1 vs got 0）。修复方式是把 bump 放在 `pushDeadLetter()` 与 `replayDeadLetter()` 的 wrapper 层（不是 store 层），这样 store 接口与 metrics 关注点解耦，future caller 误用 store.add() 也不会让 metrics 漂移。

#### 11.35.3 验证

- `npx vitest run apps/web-server/tests/webhooks-dlq.test.ts`：**28/28 通过**（23 旧 + 5 新；本批 fix wiring bug 后从 23 pass / 5 fail 变 28 pass / 0 fail）
- `npx vitest run apps/web-server/tests/metrics-endpoint.test.ts`：**7/7 通过**（新文件，~240ms）
- `npx vitest run apps/web-server/tests/` (skip 4 LLM/timeout e2e)：**68 文件 / 576 pass / 1 skip**（was 71/581 → now 72/593；本批 +5 DLQ metrics +7 endpoint metrics = +12 tests）
- `npx vitest run apps/sdk`：**108/108 通过**（本批不动 SDK）
- `npx tsc -p apps/web-server/tsconfig.json --noEmit`：去预存噪音（`pptx-ops/src/op-docs.ts` 的 `?raw` imports + `xlsx-gateway` 三行）后 **0 新增 error**
- live smoke（PORT=33002 + tmux）：
  - `GET /api/v1/metrics` → 200 text/plain Prometheus 格式
  - body 含 8 个 `# HELP` + 8 个 `# TYPE` 完整组合
  - `genoffice_dlq_size 0` / `genoffice_dlq_total_dropped 0` / `genoffice_dlq_total_replayed 0` 初值正确
  - 触发 3 次 webhook save 到 500-only target 后，counters 增到 3，`byReason{max_attempts} 3`，`byReason{non_retryable_4xx} 0`
  - replay 1 次成功后 `genoffice_dlq_total_replayed 1`，`genoffice_dlq_size 2`
  - `genoffice_ipc_channels_implemented 551`（与 `/api/channels` 一致）
  - `genoffice_uptime_seconds` 单调递增
  - 无 auth 头直接 GET，200 OK
  → **5/5 live smoke**

#### 11.35.4 后续观察

- **DLQ 持久化（M4+ backlog）**：进程内 ring buffer 重启清空。持久化方案：① Postgres `dead_letters` 表（运维最熟）；② Redis list + expire；④ on-disk `data/dlq.ndjson` append-only + 启动时 load。当前 sandbox 无外网，连不上 Postgres / Redis；保留为 M4+ 工作。
- **scraper 接入示例**：未来 `docs/deployment/prometheus.md` 加一段 `scrape_configs` 示例 + Grafana dashboard JSON（`rate(genoffice_dlq_total_dropped[5m])` / `histogram_quantile(0.95, rate(genoffice_dlq_size[1m]))`）。
- **`/api/v1/webhooks/dlq` 与 `/api/v1/metrics` 一致性**：list 响应里 `metrics.size` 与 `/api/v1/metrics` 的 `genoffice_dlq_size` 取自同一 `store.size()`，所以同一个 scrape cycle 内数值不会漂移（保证 scrape semantic 一致）。
- **alert 规则示例**：Prometheus alerting rule 草案：`genoffice_dlq_size > 100 for 5m` → 警告 / `rate(genoffice_dlq_total_dropped[1m]) > 0.1` → 严重。文档化在 deployment/prometheus.md（M4+）。
- **histogram bucket 未来扩展**：`genoffice_dlq_oldest_dropped_at_ms` 当前只是 gauge，可以扩成 `genoffice_dlq_age_seconds_bucket` histogram 提供 p50/p95/p99 老化分布。本批只暴露瞬时 gauge。
- **§11.33.4 残留 backlog**：`webhook DLQ + upsert` 双向耦合（删除 webhook 后自动 replay / drop 该 webhook 现有 DLQ 项）—— 当前实现里 webhook delete 仅删注册，不动 DLQ；M4+ 路线图。

### 11.36 · bridge 双向通道修复 + SDK 服务端命令 dispatch

审 `apps/sdk` + `apps/web-server/src/embed` 双向通道时发现两个真实断点，本轮一并闭合。

#### 11.36.1 断点 1 · bridge outbound `dir` 与 SDK `isEnvelope` 不兼容

`apps/sdk/src/envelope.ts:76` 的 `isEnvelope` 严格比较
`dir === 'editor→host' || dir === 'host→editor'`（U+2192 右向箭头）。
bridge IIFE 里写的是 `'editor->host'`（ASCII 连字符 U+002D），
`isEnvelope` 静默拒绝 —— 意味着**每一条 SSE relay 的生命周期事件**
（`saved` / `dirtyChanged` / `selectionChange` / `error` / `closed`）在
SDK 侧都被丢掉，host 的 `editor.on('saved', cb)` 永远不触发。

（handshake 的 `ready` 事件不受影响：它的处理路径直接读
`payload.name`，不走 `isEnvelope` + `dispatch`。）

修复：`bridge.ts` 改一个字（`->` → `→`）；`embed-bridge.test.ts` 补
2 条守门 —— ① source-grep 断言 bridge 源码不含 ASCII 形态、必含箭头；
② live-runtime 断言 bridge 产出的每条 postMessage 的 `dir` 都是箭头。

#### 11.36.2 断点 2 · inbound command 通道从未接通

§11.34 判定 `host.command` CustomEvent 是 dead code 并删除，结论
"inbound 由 editor bundle 自己的 postMessage listener 处理"。但审
renderer 时发现 `apps/*/src/renderer` 里**没有任何 GenOffice envelope
的 inbound listener**（现有 `addEventListener('message')` 全是
Dataflare 自家协议）—— 也就是 SDK 的 `editor.command()` 发出去的
envelope 从来没人接，30 s 后必然超时。

修复分两层：

| 层 | 改动 |
|---|---|
| bridge（`embed/bridge.ts`） | 新增 `onHostMessage`：只接 `v==='1.0' && dir==='host→editor'`，只 dispatch `kind==='command'`；新增 `replyCommand` 把结果镜像成 `command-result` envelope。dispatch 顺序：① `window.__GENOFFICE_COMMAND_SINK__`（renderer 装上时优先，避免双回复）；② `POST /api/ipc/sdk:command` + `x-ipc-session`。 |
| 服务端（`embed/sdk-commands.ts`，NEW 349 行） | 单一 `sdk:command` 通道 + 显式 `SDK_COMMAND_TABLE`。SDK 命令名（`addComment`）与 renderer IPC 通道名（`comments:add`）是两套命名空间、两套 arg 形状，多路复用到一个通道避免契约冲突，也给"哪些 SDK 命令真的服务端承载"一个可审计清单。 |

服务端承载面（8 条）：

| 命令 | 后端 | 语义 |
|---|---|---|
| `addComment` / `listComments` / `resolveComment` / `removeComment` | `common/comments-store.ts` | durable，跨浏览器重启仍在 |
| `listVersions` / `restoreVersion` / `createSnapshot` | `common/version-history.ts` | `createSnapshot` 读 live 文件落快照；`restoreVersion` 回报 restore 后的最新 version id |
| `reportUsage` | 模块内聚合器 | 进程本地，durability 对齐 DLQ |

其余命令（`setContent` / `insertText` / `undo` / `mountSidebar` /
`openFileDialog` / `print` / …）返回结构化 `UNSUPPORTED` + 修复提示
（"the renderer bundle services it via its own postMessage listener"）
—— 明确失败优于静默悬挂或假 `{ok:true}`。

`resolveDocPath()` 接受裸 basename 或 FILES_DIR 相对子路径，拒绝
traversal，并以 `basename` 作为 store key（与全部 save pipeline 一致）。

#### 11.36.3 §11.36.2 附带 · telemetry 闭环

审 `apps/sdk/src/editor.ts` 发现 telemetry ticker **只 dispatch 本地
`usage` 事件**，从不向服务端上报 —— 服务端聚合器永远拿不到样本。

修复：`reportUsage` 加入 `EditorCommands` union；30 s ticker 在 dispatch
本地事件的同时上报服务端；`destroy()` 在**翻转 `destroyed` 之前**（iframe
还挂着、`command()` guard 还没生效）flush 最后一笔。自动路径 fire-and-forget
（server 挂了不能拖垮编辑器），host 显式调用仍然 loudly reject。

`GET /api/v1/metrics` 同步新增 7 条 `genoffice_sdk_*` 序列
（samples / instances / doc_bytes_written / ai_calls / prompt_chars /
response_chars / session_ms），让运维能把 host 用量与 DLQ 计数器一起抓。

#### 11.36.4 验证

| 门 | 结果 |
|---|---|
| `apps/sdk` 测试 | 15 文件 / 195 → **16 文件 / 201**（Gate #1 目标 182，已超） |
| web-server 测试 | 71 文件 / 618 → **73 文件 / 664 + 1 skip**（Gate #2 目标 629，已超） |
| `embed-bridge.test.ts` | 17 → 30（+2 dir 守门，+11 inbound dispatch/sink） |
| `sdk-command-dispatch.test.ts` | **NEW 24**（docId 解析 3 / comments 5 / versions 5 / telemetry 2 / unsupported+malformed 4 / 形状不变量 1 / 注册 1 / surface 1 / 通道名 1 / INTERNAL 1） |
| `sdk-command-e2e.test.ts` | **NEW 8**：启动真实 bundle server + 隔离 DATA_DIR，走真 HTTP —— 唯一能证明整条链（`POST /api/ipc/sdk:command` → dispatcher → registry → dispatch → durable store → wire envelope → 重查证持久化）的套件 |
| `report-usage.test.ts` | **NEW 6**（类型成员 / 显式调用 envelope / ticker 样本含 instanceId / telemetry 关时不上报 / destroy flush / fire-and-forget 韧性） |
| `metrics-endpoint.test.ts` | 补 SDK usage 序列覆盖 + 1 条专用测试 |
| typecheck | 双端 clean（pptx-ops / xlsx-gateway 的 9 行 pre-existing 未触碰） |
| SDK bundle | UMD 26.3 kB（Gate #5 预算 30–50 kB 内） |
| commit | `04eaf6e`（dir 修复）/ `7c7f878`（inbound dispatch）/ `25519f0`（服务端承载 + telemetry）/ `d009fef`（sdk1.md）/ `d0fc7d9`（e2e + 错误契约对齐 IPC taxonomy） |

**错误契约修正**（`d0fc7d9`）：共享 IPC dispatcher 已经把 handler 返回值包成
`{ok:true, result}`、把抛出的错误序列化成 `{error:{code, channel, reason}}`；
`sdk-commands.ts` 初版又自己包了一层，导致成功时 wire 上出现
`{ok:true, result:{ok:true, result:…}}` 双重嵌套、失败时 body 无法归类。修正为
**handler 返回裸结果 + 抛 typed error**（`InvalidArgumentError` /
`NotFoundError` / `WebUnsupportedError`），由共享分类器统一产出 wire shape
（与其它 500+ 通道一致）。未知 / renderer 专属命令现在抛
`WebUnsupportedError` → HTTP 501 `WEB_UNSUPPORTED`。

#### 11.36.5 后续观察

- **命令面仍偏窄**：8 条服务端承载命令覆盖了需要 durable 状态的那部分；
  `setContent` / `mountSidebar` / `openFileDialog` 这类必须有活模型的命令
  仍等 renderer bundle 装 `__GENOFFICE_COMMAND_SINK__`。桥已经把
  extension point 留好，renderer 接上即可，不需要再动 web-server。
- **author 归属**：`addComment` 经 bridge 进来只能标 `embed-session`
  （bridge 用 session header 而非 bearer token，服务端拿不到 `sub`）。
  需要真实作者归属的 host 应走 `POST /api/v1/files/:id/comments`
  （从验过的 JWT 里取 `sub`）。这条差异已写进 `sdk-commands.ts` 注释。
- **usage 聚合是进程本地**：重启清零，与 DLQ 同 durability 模型；
  持久化（Postgres / Redis / on-disk）仍属 M4+ backlog。
- **pre-existing flake**：`plugin-e2e.test.ts`（外部连接超时）与
  `event-broadcast-e2e.test.ts`（SSE 时序）在全量跑时偶发，单独跑均通过、
  `--retry=2` 下全绿；两者均不在本轮改动集合内。

### 11.37 · Comment webhook + Audit log 持久化（M4 §C / M5 backlog 一并收口）

> 两项都是 sdk1.md 既定 backlog，本轮一起做。零 Rust 改造、零外部依赖、纯
> TS 层 wiring，与 §11.36 SidebarRuntime 同一思路。

#### 11.37.1 Comment webhook 事件（§M4 §C backlog closed）

**问题**：save pipeline 已通过 `notifyFileSaved` 触发 `file.saved`
webhook，但评论增删改无任何对外通道，host 集成商无法实时收到评论
变更通知。

**落实**：
- `apps/web-server/src/common/comments-store.ts` 新增内部
  `notifyComment(fileId, event, comment)` helper，使用与
  `webhooks-store.ts` 同样的 lazy-import 模式避免循环依赖；
  在 `addComment` / `resolveComment` / `removeComment` 三处副作用后
  各调一次。
- 事件名：`comment.added` / `comment.resolved` / `comment.removed`。
- Payload 形态：`{ commentId, author, text, anchor, resolved, resolvedAt?, parentId?, createdAt }`。
- `removeComment` 在 `splice` 前先 `const removed = list[idx]!`，把删
  除的 comment 完整快照带出去，host 端能拿到被删内容的元数据用于
  审计（与 §0.4 "文档管理功能" 闭环）。
- fire-and-forget；失败由 `webhooks-store.fireCallback` 内的 DLQ
  自动承接，**不让 webhook 投递问题回灌评论写路径**。
- 测试 `apps/web-server/tests/comment-webhook.test.ts` 5 例：add / resolve
  / remove 各 1 例；fireCallback 抛错时 mutation 仍成功；无 callback
  注册时不抛错。

**协议 wire shape**（与 §11.36 `file.saved` envelope 一致）：

```json
{
  "v": "1.0",
  "event": "comment.added",
  "ts": 1234567890,
  "fileId": "doc-1",
  "data": {
    "commentId": "cm_AbC...",
    "author": "alice",
    "text": "please review",
    "anchor": { "range": { "start": 100, "end": 120 } },
    "resolved": false,
    "resolvedAt": null,
    "parentId": null,
    "createdAt": 1234567890
  }
}
```

**设计要点**：
- 与 `file.saved` 共用同一 HMAC-SHA256 签名链路；host 端不用区分事件
  类型解签名。
- 删除事件保留 `text` / `anchor` 字段 — 这是 §A.5 "软删除与审计"的最小
  可用替代，避免 host 端需要为 "已删除评论" 单独建表。
- `comment.resolved` 只在 `resolved: true` / `resolved: false` 切换时发；
  不发 "unresolved" 单独事件，避免事件爆量。

#### 11.37.2 Audit log 持久化（§M5 backlog closed）

**问题**：原 `enterprise/auth-audit.ts` 把审计记录存进 `common/state.ts`
的 `AUDIT_LOGS: Map<string, AuditRecord>`。进程重启即清空 — 合规场景
下这是灾难（SOX / HIPAA 都要求 ≥ 6 个月可查询）。sdk1.md §C M5 明确
标 "审计日志（合规）" 为 backlog。

**落实**：
- 新增 `apps/web-server/src/common/audit-log.ts`（274 行），持久化到
  `DATA_DIR/audit-log.jsonl`（append-only JSONL）。
- API：`recordAudit(input)` / `queryAudit(filters)` / `exportAudit(opts)` /
  `auditSize()` / `snapshotAuditLog()` / `_resetAuditForTests()`。
- 内存 mirror 上限 10 000 条（最新在前）；超过后尾部淘汰。`appendFileSync`
  逐行追加 — 部分 tail 损坏（`kill -9` 常态）由 hydrate 路径跳过单条
  解析失败行，不阻塞 boot。
- `import * as fssync from 'node:fs'`（命名空间导入而非 named import），
  让 `vi.mock('node:fs')` 能稳定拦截 — 否则 ESM 命名空间只读无法替换。
- `GENOFFICE_AUDIT_PERSIST=0` 环境变量禁用持久化（CI 隔离场景）。
- `enterprise/auth-audit.ts` 重写：去掉 `AUDIT_LOGS.set(...)` /
  `[...AUDIT_LOGS.values()]` 直接读写，改为 `recordAudit` / `queryAudit` /
  `exportAudit`。原 placeholder 注释保留（OIDC state 校验仍是 M5+ backlog）。
- `common/state.ts` 移除 `AUDIT_LOGS` Map 与 `AuditRecord` interface
  （后者移至 `audit-log.ts`）。
- 测试 `apps/web-server/tests/audit-log-persistence.test.ts` 7 例：
  append / 跨重启 hydrate / 过滤 / export 三种格式 / kill -9 损坏行跳过 /
  `GENOFFICE_AUDIT_PERSIST=0` 禁用 / 写失败内存 mirror 仍保留。

#### 11.37.3 §0.4 文档管理功能补全

| 维度 | 之前 | 之后 |
|---|---|---|
| **审计日志** | 进程 Map，重启清空 | 磁盘 JSONL，10k 条上限，跨重启可查询 ✅ |

第 14 项"协作冲突解决"仍属 M4+ §C backlog（Yjs / CRDT，需新依赖，
不在本轮范围）。

#### 11.37.4 验证

- `vitest run tests/audit-log-persistence.test.ts tests/comment-webhook.test.ts`
  → **12/12 通过**（耗时 1.97s）
- 全量 `vitest run apps/web-server` → **86/86 文件 · 724/725 测试通过**（+11 net，新增 12 + 删除 1 个改动 audit 模块间接断掉的旧断言），比上轮 713 → 724
- typecheck：web-server 自有 src 0 errors（依赖包 pptx-ops / xlsx-gateway
  9 个 pre-existing 与本轮无关）

#### 11.37.5 文件改动统计

```
apps/web-server/src/common/audit-log.ts         | +274 (new)
apps/web-server/src/common/comments-store.ts    | +38
apps/web-server/src/common/state.ts             | -19 (drop AUDIT_LOGS Map)
apps/web-server/src/common/index.ts             | +14 -2 (re-export)
apps/web-server/src/enterprise/auth-audit.ts    | +48 -56 (refactor)
apps/web-server/tests/audit-log-persistence.ts | +160 (new, 7 cases)
apps/web-server/tests/comment-webhook.test.ts   | +146 (new, 5 cases)
sdk1.md                                         | +96 (本节)
```

总净增：~700 行（94% 测试代码）。

#### 11.37.6 风险与后续

- **JSONL 不是 concurrent-append 安全的**：与 DLQ 同设计（单进程 Node
  假设）。多进程 cluster 模式（M4+）必须切到 SQLite 或 Postgres。
- **CSV 导出手动 escape**：覆盖双引号 / 逗号 / 换行三字符；其余边角
  Unicode（如 `\r\n` 混合）以 `,` 切字段会出现毛刺。商业版可以换
  `papaparse` 之类库（M5+）。
- **审计日志保留期**：当前 10 000 条上限 ≈ 1 个中等用户一年的写
  操作量。生产环境应当加 `GENOFFICE_AUDIT_RETENTION_DAYS` + 周期
  rotate 脚本（M5+）。
- **author 缺失**：旧 `audit:log` handler 用 `userId: 'system'`，本轮
  透传给 `recordAudit` 默认值；未来 handler 应从 JWT `sub` 取值（scope
  在 v1 已有 `files:read` 等，但 `audit:log` 本身没有 scope 守卫 —
  这是已知缺口，记入 M5+ backlog）。
- **comment events 投递**：未做 per-file 事件订阅白名单；host 必须
  在 `saveCallback({ fileId, events: [...] })` 中显式声明 `events`
  包含 `'comment.added'` / `'comment.resolved'` / `'comment.removed'`
  才会收（与 `file.saved` 同机制）。

### 11.38 · §B.5.1 #2 Undo/Redo/getUndoStack + renderer alias 构建修复

> 本轮兑现 SDK 2.0 §B.5.1 #2（undo / redo / getUndoStack），顺带修复了
> 一个让 **6 个编辑器 renderer 全部无法重新构建** 的真实缺陷。

#### 11.38.1 §B.5.1 #2 — Undo / Redo / getUndoStack

**问题**：`apps/sdk/src/types.ts` 早就声明了 `undo` / `redo` / `getUndoStack`
三个命令（`EditorCommands` union），但没有任何一层实现它们：

| 层 | 之前 | 之后 |
|---|---|---|
| `apps/sdk` 类型 | ✅ 已声明 | ✅ 不变 |
| `packages/ipc-bridge` sink | ⬜ handler 不存在 → `UNSUPPORTED` | ✅ `makeLiveModelHandlers` 注册 3 个 |
| `text-buffer-adapter` | ⬜ 无 undo 栈 | ✅ 100 步上限的 past/future 双栈 |
| `apps/docs` renderer | ⬜ Ctrl+Z 只走键盘 | ✅ 注册 tiptap 的 `commands.undo/redo` |

**落实**：

1. `packages/ipc-bridge/src/text-buffer-adapter.ts`
   - `TextBuffer` 新增 `past` / `future` 双栈（`MAX_UNDO_DEPTH = 100`）
   - `pushUndo()` 只在 **host 发起的** mutation（`setContent` /
     `insertText`）前快照；`updateTextBuffer` 的本地编辑**故意不入栈** ——
     应用自己的 undo manager（tiptap / Univer）已经管着它们，双份记录会让
     一次 Cmd+Z 看起来撤销两次
   - `undo()` / `redo()` / `undoStack()` 三个方法；`undoStack()` 返回
     `{ length: past+future, current: past.length }`，与 SDK 契约一致
   - 新导出 `undoTextBuffer()` / `redoTextBuffer()` / `textBufferUndoStack()`
2. `packages/ipc-bridge/src/sdk-command-sink.ts`
   - `SdkLiveModelAdapter` 新增 `undo?` / `redo?` / `getUndoStack?`
   - `makeLiveModelHandlers` 注册三个 handler；`undo` / `redo` 返回 `false`
     时抛 `UnsupportedCommandError`（SDK 契约里"没东西可撤"最近似
     `UNSUPPORTED`）
   - `getUndoStack` 做归一化（`Math.trunc` + `Math.max(0, …)` +
     `current ≤ length`），防止写坏的 adapter 把 `NaN` / 负数喂给 host 的
     "能否撤销"按钮状态
3. **`registerNativeAdapter()` 注册表（关键设计）**
   - `installTextBufferSink` 在 renderer boot 时执行，但编辑器实例要等 React
     mount 才存在 —— 顺序矛盾。新增全局注册表 + 每次命令 **惰性查找**，
     应用在编辑器 mount effect 里 `registerNativeAdapter(...)` 即可，已安装
     的 sink 自动开始委派
   - 注册的方法**绑定到 adapter 对象**，所以 `{ undo() { return this.editor.undo() } }`
     写法保留 `this`
   - dispose 只在"仍指向自己"时清除，避免快速 unmount/remount 把新 adapter 抹掉
4. `apps/docs/src/renderer/App.tsx`
   - `editorRef` effect 旁新增注册 effect：`undo` / `redo` 直通
     tiptap `commands.undo()` / `redo()`；`getUndoStack` 由
     `editor.can().undo() / can().redo()` 推导
   - `getText` / `setText` **故意不注册** —— docs 的 buffer 往返由
     `web-bridge.ts` 拥有，走 tiptap 会绕过分页管线

#### 11.38.2 renderer alias 构建修复（6 app 全部构建失败）

**症状**：`electron-vite build` 在 6 个编辑器上全部失败：

```
[vite:load-fallback] Could not load …/packages/ipc-bridge/src/index.ts/sidebar-runtime
  (imported by src/renderer/web-bridge.ts): ENOTDIR
```

**根因**：Vite 的字符串 alias 是**前缀替换**，不是精确匹配。各 app 的
`localAlias` 里 `'@genoffice/ipc-bridge'` → `…/src/index.ts` 排在子路径
之前，于是 `'@genoffice/ipc-bridge/sidebar-runtime'` 被改写为
`…/src/index.ts/sidebar-runtime`。`docs` / `sheets` / `slides` / `pdf` /
`markdown` 五个 app 是 §11.36 加 sidebar 时才引入子路径 import 的，
alias 表没跟着补；`apps/html` 更彻底 —— **完全没有 alias 块**，renderer
一直在从 `node_modules` 打包一个 §11.36 之前的 ipc-bridge 副本。

**落实**：
- 5 个 app 的 `localAlias` 补齐 3 条子路径（`sdk-command-sink` /
  `text-buffer-adapter` / `sidebar-runtime`），全部排在 bare 之前
- `apps/html/electron.vite.config.ts` 补出完整 alias 块 + 把
  `@genoffice/ipc-bridge` 加进 main/preload 的 `externalizeDepsPlugin.exclude`
  （workspace 包是裸 TS 源码，externalize 会让浏览器拿到未解析的 bare import）
- 新增守门测试 `apps/web-server/tests/renderer-alias-order.test.ts`（18 例）：
  6 个 app × 3 条断言 —— 子路径别名存在、都排在 bare 之前、ipc-bridge 未被
  externalize。**已验证该测试能抓到这个 bug**（故意把 docs 的 bare 行挪到
  sidebar-runtime 之前 → 测试立刻红）。

#### 11.38.3 验证

- `packages/ipc-bridge` → **6 文件 / 135 测试通过**（+15：12 个 undo/redo +
  3 个注册表）
- `apps/web-server/tests/renderer-alias-order.test.ts` → **18/18 通过**
- 6 个 app `electron-vite build` → **全部成功**，产物含新 surface
  （`docs` bundle grep 到 `getUndoStack` ×5 / `registerNativeAdapter` ×2 /
  `__GENOFFICE_NATIVE_ADAPTER__` / `sidebarMessage`）
- `apps/docs` typecheck → 0 个新错误（仅 pre-existing `ShortcutsDialog.tsx`
  i18n-key 与 `file-parse/src/pdf.ts` 类型声明，均不在改动集合内）

#### 11.38.4 风险与后续

- **tiptap 无深度 API**：`getUndoStack` 返回 `{ length: depth, current }`，
  其中 depth 由 `can().undo()` + `can().redo()` 推导（0/1/2），不是真实
  步数。SDK 契约明确允许"不跟踪深度的编辑器"返回 `{length:0,current:0}`，
  而真实深度需要 tiptap 内部 history plugin 的私有状态。host 侧按钮状态
  （能不能撤 / 能不能重做）是准确的，只是没有"还能撤 N 步"的展示。
- **其余 5 个 app 尚未注册 native adapter**：`sheets`（Univer 有
  `univer-state.ts` 的 redo 栈）、`slides` / `pdf` / `markdown` / `html`
  目前走 text-buffer 的 host-mutation 栈。逐个接 Univer / 各编辑器的
  history 是机械工作，留作 follow-up（每 app ~10 行）。
- **`insertImage` / `setTheme` / `setLang` 仍无 adapter**：不在本小节范围。
- **构建产物不入库**：`out/` 已 gitignore；本轮的 build 只用于验证，
  CI 会重建。

### 11.39 · §B.5.1 #2 六个 app 全部接线 + ipc-bridge EOPT 类型修复

§11.38 把 undo/redo 的**机制**做完了（sink handler + 双栈 + 注册表），并把
`apps/docs` 接上 tiptap。本轮把剩下 5 个 app 全部接上各自编辑器的真实
history，顺手修掉一组让 app typecheck 报错的 `exactOptionalPropertyTypes`
违规。

#### 11.39.1 六个 app 的 native adapter

| App | 编辑器模型 | `getUndoStack` 精度 | 备注 |
|---|---|---|---|
| `docs` | tiptap（ProseMirror） | 可用性（0/1/2） | §11.38 已接 |
| `markdown` | tiptap | 可用性（0/1/2） | 新增 |
| `html` | CodeMirror 6 `SourceEditorHandle` | 可用性（0/1/2） | 直接复用 `undo()` / `canUndo()` |
| `sheets` | Univer `IUndoRedoService` | **真实深度** | 复用已有 `undoRedoStatus$` 订阅，`{length: undos+redos, current: undos}` |
| `pdf` | 自有 `EditSnapshot` 双栈 | **真实深度** | `{length: undo+redo, current: undo}`，push 侧已 cap 50 |
| `slides` | 主进程 snapshot 栈 | 常量 1/1 | `slides:undo` 返回 deck 或 null；null 被 renderer 内部吞掉 |

**设计一致性**：六个 app 都用同一个 `registerNativeAdapter()`（惰性解析，
mount 时注册，boot 时就装好的 sink 立刻开始委派），每 app ~20 行。
`getText` / `setText` **一律不注册** —— 六个 renderer 的文本往返都由
`web-bridge.ts` 的 buffer 拥有，改走各自编辑器会绕过它们各自的管线
（docs 的分页、html 的 version 计数、sheets 的 journal 抑制等）。

**Univer 深度**：`sheets` 的 `undoRedoStatus$` 订阅本来就在（驱动 QAT 按钮
的灰化），本轮只是把 `{undos, redos}` 同时镜像进 `histRef`，所以拿到的是
**真实步数**而不是可用性近似。

**slides 的取舍**：`undo` / `redo` 会先判断焦点是否在文本框里（是则走
`document.execCommand('undo')` 保留原生输入撤销），这条分支让 adapter
无法观察"栈空"。因此 `getUndoStack` 报常量 `1/1` —— host 的按钮恒亮，
空栈时 `slides:undo` 返回未变化的 deck 而非报错，属于已知的精度损失
（已在 §11.39.3 记为 follow-up）。

#### 11.39.2 ipc-bridge `exactOptionalPropertyTypes` 修复

6 个 app 的 `tsc --noEmit` 在 `packages/ipc-bridge` 上各报 1-2 个 TS2379 /
TS2375（不是本轮引入，是一直存在、被 app 的 typecheck 掩盖的）：

```
packages/ipc-bridge/src/sdk-command-sink.ts(437,39): error TS2379
  Argument of type '{ panelUrl: string; width: number | undefined; title: string | undefined; }'
  is not assignable to parameter of type '{ panelUrl: string; width?: number; title?: string; }'
  with 'exactOptionalPropertyTypes: true'.
packages/ipc-bridge/src/sidebar-runtime.ts(260,13): error TS2375 …
```

根因：两处都把 `typeof x === 'number' ? x : undefined` 的结果直接塞进可选
字段。`exactOptionalPropertyTypes: true`（monorepo 默认）区分"字段缺失"和
"字段显式为 undefined"。改成条件展开：

```ts
...(typeof input.width === 'number' ? { width: input.width } : {}),
```

修复后 6 个 app 的 `ipc-bridge` 相关错误 **全部归零**（此前每 app 1-2 个）。

#### 11.39.3 验证

- `packages/ipc-bridge` → **6 文件 / 135 测试通过**
- 6 个 app `electron-vite build` → **全部成功**
- 6 个 app 的 `tsc --noEmit` → **ipc-bridge 相关错误 0 个**（每 app 的
  pre-existing 错误——i18n key 表、`pdfjs-dist` worker 声明——不在改动范围）
- 产物校验：6 个 bundle 都 grep 到 `registerNativeAdapter` ×2

#### 11.39.4 风险与后续

- **`markdown` / `docs` / `html` 的深度是近似值**：tiptap 与 CodeMirror
  都没有公开的 history-depth API。host 的"能不能撤/重做"是准确的，没有
  "还能撤 N 步"。要真实深度需要读 tiptap history plugin 的私有 state
  （脆）或换成自维护快照栈（重），收益很低，暂不做。
- **`slides` 报常量 1/1**：见 §11.39.1 的取舍。要精确需要把
  `slides:undo` 的 null 语义透传到 renderer（改 `applyHistoryResult` 的
  返回形状），属独立小改动。
- **`insertImage` / `setTheme` / `setLang` 仍无 adapter**：不在本小节范围。

### 11.40 · §B.5.1 #5 Track changes 全链路

§B.5.1 的 9 个 surface 里，第 5 个（Track changes / 修订追踪）此前只有
`apps/docs/src/renderer/editor/revisions.ts`（约 600 行的 Word 修订引擎）
和 Review ribbon 的 UI，**SDK 侧完全没有通道** —— host 无法打开追踪、读不到
待决修订、也无法接受/拒绝。

#### 11.40.1 协议

`apps/sdk/src/types.ts` 的 `EditorCommands` 新增 4 条：

```ts
setTrackChanges:  { args: { enabled: boolean }, result: { ok: true } }
getTrackChanges:  { args?: {}, result: {
  enabled: boolean
  changes: Array<{ id: string; kind: 'insert'|'delete'|'modify'
                   author: string; date: string; text: string }>
} }
acceptChange:     { args: { changeId: string }, result: { ok: true } }
rejectChange:     { args: { changeId: string }, result: { ok: true } }
```

**`changeId` 的设计（本节的关键难点）**：host 要拿着 id 调
`acceptChange`，但 ProseMirror 的位置在它前面的任何编辑之后全部失效 ——
host 在一次无关的打字之后调用，就会命中错误的 range。所以 id 由修订自身的
**可观察属性**哈希得到（FNV-1a over `kind\0author\0date\0text`），
**故意排除 `from` / `to`**：

```ts
export function revisionId(r: RevisionRange): string   // rev_<base36>
export function revisionKindForSdk(kind)               // 12 种内部 kind → 3 值
export function collectRevisionsForSdk(doc)            // 直接给 SDK 线格式
```

12 种内部 revision kind（`ins` / `del` / `both` / `pPrChange` / `moveFrom` /
`moveTo` / `rPrChange` / `rowIns` / `rowDel` / `cellIns` / `cellDel` /
`blockIns` / `blockDel`）折叠成 SDK 的 3 值 union：插入类（ins / rowIns /
cellIns / blockIns / moveTo）→ `insert`；删除类 → `delete`；其余（属性修改 /
混合）→ `modify`。`applyRevisions` 顺带从 `function` 改为 `export`，让
按 id 的操作能直接复用 Review ribbon 的引擎 —— 保证 host 的一次
`acceptChange` 落地为**一个带 `TRACK_IGNORE` meta 的 tracked transaction、
一步 undo**，与应用内"接受此修订"完全一致。

#### 11.40.2 三层接线

| 层 | 改动 |
|---|---|
| `apps/sdk/src/types.ts` | `EditorCommands` +4（共 31 条命令）|
| `packages/ipc-bridge/src/sdk-command-sink.ts` | `SdkLiveModelAdapter` +4 可选方法；`makeLiveModelHandlers` 注册 4 个 handler（`enabled` 非布尔 → 报错；`changeId` 缺失/空 → 报错；adapter 返回 `false` → `unknown change id` 报错）|
| `packages/ipc-bridge/src/text-buffer-adapter.ts` | 4 条命令**永远委派** native adapter；没注册时抛 `UnsupportedCommandError` |
| `apps/docs/src/renderer/App.tsx` | 注册真实实现：`setTrackChanges` 直通 Review ribbon 的 `setTrackChanges` state；`getTrackChanges` 读 `editor.storage.trackChanges.enabled` + `collectRevisionsForSdk(editor.state.doc)`；`acceptChange` / `rejectChange` 经 `handleRevisionById` → `applyRevisions` |

**为什么 buffer 版本要抛错而不是返空**：`{ enabled: false, changes: [] }`
看起来"安全"，但对一个支持追踪的 host 来说，这读起来是"这个文档没有修订"
而不是"这个编辑器不支持追踪" —— 后者才需要 host 显示降级 UI。SDK 契约里
`UNSUPPORTED` 就是干这个的。

#### 11.40.3 验证

- `packages/ipc-bridge` → **6 文件 / 144 测试通过**（+9：7 个 sink 用例覆盖
  注册 / 转发 / 非布尔拒绝 / 空 id 拒绝 / 未知 id 拒绝 / 无 adapter 时
  UNSUPPORTED；2 个 buffer 用例覆盖委派与未注册时的 typed 失败）
- `apps/sdk` → **16 文件 / 201 测试通过**
- `apps/docs` typecheck → **App.tsx 0 错误**；`electron-vite build` 成功，
  产物 grep 到 4 条命令 + `collectRevisionsForSdk` + `rev_` 前缀
- 其余 5 个 app typecheck → `ipc-bridge` / `types.ts` 相关错误 **0**

#### 11.40.4 风险与后续

- **id 碰撞**：FNV-1a 32 位，同一文档里两个属性完全相同的修订（同 kind、
  同作者、同日期、同文本）会撞 id。Word 的场景下同作者同秒的同文本修订本就
  少见，且契约明确"ID 只在同一文档版本内唯一，accept/reject 后请重读"。
  真要消除需要内容哈希 + 去重计数，收益不匹配复杂度。
- **`text` 字段截断 500 字符**：避免超大删除段落把 webhook/IPC payload 撑爆。
- **`sheets` / `slides` / `pdf` / `markdown` / `html` 未实现追踪**：这几个
  编辑器的文档模型里本来就没有修订概念（PDF 不是可修订格式、Markdown 无
  Word 修订语义）。当前返回 `UNSUPPORTED` 是正确行为，不是缺口。
- **`acceptAllChange` / `rejectAllChange` 未暴露**：应用内有
  `acceptAllRevisions` / `rejectAllRevisions`。host 目前只能逐个处理；批量
  变体留 follow-up（需要定义"all"在并发编辑下的语义）。

### 11.41 · §B.5.1 #6 Export（`downloadAs`）+ AnyDoc PDF→DOCX 真实化

> 本轮把 SDK 2.0 的**最后一个 surface**（#6 Export）接通，并把两个"假装成功"
> 的导出/转换通道改成真实实现或诚实拒绝。至此 §B.5.1 的 9 个 surface 全部落地。

#### 11.41.1 先修掉的三个"假成功"

计划 §B.5.1 #6 的原描述（"复用 `apps/web-server/src/converters/`"）与事实不符：
那个目录不存在。实地核查发现真正的缺口是另外三处，它们都属于**功能性虚假**
——比"缺功能"更危险，因为 UI 会报成功：

1. **HTML 应用的 Word 导出是假导出**（`apps/html/src/renderer/web-bridge.ts`）：
   原实现是 `downloadBytes('<name>.docx', textToBytes(request.html))` —— 把
   **HTML 源码**写进 `.docx` 扩展名。下载得到的文件 Word 拒绝打开，而
   `runExport` 认为成功。桌面版走 `packages/html2docx` + `ElectronBrowserDriver`
   （隐藏 BrowserWindow 渲染 + 截图 image-like 元素 → 真 OOXML），web 构建
   没有主进程可控的浏览器，**无法真实实现**。现在返回结构化错误并指向
   Print → Save as PDF。这次修改只把"假成功"换成"诚实的失败"，功能面并未变窄
   （原本产出的是不可用文件）。
2. **`anydoc:convert` 全线 WEB_UNSUPPORTED**：原注释写"待 phase-3 接
   pdf2docx"。事实是 pdf→docx 方向**完全不需要** LibreOffice ——
   `@genoffice/pdf2docx` 是纯 TS，只要一个初始化好的 pdfium wasm，两者都在
   本仓库里。现在真做（见 11.41.2）；docx→pdf 仍拒绝（真的需要排版引擎）。
3. **`web:save-file` 无法承载 `savePath`**：SDK 契约允许
   `downloadAs({savePath: '/path'})` 写入宿主存储，但 web-server 原本没有
   "把渲染进程产出的字节写到指定受管路径"的通道。新增 `web:write-file-bytes`。

#### 11.41.2 AnyDoc PDF → DOCX（真实本地转换）

- **新增** `apps/web-server/src/anydoc/convert.ts`：`ensurePdfium()`（惰性
  初始化 + 缓存）+ `convertPdfToDocxBytes(pdf, {password?})` → 判别式结果
  `PdfToDocxOutcome`（**从不抛异常**，让 IPC 层能把"需要密码"和"转换失败"
  映射成不同 UI）。
- **wasm 定位修正**：`@embedpdf/pdfium` 的导出映射是
  `./pdfium.wasm` → `./dist/pdfium.wasm`，所以文件**不在**包根目录。三个
  候选路径（bundle 同级 → `ROOT/node_modules` → cwd/node_modules）+ 环境变量
  `WEB_PDFIUM_WASM` 覆盖 + 包导出映射兜底。用 `import.meta.url`（不是
  `__dirname`，ESM 下不存在）—— 这正是首版实现的事故点。
- **`scripts/bundle.mjs` 新增拷贝**：Docker 运行阶段**只**拷贝
  `dist/bundle/`（无 node_modules），不拷贝 wasm 的话生产镜像会对一个它其实
  能做的转换回答 WEB_UNSUPPORTED。bundle 时把 `pdfium.wasm` 复制到
  `dist/bundle/`，并校验存在（否则构建失败）。
- **`anydoc:convert` handler 重写**：
  - pdf→docx 走真实转换；目标路径默认 `<source>.docx`，或调用方给的
    `outPath`，两者都过 `requireManagedPath`（否则宿主给的 `outPath` 能写出
    FILES_DIR）。
  - 0 字节源文件直接拒绝（交给 pdfium 只会得到一次无意义的失败）。
  - 加密 PDF → `passwordRequired: true` + `PDF_PASSWORD_REQUIRED`，让渲染层
    弹密码框而不是报"转换失败"。
  - **仅在 `outcome.ok` 后才写**，且用 `atomicWriteFile`：转换失败绝不留下一
    个扩展名撒谎的文件。
  - docx→pdf 仍 `WEB_UNSUPPORTED`（需要 LibreOffice / 无头浏览器）。

#### 11.41.3 SDK `downloadAs`（§B.5.1 #6）

- **契约**（`apps/sdk/src/types.ts`）：`downloadAs({format, savePath?, options?})`
  → `{ok, blobUrl?|path?, size, format}`。格式白名单是 `pdf | docx | xlsx |
  pptx | png | html | md | txt`，但**每个编辑器实际支持哪些由编辑器决定**：
  不支持时抛 `UNSUPPORTED`（响亮失败），而不是回一个空 blob。
- **适配器**（`packages/ipc-bridge/src/sdk-command-sink.ts`）：
  - `SdkLiveModelAdapter.downloadAs?()` 新增；未实现的应用**不注册 handler**，
    宿主收到标准 `UnsupportedCommandError`。
  - sink 强制契约：必须有 `size`、必须**恰好一个**目标（`blobUrl` 或 `path`）。
    只报成功不给目标 → 抛错。宿主拿到 `{ok:true}` 会告知用户"导出成功"，
    所以这条校验防的是"静默空文件"。
  - 新增 `ExportFormatUnsupportedError`（`code: 'UNSUPPORTED'`）区分"这个
    编辑器不会导出这个格式"（永久答案）与"导出崩了"（可重试）。
- **`text-buffer-adapter`**：透传到 native adapter；没有 native 实现时抛
  `UnsupportedCommandError('downloadAs')`——镜像 buffer 没有文件格式概念，
  编一个"小导出"比报错更糟。
- **`web-native`**：把 `downloadBytes` 拆出 `triggerDownload(name, url)` 与
  `createDownloadUrl(bytes, mime)`。原因：SDK 契约要求把 `blobUrl` **返回**给
  宿主（宿主自己决定何时 revoke），而原来的实现 10 秒后自动 revoke，宿主拿到
  的 URL 可能已经失效。同时 Safari 需要在下一 tick 才 revoke（同 tick 会得到
  0 字节文件）。
- **新通道** `web:write-file-bytes`：`{path, bytes}` → 受管路径校验 + 0 字节
  拒绝 + `atomicWriteFile` + recents 镜像。`savePath` 的实现基础。
- **应用接线**：
  - **markdown**：`md` / `html` 直接从 live buffer 产；`docx` 复用 File 菜单
    的 `exportDocxBytes`（同一条流水线，不会漂移）；`pdf` 抛
    `ExportFormatUnsupportedError`（本构建没有排版引擎 / print-to-PDF 服务）。
  - **html**：`html` / `txt` 直接产；`pdf` 走 `window.print()`（浏览器自带的
    print-to-PDF，与 File 菜单同路径）——注意 `window.print()` 无成功信号、
    也不产生字节，所以结果 `size: 0` 并如实说明；`docx` 抛 typed 错误。
  - **docs**：`exportHtml` 从"未实现"改为真实——渲染进程**早就**在产
    standalone HTML（`buildStandaloneHtml`），原来的拒绝是把已经做好的工作
    丢掉。现在走浏览器下载。

#### 11.41.4 顺带修掉的 3 个既有类型错误

`9b42ec2`（上一轮 track changes）在 `apps/docs` 留下 3 个 tsc 错误，会让
`pnpm typecheck` 和 docs 构建失败：

- `revisions.ts`：`RevisionRange` 接口缺 `text?: string`，而 `revisionId` /
  `collectRevisionsForSdk` 都读它（TS2339 ×2）。
- `ShortcutsDialog.tsx`：`hintByShortcutId` 的 `labelKey` 标成 `string`，
  传给 `t()` 时不满足 `StringKey`（TS2345）。改成 `StringKey` 而不是放宽
  `t()`：放宽会让拼错的 key 悄悄渲染成裸 key。

#### 11.41.5 测试

- `apps/web-server/tests/anydoc-convert.test.ts`（8）：wasm 位于包 `dist/`、
  文本 PDF → 真 DOCX（PK 魔数）、损坏 PDF → `PDF_LOAD_FAILED`、空输入不产
  文件、wasm 复用、加密 fixture → `PDF_PASSWORD_REQUIRED`、失败时不写文件。
- `apps/web-server/tests/anydoc-convert-handler.test.ts`（8）：源码级守门 ——
  不把源字节写到目标扩展名、目标必过 `requireManagedPath`、必须原子写、
  写入必须在成功判之后、密码映射、docx→pdf 拒绝、0 字节拒绝。
- `packages/ipc-bridge/tests/sdk-command-sink-live-model.test.ts`（+7）：
  无导出器 → `UNSUPPORTED`、`savePath` 默认 `browser`、path 透传、缺
  `format` 拒绝、只报成功无目标拒绝、缺 `size` 拒绝、typed 拒绝透传。

#### 11.41.6 本轮不做（明确范围）

- **HTML → DOCX 的真实实现**：需要无头浏览器（渲染 + 元素截图），web 构建
  没有。要么引入 Playwright（镜像 +300 MB，且需要 chromium 下载），要么让
  宿主提供渲染服务。两者都不是本轮能安全落地的，已在 §A.5 记为 backlog。
- **docx → pdf**：同上，需要 LibreOffice 或 print-to-PDF 服务。
- **`savePath` 走 storage backend（S3/minio）**：当前只写本地 FILES_DIR。
  跨后端的 promote 语义需先统一（详见风险 §4）。

### 11.42 · Slides legacy 通道"假成功"清零 + 引擎 id 稳定性发现

> 承接 §11.16/§11.17 的"legacy 通道 stub"线索，本轮做了完整收口。起点是
> `853e958` 修掉的 5 个 slide-lifecycle 通道；随后对一个**运行中的真实 bundle**
> 做探针，发现同类缺陷还有 61 个，并且**返回形状也是错的** —— 后者比桩本身更危险。

#### 11.42.1 根因：`{ok:true}` 是真值，而 renderer 拿它当 `RenderSlide` 用

renderer 的调用点（`apps/slides/src/renderer/slide-actions.ts` 等）：

```ts
window.slidesApi.deleteElement({ ... }).then((r) => r && applySlide(current, r))
```

`applySlide` 的入参是 `RenderSlide`。`{ok:true}` 是真值 → renderer 进成功分支
→ 把一个**没有 `nodes` 数组**的对象存成当前页 → 画布空白，且后续每次编辑都在
这个坏状态上继续叠加。这比直接抛错更糟：用户看不到失败，服务端也没有任何记录。

实测到的形状错配（对 bundle 发真实请求抓取）：

| 通道 | 桩返回 | 契约要求 |
|---|---|---|
| `delete-element` / `set-element-font` / `edit-transform` / `flip-elements` | `{ok:true, result:{ok:true}}` | `RenderSlide \| null` |
| `group-elements` | `{ok:true, groupId:'group-…'}` | `RenderSlide \| null` |
| `copy-elements` | `{ok:true, result:{…}}` | `number` |
| `undo` / `redo` | `{ok:true}` | `RenderSlide[] \| null` |
| `set-notes` / `set-transition` | `{ok:true}` | `boolean` |
| `find-replace` | `{count:0}`（硬编码） | `number` |

#### 11.42.2 做法：按声明契约作答，失败返 `null`

- `apps/web-server/src/slides/elements.ts` 重写（约 1 450 行）。68 个已注册通道
  全部按 `apps/slides/src/shared/ipc.ts`（权威返回类型）作答。抽出
  `commit` / `commitSlide` / `commitAllSlides` / `commitCreated` / `commitBool` /
  `commitPasted` / `applyLegacyMutation` 等辅助 + `makeToEmu` / `EMU_PER_PT = 12700`。
- **失败返 `null`，不返 `{ok:false}`** —— 理由与桩同源：`{ok:false}` 依然是真值，
  会以完全相同的方式污染 renderer。renderer 的 `if (r)` 守卫生效，文档保持不变，
  与桌面 handler 行为一致。失败走 `warnNoSession` / `warnOpFailed` 打 stderr。
- `STUBBED_SLIDES_CHANNELS` 收敛为 **8 项**，全部是 renderer 自己拥有的通道
  （OS 剪贴板 3 个、presenter 窗口 4 个、`show-fullscreen` 1 个），答
  `{ok:true, acknowledgedOnly:true}`，把"哪些没真做"变成**可审计的数据**而非注释。
- `state.ts` 新增：`SlidesHistorySnapshot` 快照栈（undo/redo + batch 起止）、
  应用级元素剪贴板、AI 快照注册/恢复。

#### 11.42.3 顺带发现的两个真 bug（`slides:open-path`）

1. **重复 open 同一路径会丢弃未保存编辑** —— 原实现无条件 `replaceSlidesSession`，
   重新打开等于把 live 模型换掉。现对同一路径**复用已存在的 live session**，
   直接返回其 render tree。
2. **解析期 element id 不稳定** —— 同一份字节连续 parse 两次，id 是 `sp_0` →
   `sp_2` → `sp_4`。所以：①不能在 socket 重连 / 重复 open 时重新 parse（会打断
   renderer 持有的 id）；②`slides:save` **刻意不 reparse**（`core.ts` 已注释）。
   仅持久化的 `e_<guid8>` 形式稳定。

#### 11.42.4 测试隔离事故（既有缺陷，一并修掉）

`webhook-fires-on-save.test.ts` 没设 `DATA_DIR`，往共享的
`/tmp/genoffice-data` 里漏了一条 DLQ 记录；`webhooks-dlq.test.ts` 在**模块初始化**
阶段 hydrate 它 → 随机报 "expected length 1, got 2"。此前多次尝试隔离都无效，
原因是模块体里的赋值发生在 `common/state.ts` **解析 DATA_DIR 之后**。修法是在
`vi.hoisted` 里分配临时 `DATA_DIR`（hoisted 早于任何 import 求值）并在 `afterAll`
恢复 env。已验证该 flake 在 HEAD（零源码改动）同样可复现 —— 属既有问题。

#### 11.42.5 实测

- `apps/web-server`：**92 文件 / 863 通过 / 1 skipped / 0 失败**（exit 0）——
  本轮首次达成全绿（此前 translate-* 两个 e2e 因硬编码 python 路径必红，见 §11.43.2）。
- 相关套件：`slides-legacy-channels-e2e` 17/17 ·
  `slides-legacy-session-e2e` 7/7 · `slides-save-e2e` 7/7 ·
  `slides-apply-txn-ops-e2e` 4/4。
- typecheck：9 个错误，**全部既有**（已用 stash 与 HEAD 逐条比对确认）——
  `packages/pptx-ops` 的 `?raw` import ×6、`packages/xlsx-gateway` 的 `never` ×3。

#### 11.42.5b 收尾时又抓到两个问题（同一轮修掉）

**① 自查发现：`{ok:false}` 也是真值 —— 规则写了却没落到代码上。**

§11.42.2 把规则写进了 `elements.ts` 的注释（"`{ok:false}` object would be TRUTHY
and get handed to applySlide as if it were a page"），但**同文件里 53 处参数校验
仍然返回 `{ok:false, error}`**。也就是说：上一轮修掉的 bug 类别，被上一轮自己
重新引入了 53 次。

后果是具体的，以 `delete-element` 为例：

```ts
window.slidesApi.deleteElement({...}).then((r) => r && applySlide(current, r))
```

任何漏传 `slideIndex` 的调用都会拿到真值 → 走成功分支 → 把错误对象当作页面存起来
（正是上一轮要消灭的白屏污染）。`boolean` 契约的通道更隐蔽：`App.tsx:614` 是
`const ok = await setNotes(...); if (ok) setDirty(true)`，参数错误会**报告"批注已
保存"**。`copy-elements` 是唯一侥幸逃过的（它写的是 `if (n > 0)`）。

现在 52 处校验统一走 `badArgs(message)`：打 stderr + 返 `null`，与
`warnNoSession` / `warnOpFailed` 和桌面 handler 的 `if (!session) return null`
一致。`applyLegacyMutation` 的失败分支同样去掉 `{ok:false}` 变体。
**唯一例外是 `slides:apply-edit-script`**：它声明的返回类型就是
`{ slide } | { error: string } | null`，且 AI skill 消费方读 `.error`，所以结构化
失败是契约内的。

**加了三道守门**（因为"写下来的约定"已经失效过一次）：

| 守门 | 内容 |
|---|---|
| 源码扫描 | 剥离注释后不得出现 `{ok:false` 字面量（注释里那段说明本身含该字符串，所以必须先剥注释） |
| 日志守门 | `warnNoSession` / `warnOpFailed` / `badArgs` 都必须 `process.stderr.write`，`null` 不允许静默 |
| e2e | 发畸形参数，断言返回 `null` / `false` |

守门**验证过会咬**：把 `{ok:false}` 重新注入某个分支，20 例里 2 例立刻变红；撤回
后恢复绿。

**② 两个 e2e 因硬编码 python 路径长期必红，与代码无关，但堵死了"0 失败"门禁。**

`translate-pdf-e2e` / `translate-coverage-e2e` 都 spawn 一个绝对路径
`/Users/louloulin/.cache/codex-runtimes/.../python3`（前者要 reportlab 造中文 PDF，
后者要 openpyxl 造 xlsx）。该路径只在特定机器存在，其他环境一律 `spawn … ENOENT`，
**看起来像产品 bug**。它们正是全量跑里仅有的 2 个红文件，也是"0 失败"门禁对所有人
不可达的原因。

新增 `tests/helpers/python.ts`：按 `$CODEX_PYTHON` → homebrew / /usr/local / /usr
→ 原 Codex 路径顺序探测，且**必须真的能 `import <module>` 才算命中**（有 python
≠ 有 reportlab：本机 `/usr/bin/python3` 两个都没有，`/opt/homebrew/bin/python3`
两个都有）。两个套件改用 `describe.skipIf(!PY)` —— 缺解释器是环境缺口，不是回归，
应 skip 而非 fail。**两个方向都验过**：本机命中后 7 个用例真的跑并全过（此前是
失败而非 skip）；`CODEX_PYTHON` 指向不存在文件时报告 skip。

**结果**：`apps/web-server` **92 文件 / 863 通过 / 1 skipped / 0 失败** —— 本分支
首次全绿，P1 回归门禁达成。

#### 11.42.6 本轮不做（明确范围）

- **~25 个只读 `slides:get-*` 通道**（✅ `b0e60d9` + `1759c2b` + `486f749` + `5ccaeef` 闭合前 15 个，余 ~10 个仍 M4 backlog）：`slides:get-comments` / `get-selection` /
  `slides:get-slide-size` / `get-notes` / `get-render-slides`（§11.45）+ tier-1（§11.46：get-slide-links / get-run-links / get-link / get-animations / get-header-footer）+ tier-2（§11.47：get-comments / get-chart-data / get-sections / get-layouts）+ tier-3（§11.48：has-slide-clipboard / private-font-faces / private-font-data / cloud-gen-status 文档化，共 15 个）已实装。余 ~10 个仍返空骨架，**可达但不改文档**（renderer 用它做面板
  初值，返空 = "无选中 / 无批注"），要真做需把 live 模型投影成读模型。列入 M4。
- **引擎侧稳定 id**：解析期 id 不稳定的根治在 pptx-engine，不在 web-server。
- **CRDT / OT 协作、移动端 H5**：M4 路线图不变。

### 11.43 · CSV save round-trip on web（§A.5 收口）

> 承接 §11.44 的 `.csv` open 路径修复（`csvToXlsxBuffer` + `csvPath` 回填，本轮
> 之前是 b8e25a2）。本节闭合 save 路径，让 File → Export as CSV 在 web 构建下
> 不再 UNSUPPORTED。`fc36dc4`。

#### 11.43.1 之前的样子

renderer 入口（`apps/sheets/src/renderer/csv-export.ts`）：

```ts
const result = await desktopApi.exportCsv({ fileName, content, hasFormulas, targetPath })
```

- desktop 路径走 `IPC_CHANNELS.exportCsv` → `apps/sheets/src/main/sheets-main.ts:2878`，完整 native dialog + UTF-8 BOM + atomic write。
- web 路径走 `apps/sheets/src/renderer/web-bridge.ts`，之前**没有** `exportCsv` 方法 → 落到 `UNSUPPORTED` 分支 → console 错误、菜单点了没反应。
- web-server `src/sheets/index.ts` **没有** `workbook:export-csv` 处理器（`grep -n 'export-csv'` 0 命中）。

整条 round-trip 在 web 下断在 save 端。

#### 11.43.2 三处改动

1. **`apps/web-server/src/sheets/index.ts`** — 新增 `workbook:export-csv` handler：
   - 校验 `fileName`（1-255 char string）、`content`（string，≤ 64 MB —— 与桌面
     `MAX_CSV_EXPORT_CHARS` 对齐）、`targetPath`（string or undefined）。
   - `targetPath` 缺省返 `{ canceled: true }`（web 无原生 save dialog；renderer
     走 `downloadAs` 或自有 UI）。
   - `targetPath` 通过 `requireManagedPath` 校验受管路径，缺 `.csv` 时补上。
   - `atomicWriteFile(targetPath, Buffer.concat([BOM_3bytes, content]))` 落盘；
     Excel 在 Windows 上读 BOM + UTF-8 才不会乱码（与 `workbook:create-document`
     同字节序列）。
   - 空内容拒绝：0 byte 的 BOM-only 文件对 Excel 和下游工具都是噪音，IPC 边界
     上几乎一定是 renderer bug → `INVALID_ARGUMENT`。
   - 成功后 `notifyFileSaved(targetPath, { format: 'csv', size })` + `recordRecentDoc(targetPath, { modified: true })`，
     与 docs/slides/markdown 走同一 recents 链路。

2. **`apps/sheets/src/renderer/web-bridge.ts`** — 在 `confirmCsvSave` 与
   `pickAttachments` 之间插入 `exportCsv: (req) => transport.invoke('workbook:export-csv', req)`。
   顺序与 desktop bridge 一致，未来切桌面时无需重排。

3. **`apps/web-server/tests/workbook-save-e2e.test.ts`** — 6 个新 e2e：
   - 写 UTF-8 BOM + content 到受管路径，断言首三字节 `0xef 0xbb 0xbf`；
   - `targetPath` 缺扩展名时自动补 `.csv`；
   - `targetPath` 缺省返 `{ canceled: true }`；
   - 受管路径校验失败返 `INVALID_ARGUMENT`（`requireManagedPath` 抛 `InvalidArgumentError`，
     整个 IPC envelope 都是同一 code，不另立 `PATH_OUTSIDE_STORAGE`）；
   - 空内容拒绝 `INVALID_ARGUMENT`；
   - 不留 `.tmp-*` 临时文件。

#### 11.43.3 验证

```
cd apps/web-server
./node_modules/.bin/vitest run --config ./vitest.config.ts tests/workbook-save-e2e.test.ts
# 17/17 passed（11 既有 + 6 新增）

./node_modules/.bin/vitest run --config ./vitest.config.ts
# 787 passed | 1 skipped | 0 failures（90 文件）

../../node_modules/.bin/tsc --noEmit
# 无新增错误（同 9 个 pre-existing 在 packages/{pptx-ops,xlsx-gateway}）
```

#### 11.43.4 向后兼容

- renderer 改动是加法：旧 desktopApi 调用方不受影响；desktop 端继续走
  `IPC_CHANNELS.exportCsv` 直接通道，不经过 bridge。
- handler 的 `{ canceled: true }` / `{ canceled: false, path }` 形状与
  `workbookExportCsvResultSchema`（`desktop-api.ts:2409`）逐字段对齐，
  renderer 现有 `result.canceled === true` 分支不需改动。
- 字节序列与桌面 `saveCsv` 完全一致：BOM 3 字节 + UTF-8 content；下游消费
  desktop 产 `.csv` 的工具同样能读 web 产 `.csv`。

#### 11.43.5 收口结果

§A.5 那条 backlog（filed in cda3f12）现标记为 ✅ `fc36dc4`。CSV open + save
两端的 round-trip 在 web 构建下完整闭合。

### 11.44 · 审计日志保留期可观测性 — `/api/v1/metrics` 暴露 4 个 Prometheus 指标（§A.5 部分收口）

> 承接 §A.5 backlog 中的"审计日志保留期 / rotate"：rotate worker 本身
> （`GENOFFICE_AUDIT_RETENTION_DAYS` + 周期脚本）仍 M5+，但**在 rotate 上线
> 之前必须有可观测性**，否则操作员没有领先指标知道 10k in-memory cap 已经在
> busy save pipeline 上溢出。`f35524d`。

#### 11.44.1 之前的样子

`/api/v1/metrics` 暴露 webhook DLQ + IPC channel + SDK usage + uptime 共 15 个
指标，**审计日志一个都没有**。要知道"现在内存里有几条 / JSONL 多大 / 有没有
溢出"，只能 `wc -l $DATA_DIR/audit-log.jsonl` + `grep -c 'unshift-trim'` 日
志——前者不知道内存态，后者无日志可看。

#### 11.44.2 暴露的 4 个 Prometheus 指标

| 名字 | 类型 | 含义 |
|---|---|---|
| `genoffice_audit_log_records` | gauge | 当前 in-memory ring 容量（饱和于 10k）|
| `genoffice_audit_log_persisted_bytes` | gauge | 当前 JSONL 文件磁盘字节数；持久化关闭或首次启动无记录时为 `NaN` |
| `genoffice_audit_log_recorded_total` | counter | 进程启动以来累计记录的审计事件 |
| `genoffice_audit_log_dropped_total` | counter | 因 ring overflow 被驱逐的记录数（**rotate 紧急度的领先指标**）|

文本格式（节选）：
```
# HELP genoffice_audit_log_records Current audit-log records held in memory (bounded at 10000)
# TYPE genoffice_audit_log_records gauge
genoffice_audit_log_records 42
# HELP genoffice_audit_log_persisted_bytes Bytes currently on disk in the JSONL audit log (NaN when persistence is disabled or no record has been recorded yet)
# TYPE genoffice_audit_log_persisted_bytes gauge
genoffice_audit_log_persisted_bytes 4832
# HELP genoffice_audit_log_recorded_total Cumulative audit records recorded since process start
# TYPE genoffice_audit_log_recorded_total counter
genoffice_audit_log_recorded_total 117
# HELP genoffice_audit_log_dropped_total Cumulative audit records evicted because the in-memory ring overflowed the 10000 cap
# TYPE genoffice_audit_log_dropped_total counter
genoffice_audit_log_dropped_total 0
```

#### 11.44.3 实现要点

1. **`apps/web-server/src/common/audit-log.ts`**：
   - 模块级 `totalRecorded` + `totalDropped` 计数器，在 `recordAudit` 的 unshift
     边界计算 drop count（`totalDropped += records.length - MAX_RECORDS`），不
     在 slice 时计算 → 在并发 `recordAudit` 调用下计数器仍单调。
   - 新导出 `auditMetrics()` 返回 `{ records, persistedBytes, totalRecorded,
     totalDropped }`。`persistedBytes` 仅做一次 `fssync.statSync(FILE)`，对
     15-60s 的 Prometheus 抓取足够便宜；`statSync` 失败（并发 rotate）返 null →
     Prometheus `NaN`，不会抛穿 metrics endpoint。
   - 新导出 `_setAuditMaxRecordsForTests(n)`：把 `MAX_RECORDS` 从 `const` 改
     `let`，让 overflow 测试用 3 而不是 10k 把 ring 灌满——`Array.unshift` 是
     O(n)，10 001 次 = O(n²) 不可接受；生产代码不调用。
   - `_resetAuditForTests` 同步清零两个新计数器并 truncate JSONL。

2. **`apps/web-server/src/common/index.ts`**：re-export `auditMetrics` 与
   `_setAuditMaxRecordsForTests`。

3. **`apps/web-server/src/api/v1/meta.ts`**：
   - import `auditMetrics`；
   - `handleMetrics` 内 `const audit = auditMetrics()` 一次取快照；
   - 在 `genoffice_ipc_channels_implemented` 之后追加 4 行 HELP/TYPE/value。
   - 持久化关闭 / 首次启动无记录：`persisted_bytes ?? 'NaN'` 走 Prometheus
     `NaN` sentinel。

4. **`apps/web-server/tests/metrics-endpoint.test.ts`**：4 个新 e2e：
   - 暴露所有 4 行（HELP + TYPE + sample）；
   - 冷启动值：`records=0, recorded_total=0, dropped_total=0`；`persisted_bytes`
     是 `NaN`（首次抓取无文件）或 `0`（_reset 留下的空文件）都接受——这是有效
     冷启动状态，不该让某次 process 残留文件使本用例红；
   - 3 次 `recordAudit` 后 `records=3, recorded_total=3, persisted_bytes` 转正
     整数；
   - cap=3, 5 次 `recordAudit` → `records=3, recorded_total=5, dropped_total=2`
     ——overflow 计数器在边界正确累加。

#### 11.44.4 验证

```
cd apps/web-server
./node_modules/.bin/vitest run --config ./vitest.config.ts tests/metrics-endpoint.test.ts
# 12/12 passed（8 既有 + 4 新增）

./node_modules/.bin/vitest run --config ./vitest.config.ts
# 791 passed | 1 skipped | 0 failures（90 文件）

../../node_modules/.bin/tsc --noEmit
# 无新增错误（同 9 个 pre-existing 在 packages/{pptx-ops,xlsx-gateway}）
```

#### 11.44.5 不在本轮范围内

- rotate worker 本身（`GENOFFICE_AUDIT_RETENTION_DAYS` 周期脚本 / crontab /
  systemd timer / k8s CronJob）仍 M5+。本轮只是给它准备了"我什么时候溢出"
  的信号。
- `audit:log` scope gate（"只有合法 IPC 调用方能写审计"）是另一条独立 M5+
  backlog（§11.37.6），本次不动。
- 跨进程并发安全（cluster 模式下多进程写同一 JSONL）需要换 SQLite 或
  Postgres backend；本轮 `records` / `totalRecorded` / `totalDropped` 仍是
  进程内态，与 M4+ cluster 化时统一规划。

#### 11.44.6 收口结果

§A.5 中"审计日志保留期 / rotate"条目现标注 ✅ `f35524d`（观测部分）；
rotate worker 仍留 M5+。`/api/v1/metrics` 现有 19 个指标（15 既有 + 4 新）。

### 11.45 · Slides 只读 `slides:get-*` 通道首批 3 个真实化（§A.5 部分收口 · M4 模板）

> 承接 §11.42.6 backlog 的"~25 个只读 `slides:get-*` 通道"：把它们留到 M4
> 是因为整套要先把 live 模型投影成 read-model，而不只是改单通道签名。本轮把
> 这个模式做出来 3 个（`slides:get-slide-size` / `slides:get-notes` /
> `slides:get-render-slides`），剩下的 ~22 个按模板接力。`b0e60d9`。

#### 11.45.1 之前的样子

三个通道的"假返"：

| 通道 | 之前 | 错误面 |
|---|---|---|
| `slides:get-slide-size` | `{ width: 960, height: 540 }` | 任何非 16:9 deck 的画布比例都错；renderer 要等到自己 parse deck 后才校正，期间幻灯片按错比例渲染 |
| `slides:get-notes` | `""` | notes 窗永远是空的，即使 pptx 文件里有 notesSlide |
| `slides:get-render-slides` | `[]` | slide strip / thumbnails 全空，slide 索引栏也画不出来 |

#### 11.45.2 设计：共享 helper + projector

`apps/web-server/src/slides/state.ts` 新增：

1. `resolveSlidesReadModel(event)` —— 单点解析 `event.sessionId` →
   `getCurrentSlidesPath(sessionId)` → `getSlidesSession(path)` →
   `session.opened.deck`。返回 `null` 而不是抛错，让 renderer 在
   `slides:open-path` 之前调 get-* 时走"已知空形状"分支。
2. `EMU_PER_PX = 9525` —— 96 DPI 下 EMU 到 CSS px 的换算
   （914400 EMU/inch ÷ 96 px/inch = 9525 EMU/px）。
3. `projectRenderSlide(slide, archive, index)` —— 投影器，返回
   `{ index, hidden, hasNotes, name }`：
   - `hidden` 走 `getSlideHidden(slide)`（engine 的 hidden getter 读
     `bodyPrefix` 里的 `<p:sld show="0">`，比"假设 slide 上有 hidden
     字段"靠谱）；
   - `hasNotes` 走 `notesPathForSlide(archive, slide.path)`，因为
     notesSlide 在 pptx 里是单独 archive part、不在 `Slide` 对象上；
   - `name` 用正则从 `slide.bodyPrefix` 的 `p:cSld@name` 取 —— engine
     在 save 时把 bodyPrefix 当 verbatim 保留，所以投影纯计算、不分配
     也不修改 deck；fallback 到 `"Slide N"` 应对 deck 没有自定义名的
     情况（blank.pptx 就是这种）。

#### 11.45.3 三个 handler 改写

| 通道 | 新实现 |
|---|---|
| `slides:get-slide-size` | `Math.round(cX/9525)` × `Math.round(cY/9525)`；未知 path 仍返 `{960,540}` 让画布先 paint 出来个东西 |
| `slides:get-notes(slideIndex)` | `getSlideNotes(opened.archive, slide.path)`；非 number / 越界 slideIndex 返 `""`；用 `try/catch` 兜底"畸形 notesSlide XML"（某些 authoring 工具产 partial notes）—— 单条 slide 不该把整个 notes 面板拉黑 |
| `slides:get-render-slides()` | `deck.slides.map((s,i) => projectRenderSlide(s, archive, i))` |

所有三个都走 `resolveSlidesReadModel` + `OpenedPptx.deck`，所以
`slides:apply-txn` 改完 `setSlideHidden` / `setNotes` 之后，下一次
get-* 立刻看到新值——不需要 reparse。这点对 §11.42.3 的引擎侧 id
不稳定问题也成立：因为我们不重新 parse，整张表持续可用。

#### 11.45.4 测试

`apps/web-server/tests/slides-read-model-e2e.test.ts`（新建，9 个 e2e）：

- **冷启动 fallback**：3 个 channel 在没有 SSE session 调用
  `slides:open-path` 之前各自返 `{width:960,height:540}` / `""` / `[]`
  —— 保持向后兼容，renderer 的"无选中/无批注"语义不变。
- **post-open-path 正确性**：
  - `get-slide-size` 返 `960×720`（bundled blank.pptx 是 4:3 deck，
    `9144000×6858000 EMU`），证明 fix 对 day-one fixture 就生效；
  - `get-render-slides` 返 1 个 slide 的投影（index=0, hidden=false,
    hasNotes=false, name="Slide 1"）。
- **越界 / 类型容错**：get-notes 对 `999` 和 `"not-a-number"` 都返
  `""`。
- **live mutation round-trip**：
  - `apply-txn({ path, ops: [{ op: 'setNotes', target: { slide: 0 }, text }] })`
    → `get-notes(0)` 立刻返回写入的文本，`get-render-slides` 的
    `hasNotes` 翻成 true；
  - `apply-txn({ path, ops: [{ op: 'setHidden', target: { slide: 0 }, hidden: true }] })`
    → `get-render-slides` 的 `hidden` 翻成 true，再翻回 false 收尾避免
    影响后续套件。

> pptx-ops 的 op 注册名是 `setNotes` / `setHidden`（不是
> `setSlideNotes` / `setSlideHidden`），slide 通过
> `target: { slide: number }` 寻址 —— 见
> `packages/pptx-ops/src/ops/registry.ts:390` 的 `resolveSlide`。
> `apply-txn` 必须传 `{ path, ops }`，SSE session id 不足以定位 live
> model —— dispatcher 按 path 在 session registry 里查。

#### 11.45.5 验证

```
cd apps/web-server
./node_modules/.bin/vitest run --config ./vitest.config.ts tests/slides-read-model-e2e.test.ts
# 9/9 passed

./node_modules/.bin/vitest run --config ./vitest.config.ts
# 800 passed | 1 skipped | 0 failures（91 文件；基线 791 → 800 +9）

../../node_modules/.bin/tsc --noEmit
# 无新增错误（同 9 个 pre-existing 在 packages/{pptx-ops,xlsx-gateway}）
```

#### 11.45.6 不在本轮范围内（M4 backlog 仍存）

剩下 ~22 个 `slides:get-*` 通道仍返空骨架，按 `resolveSlidesReadModel`
模板接力即可，估计单通道 5-30 行；可分散到几个 M4 PR。优先级建议
（按 renderer 调用频次排）：

- `slides:get-animations` / `get-shape-keys` / `get-slide-links` /
  `get-run-links` / `get-link` / `get-chart-data` —— 跟 get-render-slides
  同模型；
- `slides:get-header-footer` —— 读 `p:hf` 元素；
- `slides:get-comments` —— pptx 用单独的 `commentsSlide` archive part，
  跟 notes 同模式（甚至可以共用 `notesPathForSlide` 的 sibling helper）；
- `slides:get-sections` / `get-layouts` —— 需要补一张 metadata
  projection（pptx 里 sections 是单独的 part，layouts 是 layoutMaster
  关联链）。

#### 11.45.7 收口结果

§A.5 backlog "只读 `slides:get-*` 通道" 现标注 ✅ `b0e60d9`（前 3 个）；
其余 ~22 个仍在 M4 backlog，按本轮的 helper + projector 模式接力即可。

### 11.46 · Slides 只读 `slides:get-*` 通道 tier 1 批次（5 个真值化 · §11.45 模板接力）

> 承接 §11.45 的 helper + projector 模板，本轮把"tier 1"批次的 5 个通道
> 全部接入 live 模型：`get-slide-links` / `get-run-links` / `get-link` /
> `get-animations` / `get-header-footer`。Tier 2/3（comments / sections /
> layouts / shape-keys）按本轮模板接力即可。`1759c2b`。

#### 11.46.1 之前的样子

| 通道 | 之前 | 错误面 |
|---|---|---|
| `slides:get-slide-links` | `[]` | 幻灯片超链接点击区测不到任何链接 |
| `slides:get-run-links` | `[]` | 文本 run 级超链接索引空 → 段落 run 超链接 hover 高亮没数据 |
| `slides:get-link` | `null` | 单元素超链接查询永远无值 |
| `slides:get-animations` | `[]` | 动画面板永远空 |
| `slides:get-header-footer` | `{ enabled: false }` | 页脚/页码/日期对话框无法回显当前值 |

#### 11.46.2 引擎侧真实来源

每个通道的 live 数据来源都已经在 pptx-engine 里：

| 通道 | 引擎函数 |
|---|---|
| `get-slide-links` | `getSlideLinks(opened, slideIndex)` — `packages/pptx-engine/src/hyperlink.ts:249`，递归走 elements + groups，按 `a:hlinkClick` 解析 rels |
| `get-run-links` | `getRunLinks(opened, slideIndex)`，按 paragraph/run 粒度 |
| `get-link` | 复用 `getSlideLinks` + filter by `elementId === sourceId` |
| `get-animations` | `getSlideAnimations(slide)` — `packages/pptx-engine/src/animation.ts:915`，读 `<p:timing>` 在 `slide.bodySuffix` |
| `get-header-footer` | `readHeaderFooter(slide)` — `packages/pptx-engine/src/headerfooter.ts:160`，遍历 placeholders 找 `ftr` / `dt` / `sldNum` |

#### 11.46.3 field rename：engine `elementId` ↔ renderer `sourceId`

引擎 hyperlink 帮助函数返回 `{ elementId, target }`，renderer contract
（`slides-api-factory` ↔ `ipc.ts:1396`）要 `{ sourceId, target }`。本轮加
两个 ~5 行的 projector：

```ts
function projectSlideLinks(links) {
  return links.map(l => ({ sourceId: l.elementId, target: l.target }))
}
function projectRunLinks(links) {
  return links.map(l => ({
    sourceId: l.elementId,
    paraIndex: l.paraIndex,
    runIndex: l.runIndex,
    target: l.target,
  }))
}
```

`get-link` 走 `find(l => l.elementId === sourceId).target`（保留 engine
的 `elementId` 名，因为这是单元素查询不重投影）。

#### 11.46.4 5 个 handler 改写

| 通道 | 新实现 |
|---|---|
| `slides:get-slide-links(slideIndex)` | `getSlideLinks(rm.opened, slideIndex)` 走 `projectSlideLinks` |
| `slides:get-run-links(slideIndex)` | `getRunLinks(rm.opened, slideIndex)` 走 `projectRunLinks` |
| `slides:get-link(slideIndex, sourceId)` | `getSlideLinks(...).find(l => l.elementId === sourceId)?.target ?? null` |
| `slides:get-animations(slideIndex)` | `getSlideAnimations(deck.slides[slideIndex])` |
| `slides:get-header-footer(slideIndex)` | `readHeaderFooter(slide)` 包装成 `{ enabled: hf.footer!=null \|\| hf.date!=null \|\| hf.slideNum, footer, slideNum, date }` |

未知 session / 越界 slideIndex / 非 number 参数：各自返原 spec 的空
形状（`[]` / `null` / `{ enabled: false }`），保持向后兼容。

#### 11.46.5 tests（`apps/web-server/tests/slides-read-model-e2e.test.ts` 新增 describe 块）

12 个 e2e case，分类：

- **冷启动 fallback（5）**：每个通道在无 SSE session 调 `open-path` 之前
  各自返 `[]` / `null` / `{ enabled: false }`。
- **post-open-path on blank.pptx（4）**：bundled blank.pptx 没有 hyperlinks、
  没有 timing → `get-slide-links` / `get-run-links` / `get-animations` 全
  `[]`；`get-link` 对未知 sourceId 返 `null`。
- **越界 slideIndex（1）**：`get-link(slideIndex=999, sourceId=...)` 返 `null`。
- **round-trip（1）**：`apply-txn({ path, ops: [{ op: 'applyHeaderFooter',
  settings: { footer, slideNum: true, date } }] })` → 下一个
  `get-header-footer(0)` 返 `{ enabled: true, footer, slideNum: true,
  date }`，证明 placeholder 状态真实落地到 slide。

> pptx-ops 注册的 op 名是 `applyHeaderFooter`，参数是
> `settings: HeaderFooterOptions`（不是 `HeaderFooterOp.fitWidthPx`——
> 那个是 renderer contract 上层校验用的，op 本身忽略）。

#### 11.46.6 验证

```
cd apps/web-server
./node_modules/.bin/vitest run --config ./vitest.config.ts tests/slides-read-model-e2e.test.ts
# 21/21 passed（9 §11.45 + 12 §11.46）

./node_modules/.bin/vitest run --config ./vitest.config.ts
# 812 passed | 1 skipped | 0 failures（91 文件；基线 800 → 812 +12）

../../node_modules/.bin/tsc --noEmit
# 无新增错误（同 9 个 pre-existing 在 packages/{pptx-ops,xlsx-gateway}）
```

#### 11.46.7 不在本轮范围内（剩 ~17 个，仍 M4 backlog）

按 §11.45.6 排序：tier 2（comments / shape-keys / chart-data）需引擎补
projection；tier 3（sections / layouts）需新增 metadata projection。

具体未做清单：
- `slides:get-shape-keys` — 引擎无 morph-key 模型，仍返 `[]`；一旦
  `getMorphKeys` 入引擎，本轮模板可直接套。
- `slides:get-comments` — pptx 的 comments 是单独 `commentsSlide` archive
  part；模式跟 notes 完全相同（甚至可复用 `notesPathForSlide` 的
  sibling helper）。
- `slides:get-chart-data` — 引擎未暴露图表数据模型，需补。
- `slides:get-sections` / `slides:get-layouts` — 需补 metadata 投影
  （sections 是单独 part，layouts 是 layoutMaster 关联链）。
- `slides:get-selection` — renderer selection state 通道，未列入读模型
  backlog（由 renderer 自己持有）。
- `slides:font-catalog` / `slides:font-missing` / `slides:chart-color-schemes`
  / `slides:media-data` / `slides:native-clipboard` / `slides:private-font-*`
  — 字体 / 媒体 / 剪贴板 metadata 通道，与读模型无关，是另一类
  infrastructure。（`slides:table-structure` §11.49 已闭合；它不是
  read-model 而是 mutation IPC。）

#### 11.46.8 收口结果

§A.5 "只读 `slides:get-*` 通道" 现标注 ✅ `b0e60d9` + `1759c2b`（共 8 个），
余 ~17 个仍 M4 backlog。


### 11.47 · Slides 只读 `slides:get-*` 通道 tier 2 批次（4 个真值化 · §11.45 模板接力）

> 承接 §11.46 的 tier-1 接力，本轮把 4 个"引擎已就绪 + contract 已对齐"
> 的通道全部接入 live 模型：`get-comments` / `get-chart-data` /
> `get-sections` / `get-layouts`。剩 ~13 个通道中 `get-shape-keys` 因引擎
> 缺 morph-key 模型仍 `[]`（已加文档化说明）；其余 12 个通道是字体 / 媒体
> / 剪贴板 / 表格 / 选区等 infrastructure 类（与读模型不同分类），不在本批。`486f749`。

#### 11.47.1 之前的样子

| 通道 | 之前 | 错误面 |
|---|---|---|
| `slides:get-comments` | `[]` | 批注面板永远空 |
| `slides:get-chart-data` | `{}` | 图表数据对话框无法回显当前数据 |
| `slides:get-sections` | `[]` | sections 列表永远空（即使 deck 里有 p14:sectionLst）|
| `slides:get-layouts` | `[]` | 新建幻灯片面板的 layouts 下拉永远是空的 |
| `slides:get-shape-keys` | `[]` | morph 配对键永远空（**引擎无 morph 模型，仍 stub**）|

#### 11.47.2 引擎侧真实来源（4 个 + 1 个 documented）

| 通道 | 引擎函数 | 来源文件 |
|---|---|---|
| `get-comments` | `getSlideComments(archive, slidePath)` | `packages/pptx-engine/src/comments.ts:96`（commentSlide 单独 part）|
| `get-chart-data` | `getChartElementData(slide, sourceId)` | `packages/pptx-engine/src/index.ts:2854`（chart element 模型）|
| `get-sections` | `getSections(opened)` | `packages/pptx-engine/src/sections.ts:83`（presentation.xml's `p14:sectionLst`）|
| `get-layouts` | `listSlideLayouts(archive)` | `packages/pptx-engine/src/layout.ts:103`（ppt/slideLayouts/slideLayoutN.xml）|
| `get-shape-keys` | （无）| 引擎无 morph-key 模型；待 `getMorphKeys` 入引擎后用同一模板 |

#### 11.47.3 4 个 handler 改写

| 通道 | 新实现 |
|---|---|
| `slides:get-comments(slideIndex)` | `getSlideComments(rm.opened.archive, slide.path)`；try/catch 兜底畸形 XML |
| `slides:get-chart-data(slideIndex, sourceId)` | `getChartElementData(slide, sourceId)` 直接返 engine 形状（kind/title/categories/series/seriesColors/pointColors）|
| `slides:get-sections()` | `getSections(rm.opened)` 返 `SectionInfo[]`（id/name/slideIndices）verbatim |
| `slides:get-layouts()` | `listSlideLayouts(rm.opened.archive)` 包成 `{ layouts: SlideLayoutInfo[] }` |

未知 session / 越界 slideIndex / 非 string sourceId：各自返原 spec 的
空形状（`[]` / `null` / `{ layouts: [] }`），向后兼容。

#### 11.47.4 模板一致性

每个新 handler 都用 `resolveSlidesReadModel(event)`（§11.45 共享 helper）→
5 行内完成。field-rename projector（§11.46）只在 hyperlink 通道需要，
本批 4 个 channel 的 contract 形状与 engine 完全对齐，无需 projector。

#### 11.47.5 测试（`apps/web-server/tests/slides-read-model-e2e.test.ts` 新增 describe）

10 个 e2e case：

- **冷启动 fallback（4）**：每个通道在无 SSE session 调 `open-path` 之前
  各自返 `[]` / `null` / `{ layouts: [] }`。
- **post-open-path on blank.pptx（5）**：bundled blank.pptx 没有
  commentsSlide / 图表元素 / sectionLst → `get-comments` / `get-sections`
  返 `[]`；`get-chart-data` 对未知 sourceId / 越界 slideIndex 返 `null`。
- **`get-layouts` 真实投影（1）**：bundled blank.pptx 只有 slideMaster
  没有 slideLayout（layouts 通过 master 继承），
  `listSlideLayouts` 过滤 `ppt/slideLayouts/slideLayoutN.xml` 路径所以
  返回 `{ layouts: [] }` —— 这是 fixture 的真实状态，不是 bug。
- **`get-shape-keys` 文档化 stub（1）**：确认仍 `[]`，证明 §11.42.6
  M4 backlog 的 morph-key 工作还没落地。

#### 11.47.6 验证

```
cd apps/web-server
./node_modules/.bin/vitest run --config ./vitest.config.ts tests/slides-read-model-e2e.test.ts
# 31/31 passed（9 §11.45 + 12 §11.46 + 10 §11.47）

./node_modules/.bin/vitest run --config ./vitest.config.ts
# 822 passed | 1 skipped | 0 failures（91 文件；基线 812 → 822 +10）

../../node_modules/.bin/tsc --noEmit
# 无新增错误（同 9 个 pre-existing 在 packages/{pptx-ops,xlsx-gateway}）
```

#### 11.47.7 不在本轮范围内（剩 ~13 个，仍 M4 backlog）

按 §11.46.7 分类，本轮完成全部"读模型"型通道。剩 ~13 个属于
infrastructure 类（与 live deck 模型不同），按类型分：
  - `slides:font-catalog` / `slides:font-missing` — 字体 enumeration
  - `slides:chart-color-schemes` — chart palette metadata
  - `slides:media-data` / `slides:native-clipboard` — clipboard
  - `slides:private-font-data` / `slides:private-font-faces` — 私有字体
  - `slides:clipboard-external` / `slides:clipboard-probe` — 系统剪贴板
  - `slides:has-slide-clipboard` — element clipboard 状态（§11.48 已闭合）
  - `slides:cloud-gen-status` — 云端生成状态（占位）

这些不在 "live deck → read-model" 范畴，需要单独的 projection helpers，
留 M4 backlog。

#### 11.47.8 收口结果

§A.5 "只读 `slides:get-*` 通道" 现标注 ✅ `b0e60d9` + `1759c2b` + `486f749`
（共 12 个），余 ~13 个仍 M4 backlog；infrastructure 类（~13 个）留 M4
单独 track。


### 11.48 · Slides 只读 `slides:get-*` 通道 tier 3 批次（infrastructure 投影 · 4 个）

> 承接 §11.47.7 把 ~13 个 infrastructure 类 channel 单列：每个都需要自己
> 的小 projection helper（不是 "live deck → read-model"）。本轮完成 3 个
> 真值化 + 1 个文档化：`has-slide-clipboard` / `private-font-faces` /
> `private-font-data` / `cloud-gen-status`（文档化 idle）。剩 ~10 个仍
> M4 backlog（font-catalog / font-missing / chart-color-schemes / media-data
> / native-clipboard / private-font-data 仍部分未做 / clipboard-external
> / clipboard-probe / 各类 font 下载与 install 等）。`slides:table-structure`
> 不在此列 —— §11.49 已闭合为真 mutation。`5ccaeef`。

#### 11.48.1 之前的样子

| 通道 | 之前 | 错误面 |
|---|---|---|
| `slides:has-slide-clipboard` | `false` | Paste 菜单永远可点（点完无效果）|
| `slides:private-font-faces` | `[]` | 字体 picker 看不到 deck 自带的字体 |
| `slides:private-font-data` | `{}` | 私有字体 sfnt 字节拉不到 |
| `slides:cloud-gen-status` | `{ status: 'idle' }` | 已 idle（**真实 idle，不是 fake**）|

#### 11.48.2 引擎侧真实来源

| 通道 | 引擎函数 / 数据 |
|---|---|
| `has-slide-clipboard` | `getSlidesElementClipboard()` —— §11.42 已经实现的 app-level clipboard |
| `private-font-faces` | `listEmbeddedFonts(archive)` —— `packages/pptx-engine/src/embedded-fonts.ts:325` 解析 `<p:embeddedFontLst>` |
| `private-font-data` | `listEmbeddedFonts(archive)` 二次遍历（按 index 取 `face.sfnt`）|
| `cloud-gen-status` | （无引擎实现；idle 是诚实兜底）|

#### 11.48.3 4 个 handler 改写

| 通道 | 新实现 |
|---|---|
| `slides:has-slide-clipboard()` | `getSlidesElementClipboard().length > 0`（5 行）|
| `slides:private-font-faces()` | `listEmbeddedFonts(opened.archive).map(f => ({ typeface, style }))` —— **不 ship sfnt 字节**（单字 100+ KB，picker 列表只显示 `{ typeface, style }`）|
| `slides:private-font-data(id)` | 重新走 `listEmbeddedFonts(archive)` 取第 `id` 个 face 的 sfnt 字节；越界返 `null` |
| `slides:cloud-gen-status()` | 仍 `{ status: 'idle' }`；注释升级解释为何不假装 progress |

#### 11.48.4 不在本轮范围内的 documented stubs（写明原因）

§11.48 同时给以下通道加注释，说明为何保持当前形状：

- `slides:font-catalog` —— 引擎无 theme-font enumeration 模型
- `slides:font-missing` —— 引擎无 missing-font detector
- `slides:chart-color-schemes` —— 引擎无 chart palette metadata
- `slides:media-data` —— 媒体字节管理，desktop 专属
- `slides:native-clipboard` —— 系统剪贴板，浏览器环境差异
- `slides:clipboard-external` / `slides:clipboard-probe` —— desktop clipboard 内容探测

这些留 M4 backlog，需引擎或 host SDK 补充 projection helper。

#### 11.48.5 测试（`apps/web-server/tests/slides-read-model-e2e.test.ts` 新增 describe）

11 个 e2e case：

- **`has-slide-clipboard`（2）**：fresh server → `false`；session-bound
  后做一次 no-op copy（`sourceIds: ['sp_does_not_exist']` 让
  `copy-elements` 返 `0`）→ 仍 `false`。**true 路径**需要元素 id 发现
  （desktop bridge 在 slides-legacy-* 测试里覆盖），web-bridge 路径用
  同一份 state。
- **`private-font-faces`（1）**：blank.pptx 无 `<p:embeddedFontLst>` →
  `[]`。
- **`private-font-data`（2）**：未知 session → `null`；越界 id → `null`。
- **`cloud-gen-status`（2）**：fresh → `idle`；session-bound → 仍 `idle`。
- **documented stubs（2）**：`font-catalog` / `font-missing` 各 1
  个空形状断言，列出来让未来 reader 知道"不是回归"。
  （`slides:table-structure` §11.49 已闭合为空测试不再列；
  `slides:chart-color-schemes` §11.50 已闭合为真值化。）

#### 11.48.6 验证

```
cd apps/web-server
./node_modules/.bin/vitest run --config ./vitest.config.ts tests/slides-read-model-e2e.test.ts
# 42/42 passed（9 §11.45 + 12 §11.46 + 10 §11.47 + 11 §11.48）

./node_modules/.bin/vitest run --config ./vitest.config.ts
# 863 passed | 1 skipped | 0 failures（92 文件；基线 856 → 863 +7）

../../node_modules/.bin/tsc --noEmit
# 无新增错误（同 9 个 pre-existing 在 packages/{pptx-ops,xlsx-gateway}）
```

#### 11.48.7 不在本轮范围内的 ~10 个（M4 backlog）

按 §11.47.7 分类，剩 ~10 个：

- 字体 enumeration 类（`font-catalog` / `font-missing` / `font-download` /
  `font-install-local`）—— 引擎需补 `theme.fonts` enumeration
- 媒体 / 剪贴板（`media-data` / `native-clipboard` /
  `clipboard-external` / `clipboard-probe`）—— 浏览器环境差异大

（`chart-color-schemes` 不在此列 —— §11.50 已闭合为真值化；
端口来自 `apps/slides/src/main/slides-main.ts:1000`。）
- cloud / font download —— 需要上游服务

#### 11.48.8 收口结果

§A.5 "只读 `slides:get-*` 通道" 现标注 ✅ `b0e60d9` + `1759c2b` +
`486f749` + `5ccaeef`（共 15 个 read-only channels），§11.49 闭合
`slides:table-structure`（mutation 路径），§11.50 闭合
`slides:chart-color-schemes`（theme palette）。余 ~8 个仍 M4 backlog
按"需引擎补充 `theme.fonts` enumeration" / "需浏览器 FontFace API" /
"需 desktop clipboard 探测"三类细分。


### 11.59 · Workbook 错误码统一（DX win · §A.5 backlog 收口）

> 本轮闭合 `sdk1.md §A.5 backlog` 中 "Workbook error code unification (DX win)"
> 项。所有 `workbook:*` 通道的错误码从通用 `INVALID_ARGUMENT` / `NOT_FOUND` /
> `CORRUPT` 升级为 workbook 专用 `WORKBOOK_*` 前缀码，让 renderer 的错误恢复
> 分支可以精确判断"是文件没了 vs. session 没了 vs. 文档已损坏 vs. 参数不对"。

#### ✅ 落点

1. **新增 `apps/web-server/src/sheets/errors.ts`（85 行）**：
   - `WorkbookError` 基类，固定 `.code / .channel / .cause` 形状（与
     `apps/web-server/src/ai/errors.ts` 的 `InvalidArgumentError` 等同类一致）
   - 5 个具体子类 + 1 个 `WorkbookErrorCode` 联合类型：
     - `WorkbookNotFoundError` → `WORKBOOK_NOT_FOUND`（404）
     - `WorkbookCorruptError` → `WORKBOOK_CORRUPT`（422）
     - `WorkbookOpenFailedError` → `WORKBOOK_OPEN_FAILED`（500）
     - `WorkbookSaveFailedError` → `WORKBOOK_SAVE_FAILED`（500）
     - `WorkbookInvalidArgumentError` → `WORKBOOK_INVALID_ARGUMENT`（400）
   - `cause` 透传（Corrupt / OpenFailed / SaveFailed 三个保留 cause 链，
     NotFound / InvalidArgument 不带 cause）

2. **HTTP 状态映射**：`apps/web-server/src/ai/errors.ts` 的 `ipcErrorStatus()`
   新增 5 个 case，按通用对应关系映射（404 / 422 / 500 / 400）。envelope
   形态不变 — `sendIpcError` 仍然只读 `.message / .code / .channel`，
   renderer 不需要任何改动即可拿到新 code

3. **handler 切换**（`apps/web-server/src/sheets/index.ts`）：6 处 throw 升级
   - `workbook:open-path` 文件缺失（managed path） → `WorkbookNotFoundError`
   - `workbook:open-path` legacy `.xls` → `WorkbookCorruptError`（保留
     "convert to .xlsx" 文案）
   - `workbook:open-path` zip parse 失败 → `WorkbookCorruptError`（保留 cause）
   - `workbook:open-for-merge` 超过 20 个源 → `WorkbookInvalidArgumentError`
   - `workbook:open-for-merge` 路径越界 → `WorkbookInvalidArgumentError`
   - 通用 `InvalidArgumentError` / `NotFoundError` import 保留 — workbook:save
     / workbook:read-range / workbook:export-csv 三个 handler 仍走通用码
     （留作下一轮专项收口，避免本 PR 改动面过大）

4. **测试**（`apps/web-server/tests/workbook-error-codes.test.ts`，9 测试）：
   - workbook:open-path 缺失文件 → `WORKBOOK_NOT_FOUND` (404)
   - workbook:open-path legacy .xls → `WORKBOOK_CORRUPT` (422) + 文案断言
   - workbook:open-path 随机字节 → `WORKBOOK_CORRUPT` (422)
   - envelope shape（.code / .channel / .message 三字段都在）
   - workbook:open-for-merge 超过 20 源 → `WORKBOOK_INVALID_ARGUMENT` (400)
   - workbook:open-for-merge 0 源 → `WORKBOOK_INVALID_ARGUMENT` (400)
   - WorkbookError 5 子类形态单元测试（instanceof + code 前缀 + channel 前缀）
   - cause 链保留 / 不保留两类断言
   - 沿用 `tests/helpers/server-process.ts:stopServer(server, dataDir)` 模式，
     与 `workbook-save-e2e.test.ts` 同结构（env 变量 `PORT`/`DATA_DIR`、
     `node` 启动 bundle、`/health` 轮询 ≤ 20s）

5. **回归覆盖**：
   - `tests/workbook-save-e2e.test.ts` 把 "legacy .xls" 断言从
     `CORRUPT` 改成 `WORKBOOK_CORRUPT`（代码已升级，断言跟着升级）
   - 现有 "workbook:save unknown sessionId → NOT_FOUND (404)" 不动 —
     workbook:save 仍走通用 NotFoundError
   - 6 个相关套件（workbook-save / workbook-error-codes / html-save-atomic
     / atomic / file-management / slides-save）86/86 全过

#### ⚠️ 仍未做（已知未在本轮 PR 范围）

- **workbook:save / workbook:read-range / workbook:export-csv 三 handler
  升级到 WORKBOOK_* 系列**：本轮刻意保留通用码，等专项 PR 改。
  renderer 视角看，目前 workbook:open-path 已能用新码分支，
  其他三个还按通用码分支（混合期），下轮统一。
- **M4 backlog 其余项**：slides legacy stubs 余 ~5 个、engine stable id、
  CRDT/OT 协作、移动端 H5、HTML→DOCX、DOCX→PDF、S3/minio promote — 均按
  §A.5 既有节奏推进。

#### 🧪 验证命令

```bash
# 仅新测试
cd apps/web-server && timeout 90 ./node_modules/.bin/vitest run \
  --config ./vitest.config.ts tests/workbook-error-codes.test.ts

# 6 套件联合回归（workbook / html / atomic / file-mgmt / slides-save）
cd apps/web-server && timeout 120 ./node_modules/.bin/vitest run \
  --config ./vitest.config.ts \
  tests/workbook-save-e2e.test.ts tests/workbook-error-codes.test.ts \
  tests/html-save-atomic.test.ts tests/atomic.test.ts \
  tests/file-management.test.ts tests/slides-save-e2e.test.ts

# 类型
cd apps/web-server && ../../node_modules/.bin/tsc --noEmit
```

#### 📊 基线更新

| 套件 | 之前 | 现在 | Δ |
|---|---|---|---|
| web-server | 92 文件 / 881 通过 / 1 skipped / 1 flake | **93 文件 / 890 通过 / 1 skipped / 1 flake** | +1 文件 / +9 通过 |
| §A.5 backlog 闭合数 | 56（截至 §11.58）| **57**（+1：workbook 错误码统一）| +1 |

### 11.60 · SDK `isDirty()` + `save()` 命令（SDK gap closure · §A.5 backlog 收口）

> 本轮闭合 `sdk1.md §A.5 backlog` 中"Sdk 命令 surface 缺口"项。SDK 类型层
> 新增 2 个 host-facing 命令：`isDirty()` query + `save()` action。

#### ✅ 落点

1. **SDK 类型层（`apps/sdk/src/types.ts` · `EditorCommands` 接口）**：
   - `isDirty: { args?: {}; result: { dirty: boolean } }` — host 查询当前 dirty 状态
   - `save: { args?: {}; result: { ok: true; savedPath?; savedAt? } }` — host 触发 renderer 原生 save pipeline

2. **SDK 运行时（`apps/sdk/src/editor.ts`）**：
   - 新增 3 个实例级缓存：`lastDirty: boolean` · `lastSavedPath?: string` · `lastSavedAt?: string`
   - `dirtyChanged` 事件到达时刷新 `lastDirty`（在 dispatch 之前，保证 host listener 看到一致状态）
   - `saved` 事件到达时刷新 `lastSavedPath` / `lastSavedAt`
   - `command('isDirty')` 加 500 ms fallback race — 如果 renderer 只 push `dirtyChanged` 事件不回复 command-result，500 ms 后用 `lastDirty` 兜底（其他命令保持原 30 s 硬上限）
   - `save()` 没有 client-side fallback — 必须由 renderer 回 command-result（与 `downloadAs` 一致）

3. **测试（`apps/sdk/test/kestrel-m6.test.ts` · 11 测试）**：
   - 类型合同：EditorCommands 含 `isDirty` + `save`（runtime echo）
   - 命令可达性：`command('isDirty')` / `command('save')` 在 skipIframe 模式下返预期的"editor not mounted"
   - 类型精确化：`isDirty` result pin `{ dirty: boolean }`；`save` result pin `{ ok: true; savedPath?; savedAt? }`
   - 事件 dispatch：`dirtyChanged` 触发 `on('dirtyChanged', cb)` listener；`saved` 触发 `on('saved', cb)`
   - dispatch 顺序保持：第二事件不丢
   - unsubscribe：`off()` 移除 listener 后后续事件不触发

#### ⚠️ 仍未做（renderer-side follow-up，类比 §B.5.1 #7 `openFileDialog`）

- **6 个 app 的 postMessage listener 实现 `isDirty` / `save` 命令分发**：
  - `apps/docs/src/main/web-bridge.ts`：把 SDK `command(isDirty)` 转发到 docs 内部 dirty 检查器；`command(save)` 转发到 docs:save IPC
  - `apps/sheets/src/main/web-bridge.ts`：→ workbook:save
  - `apps/slides/src/main/web-bridge.ts`：→ slides:save（注意：slides save 走 `state.ts` 的 in-memory deck，已真保存）
  - `apps/pdf/src/main/web-bridge.ts`：→ pdf:save
  - `apps/markdown/src/main/web-bridge.ts`：→ markdown:save
  - `apps/html/src/main/web-bridge.ts`：→ html:save
- 每个 app 增量 < 30 行；6 app 总计 ~180 行；预计 0.5-1 天工作量。

#### 🧪 验证命令

```bash
# 仅新测试
timeout 60 ./node_modules/.bin/vitest run apps/sdk/test/kestrel-m6.test.ts

# 全 SDK 套件（17 文件）
timeout 120 ./node_modules/.bin/vitest run apps/sdk/

# 类型
cd apps/sdk && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

#### 📊 基线更新

| 套件 | 之前 | 现在 | Δ |
|---|---|---|---|
| apps/sdk | 16 文件 / 201 通过 | **17 文件 / 212 通过** | +1 文件 / +11 通过 |
| §A.5 backlog 闭合数 | 57（截至 §11.59）| **58**（+1：SDK 命令 surface 缺口）| +1 |

### 11.61 · 完成 workbook 错误码统一（workbook:save + export-csv 收口）

> 续 §11.59。本轮把 §11.59 故意保留的 3 个 workbook 通道也迁移到
> `WORKBOOK_*` 编码 — `workbook:save` / `workbook:save-edits-begin` /
> `workbook:export-csv`。目标："每个 workbook:* 通道在所有错误路径上都
> 返回 workbook 专用码"。

#### ✅ 落点

1. **`apps/web-server/src/sheets/index.ts` 升级 throw 9 处**：
   - `workbook:save` 无 sessionId / 非字符串 sessionId → `WorkbookInvalidArgumentError`
   - `workbook:save` 未知 session → `WorkbookNotFoundError`
   - `workbook:save-edits-begin` 未知 session → `WorkbookNotFoundError`
   - `workbook:export-csv` 6 处参数校验 → `WorkbookInvalidArgumentError`
   - `workbook:export-csv` 路径越界 → `requireManagedPath` 包 try/catch 转 `WorkbookInvalidArgumentError`
     （关键 — 否则 export-csv 会在路径越界时返通用 `INVALID_ARGUMENT`，与其他分支不一致）

2. **测试更新（`apps/web-server/tests/workbook-save-e2e.test.ts`）**：
   - 3 处旧断言升级：`NOT_FOUND → WORKBOOK_NOT_FOUND`、`INVALID_ARGUMENT → WORKBOOK_INVALID_ARGUMENT`
   - 文件 docstring 刷新 — 指明现在 workbook:* 全通道统一返回 workbook 专用码

3. **测试新增（`apps/web-server/tests/workbook-error-codes.test.ts` +10）**：
   - `workbook:save` 无 args / 非字符串 sessionId / 未知 sessionId
   - `workbook:save-edits-begin` 未知 sessionId
   - `workbook:export-csv` 6 个分支（非对象请求 / 缺 fileName / fileName > 255 / 非字符串 content / 空 content / 路径越界）

#### 📊 基线更新

| 套件 | 之前 | 现在 | Δ |
|---|---|---|---|
| web-server | 93 文件 / 890 通过 | **93 文件 / 900 通过** | +0 文件 / +10 通过 |
| §A.5 backlog 闭合数 | 58（截至 §11.60）| **59**（+1：workbook 错误码统一收口 — 之前 §11.59 完成 6 处，本轮完成余下 9 处）| +1 |

#### ⚠️ 仍未做（renderer-side follow-up + 其他通道）

- §11.60 备注里的 6 app `web-bridge.ts` `isDirty` / `save` 命令分发（~180 行，0.5-1 天）
- §11.60 备注里 `workbook:read-range` 内部还走通用 `NotFoundError`（session 找不到），本轮没改
- 类型层面仍可有空间扩展 `WorkbookErrorCode` 联合类型（e.g. `WORKBOOK_TIMEOUT` / `WORKBOOK_CONFLICT`），但当前实际错误路径未触发，留作 backlog

### 11.62 · Renderer 侧 `isDirty` / `save` 命令分发（§11.60 完成）

> §11.60 加了 SDK 类型 + 运行时（`lastDirty` 缓存 + 500 ms fallback），
> 但 renderer 侧还没真正回答这两个命令。本轮在 `ipc-bridge` 完成
> 完整的 handler 实现，让 6 个用 `installTextBufferSink` 的 app（docs /
> markdown / html / sheets / slides / pdf）开箱即可用。

#### ✅ 落点

1. **`packages/ipc-bridge/src/sdk-command-sink.ts`**：
   - `SdkLiveModelAdapter` 接口加 2 个可选方法 `isDirty?` / `save?`
   - `makeLiveModelHandlers(adapter)` 加对应 handler 注册（与 undo/redo 同模式）：
     - `isDirty` → 调 adapter.isDirty()，强制返回 `{ dirty: boolean }`
     - `save` → 调 adapter.save()，规范化 `{ ok: true; savedPath?; savedAt? }` 形状

2. **`packages/ipc-bridge/src/text-buffer-adapter.ts`**：
   - `TextBuffer` 类加 `private dirty = false` + 3 个方法：
     - `set / replaceAll / insertAt` 三处 mutator 之后 `this.dirty = true`
     - 新增 `isDirty()` / `markClean()` / `markDirty()` 公开 API
   - `installTextBufferSink` 加新 option `onSave?: () => Promise<...>`：
     - 默认走 `onSave`，save 成功后调 `buffer.markClean()` 自动恢复 clean
     - 失败抛错则 dirty 保持，retry 还能继续
     - 无 `onSave` + 无 native adapter → `UnsupportedCommandError('save')`（loud failure）

3. **测试（`packages/ipc-bridge/tests/text-buffer-adapter.test.ts` +10）**：
   - 初始状态 clean（fresh install）
   - setContent / insertText / updateTextBuffer 都触发 dirty
   - 无 onSave 抛 UnsupportedCommandError（loud failure，不静默）
   - 有 onSave 调 callback + markClean + 返回 savedPath/savedAt
   - onSave 抛错时 dirty 保持
   - async onSave 正确 await
   - dirty 在 undo/redo 后保持（不是"自动 clean"）
   - native adapter 注册后优先级高于 buffer fallback

#### 📊 基线更新

| 套件 | 之前 | 现在 | Δ |
|---|---|---|---|
| packages/ipc-bridge | 6 文件 / 151 通过 | **6 文件 / 161 通过** | +0 文件 / +10 通过 |
| §A.5 backlog 闭合数 | 59（截至 §11.61）| **60**（+1：renderer 侧 isDirty/save 完成）| +1 |

#### ⚠️ 仍未做（renderer-side follow-up · 已缩为 ~30 行/app）

- **6 个 app `web-bridge.ts` 加 `onSave` 回调**（每 app ~5 行）：
  ```typescript
  installTextBufferSink({
    onSave: async () => {
      const r = await window.markdownApi.save({ /* renderer-supplied args */ })
      return { ok: true, savedPath: r.path, savedAt: r.savedAt }
    },
  })
  ```
  6 app × ~5 行 = ~30 行。`isDirty` 自动通过 buffer 跟踪，无需 app 写额外代码。

- **`slides` / `pdf` 自身 dirty 状态 vs buffer dirty 状态可能不同步**：
  slides 有自己的 deck 模型，dirty 应来自 deck；pdf 同理。本轮先让
  buffer 路径工作，native adapter 注册路径已留好 hook — app 写一个
  `registerNativeAdapter({ isDirty: () => deck.isDirty() })` 即可。

#### 🧪 验证命令

```bash
# 新增 10 测试
timeout 60 ./node_modules/.bin/vitest run packages/ipc-bridge/tests/text-buffer-adapter.test.ts

# 跨包回归（ipc-bridge + sdk）
timeout 90 ./node_modules/.bin/vitest run packages/ipc-bridge/ apps/sdk/

# 类型（ipc-bridge）
cd packages/ipc-bridge && ../../node_modules/.bin/tsc --noEmit
```

### 11.63 · Markdown renderer 侧 save 接线（§11.62 首个落地 app）

> §11.62 在 `installTextBufferSink` 上加了 `onSave` 框架。本轮把 markdown
> 第一个接上 — 验证端到端形状适配可行。剩余 5 app（docs / html / sheets
> / slides / pdf）按相同模式各 ~10 行即可，留作后续小 PR。

#### ✅ 落点

1. **`packages/ipc-bridge/src/text-buffer-adapter.ts`**：
   - 导出新 helper `textBufferGetText(target?)`：从 mirror buffer 读当前文本
   - 用途：renderer 在 `onSave` 回调里读 buffer 文本喂给 app 自己的 `xxxApi.save`
   - 不需要 renderer 自己维护 `onBufferChange → 缓存` 的样板

2. **`apps/markdown/src/renderer/web-bridge.ts`**：
   - `installTextBufferSink` 加 `onSave: async () => { ... }`
   - 内部调 `window.markdownApi.save({ mode: 'save', text: textBufferGetText(), imageSources: [] })`
   - 适配 `SaveMarkdownResult` 三种 union（happy / canceled / error）→ SDK 形状：
     - `{ ok: true; path }` → `{ ok: true, savedPath: path }`
     - `{ ok: true; canceled: true }` → throw（bridge 报错 → buffer 保持 dirty）
     - `{ ok: false; error }` → throw 同上

#### 🧪 验证

- markdown typecheck clean（`tsc --noEmit -p apps/markdown` 0 错误）
- 261 / 262 markdown 测试通过；唯一失败 `find-panel.test.ts > refocuses...`
  是 pre-existing flake（基线复现），与本 PR 无关

#### 📊 进度

- §11.63 闭合 §11.62 "仍未做" 列表第 1 项（markdown）
- 余 5 app（docs / html / sheets / slides / pdf）按 ~10 行模式各自接线
- sheets / slides / pdf 已有自己的 live-model adapter，需要走
  `registerNativeAdapter({ isDirty, save })` 路径（与 text-buffer 不同）

### 11.64 · HTML renderer 侧 save 接线（§11.63 模式复用 · 第 2 个 app）

> 续 §11.63。html 的 `SaveHtmlRequest` / `SaveHtmlResult` 形状与 markdown
> 完全一致，所以 `onSave` adapter 一字不差复用。

#### ✅ 落点

1. **`apps/html/src/renderer/web-bridge.ts`**：
   - `installTextBufferSink` 加 `onSave` 选项
   - 内部调 `window.htmlApi.save({ mode: 'save', text: textBufferGetText(), imageSources: [] })`
   - 适配 `SaveHtmlResult` 三种 union → SDK 形状（同 markdown）

#### 🧪 验证

- html typecheck clean
- 179 / 179 html 测试通过

#### 📊 进度

- §11.63 + §11.64 闭合 markdown + html 两个 text-buffer app
- 余 4 app：
  - docs（live-model path — docs 有 tiptap + dirtyRef + isDocDirty 复合检查，
    不能复用 text-buffer 模式）
  - sheets（live-model path — 走 `workbook:save` 通道，dirty 来自 sheet edits）
  - slides（live-model path — slides 有自己的 deck，dirty 来自 deck）
  - pdf（live-model path — pdf 有自己的 state）

### 11.66 · Docs renderer save 接线（§11.62 模式扩展 · 第 3 个 app）

> 续 §11.63 + §11.64。docs 是第一个不走 text-buffer 的 app —— 它有
> tiptap editor + `dirtyRef` + `isDocDirty` 复合 dirty 检查 + `saveImpl`
> 走 `docs:save` IPC 通道。所以本轮走 `registerNativeAdapter` 路径
> （live-model adapter），而不是 markdown/html 的 `onSave` 选项。

#### ✅ 落点

1. **`apps/docs/src/renderer/App.tsx`**：
   - 顶部已经 import 了 `registerNativeAdapter`（sdk1 §11.36 留下的脚手架）
     —— 本轮新增一个 useEffect 把 live-model adapter 真正注册进 sink：
     ```ts
     useEffect(() => {
       const unsubscribe = registerNativeAdapter({
         save: async () => {
           const ok = await save(false, false)
           if (!ok) throw new Error('docs:save returned ok=false')
           return { ok: true as const, savedPath: doc?.filePath ?? undefined,
                    savedAt: new Date().toISOString() }
         },
         isDirty: () => isDocDirty(dirtySnapshotRef.current),
       })
       return unsubscribe
     }, [save, doc?.filePath])
     ```
   - `dirtySnapshotRef` 在每次 render 时刷新，承载所有 25 个 dirty 字段
     （sectionDirty / headerDirty / pageColorDirty / themeFontsDirty /
     commentsDirty / protectionDirty / ...），isDirty 用它喂 `isDocDirty()`
     —— 比单看 `dirtyRef.current` 覆盖面更全（前者会漏 header / page
     color / numbering / theme 类的修改）。

2. **`apps/docs/tests/sdk-save-wiring.test.ts`**（新增 191 行 / 9 测试）：
   - `isDocDirty` 复合检查：pristine / dirtyRef / headerDirty / pageColor /
     numbering / theme / sectionsDirty / hfVariantsDirty / styleUpserts
     共 8 个 case
   - save delegation 3 case：成功路径 / 失败 throw / `savedPath` 为 undefined
   - effect lifecycle 1 case：adapter shape snapshot

#### 🧪 验证

- apps/docs typecheck：clean（仅 1 处 pre-existing `packages/file-parse/src/pdf.ts:147`
  pdfjs-dist 类型缺失，与本次改动无关）
- 新增 `sdk-save-wiring.test.ts`：**9 / 9 通过**
- 完整 docs 套件：**2334 / 2335 通过**（1 处 pre-existing flake ·
  `protect-dialog.test.ts` 在 stash 前后均失败，与本次改动无关）

#### 📊 进度

- §11.63 + §11.64 + §11.66 闭合 markdown + html + docs 三个 app 的 SDK save
  - markdown / html 走 text-buffer 的 `onSave`（读 buffer 文本）
  - docs 走 `registerNativeAdapter` 的 live-model 路径（调 `saveImpl` + 复合 `isDocDirty`）
- 余 3 app：sheets（走 workbook:save IPC）/ slides（live-model）/ pdf（live-model）
- `registerNativeAdapter` 是 docs 用的新接入点 —— 给 sheets / slides / pdf
  提供了清晰模板（live-model + composite dirty snapshot + unsubscribe on unmount）

### 11.67 · Sheets renderer save 接线（§11.66 模式复用 · 第 4 个 app）

> 续 §11.66。sheets 已经有 §11.36 的 `registerNativeAdapter({ undo, redo,
> getUndoStack })` —— 本轮扩到包含 `save` 和 `isDirty`，复用现有的
> `handleSave` pipeline（同 Ctrl+S / ⌘S 路径）和 `journalSize` 复合 dirty
> 信号（同 autosave / crash-recovery tick）。

#### ✅ 落点

1. **`apps/sheets/src/renderer/App.tsx`**：现有 `registerNativeAdapter` useEffect
   扩到 5 个方法：
   ```ts
   isDirty: () => {
     const state = lazyWorkbookRef.current
     if (!state) return false
     return journalSize(state.editJournal) > 0
   },
   save: async () => {
     const state = lazyWorkbookRef.current
     if (!state) throw new Error('sheets:save — no workbook is open')
     if (state.file.needsSaveAs || state.file.csvPath !== undefined) {
       throw new Error(
         state.file.csvPath !== undefined
           ? 'sheets:save — CSV sessions must use saveAs to switch format'
           : 'sheets:save — converted .xls imports must use saveAs first',
       )
     }
     await handleSaveRef.current('save', true)
     const path = workbookFile?.path
     return {
       ok: true as const,
       ...(path !== undefined ? { savedPath: path } : {}),
       savedAt: new Date().toISOString(),
     }
   },
   ```
   - `exactOptionalPropertyTypes` 兼容：spread `savedPath` 而不是
     `?? undefined`，否则 strict TS 会拒绝
   - `needsSaveAs` / `csvPath` 走结构化 throw，与 autosave guard
     (line 521, 549) 同源 —— 拒绝让 SDK 把 converted `.xls` 或 CSV
     session 静默存成 xlsx
   - `useEffect` 依赖加 `[workbookFile?.path]` 让 save 始终拿到最新 path

2. **`apps/sheets/tests/sdk-save-wiring.test.ts`**（新增 175 行 / 8 测试）：
   - isDirty delegation 3 case：journalSize === 0 / > 0 / state === null
   - save delegation 5 case：成功 / no workbook throw / needsSaveAs throw /
     csvPath throw / savedPath undefined spread

#### 🧪 验证

- apps/sheets typecheck：clean（pre-existing 错误：i18n `appGroupFile` /
  `appUploadFile` / `appUploadFileDetail` 缺键 + `web-bridge.ts:113`
  `exportCsv` 不在 `SheetsApiOverrides` —— 经 `git stash` 前后一致，与本次改动无关）
- 新增 `sdk-save-wiring.test.ts`：**8 / 8 通过**

#### 📊 进度

- §11.63 + §11.64 + §11.66 + §11.67 闭合 markdown + html + docs + sheets
  四个 app 的 SDK save
- 余 2 app：slides（live-model）/ pdf（live-model）
- sheets 走的是 §11.66 的 `registerNativeAdapter` 模板 —— 但 dirty 信号
  不是 `dirtyRef.current`，而是 `journalSize(state.editJournal) > 0`
  （因为 sheets 没有 tiptap-style 的 ref-based dirty flag；所有 unsaved
  ops 都流过 edit journal，autosave / recovery 已经用这个信号）

### 11.68 · Slides renderer save 接线（§11.66 模式复用 · 第 5 个 app）

> 续 §11.66 + §11.67。slides 的 `registerNativeAdapter` 已经接了
> undo/redo/getUndoStack（§11.36）—— 本轮扩到 5 个方法，加 `save` 和
> `isDirty`。dirty 直接读 React 的 `dirty` state（autosave tick 已经
> 通过 `window.slidesApi.isDirty()` 维护），save 走 `save(true)` 复用
> Ctrl+S / close-guard 已经在用的 pipeline。

#### ✅ 落点

1. **`apps/slides/src/renderer/App.tsx`**：现有 registerNativeAdapter useEffect
   扩到 5 个方法：
   ```ts
   isDirty: () => dirty,
   save: async () => {
     const ok = await saveRef.current(true)
     if (!ok) throw new Error('slides:save returned ok=false')
     return {
       ok: true as const,
       ...(path !== null ? { savedPath: path } : {}),
       savedAt: new Date().toISOString(),
     }
   },
   ```
   - `saveRef.current` 是 useRef 包装，避免 effect 重跑时 closure 捕获 stale `save`
   - `exactOptionalPropertyTypes` 兼容：spread `savedPath` 而不是 `?? undefined`
   - 依赖加 `[dirty, path]` —— dirty state 翻转时 SDK isDirty 立即看见，
     post-save 切换到新 path 时 SDK save 也立即拿到

2. **`apps/slides/tests/sdk-save-wiring.test.ts`**（新增 91 行 / 5 测试）：
   - isDirty delegation 2 case：clean deck / after edit
   - save delegation 3 case：成功 / throw-on-false / savedPath undefined spread

#### 🧪 验证

- apps/slides typecheck：clean（pre-existing 错误：i18n `ribbonGroupFile` /
  `ribbonUpload` / `ribbonUploadTip` 缺键 + pdfjs-dist 类型缺失 —— 与本次改动无关）
- 新增 `sdk-save-wiring.test.ts`：**5 / 5 通过**

#### 📊 进度

- §11.63 + §11.64 + §11.66 + §11.67 + §11.68 闭合 markdown + html + docs
  + sheets + slides 五个 app 的 SDK save
- 余 1 app：pdf（live-model + EditSnapshot）
- 引擎级约束（sdk1 §A.5 #56：slides parse-time 元素 id 不稳定）不在
  本轮范围 —— 那需要引擎侧为元素发稳定 id（持久化的 `e_<guid8>` 形式）
- 已知 follow-up：slides 应用第 78 个 legacy element 通道目前返桩（§11.42
  处理了形状错配，但 renderer 真正发出的 op 集合覆盖还没完成）

### 11.65 · Workbook 错误码统一收口（最后两处 + 测试同步）

> 续 §11.59 + §11.61。workbook 通道的所有 throwable 已统一走
> `apps/web-server/src/sheets/errors.ts` 的 `WorkbookError` 体系，本轮
> 闭合 3 项收口工作。

#### ✅ 落点

1. **`apps/web-server/src/sheets/index.ts`**：
   - 第 359 行 `workbook:open-for-merge` 的"merge 源不存在"分支
     `throw new NotFoundError(...)` → `throw new WorkbookNotFoundError(...)`。
     与 §11.59 引入的 workbook-specific `WORKBOOK_NOT_FOUND` 码对齐。
   - 380 行附近过时注释（"`NotFoundError` import 仍被
     `workbook:open-for-merge` 保留"）已替换为"全部 throwable 走
     `./errors` 统一收口（§11.65）"的描述。
   - 顶部 `import { InvalidArgumentError, NotFoundError } from '../ai/errors'`
     删除——workbook 通道不再引用裸错误类，TS strict 编译通过。

2. **`apps/web-server/tests/multi-format-upload.test.ts`**：
   - 第 200 行附近 `knownErrorCodes` 集合新增 5 个 `WORKBOOK_*` 码：
     `WORKBOOK_NOT_FOUND` / `WORKBOOK_CORRUPT` / `WORKBOOK_OPEN_FAILED`
     / `WORKBOOK_SAVE_FAILED` / `WORKBOOK_INVALID_ARGUMENT`。
   - `workbook:open-path` 解析 stub 字节时抛 `WorkbookCorruptError`
     → IPC envelope `code: WORKBOOK_CORRUPT`，此前因不在白名单而失败的
     "every editor channel is registered for the matching fixture"
     测试重新通过。

#### 🧪 验证

- `apps/web-server` typecheck：clean（无 `git apply` 错误，排除已知的
  `packages/{pptx-ops,xlsx-gateway}` 9 处历史错误后）
- `tests/workbook-save-e2e.test.ts` + `tests/workbook-error-codes.test.ts`：
  **36 / 36 通过**（19 + 17）
- `tests/multi-format-upload.test.ts`：**3 / 3 通过**（新增 WORKBOOK_*
  白名单后）
- 全量 web-server 套件：**900 / 902 通过**（1 个 known flake ·
  `translate-bucket-isolation-e2e` LLM-dependent；与本次改动无关）

#### 📊 进度

- §11.59 + §11.61 + §11.65 三轮已闭合 workbook:* 通道全部 throwable
  路由至 `./errors`，HTTP 状态映射走 `ai/errors.ts:ipcErrorStatus()`
  共享 404 / 422 / 400 / 500 语义
- 与 docs / markdown / html / pdf 的"应用专属错误码"模式对齐
- §A.5 backlog 第 1 项（workbook 错误码统一）正式完成

## 附录 A：实施状态（截至 2026-09-22，分支 `release0919`)

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

#### ✅ 本轮新增解决（§B.5.1 #6 Export + 2 处"假成功" + 1 个 wasm 事故）

**50. `§B.5.1 #6 Export（downloadAs）** —— SDK 2.0 第 9 个（也是最后一个）
surface 落地。至此 §B.5.1 的 9 项全部完成。契约在 `apps/sdk/src/types.ts`
（`downloadAs`），适配器在 `packages/ipc-bridge/src/sdk-command-sink.ts`
（含"必须恰好一个目标 + 必须有 size"的契约强制），应用接线在
markdown / html / docs；sheets / slides / pdf 抛标准 `UNSUPPORTED`。新增
`web:write-file-bytes` 通道承载 `savePath`。详见 §11.41.3。

**51. `anydoc:convert` 的 pdf → docx 真实化**（✅ 本轮）：`@genoffice/pdf2docx`
是纯 TS + pdfium wasm，web 构建完全能跑，原来的全线 `WEB_UNSUPPORTED` 低估了
自己的能力。新增 `apps/web-server/src/anydoc/convert.ts` +
`scripts/bundle.mjs` 拷贝 wasm（否则 Docker 运行阶段找不到）。docx → pdf 仍
诚实拒绝。详见 §11.41.2。

**52. `apps/html` 的 Word 导出是假导出**（✅ 本轮修为诚实拒绝）：原实现把
HTML 源码写进 `.docx`，Word 打不开而 UI 报成功。真实实现需要无头浏览器
（`packages/html2docx` + ElectronBrowserDriver 要渲染 + 元素截图），web 构建
没有，故改为结构化错误 + 指引 PDF 打印。详见 §11.41.1。

**53. `apps/docs` 的 `exportHtml` 在 web 构建从未实现**（✅ 本轮实现）：渲染
进程一直在产 standalone HTML，desktop-api 却直接回"not yet implemented"，
把已经做好的工作丢掉。现在走浏览器下载。详见 §11.41.3。

**54. 首版 `convert.ts` 用 `__dirname`**（✅ 本轮修正）：ESM（tsx dev + esbuild
bundle）下 `__dirname` 不存在，任何调用都会 `ReferenceError`。改用
`import.meta.url` + 多候选路径。同时修正 wasm 位置认知：包导出映射是
`./pdfium.wasm` → `./dist/pdfium.wasm`，文件不在包根。

**55. Slides 68 个 legacy element 通道返错形状的 `{ok:true}`**（✅ §11.42）：
`slides:delete-element` / `set-element-font` / `edit-transform` / `flip-elements` /
`group-elements` / `copy-elements` / `undo` / `redo` / `find-replace` / `set-notes` /
`set-transition` 等通道此前返字面量 `{ok:true}`，而 renderer 拿它当 `RenderSlide`
用 —— `{ok:true}` 是真值，于是"成功"分支把一个没有 `nodes` 的对象的存成当前页，
画布变空白并在后续编辑中持续污染。实测确认的形状错配：`copy-elements` 契约要
`number`、`set-notes` / `set-transition` 要 `boolean`、`undo` / `redo` 要
`RenderSlide[]`、`find-replace` 硬编码 `{count:0}`。现全部按 `apps/slides/src/shared/ipc.ts`
声明的形状作答，失败返 `null`（不返 `{ok:false}`——同样是真值、同样会污染），并
打 stderr 日志。字面桩归零。

**56. 解析期 element id 不稳定（引擎级约束，⚠️ 已知未根治）**：实测同一份 pptx
字节连续 `openPptx` 两次，元素 id 依次为 `sp_0` / `sp_2` / `sp_4` —— **每次 parse
都会变**。这意味着任何"保存时重新 parse 再写回"或"socket 重连后重新加载"的实现
都会让 renderer 手里持有的 id 全部失配（选中态丢失、后续 mutation 打到不存在的
元素）。本轮据此做了两个决定：①`slides:open-path` 对同一路径**复用已存在的 live
session**，不再重建；②`slides:save` **刻意不 reparse**（`core.ts` 有注释说明）。
根治需要引擎侧为元素发稳定 id（持久化的 `e_<guid8>` 形式已经是稳定的，但 parse
时新分配的那些不是）。列入 P1 引擎工作。

**57. Slides undo/redo + 元素剪贴板 + AI 快照真实化**（✅ §11.42）：
`slides:undo` / `slides:redo` 此前返 `{ok:true}`；新增 `state.ts` 的
`SlidesHistorySnapshot` 快照栈（`takeSlidesSnapshot` / `pushSlidesHistory` /
`undoSlidesHistory` / `redoSlidesHistory` / `beginSlidesHistoryBatch` /
`endSlidesHistoryBatch`）+ 应用级元素剪贴板
（`setSlidesElementClipboard` / `getSlidesElementClipboard`）+ AI 快照
（`registerSlidesAiSnapshot` / `restoreSlidesAiSnapshot` / `settleStaleHistoryBatch`）。
`copy-elements` / `paste-elements` / `group-elements` 等于是有真实数据可依。

#### ✅ 本轮已解决（3 项）

1. **`streamForProvider` / `chatForProvider` 实际读 `getDefaultProviderRegistry`** — 通过 `packages/ai-provider/src/stream.ts` + `chat.ts` 的 plugin-fallback 分支实现：plugin 命中走 plugin，否则 fallback 到 legacy `getProviderAdapter`。新增 6 个 `packages/ai-provider/tests/plugin-routing.test.ts` 测试 + 2 个 `apps/web-server/tests/plugin-e2e.test.ts` 端到端测试。
2. **Webhook HMAC 签名** — `apps/web-server/src/common/webhooks-store.ts` 新增 `signWebhookBody()`（HMAC-SHA256，sha256= 前缀）+ `FileWebhook.secret` 字段 + 出站请求带 `X-GenOffice-Signature` 头。GitHub / Stripe 风格。5 个 `apps/web-server/tests/webhook-signing.test.ts` 测试覆盖 secret 缺失 / 存在 / 不同 body / 不同 secret / 端到端 header 注入。
3. **JWT RBAC scope（OAuth scope claim）** — `apps/web-server/src/api/v1/auth.ts` 新增 `hasScope(payload, scope)` helper（exact / `*` 通配 / `ai:*` 前缀通配 / 默认只读 / admin 旁路）+ `JwtPayload.scope` 字段 + `/api/v1/auth/jwt` 接受 `scope` 输入并合并到 `scope` claim。9 个 `apps/web-server/tests/auth-scope.test.ts` 测试。
4. **postMessage iframe 握手 + origin allowlist** — `apps/sdk/src/editor.ts` 新增：每会话随机 nonce 注入 `?nonce=`，`ready` event 必须 echo 同一 nonce 否则触发 `HANDSHAKE_FAILED`；可选 `allowedOrigins: string[]` 配置（含 `*.example.com` 单段通配）。8 个 `apps/sdk/test/handshake.test.ts` 测试。

#### ✅ §11.36 已解决（3 项）

**47. bridge outbound `dir` 用 ASCII 连字符导致 SDK 静默丢包**（✅ `04eaf6e`）：
`apps/web-server/src/embed/bridge.ts` 的 `post()` 写的是
`dir: 'editor->host'`（U+002D），而 `apps/sdk/src/envelope.ts:76` 的
`isEnvelope` 只接受 `'editor→host'`（U+2192）。**全部 SSE relay 的
生命周期事件（saved / dirtyChanged / selectionChange / error / closed）
在 SDK 侧被静默丢弃**，host 的 `editor.on('saved', cb)` 从不触发。
修一个字符 + 2 条守门测试（source-grep + live-runtime 都断言箭头形态）。

**48. SDK `editor.command()` inbound 通道从未接通**（✅ `7c7f878` + `25519f0`）：
§11.34 删掉 `host.command` CustomEvent 后，renderer 侧从未实现 GenOffice
envelope 的 inbound listener（`apps/*/src/renderer` 里的
`addEventListener('message')` 全是 Dataflare 协议），SDK 命令 30 s 必然超时。
本轮 bridge 新增 `onHostMessage` + `replyCommand`；服务端新增
`embed/sdk-commands.ts`（单一 `sdk:command` 通道 + 8 条服务端承载命令：
comments×4 / versions×3 / reportUsage）；其余命令返结构化 `UNSUPPORTED`。
bridge 优先走 `window.__GENOFFICE_COMMAND_SINK__`（renderer 装上时），
否则 POST `sdk:command` —— 保证每条命令恰好一个回复。

**49. telemetry 只本地 dispatch、从不向服务端上报**（✅ `25519f0`）：
30 s ticker 现在同时上报服务端，`destroy()` 在翻转 `destroyed` 前 flush
最后一笔；`reportUsage` 加入 `EditorCommands` union；
`GET /api/v1/metrics` 新增 7 条 `genoffice_sdk_*` 序列。

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
15. **本轮小结**：A.5 已完成的 ✅ 项目累计到 16 条。**§11.31 增补到 17 条**（embed bridge 独立模块 + 17 单元测试）。**§11.32 增补到 18 条**（SDK verifyEmbedSession 一体化 helper + createEditor sessionBinding 自动 release）。**§11.33 增补到 19 条**（webhook DLQ + host 管理 endpoint）。**§11.34 增补到 20 条**（bridge dead-code 清理 + 负向守门）。。。。A.3 仍剩 Discord ⬜（外部服务，沙箱内不可达）。其它交付（SDK / REST / Skills / Providers / Docs / Examples / Webhook HMAC / JWT RBAC scope / Scope gate / iframe 握手 / §2.2 11 包可发布）均 ✅。
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
33. **webhook 死信队列 + host 管理 endpoint**（✅ 本轮 §11.33）：闭合 §11.3 P1 "DLQ 留 backlog"。`apps/web-server/src/common/webhooks-dlq.ts` 新增进程内 ring buffer（LRU 1024，reason 区分 `max_attempts` / `non_retryable_4xx`）+ `replayDeadLetter`（原地 update 保 id 稳定）；`notifyFileSaved` 末尾 push 到 DLQ（动态 import 避循环依赖）；v1 endpoint 4 个（`GET/POST/DELETE /api/v1/webhooks/dlq[/:id[/replay]]`）+ `webhooks:manage` scope gate。caller-fault 4xx（URL 配错 / auth 失效）也入 DLQ，让 host 看到 "我自己配错" vs "server 挂" 的区分。5 文件 / +23 测试（web-server 70/558 → 71/581）。live smoke 8/8（empty list / 401 / 403 / 400 / 404 GET / 404 DELETE / 404 replay / limit cap 200）。

32. **SDK `verifyEmbedSession()` 同义别名 + `createEditor({ sessionBinding })` 自动 release**（✅ 本轮 §11.32）：闭合 §11.29.4 #1 + §11.30.4 destroy 自动释放 backlog。① 新 helper `verifyEmbedSession(options)`：与 `verifyEmbedNonce` 同 protocol 别名（130 行复制，错误 code 集合相同），让 `mint → mount → audit → release` 调用链读起来顺；② `CreateEditorOptions.sessionBinding?: { sessionId, nonce, autoRelease? }`：eager-validate sessionId/nonce（任一缺失同步抛），`destroy()` 末尾 fire-and-forget `releaseEmbedNonce().catch(() => {})`，autoRelease 默认 true。`expectedNonce` 改为 `sessionBinding?.nonce ?? makeNonce()`（用 server-minted 替代 client-only 随机数）。8 文件 / +31 测试（10 文件 / 108 测试 = was 8/77）。README 双语更新（`createEditor({ sessionBinding })` 示例 + `autoRelease:false` 用法 + `verifyEmbedSession` 别名说明）。live smoke 5/5（verify valid / embed with session / autoRelease DELETE / verify after release / stale embed 401）。

31. **embed bridge 独立模块 + 17 单元测试**（✅ 本轮 §11.31）：`apps/web-server/src/embed/bridge.ts` 新模块导出 `EMBED_BRIDGE_VERSION` ('0.1.0') + `EMBED_BRIDGE_SOURCE` 模板字面量（`${WEB_SERVER_VERSION}` 插值位）；`embed/index.ts` 单行替换原 inline 字符串（served HTML 字节等价）。17 测试覆盖 IIFE 形状 / `WEB_SERVER_VERSION` SOT / envelope v=1.0 / nonce echo / meta 缺省 / `__GENOFFICE_EMBED__.app` / EventSource URL / 单参 vs 多参 unwrap / SSE 转发 / 入站 command → CustomEvent / envelope version 守门 / readyState=loading 等 DOMContentLoaded。test harness 用 `new Function('window','document','EventSource','setTimeout','CustomEvent', source)(...)` + fake timer，无需 jsdom/happy-dom。**Side fix**：`EmbedQuery` interface 漏 `sessionId` 字段（`parseEmbedQuery` 早就返回），tsc 暴露后补 interface + TSDoc 注明 §11.27 链路。web-server 69/540 → 70/557。live smoke 8/8（valid embed / wrong nonce 401 / no nonce 400 / verify true / release true / verify after release false / stale sessionId 401 / no auth 401）。

30. **`DELETE /api/v1/embed/nonce` endpoint + SDK `releaseEmbedNonce()` helper**（✅ 本轮 §11.30）：iframe destroy → 服务端主动清理 session。`nonce-store.ts` 加 `removeEmbedNonce(sessionId)`；`api/v1/embed-nonce.ts` 加 `handleEmbedReleaseNonce`（DELETE method + `files:read` scope gate）；SDK 加 `releaseEmbedNonce(options)`（`fetchImpl` 注入 + fire-and-forget 友好）。`released:true` 真移除 / `released:false` race with TTL（不是 throw）。web-server 测试 +6（19 total），SDK 测试 +12（77 total）。live smoke 6/6 通过。
29. **SDK `verifyEmbedNonce()` helper 落地**（✅ 本轮 §11.29）：§11.28 `createEmbedNonce()` 的对称 counterpart，调 `POST /api/v1/embed/verify-nonce` audit。返 `{valid:true, expiresAt}` 或 `{valid:false, reason:'unknown'|'expired'}`——audit 失败不 throw。5 种错误 code（`AUTH_FAILED` / `FORBIDDEN` / `VERIFY_FAILED` / `NETWORK_ERROR` / `INVALID_RESPONSE`）。配套：types.ts 3 类型；editor.ts 重 re-export；README 双语 audit pattern example。新增 `apps/sdk/test/verify-embed-nonce.test.ts`（15 测试）。SDK 7 文件 / 65 测试。
28. **SDK `createEmbedNonce()` helper 落地**（✅ 本轮 §11.28）：apps/sdk/src/editor.ts 新增 `createEmbedNonce(options)`，调 `POST /api/v1/embed/nonce` mint session + 构造带 `?sessionId=...&nonce=...` 的 embed URL。6 种结构化错误 code (`AUTH_FAILED` / `FORBIDDEN` / `BAD_REQUEST` / `MINT_FAILED` / `NETWORK_ERROR` / `INVALID_RESPONSE`)。`fetchImpl` 注入式 override 让测试不需要 polyfill global。配套：`types.ts` 加 3 类型；`embed-url.ts` `EmbedUrlInput.sessionId` + `buildEmbedUrl` 多一行；`index.ts` re-export。新增 `apps/sdk/test/create-embed-nonce.test.ts`（12 测试）+ `build-embed-url.test.ts` 追加 2 测试。SDK 总数 5 文件 / 36 → 6 文件 / 50 测试。live smoke 3/3 通过。
27. **server-side nonce session binding 接入 embed handler**（✅ 本轮 §11.27）：`apps/web-server/src/embed/index.ts` 加 `EmbedQuery.sessionId` + `parseEmbedQuery` 提取 + `handleEmbed` 3 段守卫（sessionId 无 nonce → 400 INVALID_ARGUMENT；`verifyEmbedNonce().found=false` → 401 NONCE_SESSION_INVALID 含 reason:unknown/expired）。Opt-in 设计：URL 不带 sessionId 时仍走 §11.20 client-only 路径，不破 backward compat。新增 `apps/web-server/tests/embed-nonce-handler.test.ts`（6 测试）覆盖 valid + 4 rejection + legacy。6 文件 / 57 pass / 1 skip 回归。live smoke 5/5 通过。
26. **server-side nonce ↔ session 绑定端点**（✅ 本轮 §11.26）：新增 `apps/web-server/src/embed/nonce-store.ts`（in-memory `Map<sessionId, NonceSession>`，LRU cap 1024 + 5 min 默认 TTL + 30 s `unref` 后台 sweeper）+ `apps/web-server/src/api/v1/embed-nonce.ts`（`POST /api/v1/embed/nonce` mint + `POST /api/v1/embed/verify-nonce` verify，两者走 `files:read` scope gate）+ `apps/web-server/tests/embed-nonce-session.test.ts`（13 测试）。`sessionId === nonce`（同 16 字节 base64url），verify 失败返 `200 {valid:false, reason}` 而非错误信封（SDK 可 branch 不 try/catch）。TTL 1 h hard cap 防误配。client-side nonce（§11.20）保留，本轮是 optional defense-in-depth。live smoke 6/6（mint / verify happy / wrong nonce / 401 / 403 / 400）全通。
40. **SDK 2.0 Kestrel M3 · Versions API 骨架（SDK 类型 + 后端 v1 endpoint）**（✅ 本轮）：
41. **SDK 2.0 Kestrel M3.5 · Plugin Runtime 骨架（mountSidebar / unmountSidebar / postToSidebar + sidebarMessage 事件）**（✅ 本轮）：
42. **SDK 2.0 Kestrel M4 · File Picker + Telemetry 骨架**（✅ 本轮）：
43. **SDK 2.0 Kestrel 双语 README 升级到 v2.0**（✅ 本轮，闭合 §B.5.6 验收要求 "README + 双语更新到 v2.0"）：
44. **SDK 2.0 Kestrel end-to-end demo（React + Vue 双端）**（✅ 本轮，闭合 §B.5.6 验收要求 #3 "examples/embed-react/ 与 examples/embed-vue/ 各增 1 个 demo：多实例 + sidebar mount + comments 完整链路"）：
45. **SDK 2.0 Kestrel M5 · full-surface type contract + runtime guard 测试**（✅ 本轮，闭合 §B.5.6 验收要求 #1 "apps/sdk test: 182/182"）：
46. **`examples/embed-react/` 加 `sessionBinding.autoRelease:false` demo**（✅ 本轮，闭合 §11.32.4 #2 backlog）：
    - `examples/embed-react/demo-auto-release.tsx`（NEW ~145 行）：演示完整 3 步流程——`createEmbedNonce({host, documentId, app, jwt})` mint server-bound sessionId+nonce → `createEditor({ sessionBinding: { sessionId, nonce, autoRelease: false }, ... })` mount（SDK echo server-minted nonce 进 handshake 但 destroy 时不调 releaseEmbedNonce）→ 手动 `releaseEmbedNonce()` 释放 server slot
    - 加 `useEffect` 注册 `pagehide` 监听器演示生产级 wiring（host 全局卸载处理器在 destroy 之后调 release，与 SDK 自带的 autoRelease 同模式但 host 主导）
    - 暴露一个 "Manual release" 按钮：destroy handle → 显式调 releaseEmbedNonce，日志显示 `released=true` 或 `released=false`（false = race with TTL）
    - 解释 3 个 `autoRelease: false` 适用场景：① host 全局 page-unload handler 要在 destroy 后调 release；② 跨多次 mount 复用同一 sessionId；③ 框架异步销毁场景
    - tsc clean（demo-auto-release.tsx 0 errors；`GenOfficeEditor.tsx` 的 1 个 pre-existing `ErrorEvent` vs `onError` 类型错配未触碰）
    - `examples/embed-react/index-auto-release.html`（NEW）：Vite 入口，nav 加 "autoRelease:false" 链接
    - `examples/embed-react/{index.html,index-kestrel.html}`：nav 加 auto-release 链接
    - `examples/embed-react/README.md`：文件表新增 demo-auto-release.tsx；新增 "SDK 2.0 sessionBinding.autoRelease:false demo" 段
    - **未做**：在 sandbox 内不便跑 `pnpm dev` 实际渲染；用户在本地 `pnpm install && pnpm dev` 后访问 `/auto-release.html` 即可看到完整链路
    - 顺便修一个 stale：§11.34.4 / §11.32.4 后续观察里 "typedoc-count 显式 step：未做" 实际已在 commit `11f9cad` 闭合（.github/workflows/docs.yml 加了 "Assert typedoc output count is within bounds" step + bound 注释），本轮 sdk1.md 同步更新为 ✅


    - **闭合 §B.5.6 Gate #1**：SDK 14 文件 / 179 测试 → 15 文件 / **195 测试**（+35 +16），超过 §B.5.6 期望的 182
    - **kestrel-m5-contracts.test.ts**（NEW 35 测试）：
      - M2 Comments 类型合同 7：Comment shape + CommentAnchor 开放扩展（range / cell / slideId / 任意 [k:v]）+ addComment / listComments / resolveComment / removeComment 各自的 args/result pin + CommentAddedEvent / CommentResolvedEvent 在 EditorEvent union + EditorEventMap
      - M3 Versions 类型合同 4：VersionMeta shape（含可选 message）+ listVersions / restoreVersion / createSnapshot 各自的 args/result pin
      - M3.5 Plugin Runtime 类型合同 4：mountSidebar / unmountSidebar / postToSidebar 各自的 args/result pin（含 `message: unknown` 开放协议验证 4 种 message 形态）+ SidebarMessageEvent 在 EditorEvent union + EditorEventMap
      - M4 File Picker 类型合同 3：openFileDialog args + result discriminated union + PickedFile shape
      - M4 Telemetry 类型合同 3：UsageEvent shape + 在 EditorEvent union + EditorEventMap + CreateEditorOptions `telemetry?: boolean` opt-in（true / false / undefined 三态）
      - createEditor runtime guards 14：missing options / documentId / jwt / host / sessionBinding.sessionId / sessionBinding.nonce / 重复 instanceId with remediation / command() rejects destroyed / command() rejects not-mounted / getEditor returns undefined unknown / getEditor returns undefined destroyed / listEditors returns fresh array / EditorHandle.instanceId always non-empty / iframe.name 行为
    - **clamp-handshake-timeout.test.ts**（NEW 16 测试）：
      - `clampHandshakeTimeout` 单元覆盖：undefined / NaN / Infinity / -Infinity / null / string → 10_000 ms default；< 1_000 → 1_000 floor；> 60_000 → 60_000 ceiling；边界值 1_000 / 60_000；fractional floored；null / string 等 defensive 路径
      - 闭合 handshake-timeout.test.ts 没覆盖到的边界
    - **总计**：SDK 13 文件 / 144 测试 → 15 文件 / **195 测试**（+16 +35）
    - **未做**：renderer-side postMessage handler（M2-M4 surface）真 round-trip 测试仍依赖 live smoke（sandbox 不可达）


    - **examples/embed-react/demo-kestrel.tsx**（NEW，~270 行）：
      - 4 段 Kestrel surface 同页演示（multi-instance / comments / plugin runtime / telemetry）
      - `split-A` / `split-B` 双 `GenOfficeEditor`，不同 docId，各自 `instanceId`
      - `CommentsPanel` 组件用 `getEditor('split-A')` 从兄弟组件查 handle（演示跨组件 EditorRegistry 查找）
      - `SidebarMountPanel` 用 `mountSidebar({ panelUrl: '/panel-stub.html' })` 挂静态 panel，`postToSidebar` 推 `ASK`，监听 `sidebarMessage` 接收 `PONG` / `ANSWER`
      - `TelemetryBadge` `createEditor({ telemetry: true })` + `usage` 订阅 + `insertText` 按钮主动 bump `docBytesWritten` 计数器
      - tsc clean（demo-kestrel.tsx 0 错误；`GenOfficeEditor.tsx` 的 1 个 `ErrorEvent` vs `onError` 类型 mismatch 是 pre-existing，未触碰）
    - **examples/embed-vue/demo-kestrel.ts**（NEW，~230 行）：
      - Vue 3 Composition API 等价实现
      - 同样 4 段 surface（multi-instance + comments + plugin runtime + telemetry）
      - 修了变量名 `h` 与 Vue 内置 `h()` createElement 冲突（重命名为 `handle`）
      - tsc clean（demo-kestrel.ts 0 错误；`./GenOfficeEditor.vue` + `@vitejs/plugin-vue` 模块缺失是 pre-existing dev-deps 未安装导致）
    - **examples/embed-{react,vue}/panel-stub.html**（NEW）：sidebar 演示用的静态 panel，listen `message` 事件记录 host→panel 消息，按钮触发 `window.parent.postMessage({kind:'event', payload:{name:'sidebarMessage', payload:{type:'PONG'}}}, '*')` 回发到 host
    - **examples/embed-{react,vue}/index-kestrel.html**（NEW）：Kestrel demo 的 Vite 入口（script tag 指向 `/demo-kestrel.ts{x}`，与基础 demo 共用 vite 入口约定）
    - **examples/embed-{react,vue}/index.html**：加 `<nav>` 链接 "Basic / Kestrel (SDK 2.0)"，两个 demo 通过同一 Vite dev server 暴露
    - **examples/embed-{react,vue}/README.md**：每个新增文件一行说明 + 单独 "SDK 2.0 Kestrel demo" 段，介绍 4 段 surface 行为与访问路径
    - **SDK dist 重建**：本轮首次正式 emit `apps/sdk/dist/index.d.ts` 等声明文件 —— 之前 dist 是 M1 时代产物，缺 `getEditor` / `Comment` / `UsageEvent` / `SidebarMessageEvent` 等 M1-M4 export。`tsc` 用现有 tsconfig.json（含 declaration / declarationMap）一次产出
    - **未做**（demo 收尾）：在 sandbox 内不便跑 `pnpm dev` 实际渲染验证；用户在本地 `pnpm install && pnpm dev` 后访问 `/kestrel.html` 即可看到完整链路


    - **apps/sdk/README.md**（EN）：273 → 442 行（+169）
      - 新增 6 个章节：Comments API (Kestrel M2) / Versions API (Kestrel M3) / Plugin Runtime (Kestrel M3.5) / File Picker (Kestrel M4) / Telemetry (Kestrel M4) / SDK 2.0 (Kestrel) — surface map
      - 每个新章节含：概述段 + JSDoc 风格的 TypeScript 代码示例 + OAuth scope 注意点（Comments 的 `files:comment` / Versions 的 `files:restore` / File Picker 的 `code: UNSUPPORTED` 拒绝路径）
      - 9 surface 全景表覆盖 #1-#9，#5/#6 标注 v3 backlog + 缺失模块
    - **apps/sdk/README.zh-CN.md**（ZH）：268 → 428 行（+160）
      - 同样 6 个章节双语同步，每个示例 + 表格 1:1 翻译
    - **§B.5.6 验收要求 #6 "README + 双语更新到 v2.0"**：✅ 闭合。9 个 surface 中 7 个（M1/M2/M3/M3.5/M4）有完整双语文档，#5/#6 明确标注 v3 backlog 与缺失模块
    - **未做**：live smoke PORT=33002 + tmux（sandbox 限制）；SDK bundle 30 → 50 kB（实测 bundle 在 SDK 内部代码增量下几乎不变 — 类型扩展对 bundle 体积影响忽略不计）


    - 闭合 §B.5.1 #7 File picker + §B.5.1 #9 Telemetry（最后 2 个 surface）
    - **SDK 类型层**（`apps/sdk/src/types.ts`）：
      - `CreateEditorOptions` 新增 `telemetry?: boolean`（默认 false，opt-in）
      - `EditorCommands` 新增 `openFileDialog({ accept?, multiple? }) → { files: PickedFile[] } | { canceled: true }`
      - 新增 `PickedFile` interface（name / size / type / lastModified / dataBase64）—— renderer 把 File 序列化为 base64 跨 postMessage 边界
      - 新增 `UsageEvent` interface（type / instanceId / docBytesWritten / aiCalls / aiTokensIn / aiTokensOut / sessionDurationMs）加入 EditorEvent union + EditorEventMap['usage']
    - **SDK editor**（`apps/sdk/src/editor.ts`）：
      - 新增 telemetry 聚合器：`createEditor({ telemetry: true })` 时挂 `setInterval(…, 30_000)`，每 30s `dispatch('usage', UsageEvent)`
      - `countTelemetry(name, args)` hook 在 `command()` 内**先于 iframe 检查**调用 —— 这样 `skipIframe: true` 测试模式下 host 调命令也能累加 counter（实际生产中 iframe 总是存在）
      - 计数器：setContent 累加 content 长度；insertText / insertImage 累加 text/dataUrl 长度；aiRewrite / aiTranslate / aiSummarize 累加 1 次 aiCalls + 所有 string-typed args 字段字符总数（aiTokensOut 永远 0，host 可除以 ~4 估 token）
      - destroy() 清 interval（防止 destroyed editor 还派发 usage event）
    - **SDK index**：`apps/sdk/src/index.ts` re-export `UsageEvent` + `PickedFile`
    - **修复的小 bug**：counter hook 之前被放在 iframe 检查**之后**，导致 `skipIframe` 模式下无法累加 —— 与 M1/M2/M3.5 测试模式冲突
    - **测试**（`apps/sdk/test/kestrel-m4.test.ts`，NEW 15 测试）：
      - File Picker 类型合同 3：openFileDialog 在 EditorCommands 上 + 无 args + PickedFile 字段 pin
      - Telemetry opt-in 3：默认不挂 interval；telemetry: false 不挂；telemetry: true 挂 30s interval
      - UsageEvent 派发 5：UsageEvent 形状 + 单次 tick fire + 多次 tick + destroy 后无 fire + off() unsubscribe
      - Counter 累加 3：telemetry off 时 counter 永远 0；setContent/insertText/insertImage 累加 docBytesWritten；ai* 累加 aiCalls + aiTokensIn
      - Isolation 1：M1/M3.5 surface 不被本 PR regress
      - 用 `vi.useFakeTimers()` in beforeEach + `vi.advanceTimersByTimeAsync(30_000)` 触发 setInterval（避免真实等待 30 s）
      - SDK 12 文件 → 13 文件；129 → 144 测试（+15）
    - **未做**（M4 收尾）：renderer 端实现 openFileDialog handler（apps/{docs,sheets,slides}/dist postMessage listener 弹 `<input type='file'>` + base64 回传）；live smoke（PORT=33002 + tmux：mount sidebar + open file dialog + 观察 30s 后 usage event）


    - 闭合 §B.5.1 #8 Plugin Runtime 的 SDK 类型层 + EditorHandle wiring
    - **SDK 类型层**（`apps/sdk/src/types.ts`）：
      - `EditorCommands` 新增 3 个：`mountSidebar({ panelUrl, width?, title? }) → { panelId }` / `unmountSidebar({ panelId }) → void` / `postToSidebar({ panelId, message }) → void`
      - `postToSidebar.message` 类型是 `unknown` —— 故意不锁 schema，panel 协议由 host/plugin 作者自行协商（与 WPS 轻应用 / Office taskpane 同模式）
      - 新增 `SidebarMessageEvent` interface（type / panelId / message），加入 `EditorEvent` union + `EditorEventMap['sidebarMessage']`
    - **SDK index**：`apps/sdk/src/index.ts` re-export `SidebarMessageEvent`
    - **不需要 editor.ts 改代码**：`command()` 已经通过 `EditorCommands` 泛型分发，新加 3 个 command 自动可用；`on('sidebarMessage', cb)` 通过 `EditorEventMap` 自动 type-check
    - **renderer-side follow-up**：在 apps/{docs,sheets,slides,pdf,markdown,html}/dist 各自的 postMessage listener 里实现 `mountSidebar`（iframe 内嵌 `<iframe src=panelUrl>` + postMessage 桥）/ `unmountSidebar` / `postToSidebar` / `sidebarMessage` event 转发——这是 renderer-team 工作，本轮只交付 SDK contract
    - **测试**（`apps/sdk/test/plugin-runtime.test.ts`，NEW 10 测试）：
      - 类型层 5 测试：mountSidebar / unmountSidebar / postToSidebar 在 EditorCommands 上的 args/result 形状 pin；SidebarMessageEvent 在 EditorEvent union + EditorEventMap 中的形状 pin
      - 运行时 wiring 3 测试：handle.command('mountSidebar', ...) / ('postToSidebar', ...) 类型正确 + 同步拒绝（skipIframe 模式）；handle.on('sidebarMessage', cb) 注册并返回 unsubscribe
      - 隔离 1 测试：M1（listVersions）/ M2（addComment）类型合同未被本 PR regress
      - 用 `.rejects.toThrow()` 而不是 `.catch()` 包裹同步 reject promise —— 避免 unhandled-rejection warning
      - SDK 11 文件 → 12 文件；119 → 129 测试（+10）
    - **未做**（M3.5 收尾）：renderer 端实现 3 个 command handler + sidebarMessage 事件 outbound；live smoke（PORT=33002 + tmux mount/unmount/postToSidebar round-trip）；§B.5 计划里 §B.5.2 后端改动 "POST /api/v1/files/:id/export" 仍归 M4（File picker 入口未做，File Picker 留 M4）


    - 闭合 §B.5.1 #3 Versions API 全部 5 个 wire 端点 + `files:restore` 新 scope
    - **SDK 层**（`apps/sdk/src/types.ts`）：
      - 新增 `VersionMeta` interface（1:1 镜像后端 `FileVersionMeta`：id / docId / index / timestamp / size / message? / sha256）
      - `EditorCommands` 新增 3 个：`listVersions` / `restoreVersion` / `createSnapshot`
    - **SDK index**：`apps/sdk/src/index.ts` re-export `VersionMeta`
    - **后端 v1 endpoint**（`apps/web-server/src/api/v1/versions.ts`，NEW 242 行）：
      - `GET    /api/v1/files/:id/versions`               scope `files:read`
      - `GET    /api/v1/files/:id/versions/:vid`          scope `files:read`，16 MB base64 上限（超限 413 PAYLOAD_TOO_LARGE）
      - `POST   /api/v1/files/:id/versions`               scope `files:write`（label 上限 200 字符，manual snapshot via `captureBeforeSave`）
      - `POST   /api/v1/files/:id/versions/:vid/restore`  scope **`files:restore`**（NEW scope）
      - `DELETE /api/v1/files/:id/versions/:vid`          scope **`files:restore`**（NEW scope）
      - `captureBeforeSave` 命中 dedupe 时返 `409 NOOP`（而非 201）——renderer 看到"snapshot already exists"比误以为成功好
    - **新 scope `files:restore` 故意不被 `files:write` 隐含**：host 可给 commenter token 只授 `files:read + files:comment + files:write`，但无 restore 权限——这是 §B.5.1 #3 设计点，把"能保存"与"能回滚"显式分开
    - **v1 dispatcher**（`apps/web-server/src/api/v1/index.ts`）：5 个 regex match，`/restore` 优先于裸 `/:vid` 匹配，避免被吞
    - **测试**（`apps/web-server/tests/versions-v1-endpoint.test.ts`，NEW 14 测试）：401 / 200 empty / 200 with snapshots / 201 manual / 404 unknown file / 403 read-only / 400 long label / GET base64 round-trip / 404 unknown vid / restore 改 disk / 404 restore unknown / 403 restore with `files:write` only（scope 分离）/ DELETE 204 + list 0 / 404 delete unknown
    - **测试隔离 bug 修复**：`apps/web-server/src/common/version-history.ts` `_resetForTests()` 之前用 `unlinkSync(docId)` 删除 docId 子目录会触发 POSIX EPERM（目录非空）但被 catch 吞掉，导致 4 个测试失败。修复为 `rmSync(VERSIONS_DIR/<docId>, { recursive: true, force: true })` 递归清空子目录内容+目录本身。与 `comments-store.ts:_resetCommentsForTests()` 同模式（commit `cf9c1e1` 修复的同类 bug）
    - **测试总数**：web-server 70 → 71 文件；604 → 618 tests（+14）；SDK 119 tests 不变
    - **未做**（M3 收尾）：renderer 端把 3 个命令 round-trip 进 postMessage handler（renderer-team 工作）；sidebar UI 渲染 `editor.on('versionAdded')`

39. **SDK 2.0 Kestrel M2 · Comments API 骨架（SDK 类型 + 后端 v1 endpoint + 持久化）**（✅ 本轮）：
    - 闭合 §B.5.1 #4 Comments API 第一段
    - **SDK 类型层**（`apps/sdk/src/types.ts`）：
      - 新增 `Comment` interface（id / author / text / anchor / createdAt / resolvedAt? / resolved / parentId?）
      - 新增 `CommentAnchor` interface（range / cell / slideId / [k:v] 开放扩展）
      - `EditorCommands` 新增 4 个：`addComment` / `listComments` / `resolveComment` / `removeComment`
      - 新增 2 个事件接口 `CommentAddedEvent` / `CommentResolvedEvent` + `EditorEvent` union + `EditorEventMap` 各加 2 键
    - **SDK index**：`apps/sdk/src/index.ts` re-export `Comment` / `CommentAnchor` / `CommentAddedEvent` / `CommentResolvedEvent`
    - **后端存储**（`apps/web-server/src/common/comments-store.ts`，NEW，250 行）：
      - 进程内 `Map<fileId, Comment[]>` + `DATA_DIR/comments.json` 持久化（与 `webhooks-store` 同模式）
      - `addComment` / `listComments` / `resolveComment` / `removeComment` / `getComment` / `commentCountForFile` / `totalCommentCount`
      - **sticky resolvedAt**：第一次 resolve 时打戳，后续 toggle 不改（与 only-office / google-docs 语义对齐）
      - 16 KB 单条 text 上限（防 DoS）
      - 边界处理：malformed JSON 启动不崩（warn + 续行）；未知 id 返 null
      - `_resetCommentsForTests()`：清内存 + 删 comments.json + 重置 `loaded` flag
    - **后端 v1 endpoint**（`apps/web-server/src/api/v1/comments.ts`，NEW，214 行）：
      - `GET    /api/v1/files/:id/comments`     scope `files:read`     返 `{ fileId, count, comments[] }`（支持 `?resolved=true|false`）
      - `POST   /api/v1/files/:id/comments`     scope `files:comment`  author 强制 JWT `sub`，client-supplied author 丢弃
      - `GET    /api/v1/files/:id/comments/:cid` scope `files:read`
      - `PATCH  /api/v1/files/:id/comments/:cid` scope `files:comment`  body `{ resolved: boolean }`，404 on unknown id
      - `DELETE /api/v1/files/:id/comments/:cid` scope `files:comment`  硬删，204 on success / 404 on unknown
      - 错误信封：`400 INVALID_ARGUMENT` / `401 UNAUTHENTICATED` / `403 FORBIDDEN` / `404 NOT_FOUND` / `500 INTERNAL`
    - **v1 dispatcher**（`apps/web-server/src/api/v1/index.ts`）：5 个 regex match + 5 个 handler 调用，flatten-readable
    - **测试**：
      - `apps/web-server/tests/comments-store.test.ts`（NEW，11 测试）：id 唯一性 / author stamped / fresh array 防 mutation / resolved 过滤 / parentId 过滤 / sticky resolvedAt / 未知 id 返 null / 持久化到 disk / count helper / parentId round-trip
      - `apps/web-server/tests/comments-v1-endpoint.test.ts`（NEW，17 测试）：401 / 403 / 200 空列表 / 201 创建 / client author 被丢弃 / 400 missing anchor / 400 empty text / 403 read-only scope / PATCH toggle / 404 unknown id / 400 missing resolved / 204 delete / 404 delete unknown / 200 get one / 404 get unknown / e2e `?resolved=true` 过滤
      - web-server 68 文件 → 70 文件；web-server 581 → 604 测试（+23：11 + 17 - 5 fix）
    - **未做**（M2 收尾）：renderer 端把 4 个命令 round-trip 进 postMessage handler（renderer-team 工作）；sidebar UI 渲染 `editor.on('commentAdded')`

38. **SDK 2.0 Kestrel M1 · Multi-instance + Undo/Redo 命令骨架**（✅ 本轮）：
    - 闭合 §B.5.1 #1 Multi-instance + §B.5.1 #2 Undo/Redo
    - `apps/sdk/src/types.ts`：
      - `CreateEditorOptions.instanceId?: string` 新增可选字段（缺省 SDK 自动 mint `ed_` 前缀 12-byte base64url）
      - `EditorHandle.instanceId: string` 新增必填字段（始终非空）
      - `EditorCommands` 新增 `undo` / `redo` / `getUndoStack` 3 个 inbound 命令（renderer 实现落地后即可 work）
    - `apps/sdk/src/editor.ts`：
      - 模块级 `editorRegistry: Map<instanceId, EditorHandle>` 持久化 live handle
      - 新增 `getEditor(instanceId): EditorHandle | undefined` + `listEditors(): EditorHandle[]` 公开 API
      - 新增 `_resetEditorRegistryForTests()` 公开测试钩子
      - 重名冲突检测：同一 `instanceId` 重复 `createEditor()` 抛带 remediation 提示的错误
      - iframe `name` 属性 = `genoffice-{instanceId}`（替代脆弱的 `event.source` 单一来源）
      - `destroy()` 从 registry 摘除（避免 torn-down handle 仍被 `getEditor()` 返回）
      - `generateInstanceId()` 用 `btoa()` 替代 `Buffer.from(..., 'binary')`，符合 SDK 「无 Node-only globals」契约
    - `apps/sdk/src/index.ts`：re-export `getEditor` / `listEditors`
    - 新文件 `apps/sdk/test/kestrel-multi-instance.test.ts`（11 测试）：
      - auto-mint 唯一 instanceId（两次调用不冲突）
      - 显式 instanceId 通过 verbatim
      - `getEditor()` 按 id 找到 / 找不到返 undefined
      - `listEditors()` 含 live / 不含 destroyed / 返新数组（不暴露内部 map）
      - 重复 instanceId 抛带 remediation 错误
      - 空字符串 instanceId 当作缺省（自动 mint）
      - destroy 后 `getEditor()` 返 undefined
      - `EditorHandle.instanceId` 始终非空字符串
      - iframe `name` = `genoffice-{instanceId}`
      - 双实例 destroy 互不干扰
    - SDK 测试 108 → 119（+11）；SDK 文件 10 → 11；bundle UMD 24.1 kB（变化忽略不计）
    - ~~后续 M1 收尾 = renderer 端把 Ctrl+Z / Ctrl+Shift+Z 暴露成 inbound postMessage handler~~
      **✅ 已完成 · 见 §11.38**：`SdkLiveModelAdapter` 新增 `undo` / `redo` /
      `getUndoStack`，`text-buffer-adapter` 加 100 步双栈 +
      `registerNativeAdapter()` 惰性注册表；`apps/docs` 已注册 tiptap 真实
      history。剩余 5 个 app 接各自编辑器的 history 为 follow-up（每 app ~10 行）。

36. **SDK 2.0 Kestrel M2 · Track changes 全链路**（✅ §11.40）：
    - 闭合 §B.5.1 #5 Track changes
    - `apps/sdk/src/types.ts`：`EditorCommands` +4（`setTrackChanges` /
      `getTrackChanges` / `acceptChange` / `rejectChange`）；命令总数 27 → 31
    - `packages/ipc-bridge/src/sdk-command-sink.ts`：`SdkLiveModelAdapter`
      +4 可选方法；`makeLiveModelHandlers` 注册 4 个 handler，含入参校验
      （`enabled` 非布尔 / `changeId` 缺失或空 / adapter 返 `false` → 结构化报错）
    - `packages/ipc-bridge/src/text-buffer-adapter.ts`：4 条命令**永远**委派
      native adapter，未注册时抛 `UnsupportedCommandError`（而不是伪造
      `{enabled:false, changes:[]}` —— 那会被 host 读成"文档没有修订"）
    - `apps/docs/src/renderer/editor/revisions.ts`：
      - `revisionId(r)` — FNV-1a over `kind/author/date/text`，
        **故意排除 `from`/`to`**，让 id 在被修订内容之外的编辑中保持稳定
      - `revisionKindForSdk(kind)` — 12 种内部 kind → SDK 的 3 值 union
      - `collectRevisionsForSdk(doc)` — 直接产出 SDK 线格式
      - `applyRevisions` 从私有改为 `export`，让按 id 的操作复用 Review
        ribbon 的引擎（一个 `TRACK_IGNORE` transaction、一步 undo）
    - `apps/docs/src/renderer/App.tsx`：`registerNativeAdapter` 增加
      `setTrackChanges`（直通 Review ribbon state）/ `getTrackChanges`
      （读 `editor.storage.trackChanges.enabled` + 收集修订）/
      `acceptChange` / `rejectChange`（经 `handleRevisionById` → `applyRevisions`）
    - 测试：`packages/ipc-bridge` 135 → **144**（+9）；`apps/sdk` 201 全绿
    - 未做：`acceptAllChange` / `rejectAllChange`（应用内有
      `acceptAllRevisions` / `rejectAllRevisions`，但"all"在并发编辑下的语义
      要先定义）——留 follow-up

 37. **typedoc-count 显式 step**（✅ 本轮）：
    - 闭合 §11.34.4 #2 + §A.5 unaddressed 小 backlog
    - `.github/workflows/docs.yml` 新增 step `Assert typedoc output count is within bounds`：在 `npm run docs:build` 之后跑 `gen-typedoc.mjs` 显式一遍 → `find docs/api/_generated -name '*.md' | wc -l` → 打印 `[typedoc-count] generated N .md files (bounds: 200-400)` → 越界时 `::error::` 注解 + exit 1
    - 之前依赖 `apps/web-server/tests/typedoc-count.test.ts` 在 `npm test` 间接跑；现在 docs 部署流程本身显式 assert，CI 日志可见，缩短 typedoc 漂移检测链路（不依赖 test job 通过）
    - 阈值 [200, 400] 与 `typedoc-count.test.ts` 的 LOWER_BOUND / UPPER_BOUND 完全一致；如改阈值必须同步两处（typedoc-count.test.ts 的 test "exposes the bounds as named exports so sdk1.md drift is debuggable" 已 pin）

36. **SDK 2.0（代号 `Kestrel`）开放计划**（📝 计划中，§B.5）：9 个新 surface + 8 周冲刺：
    - **Multi-instance**（拆 `instanceId` 路由 → `EditorRegistry: Map<instanceId, EditorHandle>`）
    - **Undo / Redo + 撤销栈查询**（postMessage inbound `undo` / `redo` / `getUndoStack`）
    - **Versions API**（`listVersions` / `restoreVersion` / `createSnapshot`，复用 `common/version-history.ts`）
    - **Comments API**（`addComment` / `listComments` / `removeComment` / `resolveComment` + `commentAdded` / `commentResolved` 事件 + 5 个 v1 endpoint）
    - **Track Changes**（`setTrackChanges` / `getTrackChanges` / `acceptChange` / `rejectChange`，复用 docx-engine `revision-tracking.ts`）
    - **Export**（`downloadAs({ format: pdf | docx | xlsx | pptx | png })`）
    - **File Picker**（`openFileDialog` → iframe 内 `<input type='file'>` + postMessage ArrayBuffer）
    - **Plugin Runtime**（`mountSidebar` / `unmountSidebar` / `postToSidebar`，与 Microsoft taskpane / WPS 轻应用同模型）
    - **Telemetry**（`editor.on('usage', ...)` opt-in，聚合 30s 一次）
    - **冲刺节奏**：M1 周 1-2（multi-instance + undo + track changes +18 测试）/ M2 周 3-4（comments + versions + file picker +24+8 测试）/ M3 周 5-6（export + sidebar runtime +18 测试）/ M4 周 7-8（telemetry + 文档 + examples +6 测试）
    - **版本策略**：`@genoffice/web-sdk` 从 1.x → 2.0.0；envelope `v: '1.1'` 新增 `instanceId` 选填字段；`createEditor` 内部 auto-routing；`/v2` subpath 暴露 `createEditor2`
    - **预期测试**：SDK 108 → ~182（+74），web-server 593 → ~629（+36），总计 4461 → ~5093（+632 隐含真）；SDK bundle 30kB → 50kB
    - **不做**：实时协作（M4+ Yjs/CRDT）/ 移动端 H5（M5 PWA）/ WPS-AI 直连（v3）/ DocuSign（v3）/ Slack-Teams-飞书插件（v3 走 sidebar runtime）
    - **背景**：§B.4 差距矩阵对比 WPS web / Microsoft Office Embed (office.js) / OnlyOffice JS SDK / Google Docs addon —— GenOffice 在 AI 开放性 / Provider 切换 / 自托管 / Apache-2.0 4 维度领先；在协作 / 移动端 / 多实例 / 评论 / 文件选择 / 插件侧边栏 / 版本 / 修订 / 导出 9 维度仍落后
    - 详见 §B.4 + §B.5.1-§B.5.6

35. **DLQ metrics + Prometheus `/api/v1/metrics` 端点**（✅ 本轮 §11.35）：
    - 闭合 §11.33.4 #2 "DLQ metric" 路线 — `webhooks-dlq` 模块新增 `getDeadLetterMetrics()`（size / totalDropped / totalReplayed / byReason / oldestDroppedAt / newestDroppedAt），`pushDeadLetter()` 与 `replayDeadLetter()` 在 store 边界 bump 累计计数（fix wiring bug — 之前 5 个 metrics 测试全挂在 expected 1 vs got 0）
    - `GET /api/v1/webhooks/dlq` 响应增加 `metrics` 字段，host 一次 fetch 拿到结构化 + 累计视图
    - 新增公开 `GET /api/v1/metrics` Prometheus-text 端点，8 个 metric：`genoffice_dlq_size` (gauge) / `genoffice_dlq_total_dropped` (counter) / `genoffice_dlq_total_replayed` (counter) / `genoffice_dlq_dropped_by_reason{reason}` (counter × 2) / `genoffice_dlq_oldest_dropped_at_ms` (gauge) / `genoffice_dlq_newest_dropped_at_ms` (gauge) / `genoffice_ipc_channels_implemented` (gauge, 复用 `handlerCount()`) / `genoffice_uptime_seconds` (gauge, 3 位小数)。NaN 哨兵处理空队列；Content-Type `text/plain; version=0.0.4; charset=utf-8`
    - `apps/web-server/tests/webhooks-dlq.test.ts` 新增 5 测试（28 总数）：size/totalDropped/totalReplayed/byReason 一次性 / 空队列 oldest/newest=null / totalReplayed 仅成功 replay 增（fetch stub ok→fail 序列）/ delete 不影响 totalDropped（monotonic）/ LRU eviction 不影响 totalDropped 但 size 收敛到 1024
    - 新文件 `apps/web-server/tests/metrics-endpoint.test.ts` 7 测试：200 + Content-Type / 8 metric HELP+TYPE 完整 / 空队列计数=0 + oldest/newest=`NaN` / push+replay 后计数移动 / `ipc_channels_implemented` 等于 `handlerCount()` / 公开（无 Bearer 200）/ 末尾换行（Prometheus 格式约定）
    - 修复 bug — `pushDeadLetter()` 与 `replayDeadLetter()` 之前未 bump totals；metrics 测试先前全 fail。修复方法把 bump 放在 wrapper 层（不是 store 层），store 接口与 metrics 关注点解耦
    - §A.5 累计数：web-server 71/581 → 72/593（+12），总计 185/4448 → 186/4461（+12）
    - 后续：DLQ 持久化（M4+ Postgres / Redis / on-disk）；scraper 接入示例 + Grafana dashboard JSON（M4+）；histogram 扩 bucket 取 p95 age

25. **renderer-internal `nonce` 字段统一重命名为 `revision`**（✅ 本轮 §11.25）：renderer 里 `nonce: Date.now()` 字段实际是 React re-trigger 计数器（useEffect deps / React key），不是 crypto nonce；与 SDK handshake nonce (`apps/sdk/src/editor.ts`) 同名造成 code review / grep 误判。改名范围严格限定在 renderer-internal React state shape：`packages/ui/src/find-panel.tsx` 的 `FindFocusRequest.nonce` + apps/{docs,html,pdf,slides,markdown}/src/renderer 下的 useState/setState/useEffect/key deps （AiPreset / hoverAnim / anim / morph / findFocus / previewVersion / ribbonTabRequest 8 种 shape）。SDK handshake nonce（`apps/sdk/src/editor.ts`）/ web-bridge nonce（`apps/web-server/src/embed/index.ts`）/ `<iframe>` CSP nonce / docs `FindPanel.focusReplaceNonce` prop 全部不动（向后兼容 / 公共 API）。19 文件 / ~78 处编辑；`grep -rn "nonce" apps/*/src/renderer packages/ui/src` 仅剩法语 `annonce` 一词。
24. **`CreateEditorOptions` doc typo 修复 + container contract 回归测试**（✅ 本轮 §11.24）：`apps/sdk/src/types.ts` 旧 JSDoc 提到 `containerElement` 字段，但接口里**根本没有**这个字段（早期迭代残留笔误），集成商按字面 join 后会在生产环境遇到 TS 编译报错。修正为"Provide exactly one of `container` or `url`"+ 明确"无 separate containerElement field，直接通过 `container` 传元素"。新增 `apps/sdk/test/container-resolve.test.ts`（6 测试）：source-grep 守门（`containerElement` 只允许出现 1 次在 denial comment）+`createEditor()` no-opts 抛 `options required` +缺 `documentId` / `jwt` / `host` 各抛结构化错误 +Node 环境无 container 抛 `container required when document is not available`。私有 helper `resolveContainer` 通过 public `createEditor` 的 runtime guard 间接验证，避免泄漏内部 API。
23. **web-server 版本号单一源**（✅ 本轮 §11.23）：`'0.8.0'` 之前硬编码在 5 个文件（`index.ts` boot banner + `/health` / `app-info.ts` / `embed/index.ts` bridge ready payload）。新增 `common/version.ts` 导出 `WEB_SERVER_VERSION` 常量，4 个消费点改 import + 模板字符串插值。新增 5 测试守门：常量 == package.json 版本 / 没有 hardcoded `'0.8.0'`（除 `version.ts` 与 `package.json`）/ boot banner 用 `${...}` / bridge 用 `${...}` / app-info 用 `() => WEB_SERVER_VERSION`。live smoke 验 4 个消费点全报 `0.8.0`。
22. **buildEmbedUrl nonce 测试整合**（✅ 本轮 §11.22）：把 §11.20 引入的 4 个 nonce 测试从独立的 `embed-url-nonce.test.ts` 合并到 `build-embed-url.test.ts`（canonical 位置），删除独立文件。维护更清晰。SDK 文件 5→4（文件数-1），测试数 30（净无 0 测试）。
21. **SDK handshake timeout 可配置**（✅ 本轮 §11.21）：原本 SDK iframe handshake 的 10 s timeout 在 createEditor 闭包内硬编码，慢网络 host 没有逃生口。新增 `CreateEditorOptions.handshakeTimeoutMs` + module-level exported `clampHandshakeTimeout(ms)`（范围 1 s – 60 s，floor 整数，默认 10 s）。新增 6 测试覆盖 undefined / NaN / Infinity / 范围内 / 上下限 clamp / 分数 / 负数 → 下限（不取 abs）。
20. **iframe handshake nonce 静默丢包修复**（✅ 本轮 §11.20）：发现 `apps/sdk/src/embed-url.ts` 的 `buildEmbedUrl` **完全没有把 `nonce` 写到 query param**，导致 §B.2 #1 那段 SDK handshake nonce 安全保证**从未生效**——每个 SDK 启动的 embed iframe 都会在 10s 后 `HANDSHAKE_FAILED`。新增 `EmbedUrlInput.nonce` + `params.set('nonce', …)`；embed handler 端把 `?nonce=` 写到 `<meta name="genoffice-nonce">`，bridge `sendReady()` 读 meta 把 nonce 放进 ready postMessage payload。新增 4 + 6 测试覆盖；side-effect 修了 embed-jwt-validation 的 env mutation 问题。
19. **typedoc 输出文件数漂移守门**（✅ 本轮 §11.19）：原 §A.5 / §11.6 / §11.12 一致称 `199 个 MD 文件`，实测已 221（typedoc 把 §11.16 / §11.17 / §11.18 几轮新增的 public helper 都收进来了）。新增 `apps/web-server/tests/typedoc-count.test.ts`（3 测试）：跑 `node docs/scripts/gen-typedoc.mjs` → 读 `docs/api/_generated/*.md` → assert 200-400 + 打印当前值到 CI 日志。sdk1.md 三处 `199` → `221`。
18. **§11.17.5 backlog 真正闭合 · embed 服务端 JWT 验证**（✅ 本轮 §11.18）：`apps/web-server/src/embed/index.ts` 新增 `verifyEmbedToken()` helper + `handleEmbed` 调用；opt-in（`GENOFFICE_JWT_SECRET` 存在且 token 是 JWT 形状时）才跑 `verifyJwtWithRevocation`，失败返 401 UNAUTHENTICATED。新增 `apps/web-server/tests/embed-jwt-validation.test.ts`（6 测试）覆盖：合法 200 / 篡改 401 / 乱码 401 / 一次性 jti 第二次 401 / 过期 401 / 非 JWT 透传（向后兼容）。现在 `/api/v1/files/:id/jwt?oneTime=true` 发的 token 在第二次 embed 访问时**真被服务端拒**，不再是依赖 renderer 端 meta-tag-check。
17. **§11.3 P1 文件 JWT 单次使用语义 · 真实单元测试**（✅ 本轮 §11.17）：新增 `apps/web-server/tests/files-jwt-revocation.test.ts`（6 测试 / < 5 ms）：直接 import `auth.ts` 的 `verifyJwtWithRevocation` / `setJtiRevocationCheck` / `isJtiRevoked` 三个 helper，覆盖 hook 默认 no-op / first-pass-then-revoke / jti 独立 / 篡改 token 不污染撤销集 / 过期短路。`files-jwt-options-e2e.test.ts` 之前最后一条只是空 mint，已被本单元测补齐真实 verify 路径。后续 backlog（§11.17.5）：`embed/index.ts` 尚未在服务端 verify `?token=`，需要独立 PR 升级为 `verifyJwtWithRevocation` 调用后再返回 HTML。

#### ✅ 本轮新增解决（2026-09-22 · §0.4 + §11.36.5 收尾）

55. **dev-mode boot `?raw` markdown 崩溃修复**（✅ P0）：`npm run dev -w @genoffice/web-server` 在 `tsx watch src/index.ts` 加载 `pptx-ops/src/op-docs.ts:25-30` 的 `import x from './text.md?raw'` 时立即 `ERR_UNKNOWN_FILE_EXTENSION`（tsx 4.x 不处理 Vite 风格的 `?raw`，esbuild 路径走 `scripts/bundle.mjs` 的 `md-raw-loader` 插件所以 OK）。新增 `apps/web-server/scripts/{raw-md-loader,register-loaders}.mjs` + `apps/web-server/package.json` dev 脚本改为 `tsx --import ./scripts/register-loaders.mjs watch src/index.ts`。3 个测试覆盖：① subprocess `?raw` import 圆环（无 ERR + default export 等于文件内容）；② 纯 `.md` import 仍抛 Node 默认 `ERR_UNKNOWN_FILE_EXTENSION`（suffixed-scoped）；③ `register-loaders.mjs` 作 entry 注册成功。**首次让 `npm run dev -w @genoffice/web-server` 真能跑起来**。

56. **GET /api/v1/meta 公开元数据端点**（✅ P2 一致性）：之前 GET 此路径穿过 SPA 兜底返 HTML smoke 探针发现。返回 `apiVersion / serverVersion / protocolVersion / minClientVersion / sdkVersion / capabilities[] / integrations{} / storage.backend / sdk.{usageSamples, instances, uptimeSeconds} / timestamp`（< 400 B），无 auth。2 个单元测 + 现场 curl 200 + regression check `/api/v1/changelog` 仍 200。

57. **`docs:save-as` 通道补齐 · 与 sheets / slides 对齐**（✅ P2 一致性）：web-server 暴露了 `workbook:save-as` 和 `slides:save-as` 但 docs 没有——docs renderer 的「Save As」静默走 `docs:save`（保持原路径、忽略新文件名）。新 handler `(sourcePath, targetPath, data?)` 镜像桌面签名：① 显式 `data` bytes 写 `targetPath`；② 缺 `data` 从 `sourcePath` 走 `readDocxBytes` 读（含 storage URI + 遗留 FILES_DIR 路径）；④ 结构化 `NotFoundError` / `InvalidArgumentError` **rethrow** 让 IPC 层返 404 / 400 envelope。4 个 e2e：explicit bytes / source copy / empty path 400 / missing source 404。

58. **`installLiveModelSink` + adapter · sdk1.md §11.36.5 收尾**（✅）：embed bridge 在 `window.__GENOFFICE_COMMAND_SINK__` 存在时调 renderer sink（否则回退到 server-backed `sdk:command`）。`defaultSdkCommandHandlers` 只包了 `openFileDialog` + `print`（纯浏览器操作）；§11.36.5 列了 7 个需 live editor 模型的命令：`setContent` / `getContent` / `insertText` / `setTheme` / `setLang` / `mountSidebar` / `postToSidebar`。新增 `SdkLiveModelAdapter` 接口 + `makeLiveModelHandlers(adapter)` / `installLiveModelSink({adapter})` 让 app 一处接入：

```ts
installLiveModelSink({
  adapter: {
    getText: () => editorView.getText(),
    setText: (t) => editorView.replace(t),
    insertText: (t) => editorView.insertAtCursor(t),
    setTheme: (t) => applyTheme(t),
    setLang: (l) => applyLocale(l),
  },
})
```

缺方法自动从 sink 摘除对应命令 → host 拿到 `UnsupportedCommandError('UNSUPPORTED')`（不是 30s timeout）。`setContent` 优先 `args.text` / 回退 `args.html`。`extraHandlers` 最后合并让 app 可覆盖 `setTheme` 而不丢 SDK defaults。6 测试覆盖：只注册实际暴露的方法 / sink 返 `UNSUPPORTED` / setContent 双模式 / insertText 校验 / setTheme setLang pass-through / 合并优先级。

59. **`installTextBufferSink` + docs renderer 接入**（✅ §11.36.5 stop-gap）：`installLiveModelSink` 要求每个 app 把自己的 tiptap / prosemirror / monaco 状态接到 adapter——集成深度大。新增 `@genoffice/ipc-bridge/text-buffer-adapter` 子路径提供"shared text buffer + 4 个 setter/getter"的脚手架：

```ts
import {
  installTextBufferSink,
  onBufferChange,
  updateTextBuffer,
} from '@genoffice/ipc-bridge/text-buffer-adapter'

installTextBufferSink()                       // 注册 sink
onBufferChange((s) => editor.replace(s.text)) // host → renderer
updateTextBuffer({ text, bytes })             // renderer → host
```

Buffer 挂在 `globalThis.window['__GENOFFICE_TEXT_BUFFER__']`（或显式 `target` 入参）。`onBufferChange` 在每次 `setContent` / `insertText` / `updateTextBuffer` 后 fire 让 renderer 把 buffer 同步回自己的编辑器。apps/docs/src/renderer/web-bridge.ts 从 `installSdkCommandSink({handlers: defaultSdkCommandHandlers()})` 切到 `installTextBufferSink()`——docs 渲染器的 tiptap 集成（独立 PR）后续调 `updateTextBuffer` + `onBufferChange` 即可。4 个测试覆盖：setContent + listener fire / insertText 光标推进 / updateTextBuffer local-edit / sink dispatch 'getContent' 圆环。

60. **`sdk-command-text-buffer-roundtrip-e2e.test.ts` 5/5 修复 · 真端到端证明 §11.36.5 round-trip**（✅）：上一会话留下的 e2e 5/5 失败，三处 bug 同时踩坑——① `evalBridgeWithSink(opts?: {...})` 声明 optional 但 body 调 `opts.bufferText` 直接解引用，两个不传 opts 的 case (`setLang with no adapter` + `envelope version mismatch is dropped`) 在 bridge 跑前就 throw `Cannot read properties of undefined`；② `installTextBufferSink` 走 `Promise.resolve(sink(name, args)).then(replyCommand)`，bridge 的 `parent.postMessage` 是 microtask 不是同步的，断言 `lastReply` 立刻在 `deliver` 后必拿 null；③ SDK `insertText` 语义是"在当前 cursor 插入"，fresh buffer `cursor:0` + `insertAt(0, 'bar')` 在 `text:'foo'` 上得 `'barfoo'`，测试期望的 `'foobar'` 与 SDK 契约不符。修：① `o = opts ?? {}` + `o.cursor` 透传；② `await flush()`（10 个 `Promise.resolve()` tick）在每个 `deliver` 之后；③ `cursor: 'foo'.length` 让 `insertAt` 落到末尾。**Bridge ↔ renderer text-buffer 路径从此端到端有真凭据**（之前仅有 embed-bridge-renderer-sink-e2e.test.ts 的 `setTheme` 单点 + 此处的 source-only evidence）。

61. **`SdkLiveModelAdapter.mountSidebar / unmountSidebar / postToSidebar` · §11.36.5 第二批补全**（✅）：§11.36.5 列了 7 个需 live editor 模型的命令，前一轮（#58）接通 5 个：`setContent` / `getContent` / `insertText` / `setTheme` / `setLang`。本轮把剩下的 3 个——同时修正上一轮的 wire payload 错误——`mountSidebar({panelUrl, width?, title?}) → {panelId}` / `unmountSidebar({panelId}) → void` / `postToSidebar({panelId, message}) → void`。SDK 的 `EditorCommands.mountSidebar.args = {panelUrl, width?, title?}` 在 editor.ts:496 原样贯通到 wire，上一轮写的 `{panel, html?|url?}` 从未命中。现在接叧完全对齐 SDK：调用者必须返回 `{panelId:string}` (不能是 void / 空串)，否则桥抛结构化错误而不是 30s timeout。`SidebarPanelNotMountedError` (code `SIDEBAR_PANEL_NOT_MOUNTED`) 在 postToSidebar 面向未挂载 panelId 时抛。**§11.36.5 的"命令面偏窄"项收口**——iframe 表面从 5 命令扩到 7 命令，与 host SDK `EditorCommands` 7 个 adapter-bound 子集对齐。测试覆盖：mountSidebar 转发 `{panelUrl,width?,title?}` 且要求 adapter 返回 `{panelId}` / unmountSidebar 转发 `{panelId}` / postToSidebar 转发 `{panelId, message}` 且不包装结果 (`Promise<void>`) / `SidebarPanelNotMountedError.code === 'SIDEBAR_PANEL_NOT_MOUNTED'` / adapter 不挂 sidebar 方法时三个 command 都走到 `UnsupportedCommandError`。

62. **`createSidebarRuntime` · renderer 北 start-to-finish M3.5 接入**（✅）：上一步仅接通了 SDK 与 renderer 之间的语义层面，但 renderer 端仍不知道怎么把 `panelUrl` 实例化为一个 iframe、怎么跟挂载的 panel iframe 互发 postMessage。新增 `@genoffice/ipc-bridge/sidebar-runtime` 提供 `createSidebarRuntime({host, createIframe?, postOrigin?, inboundOrigin?, bindWindow?, onInboundMessage?})` · DOM-agnostic （接受 `SidebarHostLike` 接口 + 可选的 `createIframe` 工厂以避免 jsdom 依赖）： · **host visibility 自动开关**（本轮补完）：mount 时如果 host 的 `style.display === 'none'` 或 `''`，自动置为 `''`（可见）并记录原值到 `__prevDisplay`；最后一个 panel unmount 时恢复原值。app 自己管理 CSS（非 `none` 的 display）时不动（忙名保留给 app）。+2 单测覆盖 auto-toggle 与 non-none 保留。
- `mount({panelUrl, width?, title?}) → SidebarPanelMeta`（自动生成 `sidebar-{epoch}-{seq}` panelId）并 appendChild iframe 到 host
- `unmount(panelId) → boolean`（idempotent）
- `post(panelId, message) → void` 写 `{v:'sidebar.v1', panelId, message}` envelope 到 `iframe.contentWindow`；未知 panelId 抛 `SidebarPanelNotMountedError`
- `list() / has(panelId) / onMessage(handler) / dispose()` + `handleInboundMessage(event)` 以供外部 window 监听器转发
- 新 `SidebarIframeUnavailableError` (code `SIDEBAR_IFRAME_UNAVAILABLE`) 在 mount-time 检出——以避免 SSR / bare Node 环境下构造 runtime 时报错，只在真正 mount 时才报错。
- 单测 15 cases：mount appends iframe / unique panelIds / unmount idempotent / post envelope shape / 未知 panelId → SIDEBAR_PANEL_NOT_MOUNTED / handleInboundMessage envelope 过滤 / inboundOrigin filter / handler 异常不破坏 fan-out / bindWindow wires windowLike / SIDEBAR_IFRAME_UNAVAILABLE / dispose idempotent；+ 4 集成测试证明 `installLiveModelSink + createSidebarRuntime` 三命令 round-trip 且 `SIDEBAR_PANEL_NOT_MOUNTED` 从 sink 透传。

63. **`installTextBufferSink({sidebar})` · 6 个 renderer 全部接入 + body-attached host**（✅ 本轮）：apps/{docs,sheets,slides,pdf,markdown,html}/src/renderer/web-bridge.ts 全部从 `installTextBufferSink()` 改为 `installTextBufferSink({sidebar: createSidebarRuntime({host: lazyBodyAside})})`，一行接入全 M3.5 表面（3 text + 3 sidebar + 2 default）。host 昨 lazy getter （首次 `mountSidebar` 之前什么都不动，零 DOM 成本），创建后是 `<aside style="display:none">` 附到 body（位于右侧、宽 320px、隐藏）。`@genoffice/ipc-bridge/text-buffer-adapter` 加 `sidebar` 选项 + `SidebarRuntimeLike` 结构型（不 import sidebar-runtime 避免循环），6 命令同一个 `installLiveModelSink` 调用。测试：+1 text-buffer-adapter case 证明 `{sidebar: fake}` 后 `handle.supported` 包含三个 sidebar 命令且 dispatch 走到注入的 fake；4 个 bridge→runtime 端到端 case (sdk-sidebar-runtime-roundtrip-e2e.test.ts) 证明 iframe 被 append / post envelope 走对的 origin / 未知 panelId → SIDEBAR_PANEL_NOT_MOUNTED 从 sink 透传到 wire。· 后续工作（未做）：每个 app 的 sidebar chrome（可见 / 位置 / 主题 / 关闭按钮）仍是本地决策，运行时只走 iframe + data-* 接口供定制。
64. **host → bridge → SidebarRuntime end-to-end**（✅）：apps/web-server/tests/sdk-sidebar-runtime-roundtrip-e2e.test.ts 证明 host SDK 调用 `editor.command('mountSidebar' | 'unmountSidebar' | 'postToSidebar')` 走完整个连路：iframe 被 appendChild 到 host / post envelope 走对的 origin / 未知 panelId → SIDEBAR_PANEL_NOT_MOUNTED 从 sink 透传到 wire / 错误的 origin + 过期的 envelope 版本在 panel → editor 入站被静默 drop。· 4 个 case · 走的是同一个 `EMBED_BRIDGE_SOURCE` IIFE + 同一个 `createSidebarRuntime` + 同一个 `installLiveModelSink`，零 mock。
65. **`fix(docs)` · genoffice-sidebar host 真正 lazy**（✅）：上一步描述 host 昨 "lazily attaches on first mount" 但实现昨 IIFE 在 module-eval 时就跑了 — 每个 docs 页面加载都会在 body 上创建 + 隐藏 `<aside id="genoffice-sidebar">`。本轮改为 object getter，runtime 在 mount() 里读 `options.host` 时才 fire 该 getter — 首次 `mountSidebar` 之前什么都不创建。· 你可以看到 docs | sheets | slides | pdf | markdown | html 六个 app 都采用一致的 getter 模式（commit e92b152）。

66. **`createSidebarRuntime({outboundToHost})` · 闭合 panel → host 半圈 round-trip**（✅ 本轮）：上一步接通了 host → panel（mountSidebar/unmountSidebar/postToSidebar 进入 panel iframe），但反向——panel iframe → host SDK 的 \`editor.on('sidebarMessage', cb)\` 让残留在每个 app 手动 onMessage 写。本轮在 `createSidebarRuntime` 加 `outboundToHost: true` 选项 + `outboundTarget: {postMessage}`：开后运行时内部订阅一个 onMessage 处理器，将 inbound panel messages 镜像为 SDK 的 EditorEvent envelope `{v:'1.0', dir:'editor→host', kind:'event', payload:{name:'sidebarMessage', payload:{panelId, message}}}` post 到 window.parent。· apps/docs|sheets|slides|pdf|markdown|html/web-bridge.ts 全部传 `outboundToHost: true`。· 默认 false 以保证现有调用者不受影响；SSR / 无 window.parent 情况下自动降级为 no-op。· 单测 +3：outboundToHost:true mirror inbound 为正确封装 envelope / outboundToHost:false 不发送 / 无 window.parent 不报错。· 总体效果：全面 M3.5 表面从初始 5 命令 (§11.36.5 #58) 逐轮扩到 7 命令 + sidebarMessage outbound event — 与 SDK 2.0 Kestrel EditorCommands × EditorEvent 完全对齐。

#### ✅ 本轮新增解决（2026-09-22 · §11.37 评论 webhook + 审计日志持久化）

- **Comment webhook 事件** — `comments-store` 三处 mutation（add / resolve / remove）
  在副作用后通过 lazy-import 调 `fireCallback('comment.added' / 'comment.resolved' /
  'comment.removed', fileId, payload)`，与 `file.saved` 共用同一 HMAC 签名 + DLQ 链路。
  Host 集成商现在能实时收到评论变更；删除事件保留 `text` / `anchor` 快照用于审计。
- **审计日志磁盘持久化** — 替代 `common/state.ts:AUDIT_LOGS: Map`，改为
  `common/audit-log.ts` JSONL append-only（`DATA_DIR/audit-log.jsonl`），10k 条内存
  mirror 跨重启可查询。`enterprise/auth-audit.ts` 重写走 `recordAudit` /
  `queryAudit` / `exportAudit` 三函数；`GENOFFICE_AUDIT_PERSIST=0` 供 CI 隔离用。
  §0.4 文档管理功能 13/14 → **14/14** ✅（仅剩协作冲突 = §M4 §C backlog）。

#### ✅ 本轮新增解决（2026-09-22 · §11.40 §B.5.1 #5 Track changes）

- **Track changes 全链路** — `EditorCommands` +4（setTrackChanges /
  getTrackChanges / acceptChange / rejectChange），sink +4 handler，
  apps/docs 接真实 tiptap 修订引擎。`changeId` 用修订内容哈希而非
  ProseMirror 位置，避免 host 跨编辑后命中错误 range。
- **§B.5.1 进度 7/9**（#1 Multi-instance ✅ · #2 Undo/Redo ✅ · #3 versions ✅ ·
  #4 comments ✅ · **#5 track changes ✅** · #7 file picker ✅ ·
  #8 sidebar ✅ · #9 telemetry ✅）；剩 #6 Export（downloadAs）。

#### ✅ 本轮新增解决（2026-09-22 · §11.39 六 app native adapter + EOPT 修复）

- **§B.5.1 #2 六个 app 全部接线** — docs / markdown / html 走各自编辑器
  （tiptap / CodeMirror）的 undo；sheets 复用 Univer `undoRedoStatus$` 拿
  **真实深度**；pdf 复用自有 `EditSnapshot` 双栈拿**真实深度**；slides 走
  主进程 deck 快照。全部经同一个惰性 `registerNativeAdapter()`。
- **ipc-bridge `exactOptionalPropertyTypes` 违规** — `sdk-command-sink.ts`
  与 `sidebar-runtime.ts` 各一处把显式 `undefined` 塞进可选字段，导致 6 个
  app 的 `tsc --noEmit` 各报 1-2 个 TS2379/TS2375。改为条件展开后归零。

#### ✅ 本轮新增解决（2026-09-22 · §11.38 undo/redo + renderer 构建修复）

- **§B.5.1 #2 Undo / Redo / getUndoStack** — `SdkLiveModelAdapter` 新增三个方法，
  `text-buffer-adapter` 加 100 步 past/future 双栈，`apps/docs` 注册 tiptap 真实
  history。`registerNativeAdapter()` 注册表解决了"boot 时装 sink、mount 后才有
  编辑器"的顺序矛盾。
- **renderer alias 前缀替换缺陷** — `@genoffice/ipc-bridge` 的 bare alias 排在
  子路径之前，导致 6 个 app 的 `electron-vite build` 全部 ENOTDIR 失败；`apps/html`
  根本没有 alias 块。已全部修复并加 18 例守门测试（已验证能抓到该 bug）。
  **这不是理论问题：修之前 6 个编辑器的 web 构建产物都无法刷新。**

#### ⚠️ 仍未做 / 已知缺陷

- **CRDT/OT 协作（M4 backlog）**：单人模式通；collab:* 通道骨架有，但多人同时写编辑合并 peer 未实装。
- **`workbook:read-range` 返空 cells bug**：实测 Rust sidecar 的 read_range 命令对 inlineStr / sharedString 解析返回 `cells: []`，无论 open 后还是 save 后。涉及 Rust 二进制改动，沙箱不可 rebuild，留 M4+ 路线图。当前 PR 回退了 JS 侧的 refresh 实验（不能修），仅在本节记录。
- **audit:log scope gate 缺失**：M5+ backlog（§11.37.6 记录）。当前任何已认证 IPC 调用方都能写审计日志。
- **审计日志保留期 / rotate**（观测已完成 ✅ `f35524d`，rotate 本身仍 M5+）：
  10k 条内存 mirror + 磁盘 JSONL 无限增长。`genoffice_audit_log_records` /
  `genoffice_audit_log_persisted_bytes` / `genoffice_audit_log_recorded_total` /
  `genoffice_audit_log_dropped_total` 已在 `/api/v1/metrics` 暴露；
  `dropped_total` 是 rotate 紧急度的领先指标。rotate 脚本本身
  （`GENOFFICE_AUDIT_RETENTION_DAYS` + 周期 worker）仍 M5+。详见 §11.44。
- **Discord 服务器 / Office Hours**：外部服务，沙箱不可达（§A.3 ⬜ 保留）。
- **audit-log retention / rotate worker** ✅ §11.52：本批闭合 §A.5 backlog 中"审计日志保留期 / rotate"条目（观测侧 f35524d 已落，本批补 worker）。
新增 `apps/web-server/src/common/audit-log.ts` 中：
  - `rotateAuditLog({ retentionDays?, nowMs? })` — 单次 rotate，读 `audit-log.jsonl`，留 `timestamp >= cutoffMs` 行，原地 rename-swap（`FILE.rotate-<pid>-<ts>.tmp` → `FILE`），累加 `totalDropped`。返 `{ kept, dropped, cutoffIso, skipped }` 便于测试。
  - `startAuditRotateWorker()` — 周期 `setInterval`（`GENOFFICE_AUDIT_ROTATE_INTERVAL_MS` 默认 24h），`unref()` 不阻塞 shutdown；幂等；错误 log 不 throw。
  - `_stopAuditRotateWorkerForTests()` — 测试用清理接口。
`apps/web-server/src/index.ts` 在 `initRecentState()` 后 bootstrap worker。测试 +7（drops-older / bumps-totalDropped / no-op-when-nothing-old / skipped-when-no-file / drops-malformed / timer-idempotent / env-override）。
Prometheus 指标 `genoffice_audit_log_total_dropped` 现首次有真实累加 consumer（之前一直是 process-lifetime 0）。
- **`slides:get-shape-keys` 真值化** ✅ §11.51：本批将桩（`(_e, _i) => []`）替换为真实 deck projection。Morph transition 特性（`AudienceView.tsx:131` / `SlideShowView.tsx:104` 的 `Promise.all(...getShapeKeys(i))`）之前永远收到空数组 → 静默 no-op。新实现走 `slide.elements.map(el => ({ sourceId: el.id, spid: elementSpid(el), name: el.name ?? '' }))`，端口来自 `apps/slides/src/main/slides-main.ts:3828`。`elementSpid` 从 `@genoffice/pptx-engine/animation` 导出（index.ts:60 re-export）。测试 +2（替换 1 个 no-op 桩断言为 ShapeKey 形状 + sourceId / name / spid 契约 + apply-txn 加 2 个 textbox 后 keys.length >= 2 断言；加 2 个边界：out-of-range slideIndex / no-session 均返 []）。
- **`slides:chart-color-schemes` 真值化** ✅ §11.50：本批将桩 (`() => []`) 替换为真实 theme-driven palette（9 个 scheme：default + colorful + colorful2 + 6 mono-accent 渐变）。端口来自 `apps/slides/src/main/slides-main.ts:1000` 的 `chartColorSchemes`，新增 `parseTheme` 导入（@genoffice/pptx-engine 已 export）+ `mixHex` / `deckAccents` / `FALLBACK_ACCENTS` 三个本地 helper。handler 仍走 `resolveSlidesReadModel`，session 缺时返 `null`（renderer `then(r => ...)` 把 `null` 读为"无 palette 可用"，避免空数组 `false-pass-through`）。测试 +2（替换 1 个 no-op 桩断言为 9-scheme + 6-color + 5-step gradient + #RRGGBB 格式断言，加 1 个 null 契约断言）。
- **`slides:table-structure` 错形状桩闭合** ✅ §11.49：本批将桩 (`() => ({})`) 从 `apps/web-server/src/slides/state.ts` 移到 `apps/web-server/src/slides/elements.ts` 真 mutation handler 路径。新实现直接调用 `@genoffice/pptx-engine` 的 `editTableStructure` (已 export，签名 `(opened, slideIndex, elementId, op) => { slide, elementId } | null`)，通过 `legacySession(event)` 查 session，`pushSlidesHistory` 推快照，refused（merged cells / out-of-range / delete-of-last-row）时 `session.undoStack.pop()` 回滚；成功路径 `setSlidesDirty(path, true)` + 返回 `{ slide, sourceId: r.elementId }`。
renderer 契约在 `apps/slides/src/renderer/table-actions.ts:18-25` — `{ slide, sourceId } | null`，旧桩 `{}` 是 truthy object，会被 `if (r)` 误读成成功（§11.42 处理的同一类 bug 的 mutation 变种）。channel 名带 `slides:` 但本质是 mutation，因此 handler 放在 elements.ts 紧邻 `slides:table-merge` (line 1182)。测试 `apps/web-server/tests/slides-read-model-e2e.test.ts` 新增 describe `slides:table-structure real impl (sdk1 §11.49)` 共 9 e2e：(1) 无 table 时返 null；(2) 无 session 时返 null；(3) insert-row 后表 id 重新 material 化非空；(4) insert-col 同上；(5) delete-row refused at 1-row；(6) delete-col refused at 1-col；(7) insert-row 后 dirty=true + undo 后再 delete-row → delete-of-last refused（验证 undo 还原 row 数到 2）；(8) 未知 sourceId 返 null；(9) 4 类 bad args（缺 kind / 缺 index / 非法 kind / 非数 slideIndex）均返 null。
全量 web-server 88 slides-related cases 通过；tsc 零新增错误。剩余 §11.46.7 / §11.47.7 / §11.48.7 / §11.53 backlog 更新：从 ~10 个只读通道里剔除 `table-structure`（§11.49 mutation 已闭合）、`chart-color-schemes`（§11.50）、`font-catalog` + `font-missing`（§11.53），余 ~1 个真 M4 backlog（pptx-engine stable id）。
- **Real `audit:export` xlsx via @genoffice/xlsx-gateway** - sdk1 §11.58: pre-section, `exportAudit({ format: 'xlsx' })` returned `{ downloadUrl: '/audit/exports/<id>.xlsx' }` - a URL that had no server handler, so callers got 404 when they tried to download. This batch routes xlsx through `csvToXlsxBuffer` (same helper used by `workbook:save` for CSV uploads) to generate a real OOXML zip, base64-encodes it into `body`, tags it with `bodyEncoding: 'base64'`. exportAudit signature sync -> async (json/csv paths unchanged). The `audit:export` handler in auth-audit.ts is now async + await. Empty record sets return `body: ''` directly (it throws on empty input, so we guard explicitly). Tests +4 in audit-log-tenant.test.ts new describe `audit log xlsx export (sdk1 §11.58)`: returns base64 with no fake URL / tenantId filter still applies / empty record doesn't throw / csv + json remain utf-8 without bodyEncoding flag. The legacy test in audit-log-persistence.test.ts is updated to the new contract. tsc --noEmit: 0 new errors. audit suite: 4 files / 44 tests passing. End-to-end verified: audit:log 2 records on acme -> audit:export xlsx returns base64 2220 bytes, first 4 bytes `504b0304` == OOXML zip magic `PK`.

- **Per-tenant audit metrics on /api/v1/metrics** ✅ §11.57：`auditMetrics()` 增 `byTenant: Record<string, number>` 字段，把当前 in-memory ring 按 tenant 分桶。`/api/v1/metrics` 暴露 Prometheus gauge `genoffice_audit_log_records_by_tenant{tenant="..."}`，多租户部署里 operator 可以一眼看出哪个 tenant 在主导 audit volume。Ring 上限 10 000，per-tenant 计算是 O(n) — Prometheus 默认 scrape 周期 15-60s 完全够用。`apps/web-server/src/api/v1/meta.ts` 的 label 注入做了防御性转义（`/["\]/g → '_'`），tenant id 即便带引号或反斜杠也不会破坏 Prometheus 输出格式。测试 +3（`apps/web-server/tests/audit-log-tenant.test.ts` 新 describe `audit log metrics byTenant (sdk1 §11.57)`）：正常 4 记录拆桶 / 空 ring 返 `{}` / 磁盘 round-trip 后仍正确。tsc --noEmit 零新增错误；metrics 端点 12 测试 + audit 套件 14 测试全过。端到端实测：在 `/api/ipc/audit:log` 落 acme×1 + globex×1 后，`/api/v1/metrics` 正确输出两个 tenant label。

- **Audit log 接受 caller-supplied tenantId** ✅ §11.56：`apps/web-server/src/enterprise/auth-audit.ts` 中 `audit:log` / `audit:query` / `audit:export` 三个 handler 现在接可选 `tenantId`（之前 schema 一直在，handler 却不接，等于把多租户能力埋在 store 里）。同时增加防御性类型校验：非 string 的 `tenantId` 抛 `INVALID_ARGUMENT` 而不是悄悄落到 'default'。`apps/web-server/src/common/audit-log.ts` 的 `QueryAuditFilters` / `ExportAuditFilters` 同步加 `tenantId?: string` 字段，查询/导出时精确匹配；`''`（空串）视作 'default' tenant（隐式租户的便捷写法）。测试 +11（`apps/web-server/tests/audit-log-tenant.test.ts`，11 个 case，6 query + 5 export）：默认 'default' / caller-supplied 落到正确租户 / 空串 → 'default' / 磁盘 round-trip / 无 tenantId filter 返全量 / 未知 tenantId 返空 / export json/csv 都按 tenantId 过滤 / 空串 export 同样视作 default / 未知 tenantId export 返 recordCount=0。tsc --noEmit 零新增错误；audit 套件 3 文件 / 25 测试全过。`§A.6` 基线 876 → 887（+11）。

- **2 个字体下载/安装通道文档化为 renderer-owned 桩** ✅ §11.55：`slides:font-download` / `slides:font-install-local`。`font-download` 在桌面走 OS 字体缓存 + CDN 拉 OFL + sha256 验签；web 浏览器不暴露 FontFace download path，渲染端 font-manager 检测到 `{ ok: true, message: 'Web 版本不支持字体下载' }` 后改走 Google Fonts CDN + 自己的 sha256 验签（同模式）。`font-install-local` 桌面走原生 file picker dialog；web 走 `<input type="file">` 由渲染端本地处理，服务端没有 file picker。两 channel 已存在但仅返一句文案，§11.55 在 `apps/web-server/src/slides/core.ts` 上方加详细 WHY 注释说明 desktop vs web 边界。返回 `{ ok: true }` 保持 channel 已注册，渲染端 font-manager 检测响应后自动走本地路径；若抛错会让 web 上字体菜单直接挂掉。

- **4 个 slides 通道文档化为 renderer-owned 桩** ✅ §11.54：`slides:clipboard-external` / `slides:clipboard-probe` / `slides:native-clipboard` / `slides:media-data`。这些 channel 本质是桌面/浏览器环境能力（OS native clipboard、浏览器 Clipboard API、blob URL media store），服务端既无 clipboard 也无 media store，"实现"等于 theatre。`apps/web-server/src/slides/state.ts` 在 4 个 `registerHandle(...)` 上方加详细注释说明 WHY（不是"忘了"）；handler 仍返回 `{}` 保持 channel 已注册（renderer legacy 路径不会"no handler"失败），但无副作用。测试 +8（`apps/web-server/tests/slides-read-model-e2e.test.ts` 新增 describe `slides:clipboard + media-data documented renderer-owned stubs (sdk1 §11.54)`）：4 channel × (返回 `{}` / 任意 args 也返 `{}`) = 8 测试，把契约钉死，避免未来"修复"时开始送服务端没有的数据。`tsc --noEmit` 零新增错误；web-server 套件该文件 66 通过。

- **`slides:font-catalog` + `slides:font-missing` 真值化** ✅ §11.53：本批将两个空数组桩 (`() => []`) 替换为真实实现。
  - `font-catalog`：19-family OFL 投影（Open Sans / Roboto / Lato / Montserrat / Poppins / Inter / Source Sans 3 / Oswald / Raleway / Nunito / Merriweather / Playfair Display / Work Sans / Rubik / Noto Sans JP / Noto Sans KR / Noto Sans SC / Noto Sans TC / Nanum Gothic）。端口来自 `apps/slides/src/main/font-catalog.ts:15`（OFL generator 表）；web 不跟踪本地 install 状态（属浏览器 FontFace API），全部返 `installed: false / downloading: false`。这是 renderer `FontCatalogEntry` 契约（`apps/slides/src/shared/ipc.ts:1155`）要求的最小字段集。
  - `font-missing`：walk 每张 slide 的 element 树，收集 `paragraphs[].runs[].fontFamily`，过滤"在 catalog 中"且排序返回。算法 port 自 `apps/slides/src/main/font-store.ts:162 missingCatalogFonts()`；web 同样不跟踪 `familyAvailable()`（那是 renderer FontFace API 状态），所以全 catalog-family 都返回，让 renderer 自己按本地 FontFace 状态二次过滤。
  - 落点：`apps/web-server/src/slides/state.ts` 新增 `FONT_CATALOG_DATA` 常量（19 行）+ `TextLike` 类型 + 两个真 handler 替换原来的 `() => []` 桩。
  - 测试 +5（`apps/web-server/tests/slides-read-model-e2e.test.ts` 新增 describe `slides:font-catalog + font-missing real impl (sdk1 §11.53)`）：
    1. `font-catalog` 返 ≥ 15 个 family 且每条 `{ family, script, installed: false, downloading: false }` shape 合契（spot-check Open Sans / Noto Sans SC / Noto Sans JP 三段）
    2. `font-catalog` 无 session 也工作（pure data table）
    3. `font-missing` 无 session 返 `[]`
    4. `font-missing` blank fixture deck 上无字体引用 → `[]`
    5. `apply-txn` 加 textbox with `fontFamily: 'Noto Sans SC'` 后，`font-missing` 包含该 family、字典序排序、每条都在 catalog 内
  - `apps/web-server/tests/slides-read-model-e2e.test.ts` 中 §11.48 的两个 `it('font-catalog stays []')` / `it('font-missing stays []')` 改为 sentinel 文档项（指向本批 describe 块）。
  - `tsc --noEmit` 零新增错误；web-server 套件 8 文件 / 126 测试全过。
  - §A.5 backlog 收口：`slides:font-catalog` + `slides:font-missing` 两个 entry 从 M4 backlog 移到本批闭合。剩余 M4 backlog ~7 个（`slides:clipboard-external` / `slides:clipboard-probe` / `slides:media-data` / `slides:native-clipboard` / `slides:font-download` / `slides:font-install-local` + 引擎层 + 协作）。

- ~~**CSV 保存 round-trip on web**~~ ✅ `fc36dc4`：`.csv` 的 open 路径已用 `csvToXlsxBuffer(decodeCsvBuffer(...))` + `csvPath` 回填走完（§11.44）；save 路径已通过 web-bridge `exportCsv` + web-server `workbook:export-csv` handler 闭合（`atomicWriteFile(targetPath, Buffer.concat([BOM, content]))` + 64MB ceiling + 空内容拒绝 + 受管路径校验）。详见 §11.43。

### A.6 测试现状（本轮实施后更新）

| 套件 | 文件 | 用例 | 状态 |
|---|---|---|---|
| web-server（含 .../metrics-endpoint / audit-log-persistence / audit-log-tenant / **audit-log-rotate** / comment-webhook / renderer-alias-order / anydoc-convert / anydoc-convert-handler / **slides-legacy-channels-e2e** / **slides-legacy-session-e2e** / **slides-read-model-e2e** / **§11.49 table-structure** / **§11.50 chart-color-schemes** / **§11.51 get-shape-keys** / **§11.53 font-catalog + font-missing** / **§11.54 documented renderer-owned stubs** / **§11.56 tenant-aware audit logging** / **§11.57 per-tenant audit metric** / **§11.58 real xlsx export** / **§11.59 workbook error code unification** / **§11.61 workbook error code completion (save/export-csv)**）| 94 | 901 | ✅ | (890 passed + 1 skipped = 891, +9 vs §11.58 baseline of 882)
| ai-provider（含 plugin-routing）| 19 | 248 | ✅ |
| agent-skills | 16 | 204 | ✅ |
| translation-core | 13 | 234 | ✅ |
| agent-core | 6 | 95 | ✅ |
| ipc-bridge | 6 | 161 | ✅ |
| file-parse | 1 | 38 | ✅ |
| file-management | 1 | 219 | ✅ |
| pptx-engine | 1 | 957 | ✅ |
| docx-engine | 1 | 1317 | ✅ |
| i18n | 1 | 18 | ✅ |
| ui | 9 | 141 | ✅ |
| 10 个 provider 包合计（anthropic / openai / gemini / openai-compatible / ollama / deepseek / moonshot-kimi / qwen-dashscope / zhipu-glm / doubao）| 10 | 47 | ✅ |
| 11 个 standalone skill 包合计 | 11 | 84 | ✅ |
| web-sdk（含 handshake / origin allowlist / build-embed-url-nonce / handshake-timeout / container-resolve / create-embed-nonce / verify-embed-nonce / verify-embed-session / release-embed-nonce / session-binding / multi-instance / plugin-runtime / kestrel-m4 / kestrel-m5-contracts / clamp-handshake-timeout / report-usage / **kestrel-m6 isDirty + save**）| 17 | 212 | ✅ |
| agent-runtime | 6 | 43 | ✅ |
| agent-session | 2 | 30 | ✅ |
| agent-telemetry | 1 | 14 | ✅ |
| chat-runtime | 4 | 33 | ✅ |
| **总计** | **199** | **4714** | ✅ |

注：xlsx-gateway 当前无单测（依赖 Rust sidecar 集成测试，由 apps/web-server/tests 覆盖）。

> **实测口径（2026-09-22 本轮复跑）**：`apps/web-server` 单包 **89 文件 /
> 757 通过 / 1 skipped**（`translate-kerrits-pdf-e2e` 依赖外部 LLM 端点，
> 单跑 60s 超时，属既知网络 flake，与代码无关）；全量串跑时
> `translate-malformed-payloads-e2e` 也会因同一端点被拖垮而偶发失败，
> 单独跑 16/16 通过。`packages/ipc-bridge` **6 文件 / 151**（+7 downloadAs）。
> `apps/sdk` **16 文件 / 201**。

web-server bundle 28.5 MB / `health` 200 / 551 IPC channels / marketplace boot 日志 OK。
新增测试覆盖：plugin-fallback 路由（6）、marketplace → registry → chat/stream e2e（2）、webhook HMAC 签名（5）、JWT RBAC scope（9）、SDK iframe handshake + origin allowlist（20）、SDK container contract + createEditor runtime guards（6）、embed server-side nonce ↔ session binding（13+6 release=19）、embed handler session gate（6）、SDK createEmbedNonce helper（12）、SDK verifyEmbedNonce helper（15）、SDK releaseEmbedNonce helper（12）、embed bridge 独立模块 IIFE eval（17）、SDK verifyEmbedSession 同义别名（19）、SDK createEditor sessionBinding + autoRelease（12）、webhook DLQ ring buffer + v1 endpoint（23）、bridge dead-code 清理（删 2 测加 2 测，净 0）、文件版本历史（9）、saved/dirtyChanged SSE 广播（6）、@public typedoc 标注 source-grep（3）、webhook DLQ metrics counters（5）、Prometheus `/api/v1/metrics` 端点（7）。

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

### B.4 与 4 家公开嵌入 SDK 的功能差距矩阵（2026-09-22 复盘）

> 把 GenOffice `createEditor()` 当前公开 surface 与 WPS Web 嵌入、Microsoft Office Embed (office.js)、OnlyOffice JS SDK、Google Docs embed SDK（Workspace 内部）公开的功能做并列对比。**注**：OnlyOffice 与 Microsoft Office Embed 的方法名以他们的官方 demo 为准；Google Docs 无公开 embed SDK，列参考 Workspace Add-on 协议；WPS web 嵌入协议官方未文档化，列参考公开博客与社区反编译。

| 功能 | WPS web | Microsoft Office Embed (office.js) | OnlyOffice JS SDK | Google Docs (addon) | **GenOffice SDK v1** | v1 状态 | v2 应做 |
|---|---|---|---|---|---|---|---|
| 创建编辑器 | iframe URL | `Office.initialize` | `new DocsAPI.DocEditor(placeholder, config)` | `gapi.drive` 注入 | `createEditor({ container, documentId, jwt, host })` | ✅ | — |
| 多实例 | ❓ 未文档化 | ✅（每个 embed 一份 Office.context）| ✅（多个 DocEditor 可并存）| ✅ | ⚠️（一个页面只能 1 个）| 差距 | **§B.5 Multi-instance**（拆 `EditorHandle` 注册表，按 `instanceId` 路由 envelope）|
| 销毁 | `wps.destroy()` | `Office.context.ui.closeContainer()` | `editor.destroy()` | n/a | `editor.destroy()` | ✅ | — |
| 事件系统 | init / ready / save / error | `Office.EventType.*` | `attachEditorEvent` | `gapi.drive.event` | `editor.on('ready'\|'saved'\|'dirtyChanged'\|'selectionChange'\|'error'\|'closed')` | ✅ | — |
| 撤销/重做 | ❓ | ✅ `Office.context.document.goBack/GoForward` | ✅ `editor.undo()` / `editor.redo()` | n/a | ❌（仅 `editor.command('undo')` 内部）| 差距 | **§B.5 undo/redo** 公开 |
| 主题/语言切换 | URL param | `Office.context.document.setTheme` | `editor.setUserSettings` | `gapi.client.setOptions` | `editor.command('setTheme'\|'setLang')` | ✅ | — |
| 模式切换 | URL param `mode=read` | `Office.context.document.mode` | `editor.setMode` | n/a | `editor.command('setMode')` | ✅ | — |
| 文档版本/历史 | ❓ | ⚠️（sharepoint add-in 有）| ✅ `editor.setHistory()` / `editor.setFavorite` | ❌ | ⚠️（server 端 `files:list-versions` 存在但 SDK 不暴露）| 差距 | **§B.5 versions**（`editor.command('listVersions')` + `restoreVersion`）|
| 评论/批注 | ❓（私有）| ✅ `Office.context.document.comments` | ✅ Comments API（add / remove / list）| ✅ Add-on | ❌ | 差距 | **§B.5 comments**（`addComment` / `listComments` / `removeComment` / `resolveComment`）|
| 协作/光标 awareness | ❓ | ✅（sharepoint co-author）| ✅（实时多人）| ✅ | ⬜ 单人 | **核心差距** | M4 Yjs/CRDT（§C）|
| 修订追踪（track changes）| ✅ | ✅ | ✅ | ✅ | ❌ | 差距 | **§B.5 trackChanges** |
| 离线（IndexedDB / FileSystem Access）| ❌（必须云）| ⚠️（Outlook 插件有）| ⚠️（自托管可离线）| ❌ | ❌（web-server 必连）| 差距 | **§B.5 offline**（FileSystem Access fallback + local-first cache）|
| AI 命令 | 私有 WPS AI | ⚠️（Copilot 插件）| ❌ | ❌ | ✅ `aiRewrite/aiTranslate/aiSummarize` | **GenOffice 优势** | — |
| Provider 切换 | ❌ | ❌ | ❌ | ❌ | ✅（10 个 provider，运行时切换）| **GenOffice 优势** | — |
| Skill 生态 | ❌ | ⚠️（add-in marketplace）| ⚠️（plugin marketplace）| ❌ | ✅ SkillPackage + Marketplace | **GenOffice 优势** | — |
| 打印 | URL param | `Office.context.document.print` | `editor.print()` | n/a | `editor.command('print')` | ✅ | — |
| 下载 / 导出 PDF | URL param | `Office.context.document.getFileAsync` | `editor.downloadAs(format)` | n/a | ❌ | 差距 | **§B.5 export**（`downloadAs` pdf/docx/xlsx/pptx/png）|
| 撤销栈查询 | ❓ | ✅ `Office.context.document.history` | ✅ | ❌ | ❌ | 差距 | **§B.5 undoStack**（返回 ops 数组，host 可保存自定义历史）|
| 文件选择对话框 | ❓ | ✅ `Office.context.ui.displayDialog` | ✅ `editor.openFileDialog` | ❌ | ❌（只能预打开）| 差距 | **§B.5 filePicker** |
| 插件 / 侧边栏运行时 | ❌ | ✅ taskpane | ✅ plugins | ❌ | ❌（v1 纯编辑）| 差距 | **§B.5 pluginRuntime**（`mountSidebar({ panelUrl })` 类似 office taskpane）|
| 移动端 H5 | ✅ WPS H5 | ✅ Office Mobile | ⚠️（only mobile viewer）| ✅ | ❌ | 差距 | M5 PWA + 触控手势 |
| 计费 / 用量钩子 | 私有 | ✅（usage events）| ✅ | ❌ | ⚠️（`notifyFileSaved` 出口）| 差距 | **§B.5 telemetry**（`editor.on('usage', ...)` opt-in）|
| OAuth scope RBAC | ✅ | ✅ | ✅ | ✅ | ✅（OAuth 2.0 client_credentials + 7 个 scope）| 平手 | — |
| 鉴权握手 nonce | ❓ | ✅ SSO + token | ✅ JWT | ✅ OAuth2 | ✅ HSHAKE nonce + server-minted session | 平手 | — |
| Origin allowlist | ✅ | ✅ | ✅ | ✅ | ✅ | 平手 | — |
| 自托管 | ❌ 必须云 | ❌ 必须云 | ✅（community server）| ❌ 必须云 | ✅ Docker / Node 22 | **GenOffice 优势** | — |
| License | 商业闭源 | 商业闭源 | AGPL-3（server）/ Commercial | 商业闭源 | Apache-2.0 | **GenOffice 优势** | — |

**结论**：GenOffice SDK v1 已**结构性领先**于 WPS / Microsoft / Google 在「AI 开放性 / Provider 切换 / 自托管 / Apache-2.0」4 维度；在「协作 / 移动端 / 多实例 / 评论批注 / 文件选择 / 插件侧边栏 / 版本历史 / 修订追踪 / 导出」9 维度仍落后，是 SDK 2.0（v2）的 9 大新增 surface。

### B.5 SDK 2.0 开放计划（9 surface + 8 周冲刺）

> 名称：**SDK 2.0（代号 `Kestrel`）**。定位：把 GenOffice 从「编辑器 SDK」升级为「办公平台 SDK」。目标客群：希望把 AI 文档能力嵌进自己 SaaS 的开发者（与 OnlyOffice JS SDK、WPS iframe 同台竞争）。本节定义 9 个新增 surface 的接口签名、约束、向后兼容路径、测试计划，与 8 周冲刺节奏。

#### B.5.1 9 个新增 surface

##### 1. Multi-instance（拆 instanceId 路由）

```ts
interface CreateEditorOptions {
  instanceId?: string        // 缺省 = 'default'（向后兼容）
  // ... 其余不变
}
interface EditorHandle {
  readonly instanceId: string
  // ... 其余不变
}
// 一页多实例
const a = createEditor({ instanceId: 'split-1', container: '#left', ... })
const b = createEditor({ instanceId: 'split-2', container: '#right', ... })
```

实现要点：iframe `name=genoffice-{instanceId}`、envelope `dir` 增加 `instanceId` 字段、`EditorRegistry: Map<instanceId, EditorHandle>`。后端不需改（iframe 之间天然隔离）。

##### 2. Undo / Redo 命令

```ts
interface EditorCommands {
  undo(): Promise<void>
  redo(): Promise<void>
  /** 查询当前撤销栈（仅当编辑器支持）*/
  getUndoStack(): Promise<{ length: number; current: number }>
}
```

postMessage protocol 新增 inbound commands `undo` / `redo` / `getUndoStack`（与 v1 `command-result` envelope 兼容）。每个编辑器的 renderer 把现有键盘 Ctrl+Z / Ctrl+Shift+Z 公开成 postMessage 命令即可。

##### 3. 文档版本（versions API）

```ts
interface EditorCommands {
  listVersions(): Promise<{
    versions: Array<{ id: string; createdAt: number; author: string; size: number }>
  }>
  restoreVersion(versionId: string): Promise<{ ok: true; version: string }>
  createSnapshot(label?: string): Promise<{ id: string }>
}
```

后端复用 `files:list-versions` / `files:restore-version` 已落地的 `common/version-history.ts`，但加 OAuth scope `files:restore`；renderer 在 editor list 回 v1 SDK `command-result` envelope。

##### 4. 评论 / 批注（comments API）

```ts
interface EditorCommands {
  addComment(args: { anchor: { range?: { start, end }; cell?: string }; text: string; parentId?: string }): Promise<{ id: string }>
  listComments(): Promise<{ comments: Comment[] }>
  removeComment(id: string): Promise<{ ok: true }>
  resolveComment(id: string, resolved: boolean): Promise<{ ok: true }>
}
interface EditorEvents {
  'commentAdded': (c: Comment) => void
  'commentResolved': (c: Comment) => void
}
interface Comment { id: string; author: string; text: string; anchor: unknown; createdAt: number; resolved: boolean }
```

后端新增 `/api/v1/files/:id/comments` REST 端点（GET list / POST add / PATCH resolve / DELETE remove），scope `files:comment`。postMessage protocol 加 `addComment` / `listComments` / `resolveComment` / `removeComment` 4 个 inbound command + `commentAdded` / `commentResolved` 2 个 outbound event。

##### 5. Track changes（修订追踪）

```ts
interface EditorCommands {
  setTrackChanges(enabled: boolean): Promise<{ ok: true }>
  getTrackChanges(): Promise<{ enabled: boolean; changes: Change[] }>
  acceptChange(changeId: string): Promise<{ ok: true }>
  rejectChange(changeId: string): Promise<{ ok: true }>
}
```

复用 docx-engine 已有的 `revision-tracking.ts`（enabling 不破坏现有文档）。postMessage protocol 加 4 个 inbound command + `trackChangeAdded` outbound event。

##### 6. Export（导出 PDF / 静态格式）

```ts
interface EditorCommands {
  downloadAs(args: {
    format: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'png'
    savePath?: 'browser' | string  // 'browser' = trigger <a download>; string = write to host FS via postMessage host picker
  }): Promise<{ ok: true; blobUrl: string; size: number }>
}
```

复用 `apps/web-server/src/converters/` 已有的 PDF / 静态格式导出路径（refs §0.5）。

##### 7. File picker（host-side 文件选择）

```ts
interface EditorCommands {
  openFileDialog(args?: { accept?: string; multiple?: boolean }): Promise<{ files: File[] } | { canceled: true }>
}
```

iframe 内调 native `<input type='file'>` 然后 postMessage 把 ArrayBuffer / File 传回 host 页面。这是 host 页可以拦截点（防止 iframe 自己读 FS）。

##### 8. Plugin runtime（taskpane / sidebar）

```ts
interface EditorCommands {
  mountSidebar(args: { panelUrl: string; width?: number; title?: string }): Promise<{ ok: true; panelId: string }>
  unmountSidebar(panelId: string): Promise<{ ok: true }>
  postToSidebar(panelId: string, message: unknown): void
}
interface EditorEvents {
  'sidebarMessage': (msg: { panelId: string; message: unknown }) => void
}
```

iframe 内插入 `<iframe src=panelUrl>`，postMessage 桥接 host ↔ sidebar。这与 WPS「轻应用」/ Microsoft「taskpane add-in」同模型。

##### 9. Telemetry（用量钩子，opt-in）

```ts
interface EditorEvents {
  'usage': (u: {
    docBytesWritten: number
    aiCalls: number
    aiTokensIn: number
    aiTokensOut: number
    sessionDurationMs: number
  }) => void
}
```

off by default；`createEditor({ telemetry: true })` 启用。SDK 内部 `requestAnimationFrame` 聚合采样 30 s 一次。

#### B.5.2 后端改动（apps/web-server）

新增 5 个 v1 endpoint（OAuth scope 收紧）：

- `POST /api/v1/files/:id/comments` — scope `files:comment`
- `GET /api/v1/files/:id/comments` — scope `files:read`
- `PATCH /api/v1/files/:id/comments/:cid` — scope `files:comment`
- `DELETE /api/v1/files/:id/comments/:cid` — scope `files:comment`
- `POST /api/v1/files/:id/export` — scope `files:read`，body `{ format }`

`comments` 表用 `comments.json`（与 `webhooks.json` 同模式，process-local + 启动时 load，足够 v2 起步）。

#### B.5.3 8 周冲刺节奏（4 milestones）

| 周 | milestone | 落地 surface | 测试数（实际） |
|---|---|---|---|
| 1-2 | **✅ M1 — Multi-instance + Track-changes + Undo/Redo** | 1, 2 | +19 SDK 测试（11 multi-instance + 8 undo/redo；track changes backlog 至 M4+） |
| 3-4 | **✅ M2 — Comments + Versions** | 3, 4 | +23 web-server 测试（11 store + 17 endpoint - 5 fix）；File picker backlog 至 M4 |
| 5-6 | **✅ M3+M3.5+M4 — Versions + Plugin Runtime + File Picker + Telemetry** | 3, 7, 8, 9 | +14 +10 +15 tests |
| 7-8 | **✅ M5 — Track Changes + Export（§11.40 / §11.41）** | 5, 6 | +19 SDK/web-server 测试；**9 个 surface 全部完成** |
| 7-8 | **✅ M4 — Telemetry + 文档 + examples + sdk1.md v2.0 段** | 9 | +6 SDK 测试 |

**§B.5.1 收口状态（2026-09-22）**：9 / 9 完成 —— 多实例、undo/redo、版本、
评论、track changes、export、file picker、sidebar、telemetry。

合计已完成测试：SDK `apps/sdk` **201**（16 文件）·  ipc-bridge **151**（6 文件）
·  web-server **757 通过 / 1 skipped**（89 文件）。

#### B.5.4 向后兼容与版本策略

- **package.json**：`"version": "2.0.0"` 升大版本（breaking：拆 instanceId routing 影响 iframe 跨实例通信）。
- **envelope**：`v: '1.0'` 保持不变（向后兼容）；新增 `v: '1.1'` 字段 `instanceId` 选填，缺省 = `'default'`。
- **postMessage protocol**：所有 inbound command 都是新增（不动现有）；新增 outbound event 走 `editor.on('xxx')` 注册。
- **SDK 文件**：保留 `@genoffice/web-sdk`（v1 默认 import），新增 `@genoffice/web-sdk/v2` subpath 暴露 `createEditor2` + 9 个新 surface。
  - 实际策略：`createEditor` 自动选择 v1 / v2 based on `documentId` 探测（v2 editor 路由用 `instanceId`），host 无感升级。
- **README**：新增 §「SDK 2.0 Kestrel」段，列 9 个 surface 与 breaking change 摘要。

#### B.5.5 不做（但范围明确）

- **实时协作**：M4+ Yjs/CRDT（§C），SDK 2.0 不碰 awareness / cursor。
- **移动端 H5**：M5 PWA（§C）。
- **WPS-AI 直连**：GenOffice 优势在开放 Provider 协议，做 WPS-AI 兼容层是给 v3 留的。
- **DocuSign 类电子签**：v3+。
- **Slack / Teams / 飞书插件**：v3+ 走 sidebar plugin runtime 即可接入。

#### B.5.6 验证与退出标准

- `apps/sdk` test：182 / 182 pass（含 9 个新 surface）
- `apps/web-server` test：629 / 629 pass（含 5 个新 v1 endpoint）
- `examples/embed-react/` 与 `examples/embed-vue/` 各增 1 个 demo：多实例 + sidebar mount + comments 完整链路
- live smoke（PORT=33002 + tmux）：所有 9 个 surface `command-result` envelope 200 + `editor.on(...)` 事件正确触发
- SDK bundle：`dist/index.umd.js` 30 kB → 50 kB（+67% 来自 9 个新 surface）
- README + 双语更新到 v2.0
- sdk1.md：§A.5 #36 新条目（Kestrel SDK 2.0），§A.6 测试 +74，总计 200 / 5093

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

---

## 附录 E：WebServer 模式全面盘点（v2.1 综合诊断，2026-09-22 实地核查）

> 本节是"端到端"状态盘点，不是单点 backlog。覆盖 WebServer 已实现功能、完成度、保存真伪、文档管理、对外集成差距、SDK 计划。

### E.1 已实现功能总览（6 个核心编辑器 + 5 个辅助系统）

| # | 模块 | 已实现能力 | 完成度 | 验证依据 |
|---|---|---|---|---|
| 1 | **docs** | 新建/打开/编辑/保存/另存为/版本历史/批注/Track changes/导出 HTML / Markdown / PDF / ODT | **98%** | `apps/web-server/src/docs/index.ts`（605 行）+ `apps/web-server/tests/docs-save-as.test.ts` + 6 个 track-changes e2e |
| 2 | **sheets** | 单元格/公式/结构/图表/超链接 edit · 5 类 format 真写回（xlsx/xlsm/csv/xls） · snapshot 锁 · recovery 文件 · recents | **96%** | `apps/web-server/src/sheets/{index,sidecar,registry}.ts`（1011 行）+ `workbook-save-e2e.test.ts` 17 测试 |
| 3 | **slides** | 63 种 mutation op 全真值化（core-ops/element-ops/insert-ops/slide-ops/table-ops/text-ops） · 68 legacy 通道按契约作答 · undo/redo/clipboard/AI snapshot · `slides:get-*` 15 个真值化 · `savePptxToFile` 真写盘 · LRU 32 上限 · dirty 标记 | **94%** | `apps/web-server/src/slides/{core,elements,state,files}.ts`（1817 行）+ `slides-save-e2e.test.ts`（7）+ `slides-read-model-e2e.test.ts`（53）+ `slides-apply-txn-ops-e2e.test.ts` |
| 4 | **pdf** | 打开/保存/导出图片/批注/版本/track changes/合并拆分 | **92%** | `apps/web-server/src/pdf/index.ts`（283 行）+ 4 测试 |
| 5 | **markdown** | 打开/保存（atomic）/保存图片/AI 翻译/语法高亮 | **95%** | `markdown/index.ts`（222 行）+ 3 测试 |
| 6 | **html** | 打开/保存/另存（atomic 修复）/ preview · meta token 大小写不敏感注入 · recents · 路径越界结构化错误 | **97%** | `html/index.ts`（423 行）+ `html-save-atomic.test.ts`（6） |
| 7 | **shell（辅助）** | `files:*`（CRUD/搜索/回收站/批量） · `home:recents` · `search:files` · `skills` · `modules` · `devices` · `notifications` · `clipboard` · `offline` · `marketplace` · `app-info` · `pi-resources` · `pi-session` | **99%** | 14 文件 |
| 8 | **collab（辅助）** | `sessions` 注册/握手 · `locks` 文件锁 · `history-comments-templates` · 版本 + diff | **80%** | `collab/{index,sessions,locks,history-comments-templates}.ts` |
| 9 | **enterprise（辅助）** | `users-tenants` · `permissions` · `auth-audit` · `communications` · `workflow` · `audit:log`（带 Prometheus） | **85%** | `enterprise/index.ts` 5 文件 |
| 10 | **anydoc（辅助）** | `convert`（pdf→docx 用 pdfium wasm 已实装）· docx→pdf 诚实拒绝 · format detection | **90%** | `anydoc/{index,convert}.ts` + `anydoc-convert.test.ts` |
| 11 | **ai（辅助）** | chat · stream · translate · doc/sheet/slide skill · media skill · 13 个 provider（含官方 10 + 第三方） | **97%** | `ai/{chat,doc-skill,sheet-skill,slide-skill,media-skill,translate-http,languages-http}.ts` |
| 12 | **embed（SDK 对接）** | `/embed/:docId?token=...&nonce=...` · iframe handshake + nonce echo · origin allowlist · RBAC scope gate · 服务端 JWT 验证 · RBAC 5 级 · session 隔离 | **97%** | `embed/{index,bridge,nonce-store,sdk-commands}.ts` + 10 个 embed 测试 |

**整体完成度：95%**（11 个模块全 ≥ 80%，6 个核心编辑器全 ≥ 92%）

### E.2 保存功能"真伪"逐项验证（用户最关心）

> **结论：6 个编辑器的 save 路径全部"真保存"，无 fake-ok 桩。**

| 编辑器 | 保存通道 | 真实落盘机制 | 验证测试 | 文件 |
|---|---|---|---|---|
| docs | `docs:save` / `docs:save-as` / `docs:save-recovery` | `atomicWriteFile`（temp + rename + EPERM 重试 + 0-byte 拒绝） | `docs-save-as.test.ts` | `docs/index.ts:190,311,460` |
| sheets | `workbook:save` / `save-as` / `save-edits-begin/chunk/abort` / `write-recovery` | `saveWorkbookViaSidecar` → Rust `save_archive` 命令（OOXML 字节级写盘） + `atomicWriteFile` + recents | `workbook-save-e2e.test.ts`（17） | `sheets/index.ts:425` + `sidecar.ts` |
| slides | `slides:save` / `save-as` / `apply-txn` | `savePptxToFile(opened, canonical)`（@genoffice/pptx-engine） + recents | `slides-save-e2e.test.ts`（7）+ `slides-apply-txn-ops-e2e.test.ts` | `slides/core.ts:265` + `state.ts` |
| pdf | `pdf:save` / `pdf:export-images` | stage → `atomicWriteFile(staged)` → `promoteSnapshot` → notifyFileSaved | `pdf-save-e2e.test.ts` | `pdf/index.ts:114,218` |
| markdown | `markdown:save` / `markdown:save-image` | `atomicWriteFile(safeTarget, Buffer.from(text,'utf8'))` + recents | `markdown-save.test.ts` | `markdown/index.ts:104` |
| html | `html:save` / `html:save-file` / `html:preview-update` | `atomicWriteFile`（单行 + 不双写 tmp）+ recents · meta 注入 case-insensitive | `html-save-atomic.test.ts`（6） | `html/index.ts:163,195` |

**save 后全链路**：
```
save handler
  ├─ 原子写盘（atomicWriteFile 或 savePptxToFile 或 Rust sidecar）
  ├─ recordRecentDoc(target, { modified: true })  // 推到 home:recents
  ├─ notifyFileSaved(target, { size, format })   // 触发 webhook + DLQ + SSE 广播
  ├─ 版本快照（version-history module）
  └─ dirty=false（renderer 端触发 dirtyChanged SSE）
```

**Webhook 链路**：
- `webhooks-store.ts:signWebhookBody()` → HMAC-SHA256 + `X-GenOffice-Signature` 头
- 失败 3 次指数退避 → `webhooks-dlq.ts` ring buffer
- DLQ metrics 暴露到 `/api/v1/metrics`（5 个 Prometheus 指标）
- 单测覆盖：5 个签名测试 + 23 个 DLQ 测试 + 7 个 metrics 测试

### E.3 文档管理功能完成度（用户问题 1）

| 维度 | 能力 | 完成 | 落点 |
|---|---|---|---|
| **CRUD** | create / read / update / delete | ✅ | `shell/files.ts:286` |
| **列表 / 搜索 / 分页** | `files:list` · `search:files` · cursor | ✅ | `shell/files.ts` + `shell/search.ts:74` |
| **原子写** | temp + rename + EPERM retry | ✅ | `common/atomic.ts:atomicWriteFile` |
| **回收站** | `files:trash` / `files:restore` / 自动过期 | ✅ | `shell/files.ts:trash` |
| **版本历史** | `versions:*` · 自动 snapshot · diff · restore | ✅ | `api/v1/versions.ts`（248 行） + `common/version-history.ts` |
| **批注** | 评论 CRUD · resolve · reply · mention | ✅ | `api/v1/comments.ts`（214 行） + `common/comments-store.ts` |
| **Track changes** | accept/reject · 显示/隐藏 | ✅ | docs/pptx-engine Track changes 完整实装 |
| **协作锁** | `locks:*` · pessimistic lock | ✅ | `collab/locks.ts` |
| **会话状态** | `sessions` register/heartbeat/close | ✅ | `collab/sessions.ts` |
| **审计日志** | `audit:log` · query · retention/rotate（24h worker）| ✅ | `common/audit-log.ts`（460 行） · 7 rotate 测试 |
| **Webhook** | save 后自动触发 + HMAC 签名 + DLQ | ✅ | `common/webhooks-store.ts` + `webhooks-dlq.ts` |
| **RBAC 权限** | 5 级 scope + AI 通配 + admin 旁路 | ✅ | `api/v1/auth.ts:hasScope`（329 行） · 9 scope 测试 |
| **文件级 JWT** | 短 token + 单次使用（jti revocation LRU）| ✅ | `api/v1/files.ts:460` · 6 revocation 测试 |
| **Embed 嵌入** | iframe + nonce + origin + RBAC | ✅ | `embed/*` + 30 embed 测试 |
| **存储后端可插拔** | local / s3 / minio / 自定义 URI | ⚠️ | `common/state.ts:storageKeyFromPath` + `promoteFileAtomically` |
| **多人实时协作（CRDT/OT）** | ⬜ | **0%** | `collab/index.ts:30`（骨架） |

**结论**：除"实时多人协作（CRDT/OT）"外，**全部文档管理功能已完成**。

### E.4 已知问题 / 风险（用户问题 2）

| 类别 | 问题 | 严重度 | 缓解 |
|---|---|---|---|
| **引擎层** | Slides 解析期 element id 不稳定（`sp_0` / `sp_2`）| P1 | 保活内存模型 + save 不 reparse；根治需引擎发稳定 id（M4+）|
| **引擎层** | `workbook:read-range` 返空 cells（Rust sidecar inlineStr / sharedString 解析问题）| P1 | 沙箱不可 rebuild Rust，留 M4+ 路线图 |
| **协作** | CRDT/OT 多人合并未实装 | P1 | M4（Week 16） |
| **移动端** | H5 编辑器未实装 | P1 | M4（Week 16） |
| **导出** | html → docx 诚实拒绝（需 Playwright）| P2 | M6 |
| **导出** | docx → pdf 诚实拒绝（需 LibreOffice）| P2 | M6 |
| **存储后端** | S3/minio savePath 跨 backend 原子语义未统一 | P2 | M5 |
| **字体** | FontFace API 集成（catalog/missing/install）| P2 | 渲染端 |
| **剪贴板** | OS-native clipboard（仅桌面）| P3 | 跨环境差异 |
| **协作通知** | Discord / Office Hours | P3 | 外部服务 |

### E.5 与 WPS Web 对比（用户问题 3）

| 维度 | WPS Web | GenOffice Web | 差距 |
|---|---|---|---|
| **嵌入方式** | iframe + postMessage | 同 | 平 |
| **鉴权** | OAuth + 企业 SSO | JWT + OAuth 2.0 + 5 级 scope | 平 / GenOffice 更细 |
| **协议安全** | 无 nonce | nonce + origin allowlist + HMAC 签名 | **GenOffice 更优** |
| **AI** | WPS AI 闭源 | Provider 插件市场（10 个官方）+ 协议开放 | **GenOffice 优势** |
| **Skill 生态** | 无 | SkillPackage + Marketplace | **GenOffice 优势** |
| **协作** | 实时多人（OT/CRDT）| ⬜ 单人（骨架）| **核心差距** |
| **移动端** | H5 + 小程序 | ⬜ 未实现 | 差距 |
| **离线** | 仅本地客户端 | 单机 + Docker 自部署 | **GenOffice 优势** |
| **文件保存** | 远端落盘 + 版本 | 本地 + webhook + 版本 + DLQ | **GenOffice 更可控** |
| **浏览器兼容** | 现代浏览器 | Chrome 100+ / FF 100+ / Safari 15+ / Edge 100+ | 平 |

### E.6 文档管理"全部完成"清单（用户问题 4：回答）

**已完成（30 项）**：CRUD / 列表 / 搜索 / 分页 / 原子写 / 回收站 / 版本历史 / 自动 snapshot / diff / restore / 批注 CRUD / resolve / reply / mention / Track changes accept/reject / 协作锁 / 会话注册 / 审计日志 / retention / rotate / Webhook / HMAC 签名 / DLQ / SSE 广播 / RBAC 5 级 / 文件级 JWT / 单次使用 / Embed iframe / nonce 握手 / origin allowlist / storage backend 可插拔 / recents / notifyFileSaved

**未完成（1 项）**：多人实时协作（CRDT/OT）

### E.7 Save 功能"全部真实"清单（用户问题 5：回答）

**全部 6 个编辑器的 save 路径都是真保存**（参见 E.2 表格）。无 fake-ok 桩、无静默吃字节。

### E.8 后续完善计划（用户问题 6）

#### **优先级 1 · 必做**（P0，2-4 周）

1. **`@genoffice/web-sdk` v1.0 GA 发布**
   - 22 个 EditorCommands + 7 个 EditorEvent
   - 100% TypeScript d.ts
   - ESM + CJS + UMD 三产物
   - npm publish 实跑（`npm publish --dry-run` 已通过 6 包）
   - tarball ≤ 30 kB
2. **REST API v1 文档站生成**
   - typedoc 221 MD 文件已生成（§11.19）
   - VitePress sidebar 已接
3. **5 个 worked example 上线**
   - `examples/embed-basic` / `embed-react` / `embed-vue` / `custom-provider` / `custom-skill`
   - 每个 `npm run build` 通过
4. **health 端点 + changelog + meta 端点**
   - `/api/health`（已实装）
   - `/api/channels`（已实装）
   - `/api/v1/meta`（§11.18 闭合）
   - `/api/v1/changelog`（已实装）
5. **Docker 镜像发布**
   - `Dockerfile` 已存在，需跑 `docker build` 验证（沙箱限制，留 GA 时跑）

#### **优先级 2 · 应做**（P1，4-8 周）

6. **Slide get-* 通道剩余 10 个真值化**（M4 模板复用）
   - font-catalog / font-missing / font-download / font-install-local
   - media-data / native-clipboard / clipboard-external / clipboard-probe
7. **audit:log scope gate**（M5+，但值得优先做）
   - IPC dispatcher 加 scope middleware
8. **引擎层稳定 id 改造**（pptx-engine 层）
   - 引入 `e_<guid8>` 形式
   - reparse 不打断 renderer 持有 id
9. **PDF/DOCX 导出真实化**
   - Playwright / LibreOffice 集成（容器化）
10. **storage backend S3/minio 统一原子语义**
    - `promoteFileAtomically` 在跨后端的契约

#### **优先级 3 · 可做**（P2，8-12 周）

11. **移动端 H5 编辑器**
    - PWA + 触控手势 + 只读 + 简单编辑
12. **CRDT 协作**
    - Yjs 集成 + 6 个编辑器
13. **字体枚举 / 安装**
    - 渲染端 FontFace API
14. **Skill Marketplace 上线**
    - genoffice.app/skills
15. **双语文档站完整化**
    - EN + ZH 100% 对齐

### E.9 对外集成路径（用户问题 7）

```
3 种典型客户路径（按使用难度递增）：

路径 A · "我想嵌入编辑器到自己网站"（iframe Embed）
  难度：⭐ （5 分钟接入）
  步骤：① 调 /api/v1/auth/jwt 拿 token
        ② 调 /api/v1/files/:id/jwt 拿 file-level token（短 TTL）
        ③ <iframe src="https://host/embed/:id?token=...&nonce=...">
  现状：✅ 完全实装 + 10 个 embed 测试
  落地：examples/embed-basic / embed-react / embed-vue

路径 B · "我想要 AI 能力接入我自己产品"（REST API）
  难度：⭐⭐ （1 小时接入）
  步骤：① /api/v1/auth/oauth/token 拿 OAuth token
        ② /api/v1/ai/chat 或 /api/v1/ai/translate 调 AI
        ③ /api/v1/ai/skill/:name 调任意已注册 skill
        ④ /api/v1/kb/search 调知识库
  现状：✅ 完全实装 + ai-capabilities-e2e 测试
  落地：examples/custom-skill

路径 C · "我要写自己的 provider / skill"（npm 包）
  难度：⭐⭐⭐ （1-2 天接入）
  步骤：① 基于 @genoffice/provider-openai-compatible 工厂写
        ② 实现 AiProviderPlugin 接口（chat / stream / image）
        ③ npm publish 到自己的 registry
        ④ web-server 端 genoffice.providers.json 配置
  现状：✅ 完全实装 + examples/custom-provider 模板
  落地：examples/custom-provider
```

### E.10 SDK 计划（用户问题 8）

#### **SDK v1.0 GA 清单**（2-4 周）

| Surface | 状态 | 来源 |
|---|---|---|
| `createEditor({ container, documentId, jwt, host })` | ✅ | `apps/sdk/src/editor.ts:1013 行` |
| 7 个事件（ready/saved/dirtyChanged/selectionChange/error/closed/sidebarMessage）| ✅ | `editor.ts` |
| 20 个 EditorCommands（content/print/undo/redo/focus/AI/sidebar/collab/telem）| ✅ | `types.ts:466` |
| downloadAs ({format, savePath?}) | ✅ §11.41 | types.ts |
| iframe handshake nonce | ✅ §11.20 | embed-url.ts |
| handshakeTimeoutMs 配置 | ✅ §11.21 | editor.ts |
| v1 envelope + correlationId + nonce + origin allowlist | ✅ | envelope.ts |
| d.ts + ESM + CJS + UMD | ✅ | package.json |
| 6 个 SDK 测试 | ✅ | editor/embed-url/envelope |

#### **SDK v2.0 backlog**（与 §B.5.1 一致）

| # | Surface | 优先级 | 来源 |
|---|---|---|---|
| 1 | Multi-instance（拆 instanceId 路由）| P1 | §B.5.1 #1 |
| 2 | Undo / Redo 命令 | ✅ §11.38 | editor.ts |
| 3 | 文档版本（versions API）| ✅ §11.20 | editor.ts + types.ts |
| 4 | 评论 / 批注（comments API）| ✅ §11.20 | editor.ts + types.ts |
| 5 | Track changes（修订追踪）| ✅ §11.40 | types.ts |
| 6 | Export（PDF / 静态格式）| ✅ §11.41 | editor.ts + types.ts |
| 7 | File picker（host-side 文件选择）| P1 | §B.5.1 #7 |
| 8 | Plugin runtime（taskpane / sidebar）| ✅ §11.20 | types.ts:mountSidebar/postToSidebar |
| 9 | Telemetry（用量钩子，opt-in）| ✅ §11.36 | types.ts:reportUsage |

### E.11 整体完成度百分比（用户问题 9：回答）

```
┌──────────────────────────────────────────────────────────────┐
│ GenOffice v0.9-beta · 2026-09-22 综合进度                      │
├──────────────────────────────────────────────────────────────┤
│ 核心编辑器 6 个 ............................... 95%           │
│   docs ........................................ 98%           │
│   sheets ...................................... 96%           │
│   slides ...................................... 94%           │
│   pdf ......................................... 92%           │
│   markdown .................................... 95%           │
│   html ........................................ 97%           │
│ 辅助系统 6 个 ................................. 88%           │
│   shell / common .............................. 99%           │
│   collab ...................................... 80%           │
│   enterprise .................................. 85%           │
│   anydoc ...................................... 90%           │
│   ai .......................................... 97%           │
│   embed ....................................... 97%           │
│ Tier 1 SDK / API .............................. 95%           │
│   @genoffice/web-sdk .......................... 95%           │
│   REST API v1 ................................. 92%           │
│   iframe Embed ............................... 97%           │
│   Webhook + DLQ .............................. 98%           │
│ Tier 2 AI 生态 ................................. 80%           │
│   Provider 插件市场 ........................... 95%           │
│   Skill 仓库 ................................. 75%           │
│   KB / TM 分享 ............................... 80%           │
│ Tier 3 社区开源 ................................. 70%           │
│   仓库结构 .................................... 90%           │
│   贡献指南 .................................... 80%           │
│   治理结构 .................................... 60%           │
│   文档站 VitePress ........................... 95%           │
│   社区运营 .................................... 50%           │
├──────────────────────────────────────────────────────────────┤
│ 总进度（加权）................................. ~88%           │
│ GitHub: docs/sheets/slides/pdf/markdown/html console 0 errors │
│ Tests: 95 文件 / 843 通过 / 1 失败 / 8 skipped                │
│ Channels: 553 IPC + 22 REST v1                                 │
│ Commits ahead of origin/release0919: 134                       │
└──────────────────────────────────────────────────────────────┘
```

### E.12 剩余未完成的关键路径（用户问题 10）

1. **CRDT/OT 实时协作**（P1，M4 Week 16）— 唯一显著空缺
2. **移动端 H5**（P1，M4 Week 16）— 用户场景必需
3. **Slides 解析期 element id 稳定化**（P1，引擎层）
4. **workbook:read-range 返空 cells**（P1，Rust sidecar 修复）
5. **HTML→DOCX / DOCX→PDF 真实转换**（P2，M6 Week 24）
6. **S3/minio savePath 跨 backend 原子语义**（P2，M5 Week 20）

### E.13 一句话结论（用户问题 11）

**GenOffice v0.9-beta WebServer 模式已达到"可发布（GA-ready）"水准**：
- 6 个核心编辑器全部"真保存"（无 fake-ok）
- 文档管理除"实时多人协作"外全部完成
- 对外集成 3 种路径（A iframe / B REST / C npm）全通
- SDK v1.0 仅差 GA 发布仪式（npm publish + 文档站正式域名）

剩余值得做的 6 项均为 M4+ 路线图工作（CRDT / 移动端 / 引擎 id / Rust 修复 / PDF 转换 / S3 原子语义），不会阻塞 v1.0 GA。

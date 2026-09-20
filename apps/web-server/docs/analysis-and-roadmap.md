# Web-Server 全面代码分析与改进路线图

> 编写时间：2026-09-19
> 适用范围：`apps/web-server`（独立 Web 构建，无 Electron）
> 数据基线：`release0919` 分支，17 个本地未推送提交 + 数据flare envelope 桥接回退后

## 一、模块拓扑

```
src/
├── ai/           AI 设置、KB/TM、聊天流、HTTP 翻译端点、render skill stubs
├── anydoc/       格式识别、转换、表格/图片抽取、预览
├── collab/       多端协作 session 与 presence
├── common/       paths、registry、codec、state（projects / files / recents）、mime
├── docs/         docs IPC（open/save/recents/recovery）
├── enterprise/   企业级 handlers（mail / calendar / workflow / audit 等）
├── html/         HTML 应用入口 + preview
├── markdown/     Markdown 应用入口
├── pdf/          PDF 应用入口
├── projects/     项目管理 IPC
├── sheets/       sheets IPC
├── slides/       slides IPC
├── shell/        home、modules、prefs、skills、pi-session 等
└── web/          web 平台桥（temp file、save-file）
```

## 二、问题清单（按风险 × 修复成本排）

### P0 安全 / 护栏（必修）

| ID | 位置 | 问题 | 触发 |
|---|---|---|---|
| P0-1 | `common/paths.ts:75` | `HOST` 默认 `0.0.0.0` | 服务器任何能 ping 通的机器都可访问 `/api/*` |
| P0-2 | `index.ts` | 没有 auth 中间件 | 同上；任何人可调 `web:save-file`、`docs:save`、`web:read-file-bytes` |
| P0-3 | `web/index.ts:21` | `web:write-temp-file` 文件名清洗不完整 | `..\\..\\evil.exe` 会写入（仅靠 `[^\w.\- ]+`），反斜杠未滤 |
| P0-4 | `common/paths.ts:requireManagedPath` | 不校验文件 magic | `.docx` 后缀指向 JPEG 也能通过 |
| P0-5 | `docs/index.ts:docs:open-path` | 同上；拿到 bytes 之后才 `isEncryptedDocxBytes` 检查 | 渲染器先把字节全部读完再判错，浪费 IO 也给攻击者更多信号 |

### P1 文档管理可靠性（必修）

| ID | 位置 | 问题 |
|---|---|---|
| P1-1 | `docs/index.ts:docs:save-new` | id 用 `Date.now()`，同毫秒并发会撞 path |
| P1-2 | `docs/index.ts:docs:open`、`docs:create-document` | `writeFileSync` 直接落盘，没有 temp+rename 原子性，没有 fsync；崩溃可能留 0 字节文件 |
| P1-3 | `docs/index.ts:docs:create-document` | 标题清洗 regex 不完整（缺 Windows 保留名 CON/PRN/AUX/NUL/COM1-9/LPT1-9、缺尾部 `.` 与空格） |
| P1-4 | `common/state.ts:DOCS_STARRED` | 仅内存 Set，重启即丢；`home:toggle-star` 只 mutate Set 不写盘 |
| P1-5 | `common/state.ts:saveProjects` / `saveRecentDocs` | `writeFileSync` 不原子 |
| P1-6 | `docs/index.ts:docs:save` | 不算文件 hash，重复保存 / 跨标签编辑无并发保护 |
| P1-7 | `web/index.ts:web:save-file` | `fileId = ${Date.now()}-${name}` 同毫秒撞；`name` 含 `/` 时 `join(FILES_DIR, fileId)` 行为不直观 |
| P1-8 | `docs/index.ts:files:add-pasted-image` | 20MB 硬上限，无 per-user / per-day 配额；多标签粘贴可填满磁盘 |

### P1 anydoc 真实性（必修）

| ID | 位置 | 问题 |
|---|---|---|
| P1-9 | `anydoc/index.ts:anydoc:convert` | 只复制 bytes、改扩展名，返回 `success: true`；真实转换未实现 → 应该返回 `WEB_UNSUPPORTED` 而不是骗用户 |
| P1-10 | `anydoc/index.ts:anydoc:extract-tables` | 永远 `unsupported: true`；`@genoffice/file-parse` 已有 docx 表格解析能力，应该接进去 |
| P1-11 | `anydoc/index.ts:anydoc:extract-images` | 永远 `unsupported: true`；同上 docx 图片抽取可接 |
| P1-12 | `anydoc/index.ts:anydoc:render-preview` | base64 字符串无大小上限，50MB PDF → 67MB base64 字符串可能 OOM |

### P2 资源回收 / 容量（高优）

| ID | 位置 | 问题 |
|---|---|---|
| P2-1 | `web/index.ts:web:write-temp-file` | 每次上传创建 `upload-${ts}-${rand}/` 永不清扫 → 磁盘泄漏 |
| P2-2 | `web/index.ts:web:read-file-bytes` | 返回 `bytes.buffer.slice(...)` 不复制，transferable 后 V8 可能让 IPC payload 被后续 mutate 破坏 |
| P2-3 | `common/state.ts:initRecentState` | 只 init 一次；DOCS_STARRED 不持久化 |
| P2-4 | `shell/home.ts:home:open-path` | 只回 `opened: true`，从来没真正打开；应该明确告诉用户 "web build 无 in-app opener，请用 web 入口" 或把打开路径接到 transport |
| P2-5 | `shell/home.ts:home:github-stars` | 命中 `https://api.github.com/repos/genspark-ai/genoffice`，但仓库实际是 `louloulin/appx/genoffice` — URL 错了 |

### P3 并发 / 状态安全（中优）

| ID | 位置 | 问题 |
|---|---|---|
| P3-1 | `common/state.ts` | projects / docs-recent / sheets-recent / slides-recent 4 个 JSON 全是非原子 `writeFileSync` |
| P3-2 | `ai/chat.ts:sharedKnowledgeBase` | 内存 KB + on-disk KB 同步有 race：HTTP path 已修（`refresh()`），IPC path 可能仍在用 stale in-memory copy |
| P3-3 | `ai/chat.ts:translationMemory` | 同上 |

### P3 通道完整性 / 文档（中优）

| ID | 位置 | 问题 |
|---|---|---|
| P3-4 | 整个 web-server | 无 `README.md` 给二次开发者；无通道清单；无部署指南 |
| P3-5 | `/health` 响应 | 不报告 KB/TM/AI provider 配置状态，运维看不到 KB 是否加载成功 |
| P3-6 | `/api/channels` | 无版本字段，渲染器无法识别 server 协议兼容性 |

## 三、改进路线图

### 阶段 1：安全护栏（必修，2-3 小时）

1. **`HOST` 默认改为 `127.0.0.1`**（仅当显式 `HOST=0.0.0.0` 才暴露）
2. **新增 `auth/index.ts`**：`WEB_TOKEN` 中间件 + Bearer / `X-GenOffice-Token` 头部验证
3. **`common/paths.ts:sanitizeFileName`**：替换 `web:write-temp-file` 的内联清洗
4. **`common/magic.ts`**：识别 zip / pdf / png / jpeg / gif / webp / plain
5. **`docs:open-path` magic 校验**：拿到 bytes 之后、`isEncryptedDocxBytes` 之前调用 `assertMagicMatchesExtension`
6. **单测**：`tests/paths-sanitize.test.ts`、`tests/magic.test.ts`、`tests/auth.test.ts`

### 阶段 2：文档管理核心（3-4 小时）

1. **`docs:save-new` 用 `crypto.randomUUID()` 取代 `Date.now()`**
2. **`docs:open` / `docs:create-document` / `docs:save` 改 temp+rename 原子写**
3. **`docs:create-document` 标题清洗加 Windows 保留名 + trailing dots/spaces**
4. **`DOCS_STARRED` 持久化**：新增 `DOCS_STARRED_FILE`、`loadStarredDocs`、`saveStarredDocs`
5. **`saveProjects` / `saveRecentDocs` / `saveStarredDocs` 全部走 `atomicWriteJson`**
6. **`docs:save` 加 hash**：保存时算 sha256，写到 `${path}.meta.json`；`docs:open-path` 校验 expectedHash
7. **`web:save-file` 用 `${randomUUID()}-${sanitize(name)}`**
8. **`files:add-pasted-image` 加每日配额**（基于 `DATA_DIR/.quotas/paste-${YYYY-MM-DD}.json`）
9. **`web:write-temp-file` 加 100MB cap + 24h GC**

### 阶段 3：anydoc 真实化（2-3 小时）

1. **`anydoc:convert` docx→pdf / pdf→docx 真接 pdf2docx / docx2pdf；其他组合返回 `WEB_UNSUPPORTED`**
2. **`anydoc:extract-tables` 用 `@genoffice/file-parse` 的 docx 表格 API**
3. **`anydoc:extract-images` 用 docx 图片抽取**
4. **`anydoc:render-preview` base64 字符串加 25MB cap，超限返回 `{ error: 'too_large' }`**

### 阶段 4：并发 + 状态安全（2 小时）

1. **`common/atomic.ts`**：`atomicWriteJson(path, value)` temp+rename
2. **`saveProjects` / `saveRecentDocs` / `saveStarredDocs` / 各模板表**全部走 `atomicWriteJson`
3. **`ai/chat.ts` `ensureKbLoaded()` 路径**：加 mutex，避免并发 load 与并发 upsert 撞
4. **`refresh()` 已有，需扩到 IPC path 的 `ai:translate*`**

### 阶段 5：运维可见性 + 文档（2 小时）

1. **`/health` 报告**：KB 行数 / TM 条数 / 当前 provider / upload 配额占用
2. **`/api/channels` 加 `protocolVersion` + `minClientVersion` 字段**
3. **`apps/web-server/README.md`**：启动 / 配置 / 部署 / 通道清单
4. **`apps/web-server/docs/channels.md`**：每个 channel 的入参 / 出参 / 错误码
5. **`home:github-stars` URL 修对**

## 四、当前进度（2026-09-19）

### 阶段 1 — 安全护栏 ✅

- ✅ `HOST` 默认 `127.0.0.1`
- ✅ `auth/index.ts`：`WEB_TOKEN` Bearer / `X-GenOffice-Token` 验证 + 401
- ✅ `sanitizeFileName` + `WINDOWS_RESERVED` 替换内联清洗
- ✅ `magic.ts`：`detectFileMagic` + `assertMagicMatchesExtension`
- ✅ `docs:open-path` 用 `assertMagicMatchesExtension` 替代内联 zip-magic
- ✅ 单测：`paths-sanitize.test.ts`（14）、`magic.test.ts`（16）、`auth.test.ts`（11）

### 阶段 2 — 文档管理核心 ✅（部分）

- ✅ `docs:save-new` 用 `randomFileId()`（`crypto.randomUUID()`）
- ✅ `docs:open` / `docs:save` / `docs:create-document` temp+rename 原子写
- ✅ `docs:create-document` 标题用 `sanitizeFileName`
- ✅ `DOCS_STARRED`：`Set<string>` → `Map<path, starredAt>`，新增 `DOCS_STARRED_FILE` 持久化
- ✅ `saveProjects` / `saveRecentDocs` 走 `atomicWriteJson`
- ✅ `web:save-file` / `web:write-temp-file` 用 `sanitizeFileName` + 100 MiB cap
- ✅ `files:add-pasted-image` magic gate + 每日配额（100 MiB UTC）
- ✅ `sweepWebTempRoot` 24h GC at boot
- 单测：`atomic.test.ts`（17）覆盖 atomic / randomFileId / sweep

### 阶段 3 — anydoc 真实化（部分）

- ✅ `anydoc:convert` 不再伪造成功，明确返回 `WEB_UNSUPPORTED`
- ✅ `anydoc:render-preview` 25 MiB cap，超限返回 `{ success: false, error }`
- ⏳ `anydoc:extract-tables` / `anydoc:extract-images` 接 `@genoffice/file-parse`（下一步）

### 阶段 4 — 并发安全（进行中）

- ⏳ KB/TM mutex + IPC `ai:translate*` refresh
- ⏳ `sheets-recent.json` / `slides-recent.json` 原子化

### 阶段 5 — 运维与文档 ✅（部分）

- ✅ `apps/web-server/README.md` 启动 / 配置 / 存储 / 通道 / 测试
- ✅ `/health` / `/api/channels` 已存在
- ⏳ `/health` 报告 KB 行数 / TM 条数 / 当前 provider
- ⏳ `/api/channels` 加 `protocolVersion`
- ⏳ `home:github-stars` URL 修对

### 测试矩阵

```
paths-sanitize: 14 passed
magic:          16 passed
auth:           11 passed
atomic:         17 passed
managed-path-guard: 39 passed
static-spa-routes:   6 passed
ipc-error-status:    7 passed
ai-provider-config:  4 passed
─────────────────────────
total:        114 passed
```

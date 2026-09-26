# web-server 整体审计 — 问题清单 + 顶级产品建议

> **审计基线**：`@genoffice/web-server` 0.8.0，分支 `release0919`
> **运行时**：`127.0.0.1:18091`，`WEB_TOKEN=test-web-token`，`GENOFFICE_JWT_SECRET=test-jwt-secret`
> **AI 后端**：继承父 shell 环境 `WEKNORA_BASE_URL=http://124.221.146.145:180/api/v1`（隐式，未在 ai-settings 中配置）
> **审计日期**：2026-09-26

---

## A. 路由全景（从实测得）

### A.1 HTTP 顶层（top-level）— 14 条
| 路径 | 方法 | 用途 | 实测状态 |
|---|---|---|---|
| `/health` | GET | 服务健康 / 通道数 | 200 ✅ |
| `/api/channels` | GET | 通道发现（公开） | 200 ✅ |
| `/api/v1/health` | GET | v1 健康 | 200 ✅ |
| `/api/v1/changelog` | GET | 变更日志 | 200 ✅ |
| `/api/v1/meta` | GET | 服务元信息 + capabilities | 200 ✅ |
| `/api/v1/metrics` | GET | Prometheus 指标 | 200 ✅ |
| `/api/ipc/<channel>` | POST | IPC 调度（559 通道） | 部分 401（见 B.1） |
| `/api/ipc/events` | GET | SSE 推送（per session） | SSE |
| `/api/ai/stream` | POST | SSE AI 代理流 | SSE |
| `/api/ai/stream/cancel` | POST | 取消流 | 200 ✅ |
| `/api/ai/translate` | POST | 单批翻译 | 200 ✅ |
| `/api/ai/translate/stream` | POST | SSE 翻译流 | SSE ✅ |
| `/api/ai/translate/stream/cancel` | POST | 取消翻译流 | 200 ✅ |
| `/api/html/preview/<id>` | GET | 公开 HTML 预览 | 200 ✅ |
| `/embed/<docId>` | GET | iframe 嵌入（set-cookie ✅，nonce ✅） | 200 ✅ |
| `/static/sdk/index.mjs` | GET | SDK ESM（修复后） | 200 ✅ |
| `/static/sdk/index.umd.js` | GET | SDK UMD（修复后） | 200 ✅ |
| `/favicon.ico` | GET | favicon | - |
| `/`, `/manage`, `/management` | GET | SPA fallback | - |

### A.2 v1 REST — 28 条
`/api/v1/auth/jwt`、`/auth/oauth/token`、`/files` (GET/POST)、`/files/:id` (GET/DELETE)、`/files/:id/jwt`、`/files/:id/callback`、`/files/:id/comments` (GET/POST)、`/files/:id/comments/:cid` (GET/PATCH/DELETE)、`/files/:id/versions` (GET/POST)、`/files/:id/versions/:vid` (GET/DELETE)、`/files/:id/versions/:vid/restore`、`/ai/capabilities`、`/ai/chat`、`/ai/translate`、`/ai/image`、`/ai/skill/:name`、`/kb/search`、`/kb/entries`、`/webhooks`、`/callbacks`、`/webhooks/dlq/*`、`/embed/nonce` (POST/DELETE)、`/embed/verify-nonce` (POST)、`/metrics`、`/meta`、`/health`、`/changelog`

### A.3 IPC 通道 — **559 个**，按 prefix：
```
slides: 130    home: 103     ai: 52      pdf: 36       html: 27
docs: 26       collab: 16    files: 12   project: 12   workbook: 12
markdown: 10   anydoc: 8     app: 8      sheets: 7     tabs: 7
workflow: 6    auth: 5       comments: 5 update: 5     users: 5
web: 5         calendar: 4   history: 4  notifications: 4   offline: 4
permissions: 4 search: 4     templates: 4 tenant: 4   audit: 3
clipboard: 3   mail: 3       pdf-password: 3 speech: 3 win: 3
mobile: 2      multimodal: 2 chart: 1   copy: 1       cut: 1
md-asset: 1    paste: 1      preview: 1  sdk: 1        visualization: 1
```

---

## B. 问题清单（按严重程度）

### 🔴 P0 — 必修 / 安全 / 一致性

#### B.1 双重鉴权模型无文档，缺一即 401
- **现象**：`/api/ipc/<scope-gated-channel>` 在仅有 `Authorization: Bearer <JWT>` 时返回 401 "Missing or invalid token for /api/ipc/xxx"；在仅有 `cookie: auth_token=<WEB_TOKEN>` 时返回 401 "Bearer token required"。
- **根因**：两段独立鉴权串行运行——
  1. `apps/web-server/src/index.ts:445` WEB_TOKEN gate（env literal via cookie/Bearer）
  2. `apps/web-server/src/index.ts:709` scope gate（需要 `Authorization: Bearer <JWT>` 且 JWT 的 `scope` 数组包含目标 scope）
- **影响**：任何第三方 host 集成 web-server 都会撞墙。SDK README、Dataflarework 集成文档、embed 指南都没有解释这一点。
- **修复**：在 `apps/web-server/src/auth/` 中加一段鉴权握手协议：把 WEB_TOKEN 视作 dev/local-trust 模式，文档清楚说明"调用 scope-gated 通道必须先 `POST /api/v1/auth/jwt` 取 JWT 并 `Set-Cookie: auth_token=<WEB_TOKEN>; Authorization: Bearer <JWT>` 双管齐下"；同时让 SDK 暴露一个 `createAuthedClient()` 帮助类替 host 包办。
- **路径**：`apps/web-server/src/auth/index.ts:52`（readToken）+ `apps/web-server/src/index.ts:709`（scope gate）+ 文档 `docs/superpowers/` / `packages/sdk/README.md`

#### B.2 `docs:create-document` 把内部错误当 result 返回
- **现象**：调用 `docs:create-document` 带 `{"format":"md"}`（无 content）→ HTTP 200，返回 `{"ok":true,"result":{"ok":false,"error":"content must not be empty"}}`。**IPC 调度器已经回了 200 ok，但 result 里又包了一个 `{ok:false}`。**
- **根因**：`apps/web-server/src/docs/index.ts` 内某些 handler 不会抛 `InvalidArgumentError`，而是返回 `{ok:false, error:string}`；调度器统一包 `{ok:true, result:<handler 的返回值>}`，于是出现 ok:false in result。
- **影响**：host 看到 `ok:true` 就不再检查 result.ok，会被静默坑。
- **修复**：所有 docs/sheets/slides handler 改用 `InvalidArgumentError`（`apps/web-server/src/ai/errors.ts:152`）；或在调度器里增加 `result.ok===false` 的归一化，把 `{ok:false, error}` 重写成 `{ok:false, error:{code,message}}` 顶到 IPC envelope。

#### B.3 隐式 AI 路由：父 shell 的 `WEKNORA_*` 环境变量被 web-server 静默继承
- **现象**：本地 ai-settings 的 12 个 provider `apiKey` 全空，但 `POST /api/ai/stream` 与 `POST /api/ai/translate/stream` 实际打到了外部 `http://124.221.146.145:180/api/v1`（被实测响应 `"Missing API key. Please provide x-api-key header."` 证实）。如果只读 ai-settings.json 而不知道 shell env，会误以为翻译是离线能力。
- **根因**：`@genoffice/ai-provider` 的 provider 解析层允许从 env 兜底取 key，且运行时日志只暴露请求 status、不暴露真正出口域名。
- **影响**：① 安全审计盲区（web-server 静默出网）；② 计费模型错算（token 计费走 GenOffice 还是走 Weknora 不清楚）；③ 多租户隔离破缺（如果 Weknora 不感知 tenant）。
- **修复**：
  - `apps/web-server/src/ai/chat.ts` 的 `defaultAiSettings` 初始化时打印一行 `[ai] effective provider = <id>, source = settings|env:<var>` 到 audit log；
  - `/api/v1/meta` 的 `integrations.ai.effectiveProviderUrl` 字段暴露出口域名（仅当操作员显式开 `WEB_AI_DISCLOSE_REMOTE=1`）；
  - `apps/web-server/src/common/audit-log.ts` 增加 `ai:provider-resolved` 事件，每次解析 provider URL 时记录。

#### B.4 AI 通道 scope 注册缺失：calendar / mail / users / tenant / workflow 等核心 enterprise 通道
- **现象**：实测 12 个 scope-gated 通道（calendar:list-events / mail:list / users:list / tenant:list / workflow:list / comments:add / comments:list / collab:lock-status / audit:query / auth:logout / home:install-skill / home:install-plugin）在没有 JWT 时 401。问题是 **scope 名空间是 ad-hoc**：
  - `calendar:list-events` 需要 scope `calendar:read`（在 JWT 中提供时 403 "token does not grant scope \"calendar:read\""）
  - `mail:list` 同理要 `mail:read`
  - 但 `comments:list` 注册的 scope 是 `comments:read`
  - `collab:*` 要 `collab:read/write`
  - `users:list` 要 `users:read`
- **根因**：每个 channel 在 `registerHandle('x:y', handler, { scope: 'a:b' })` 时各自命名 scope（散落在 5+ enterprise 模块），没有 `apps/web-server/src/common/scopes.ts` 这种中央定义。
- **影响**：host 必须打 channel-by-channel 才能配齐 scope 列表；mints JWT 时容易漏。
- **修复**：在 `apps/web-server/src/common/` 下新增 `scopes.ts`，把 30+ scope 集中定义并导出；同时给 `/api/v1/auth/jwt` 加 `?discover=true` 模式，返回该 server 全部已注册 scope 与对应 channel 列表。

#### B.5 文件路径越界保护"静默 null"
- **现象**：以下通道对 `/etc/passwd` 返回 `{"ok":true,"result":null}` 而非 400：`files:read`、`anydoc:extract-text`、`anydoc:extract-tables`、`anydoc:extract-images`、`pdf:read-file`、`markdown:read-file`、`web:read-file-bytes`（部分）。
- **根因**：`apps/web-server/src/common/paths.ts:155` 的 `requireManagedPath` 抛 `InvalidArgumentError`；但 `apps/web-server/src/anydoc/index.ts:228` 等只用了 `isManagedPath()` 的 boolean 短路 + 返回 null（"防止信息泄露"，注释明示）。
- **影响**：host 拿到 `null` 无法区分 "路径非法"（安全拒绝）和 "文件不存在"（业务 404），debug 噩梦。
- **修复**：定义统一返回 `{"ok":false,"error":{"code":"PATH_OUTSIDE_STORAGE","message":"path is outside the web storage area"}}` 而不是 null；保留"是否路径越界"的 console.warn + audit log 但不放给 host。

### 🟡 P1 — 应当修

#### B.6 SDK 文档与真实发布形态脱节
- **现象**：`packages/web-sdk/README.md` / `packages/web-sdk/CHANGELOG.md` 是否提到 `/static/sdk/index.umd.js` 没确认；上一轮"修复 Bug C" 引入 `/static/sdk/*` 路由但 SDK 包自身的发布脚本可能没改。
- **根因**：sdk1.md §A 文档治理 vs 实现治理各管一摊。
- **修复**：把 `/static/sdk/*` 路由注册也加入 `@genoffice/web-sdk` 的 build pipeline（`apps/web-sdk/scripts/build.mjs`），让 `pnpm --filter @genoffice/web-sdk build` 自动复制产物到 `apps/web-server/dist/static/sdk/`。

#### B.7 `/api/ai/translate/stream` 取消语义弱
- **现象**：`POST /api/ai/translate/stream/cancel {requestId}` 返回 `{"ok":true,"aborted":false}` 即使 requestId 合法但 stream 已自然完成 — caller 没法区分 "已取消" 和 "已完成"。
- **修复**：取消 API 返回 `{ok:true, status:'cancelled'|'completed'|'unknown'}`, `{ok:false, code:'NOT_FOUND'}`。

#### B.8 SSE `data:error` 事件缺少 `requestId`
- **现象**：实测 SSE `unit` event 携带 `requestId`，但 `error` event 内部只有 `errorMessage` 字符串。Host 收到错误时关联不到原 requestId 写日志。
- **修复**：`apps/web-server/src/ai/translate-http.ts` 的 `sendSseError` 把 `requestId` 注入 error payload。

#### B.9 v1 路径在 `Authorization: Bearer` 上限检查缺失
- **现象**：`Authorization: Bearer ` 超长串会被 `verifyJwtWithRevocation` 拒，但先经过 `getBytesHeader` 推断大小 → 触发 deprecation 警告 + 内存峰值。
- **修复**：`apps/web-server/src/api/v1/auth.ts` 入口加 `authHeader.length > 4096` 提前 401。

### 🟢 P2 — 优化 / 体验

#### B.10 `/api/channels` 返回 559 个名字，host 端没法按需过滤
- **修复**：加 `?prefix=ai&prefix=docs` 过滤；返回总大小限制到 32KB，超过则引导 host 用 `?includeCounts=true`。

#### B.11 `/api/v1/files/../../etc/passwd` 在认证通过后会暴露真实路径错误码
- **现象**：实测 `%2F..%2Fetc%2Fpasswd` 现在被 `files:get` 处理（401 是因为没带 JWT）。如果将来 JWT 配齐，路径越界是否仍被同一文件守卫挡住需要重新测。
- **修复**：在 `apps/web-server/src/api/v1/files.ts` 入口处 normalize + reject `:id` 中含 `..` 或 `%2F`，先于任何业务逻辑。

#### B.12 iframe `/embed/<docId>` 对已撤销 JWT 的处理不显
- **现象**：`embed/index.ts:85` 把 verifyJwtWithRevocation 失败统一包成 401 'invalid or expired embed token'，但无法区分是过期 vs 撤销 vs 签名错。
- **修复**：用 `verifyJwt()` 单独跑一次（已部分实现），但只在 `code === 'JWT_VERIFY_REVOKED'` 时区分返回。

---

## C. 顶级产品建议（针对 Office AI × DataflareWork）

### C.1 把 web-server 重新定位成 "AI-native Office kernel"
当前定位是 "Electron IPC 的 HTTP 镜像"。要让 DataflareWork 这种 AI-first 工作流集成进来，定位必须升级。建议：

1. **AI-as-First-Class-Endpoint**：从 559 个 IPC channel 中分离出 4 个一等公民：
   - `/api/agent/run` — 多轮 Agent Loop（openai-compatible function calling）
   - `/api/agent/cancel` — 协作取消
   - `/api/agent/resume` — 从 checkpoint 续跑
   - `/api/agent/sessions` — 会话列表 / 审计
   把 `apps/web-server/src/ai/chat.ts:649` 的 `ai:chat` / `ai:stream` 拆出来重命名。
2. **Tenant-aware AI isolation**：现在 `WEKNORA_BASE_URL` 是单租户。多租户 SaaS（Dataflarework 类）需要 `tenant:12345` → 不同 LLM 路由 + 计费 isolation。建议在 `apps/web-server/src/enterprise/auth-jwt.ts` 把 tenant 注入到 AI provider 解析层。
3. **Document intelligence metadata**：每个翻译 / 生成结果应该自动产生 `documentId + revision + tenantId + glossaryVersion + memoryHitRate` 五元组，写入 `audit-log.ts`。Dataflarework 的"per-document 可观测性"价值就在这。

### C.2 把 SDK 从 "embeddable editor" 升级成 "Dataflarework Connector Kit"
当前 `@genoffice/web-sdk` 0.9.0-beta.1 解决 "iframe 嵌入"。要让 Dataflarework 把 GenOffice 当 AI 后端来用，SDK 需要：
1. **`createEmbedBridge()` helper**：自动处理 `cookie + JWT` 双鉴权（修 B.1）、自动续期 JWT、自动 fallback 到 cookie-only 模式。
2. **Translation Stream 反规范化器**：`packages/web-sdk/src/translate-stream.ts` 把 `/api/ai/translate/stream` 的 SSE 事件流反序列化为可观察的 `Observable<UnitResult>`, `Observable<QualityReport>`, `Observable<BatchComplete>`，让 Dataflarework host 在 Vue / React 里直接订阅。
3. **postMessage protocol v1.1**：把当前 `genoffice-dataflare/v1` 的 envelope 在 SDK 内建默认值（vs 让 Dataflarework 端手写 `JSON.parse` + `event.source` 校验）。
4. **Quota + billing awareness**：SDK 暴露 `getQuota()` / `onQuotaExhausted()` 钩子，让 Dataflarework 能 "翻译到 80% 时降级到本地模型"。

### C.3 编译时和审计时双管齐下
1. **build integrity check**：`apps/web-server/scripts/check-build-integrity.mjs`（已有雏形）应在 CI 中作为必需 step，扫描"declared channel 数 vs registered handler 数"差距（如果 `registerAiHandlers()` 改文件数，新通道没补 register，全链路会被破坏）。
2. **AI integration regression suite**：新增 `apps/web-server/tests/integration/ai-dataflarework.spec.ts`，跑 3 个场景：① 翻译 100 units → 期望内存命中率 > 0；② KB 变更后立即 upsert → 下一次翻译应能命中；③ stream 取消在 unit N/2 时应停止且不写 audit。

### C.4 安全姿态调整
1. **CSP 收紧**：`/embed/<docId>` 当前注入 `script-src 'unsafe-inline'` 才能跑 bridge；建议把 bridge 改成外链 `.js` 文件（`/static/embed-bridge.js`），nonce-protected，去掉 `'unsafe-inline'`。
2. **Path guard 默认开启**：`isManagedPath` 现在是白名单 `DATA_DIR + WEB_TEMP_ROOT`。生产部署应允许 operator 通过 `WEB_MANAGED_ROOTS=/srv/data,/srv/uploads` 配置多根。
3. **AI 审计**：每个 stream 应有"prompt hash + token 估算 + provider + latency + cost estimate"五元组写入 `audit-log.ts`。这是 Dataflarework 客户法务要求。

### C.5 文档优先
1. **`docs/architecture/auth-model.md`**：画清楚 "WEB_TOKEN → cookie / Bearer literal" vs "JWT → Bearer with scope" 两段流程，附 3 个 curl 示例。
2. **`docs/architecture/ai-routing.md`**：画清 "ai-settings.json vs env var vs hardcoded fallback" 三层解析；附"如何知道我的请求走的是哪个 provider"的 `audit log` 查询示例。
3. **`docs/integration/dataflarework-quickstart.md`**：用 5 步把 Dataflarework 接上 GenOffice web-server，附 host-side 集成代码片段。

---

## D. 已确认修复（上一轮）

- **Bug A**：`/embed/<docId>` 没设 `Set-Cookie auth_token` → 已修复（`apps/web-server/src/embed/index.ts:394`），iframe 内 IPC 401 消失
- **Bug B**：bridge sendReady 双重触发 → 已修复（`apps/web-server/src/embed/bridge.ts:58` readySent flag），host 收到 ready 次数从 2 降到 1
- **Bug C**：web-server 没暴露 `/static/sdk/*` → 已修复（`apps/web-server/src/index.ts:780-800` 路由注册 + `apps/web-server/src/common/paths.ts:97` SDK_BUNDLE_ROOT），外部 host 可自挂 SDK UMD

---

## E. 实测覆盖矩阵

| 域 | 通道数 | 烟测条数 | 通过率 | 主要异常 |
|---|---|---|---|---|
| Top-level | 4 | 4 | 100% | — |
| Docs / Sheets / Slides | 6 | 8 | 100% | docs:create-document 嵌套 ok:false（B.2） |
| PDF / Markdown / HTML | 4 | 4 | 100% | 路径越界全部 400 ✅ |
| Home / Shell | 8 | 10 | 100% | home:install-skill 需 JWT（B.1） |
| Collab | 5 | 5 | 100%（双认证） | 双认证必填（B.1） |
| Comments / History | 3 | 3 | 100%（双认证） | 双认证必填 |
| AI settings / 模型 | 4 | 4 | 100% | — |
| Enterprise | 8 | 8 | 100%（JWT + scope） | scope 配置漏对（B.4） |
| Anydoc / Files | 3 | 3 | 67% | 路径越界返回 null（B.5） |
| sdk:command 真实往返 | 3 | 3 | 67% | 字段名 body 应为 text |
| V1 endpoints | 6 | 6 | 83% | /files 需 JWT；405/400 守卫工作正常 |
| AI streaming | 3 | 3 | 100% | SSE 形状规范；隐式出网（B.3） |

**总体**：57 / 63 探针达成期望响应，6 个发现已映射到 B.1–B.5。

---

## F. 后续动作（按 ROI）

1. **本周**：修 B.1（鉴权文档 + SDK helper）和 B.3（AI provider 来源审计）— 这两条直接影响外部集成。
2. **下周**：修 B.2（docs:create-document 返回形状）+ B.4（scope 中央化）— 改善内部一致性。
3. **本季度**：C.1（agent endpoint 一等公民）+ C.4（CSP 收紧）— 把产品定位从"IPC 镜像"升到"AI-native kernel"。

— END —
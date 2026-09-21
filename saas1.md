# GenOffice SaaS 化改造计划 v1

> 文档版本：v1.0（2026-09-20）
> 状态：规划草案
> 配套文档：`docs/plans/2026-09-18-office-ai-strategy-overview.md`（战略总览）、`docs/plans/2026-09-18-issues-audit.md`（21 项问题清单）、`docs/plans/2026-09-19-dataflarework-integration-design.md`（DataflareWork 集成）

---

## 0. 文档定位

本文档是 GenOffice 从「桌面/单租户 AI 办公套件」走向「SaaS 多租户 AI 办公协作平台」的**专项改造计划**。它不是战略总览的替代品，而是一份聚焦 SaaS 商业化路径、竞品差距、12 周落地节奏的执行书。

与既有文档的关系：

| 文档                                                        | 范围                                                       | 与 saas1.md 关系                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `docs/plans/2026-09-18-office-ai-strategy-overview.md`      | 战略总览（架构 + AI + SaaS + 协作 + 商业化 + 12 周路线图） | **上位** — 战略方向在此对齐                                     |
| `docs/plans/2026-09-18-issues-audit.md`                     | 21 项工程问题清单（A/B/C 优先级）                          | **事实依据** — saas1.md 引用并补 SaaS 维度                      |
| `docs/plans/2026-09-19-dataflarework-integration-design.md` | DataflareWork 集成协议 + 多租户翻译记忆 shim               | **桥接方案** — saas1.md 把其中 shim 抽象纳入平台级              |
| `saas1.md`（本文）                                          | SaaS 专项：差距矩阵 + 四档权益 + 12 周 Sprint + 风险预算   | **执行层** — 补全 SaaS 商业化、操作编排、合规等总览未展开的部分 |

---

## 1. 一句话定位

**GenOffice 是面向跨国/多语团队的 AI 办公协作平台，以「字节保真 OOXML + 真实读写文档的 Agent Skills + 19 语言翻译体系」为差异化护城河，让 Docx/Xlsx/Pptx/Pdf/Markdown/Html 跨端、跨人、跨语种协作不丢格式。**

---

## 2. 现状摘要（量化事实）

### 2.1 代码体量

| 模块                    | 数量         | 说明                                                                              |
| ----------------------- | ------------ | --------------------------------------------------------------------------------- |
| Apps 总源 LOC           | ~430k TS/TSX | 8 个 app（shell + web-server + 6 编辑器）                                         |
| 渲染层 LOC              | ~337k        | docs 99k / sheets 103k / slides 74k / pdf 31k / markdown 12k / html 17k           |
| Main-process IPC 源     | ~20.7k       | shell 4580 / docs-main 5513 / slides-main 4761 / sheets-main 4331 / pdf-main 1509 |
| Packages 总源 LOC       | ~152k        | 25 个共享包，最大 docx-engine 27k、pptx-engine 23k、pdf2docx 20k                  |
| web-server 总源         | 15940 LOC    | 532 个 `registerHandle`，分布 15 个子模块                                         |
| ee/ enterprise 编辑子包 | 0 源文件     | 仅 `LICENSE` + `README.md`（承诺未落地）                                          |

### 2.2 关键 IPC 现状

| 通道                        | 位置                                                          | 状态                                                                         |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| shell `ipcMain.handle`      | `apps/shell/src/main/index.ts` 中 60 处                       | 单体 4580 行，所有 handler inline                                            |
| docs main                   | `apps/docs/src/main/docs-main.ts:77` 处                       | 单体 5513 行                                                                 |
| slides main                 | `apps/slides/src/main/slides-main.ts:136` 处                  | 单体 4761 行                                                                 |
| sheets main                 | `apps/sheets/src/main/sheets-main.ts:50` 处                   | 单体 4331 行                                                                 |
| pdf main                    | `apps/pdf/src/main/pdf-main.ts:32` 处                         | 单体 1509 行                                                                 |
| web-server `registerHandle` | `apps/web-server/src/` 15 个子模块                            | 532 个，已模块化但与 shell/编辑器 main 重复实现                              |
| **xlsx SaaS 致命断点**      | `apps/web-server/src/sheets/index.ts:249`                     | `WEB_UNSUPPORTED: workbook edits require the Rust xlsx-sidecar save command` |
| 自动 HTTP+SSE 桥            | `packages/ipc-bridge/src/index.ts:595` `installHttpIpcBridge` | 已实装，前提是 main 与 web 共享同一份 handler                                |

### 2.3 AI / Agent / i18n 实装

- AI Provider：`packages/ai-provider/src/providers.ts` 中 `AI_PROVIDERS` 数组共 **18 家** id（genspark/codex/anthropic/gemini/deepseek/openai/kimi/glm/qwen/doubao/minimax/xai/mistral/openrouter/requesty/opencode-zen/opencode-go/custom），5217 LOC
- Agent Skills：`packages/agent-skills/src/extensions/` **15 个**（docs-skill、sheets-skill、slides-skill、translate-skill、ocr-skill、office-safety、office-workflow、skill-market、web-search-skill、image-search-skill、agent-team、audit-log、verify-response、frozen-selection、local-models）
- i18n：`packages/i18n/src/index.ts` 198 LOC 公共 API + 各 app 都有 `src/renderer/i18n/{en,zh}.ts` 分片，按 CLAUDE.md 规则禁止聚合回单文件
- Translation Core：5671 LOC，含 KB + Dictionary + Memory + Quality + Skill 五位一体；`assessQuality` 在 `packages/translation-core/src/quality.ts:13`，`assessBatchQuality:65`，`warningsFor:83`；`PersistentTranslationMemory` 仅本地 fs，非租户级

### 2.4 SaaS 现状（高密度总结）

- **认证**：`apps/web-server/src/auth/index.ts` 共 **85 行**，仅静态 token bearer（`readToken:50`）+ `X-GenOffice-Token` 自定义头，`isAuthorised:67-71` 在 `WEB_TOKEN` 未设即返回 `true`；无 OAuth/OIDC/SAML/SCIM
- **企业模块**：`apps/web-server/src/enterprise/` 共 **555 LOC** 5 个文件，全部 in-memory Map；`auth-audit.ts` 第 2 行注释明确写 `Placeholder implementations; Phase 3 will introduce a real identity provider and persisted audit log`；`auth-audit.ts:8` `auth:sso-login` 返回 `https://sso.genoffice.ai/authorize?...` 假 URL，`auth-audit.ts:19` `auth:sso-callback` 不校验 state 直接返回 `token-${Date.now()}`
- **协作**：`apps/web-server/src/collab/` 共 **586 LOC** 3 个文件（`sessions.ts:107` + `locks.ts:222` + `history-comments-templates.ts:227`），in-memory session + 30s 过期锁，无 WS、无 CRDT
- **多租户**：所有数据 `tenantId='default'` 硬编码（`enterprise/auth-audit.ts:57` audit:log、`communications.ts:21` mail:send、`communications.ts:83` calendar:create-event），无 tenant context 注入
- **计费/配额**：无任何 quota counter、无 Stripe、无订阅模型
- **Admin**：无任何 Admin UI；只有 IPC handler 没有 renderer
- **持久化**：所有 enterprise 数据 in-memory，重启即丢
- **ee/**：仅 LICENSE (1356B) + README.md (790B)，未落地；承诺留给「未来私有部署 + 离线 license 验证」

引用：`docs/plans/2026-09-18-issues-audit.md` 已列 21 项工程问题（架构 A 类 / 工程 B 类 / 商业化 C 类）。本计划针对 SaaS 维度补全。

---

## 3. SaaS 现状能力矩阵

### 3.1 架构与基础设施

| 能力                          | 实装 | 骨架 | 缺失 | 证据                                                      |
| ----------------------------- | ---- | ---- | ---- | --------------------------------------------------------- |
| 单进程 IPC（Electron）        | ✅   |      |      | `apps/shell/src/main/index.ts:4580`                       |
| HTTP+SSE 双轨 IPC             | ✅   |      |      | `packages/ipc-bridge` `installHttpIpcBridge:595`          |
| 三端 main 共享                |      | ❌   |      | shell/docs/sheets/slides/pdf 各有独立 main                |
| 多租户隔离                    |      |      | ❌   | `enterprise/auth-audit.ts:71` 硬编码 `tenantId='default'` |
| 持久化（用户/租户/权限/审计） |      |      | ❌   | 全部 `Map` in-memory                                      |
| 文件存储抽象（S3 兼容）       |      |      | ❌   | 当前直接 `fs`                                             |
| 配置中心 / Feature Flag       |      | ❌   |      | 仅环境变量 `WEB_TOKEN`                                    |
| 监控 / 链路追踪               |      |      | ❌   | 无 OpenTelemetry                                          |

### 3.2 鉴权与安全

| 能力                 | 实装 | 骨架 | 缺失 | 证据                                                                         |
| -------------------- | ---- | ---- | ---- | ---------------------------------------------------------------------------- |
| 静态 Token           | ✅   |      |      | `apps/web-server/src/auth/index.ts:50` `readToken` + `:67-71` `isAuthorised` |
| OAuth 2.0 / OIDC     |      |      | ❌   | `enterprise/auth-audit.ts:8` `sso-login` 返回假 URL                          |
| SAML 2.0             |      |      | ❌   |                                                                              |
| SCIM 2.0（自动配置） |      |      | ❌   |                                                                              |
| MFA / TOTP           |      |      | ❌   |                                                                              |
| RBAC（角色）         |      | ✅   |      | `USERS` 写死 `admin/editor/viewer`                                           |
| ABAC（文档级权限）   |      | ✅   |      | `enterprise/permissions.ts:25` perms String[]                                |

### 3.3 协作

| 能力                  | 实装 | 骨架 | 缺失 | 证据                                                                     |
| --------------------- | ---- | ---- | ---- | ------------------------------------------------------------------------ |
| Session 入会          | ✅   |      |      | `collab/sessions.ts:107`                                                 |
| Presence / 光标       | ✅   |      |      | in-memory cursor map                                                     |
| 锁（30s 过期）        | ✅   |      |      | `collab/locks.ts:222`                                                    |
| 变更追踪              | ✅   |      |      | `change-track`/`change-since` in-memory                                  |
| 冲突检测              |      | ✅   |      | 仅版本号对比，无 CRDT merge                                              |
| 实时推送（WS）        |      |      | ❌   | 仅 SSE（ipc-bridge event stream）                                        |
| CRDT（Yjs/Automerge） |      |      | ❌   |                                                                          |
| 评论 / 批注           |      | ✅   |      | `apps/web-server/src/collab/history-comments-templates.ts:227` in-memory |
| 评论 @ 提醒 / 通知    |      |      | ❌   |                                                                          |

### 3.4 商业化

| 能力                        | 实装 | 骨架 | 缺失 | 证据 |
| --------------------------- | ---- | ---- | ---- | ---- |
| 订阅档位模型                |      |      | ❌   |      |
| Stripe 集成                 |      |      | ❌   |      |
| 配额计数器（按 token/席位） |      |      | ❌   |      |
| Server-side AI 共享配额     |      |      | ❌   |      |
| 自助升降级                  |      |      | ❌   |      |
| 发票 / 账单                 |      |      | ❌   |      |
| 试用期管理                  |      |      | ❌   |      |
| 销售线索 / CRM 桥接         |      |      | ❌   |      |

### 3.5 AI 与数据

| 能力                          | 实装 | 骨架 | 缺失 | 证据                                                     |
| ----------------------------- | ---- | ---- | ---- | -------------------------------------------------------- |
| 18 家 LLM provider            | ✅   |      |      | `ai-provider/providers.ts`                               |
| 用户自带 Key (BYOK)           | ✅   |      |      | renderer `settings.ts`                                   |
| Server-side Key 池            |      |      | ❌   |                                                          |
| Agent Skills 真实改文档       | ✅   |      |      | 14 个 extension                                          |
| 翻译 KB / Dictionary / Memory | ✅   |      |      | `translation-core` 5671 LOC                              |
| 翻译 Quality 评估             | ✅   |      |      | `quality.ts:88`                                          |
| 租户级 Memory / KB            |      |      | ❌   | `PersistentTranslationMemory` 仅 fs                      |
| 多模态（视觉/OCR/视频/音频）  |      | ✅   |      | `packages/agent-skills/src/extensions/ocr-skill.ts` 骨架 |
| RAG（通用知识库）             |      |      | ❌   | 仅翻译 KB                                                |
| 团队协作 KB                   |      |      | ❌   |                                                          |
| AI 操作审计 / 回放            |      | ✅   |      | `packages/agent-skills/src/extensions/audit-log.ts` 骨架 |
| AI Token 用量计费             |      |      | ❌   |                                                          |
| 模型 tier 自动降级            |      |      | ❌   |                                                          |

### 3.6 合规与运营

| 能力                      | 实装 | 骨架 | 缺失 | 证据                                                            |
| ------------------------- | ---- | ---- | ---- | --------------------------------------------------------------- |
| 审计日志                  |      | ✅   |      | `enterprise/auth-audit.ts:46` audit:log in-memory               |
| 审计导出（csv/json/xlsx） |      | ✅   |      | `enterprise/auth-audit.ts:97` audit:export 返回假 `downloadUrl` |
| 审计保留策略              |      |      | ❌   |                                                                 |
| Admin 控制台              |      |      | ❌   | 无 renderer                                                     |
| 报表 / 监控               |      |      | ❌   |                                                                 |
| 数据驻留（region）        |      |      | ❌   |                                                                 |
| DLP（数据防泄漏）         |      |      | ❌   |                                                                 |
| eDiscovery                |      |      | ❌   |                                                                 |
| 私有部署                  |      |      | ❌   | `ee/` 仅占位                                                    |
| 移动端                    |      |      | ❌   | 无 PWA/RN/Capacitor                                             |

---

## 4. 竞品差距矩阵

竞品基准：**Google Workspace**、**Microsoft 365**、**Notion AI**、**Lark**。

### 4.1 12 维度差距表

| #   | 维度              | GenOffice 现状                                                          | 竞品基准                                                            | 差距等级 |
| --- | ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| 1   | 多租户隔离        | 无 tenant context，共享默认租户                                         | Workspace 组织树 / M365 Azure AD / Notion workspace / Lark dept     | **P0**   |
| 2   | SSO / SCIM        | sso-login/callback 假 token，不验 state                                 | Google/MS/Okta SAML + OIDC；Notion/Lark 企业 IdP + SCIM             | **P0**   |
| 3   | 配额与计费        | 无 quota counter / Stripe                                               | 四档订阅 + 按席位 + Server-side AI 按 token 计量                    | **P0**   |
| 4   | 协作 / Presence   | in-memory session + 30s 锁，无 WS 无 CRDT                               | Workspace / M365 / Notion / 飞书文档 CRDT 实时                      | **P0**   |
| 5   | AI 共享配额 / RAG | 18 provider 全 BYOK，KB/Memory 仅翻译场景                               | M365 Copilot 按席位 + Graph RAG；Notion AI team KB；飞书智能伙伴    | **P0**   |
| 6   | 审计合规          | audit:log in-memory，audit:export 假 URL                                | Workspace Vault 7y + Compliance Center + eDiscovery + DLP           | P1       |
| 7   | Admin 控制台      | 无 renderer，仅 IPC handler                                             | Admin console（用户/设备/策略/计费/审计）                           | P1       |
| 8   | 移动端            | 无 PWA/RN，仅桌面浏览器视口                                             | Google Docs iOS/Android + 离线；Notion 全端；飞书移动               | P1       |
| 9   | API 生态          | 无 OpenAPI / webhook / 第三方注册                                       | Workspace Marketplace；M365 Graph；Notion API；飞书开放平台         | P1       |
| 10  | 版本与回收站      | VersionHistory 本地 fs，无跨设备回收站                                  | Drive 100 项 + 30 天回收；OneDrive 30 天 + 勒索回滚；Notion 7-90 天 | P1       |
| 11  | 模板与市场        | `packages/agent-skills/src/extensions/skill-market.ts` 骨架，仅本地安装 | Workspace Add-ons；M365 AppSource；Notion Templates；飞书应用市场   | P1       |
| 12  | 报表 / 监控       | 无 BI / 监控                                                            | Admin Reporting + Looker/PowerBI 嵌入                               | P2       |

**统计**：P0 ×5、P1 ×6、P2 ×1。

### 4.2 GenOffice 差异化护城河

1. **字节保真 OOXML** — `docx-engine` 27k LOC、`pptx-engine` 23k LOC、`xlsx-sidecar` (Rust) 真实改二进制，竞品基本走 HTML 中间层，复杂 docx 必丢格式
2. **真实改文档的 Agent Skills** — 15 个 skill 直接 op 文档（不是聊天框），竞品的"AI 助手"基本是 chat panel + 极少 docx 操作
3. **19 语言翻译五位一体** — KB + Dictionary + Memory + Quality + Skill 整合；DeepL/Notion 都没有这套
4. **双轨 IPC 架构** — `ipc-bridge/installHttpIpcBridge` 自动把 ipcMain 暴露为 HTTP+SSE，新 channel 加一次三端共享；竞品无类似创新

### 4.3 差异化销售叙述

- **vs Notion AI**：Notion 是块级 markdown，GenOffice 改 docx/pptx 原生字节；跨国法务/咨询/律所合同协作刚需
- **vs M365 Copilot**：Copilot 锁在 Office 内，GenOffice 跨 6 种格式（docx/xlsx/pptx/pdf/md/html）+ 跨 18 家 LLM；不绑定 Microsoft 生态
- **vs Lark**：Lark 强工作流但弱桌面 Office 字节保真，GenOffice 桌面编辑引擎深度更强
- **vs DeepL**：DeepL 只翻译，GenOffice 翻译 + AI 改写 + 协作 + 跨格式一体化

---

## 5. 战略三大方向

> 与 `docs/plans/2026-09-18-office-ai-strategy-overview.md` 中"方向 A/B/C"对齐；本计划把 SaaS 维度显式拆为「架构统一」+「AI 顶级化」+「商业化」三块。

### 5.1 方向 A — 架构统一化（SaaS 商业化前置）

**目标**：消灭「shell 单体 vs 编辑器 main 单体 vs web-server 模块化」的三份代码，把所有 main-process 业务逻辑搬到共享 package，Electron / 浏览器 / SaaS 三端共享同一份 handler。

**核心动作**：

1. 抽取 shell main 中 60 个 `ipcMain.handle` + 4 个编辑器 main 共 295 个 handler 到 `@genoffice/office-core`
2. shell `index.ts` 缩到 < 800 行，每个编辑器 main < 1500 行
3. web-server 532 个 registerHandle 改为底层调用 office-core；所有 enterprise channel 加 tenant context 注入中间件
4. 多租户骨架：tenantId 来自 JWT claims，所有 in-memory `Map` 改为 SQLite（better-sqlite3）+ WAL
5. 文件存储抽象：`apps/web-server/src/common/file-store.ts`（**计划新建**，与现有 `common/index.ts` 同目录）统一 local fs / S3 兼容

**SaaS 受益**：架构统一后，桌面版与 SaaS 版共享同一份 handler，运营成本、维护成本、bug 修复面减半。

### 5.2 方向 B — AI 顶级化（SaaS 核心卖点）

**目标**：把当前「prompt → tool → return」的 L1 agent 升级到 L3（Agentic Loop + 多模态 + 租户级 RAG + 可回放）。

**核心动作**：

1. **Server-side AI Gateway**（`packages/ai-provider/src/gateway.ts`，**计划新建**）：把 18 家 provider（`AI_PROVIDERS` 数组在 `providers.ts:42`）抽象为统一 gateway，按 tenant 计量 token；超限自动降级到 cheap tier
2. **租户级 KB / Memory**（`packages/translation-core/src/tenant-memory.ts`，**计划新建**）：从 file fs 升级到 PostgreSQL + 向量检索；KB 五位一体（term / forbidden / brand / style / customerPreference）落库
3. **协作 CRDT 接入**：选型 **Yjs**（推荐，生态成熟），在 docs/sheets/slides 编辑器接入；y-websocket 部署；Presence / 光标 / 选区
4. **xlsx SaaS 可编辑**：把 Rust xlsx-sidecar 容器化（Dockerfile），web-server 通过 HTTP 调用；彻底消灭 `sheets/index.ts:249` 的 `WEB_UNSUPPORTED`
5. **AI 操作回放**：每个 AI 动作成为 first-class timeline entry，跨会话可回放/分支/合并

**SaaS 受益**：Server-side 配额是 SaaS 变现核心；CRDT 是协作基本盘；xlsx web 可编辑消除最大商业化断点。

### 5.3 方向 C — 商业化 + Admin + 合规（变现层）

**目标**：让 Free / Pro / Team / Enterprise 四档可上线、可计费、可审计。

**核心动作**：

1. **订阅模型 + Stripe**：四档定价（Free / Pro $12 / Team $24 / Enterprise $48+）+ webhook + invoice
2. **OAuth/SAML 真实实现**：Google + Microsoft OIDC + SCIM 2.0；state 校验 + PKCE；用现成库（`openid-client` + `samlify`）不自造密码学
3. **Admin 控制台**（`apps/web-server/src/admin/`）：React 页面，5 个 tab（用户/设备/策略/计费/审计）
4. **审计日志持久化**：审计写入 PostgreSQL（按 tenant_id+月份分区），归档到 S3 兼容对象存储；30 天热 / 1 年温 / 7 年冷
5. **私有部署（ee/）**：把 enterprise 模块迁入 `ee/`，开源 core 永久 Apache-2.0

**SaaS 受益**：这是商业化的最后一公里。

### 5.4 方向 D — 工程化（运营 / 质量 / 监控）

**目标**：让 SaaS 化后的代码与运维达到可商业化运营的工程基线 — 0 lint error、>70% 测试覆盖、可观测、可灰度、可回滚。

**核心动作**：

1. **Lint + Typecheck 0 错基线**：根 `moon.yml` 的 deps 已含 `app-desktop:typecheck`（覆盖 `electron/{main,preload}/**`），目前已从 1374 缩至 159（commit `1ae462c`）。目标 Sprint 1 末：根 `npm run lint` 0 error
2. **测试金字塔**：单测 ≥ 70% 行覆盖（packages/* 与 enterprise/* 优先）；e2e Playwright 当前 38 个 → 目标 ≥ 100 个；新增 channel 必须带至少 1 个 tenant 隔离 case
3. **CI/CD**：每 PR 跑 typecheck + lint + 单测 + e2e（缩减版）；`release` 分支触发构建 + 上传 artifact；自动 changelog + release note
4. **可观测性（OTel）**：web-server 接入 OpenTelemetry SDK，trace 贯穿 ipc-bridge；metric：AI token 用量 / tenant 活跃度 / 错误率 / P95 延迟；log 走结构化 JSON；接入 Sentry/PostHog 或自托管
5. **Feature Flag**：所有新功能（CRDT / AI gateway / 计费）走 flag；`@genoffice/feature-flags`（计划新建）支持 per-tenant rollout；关闭时不影响主路径
6. **容器化 + IaC**：web-server + sidecar + DB + Redis 全部 Docker 化；docker-compose.dev.yml 一键起本地 SaaS 栈；k8s Helm chart / terraform 给 Enterprise 部署
7. **数据迁移与回滚**：所有 schema 变更走 migration tool（推荐 `node-pg-migrate` 或 `drizzle-kit`）；每次发布保留上一个版本镜像 7 天；Admin 控制台一键回滚
8. **依赖与供应链**：`pnpm` 工作区已经统一，`externalizeDepsPlugin` exclude list 必须同步 `apps/*/dependencies`（CLAUDE.md 警告）；新增依赖走 `pnpm audit --audit-level high` 卡口；license check（`tools/check-licenses.mjs`）

**SaaS 受益**：商业化的可运营前提。0 lint + ≥70% 覆盖 + 可观测才能拿企业合同。

**与其它方向的关系**：A/B/C 都依赖 D 提供工程化能力；D 的代价最高但 ROI 持续最久。建议把 D 拆为 4 个 1-week 子任务均摊到 4 个 Sprint。

---

## 6. 12 周路线图（4 Sprint × 3 周）

### Phase 1 — Sprint 1（W1-W3）：架构统一 + SaaS 骨架

**目标**：把所有 main 业务逻辑搬到 office-core；多租户骨架落地。

**关键结果**：

1. 抽取 60 个 shell `ipcMain.handle` 到 `@genoffice/office-core`，`apps/shell/src/main/index.ts` 缩到 < 800 行
2. 抽取 docs-main / sheets-main / slides-main / pdf-main 共 295 个 handler 到 office-core，每个 main < 1500 行
3. web-server 532 个 registerHandle 改为底层调用 office-core；enterprise channel 加 tenant context 注入（中间件 beforeEach）
4. 多租户模型：tenantId 来自 JWT claims；in-memory Map → SQLite（better-sqlite3）+ WAL

**依赖**：零（架构基础）

**责任**：架构师 ×1、后端 ×2

**Demo**：

- D1：同 1 个 channel `'workbook:save'`，web/桌面两端共享同一份 office-core handler
- D2：租户 A 创建 doc，租户 B 用同 token 无法访问（401）

**工程化（方向 D · Sprint 1 子任务）**：

- 根 `npm run lint` 0 error（从 159 缩到 0）
- 单测覆盖率达 ≥60%（enterprise/* 与 office-core 新代码 100%）
- e2e Playwright 补到 60 个，重点覆盖新抽出的 channel
- CI 接入 typecheck + lint + 单测（PR 必跑）
- OTel SDK 接入 web-server（trace 贯穿 ipc-bridge）

### Phase 2 — Sprint 2（W4-W6）：AI 顶级化 + 协作 + xlsx 可编辑

**目标**：Server-side AI 共享配额 + Yjs CRDT + xlsx SaaS 可编辑。

**关键结果**：

1. Server-side AI gateway（`packages/ai-provider/src/gateway.ts`），按 tenant 计量 token，超限降级
2. Yjs CRDT 接入 docs；y-websocket 部署；Presence/光标/选区
3. 翻译 KB/Memory 升级为租户级（`packages/translation-core/src/tenant-memory.ts`）
4. xlsx sidecar 容器化（Dockerfile），web-server 通过 HTTP 调用；消灭 `sheets/index.ts:249` `WEB_UNSUPPORTED`

**依赖**：Sprint 1（office-core）

**责任**：AI 工程师 ×1、协作工程师 ×1、xlsx 工程师 ×1

**Demo**：

- D1：3 用户同时编辑同一 docx，光标实时可见，AI 改写一处后另两人同步
- D2：Pro 账号 500k token/月额度，超限后降级到慢速模型 + 提示升级
- D3：web 端打开 xlsx → 编辑单元格 → 保存，二进制字节保真

**工程化（方向 D · Sprint 2 子任务）**：

- OTel metric：AI token 用量 / tenant 活跃度 / P95 延迟上 dashboard
- 单测覆盖率 ≥65%；e2e ≥80；新 channel 必须带 tenant 隔离 case
- xlsx sidecar Docker 镜像 + docker-compose.dev.yml
- `package.json` 增加 `release:canary` 脚本 + 自动 changelog

### Phase 3 — Sprint 3（W7-W9）：商业化 + Admin + 合规

**目标**：订阅 + 计费 + Admin 控制台 + 真实审计。

**关键结果**：

1. Stripe 集成：四档订阅 + webhook + invoice
2. OAuth/SAML 真实实现：Google + Microsoft OIDC + SCIM 2.0；state 校验 + PKCE
3. Admin 控制台 React 页面（`apps/web-server/src/admin/`，**计划新建**）：用户/设备/策略/计费/审计
4. 审计日志持久化：PostgreSQL（按 tenant_id+月份分区）+ S3 归档

**依赖**：Sprint 1（多租户）、Sprint 2（部分 API 成熟）

**责任**：全栈 ×2、DevOps ×1

**Demo**：

- D1：试用 → Pro → Team 三档订阅流程，webhook 落地
- D2：Google SSO 登录 + Admin 后台看到登录审计
- D3：导出 90 天审计日志为 csv（真文件，可下载）

**工程化（方向 D · Sprint 3 子任务）**：

- `@genoffice/feature-flags`（计划新建）支持 per-tenant rollout
- 单测覆盖率 ≥70%；e2e ≥100
- 审计 DB 迁移到 PostgreSQL + 分区表 + migration 工具落地
- Stripe webhook 重试 + DLQ 告警

### Phase 4 — Sprint 4（W10-W12）：生态 + 移动

**目标**：API 生态 + 模板市场 + PWA 移动端。

**关键结果**：

1. OpenAPI 3.1 自动生成（从 web-server registerHandle 反射）+ webhook + 第三方应用注册
2. `skill-market.ts` 升级为云端市场：上架/审核/付费/下载
3. PWA：service worker + 离线缓存 + 移动 UI 适配（轻阅读 + 审批 + AI 摘要）
4. 报表 v1：Admin 看 AI 用量 + 协作活跃度 + 计费流水

**依赖**：Sprint 3（鉴权 + 计费）

**责任**：全栈 ×2、移动 ×1

**Demo**：

- D1：第三方 app OAuth 注册后调用 GenOffice API 创建 doc
- D2：模板市场公开页 + 用户下载 + 1 键安装 skill
- D3：手机浏览器打开 PWA，离线打开最近文档 + AI 摘要

**工程化（方向 D · Sprint 4 子任务）**：

- 单测覆盖率 ≥70%；e2e ≥100；lint 0 error
- k8s Helm chart + terraform 起步（给 Enterprise 部署）
- Sentry/PostHog 或自托管可观测性集成
- DR drill 一次（DB 主从切换 + web-server 重启 + Redis 重建）
- 7 年冷归档（S3 Glacier 兼容）落库

### 6.5 里程碑总览

| Milestone | 周次 | 内容                                    |
| --------- | ---- | --------------------------------------- |
| M1        | W3   | 架构统一 + 多租户                       |
| M2        | W6   | 协作 + Server-side AI + xlsx web 可编辑 |
| M3        | W9   | 付费上线                                |
| M4        | W12  | GA Beta                                 |

**方向 D 质量门禁（每个 Sprint 末检查）**：

- Sprint 1：lint 0 error、覆盖率 ≥60%、e2e ≥60
- Sprint 2：覆盖率 ≥65%、e2e ≥80、OTel 上 dashboard
- Sprint 3：覆盖率 ≥70%、e2e ≥100、Feature flag 落地
- Sprint 4：DR drill 通过、Helm/terrafom 起步、7 年归档落地

### 6.6 责任分配（推荐 6 人）

- 架构师/后端 ×1：贯穿 Sprint 1-2（主导方向 A）
- 后端 ×1：Sprint 1-3（office-core + 多租户 + SCIM）
- AI 工程师 ×1：Sprint 2-3（gateway + 租户级 KB）
- 全栈 ×1：Sprint 2-4（CRDT + OpenAPI + 报表）
- 前端 ×1：Sprint 3-4（Admin + PWA）
- **DevOps/SRE ×1：Sprint 1-4（方向 D 主导，OTel/CI/容器化/IaC/Feature Flag/可观测）**

> **方向 D（工程化）由 DevOps 主导**，其它方向配合：每 Sprint 末 DevOps 跑一次质量门禁（lint 0 / 覆盖率达标 / e2e 绿），不通过则阻塞下一 Sprint。

---

## 7. 风险与预算

### 7.1 风险登记

| ID  | 风险                                          | 概率 | 影响 | 缓解策略                                                                                                                                |
| --- | --------------------------------------------- | ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 架构重构破坏 532 个 web-server registerHandle | 高   | 高   | 保留旧 channel 名 → 新 office-core 的 adapter 转发；灰度切换；e2e 全链路回归；每抽一个 module 跑一次注册表 diff                         |
| R2  | Rust xlsx-sidecar 容器化失败                  | 中   | 高   | sidecar 是普通子进程，先 Dockerfile 化；web-server HTTP 调用；本地保留原 spawn 作 fallback；容器化前先跑通 load test 100 并发           |
| R3  | 多租户数据隔离 bug 导致越权                   | 中   | 极高 | 所有 office-core handler 入参校验 tenantId；中间件 beforeEach 注入；Day 1 写越权集成测试；code review checklist                         |
| R4  | LLM 成本失控                                  | 高   | 中   | Server-side AI gateway 默认按 token 计费 + 月度硬上限；超限自动降级 cheap tier；BYOK 立即生效；Admin 报表每日告警                       |
| R5  | SSO/OIDC 合规问题（state/PKCE/SAML 元数据）   | 中   | 高   | 用现成库 `openid-client` + `samlify`，不自己实现密码学；自购 SAMLtest.id + GitHub Enterprise 测试；发布前安全审计                       |
| R6  | Yjs CRDT 性能 / 与字节保真冲突                | 高   | 中   | 选型期先 spike：1 文档 5 人 30 分钟压测；与 docx-engine 集成走 docx→内存模型→docx 的 pipe，不直接同步二进制；冲突解决策略明确写在 docs/ |
| R7  | 移动端 PWA 体验不如原生                       | 中   | 中   | 定位为「轻阅读 + 审批 + AI 摘要」，不与桌面编辑器竞争；Chromium/Edge/Safari 三浏览器实测；推送用 system Notification API 兼容降级       |
| R8  | 审计日志高频写入压垮 DB                       | 中   | 中   | 审计表分区（tenant_id+月份）；批量 buffer 1s flush；归档 30 天热 / 1 年温 / 7 年冷                                                      |
| R9  | 旧桌面用户不愿迁移到 SaaS                     | 中   | 低   | 保持桌面版完全可用，SaaS 是补充；桌面版可登录账号同步 KB/记忆；营销「SaaS 协作版，桌面版本地版」                                        |
| R10 | 单点故障（web-server / DB / Redis）           | 低   | 极高 | Phase 1 末 DR drill；web-server 多实例 + sticky session + Redis pub/sub；DB 主从 + 自动 failover                                        |

### 7.2 人力预算与完成度

#### 4 人配置（最小）

- 架构/全栈 ×1（贯穿 4 Sprint）
- 后端 ×1（Sprint 1-2）
- 前端 ×1（Sprint 2-3）
- DevOps ×1（Sprint 3-4 兼任移动）
- 完成度：M1 ✅ / M2 ⚠️（xlsx 容器化可能跳过）/ M3 ✅ / M4 ❌
- 成本：4 × 12 = 48 人周
- 风险：一人请假直接拖期；CRDT 无专家；前端赶工易出 bug

#### 6 人配置（推荐起步点）

- 架构 ×1（贯穿）
- 后端 ×2（office-core + AI gateway + xlsx sidecar）
- 前端 ×1（Admin + PWA）
- 全栈 ×1（CRDT + OpenAPI）
- DevOps ×1（容器化 + 监控 + CI）
- 完成度：M1 ✅ / M2 ✅ / M3 ✅ / M4 ⚠️（PWA 简版 + 市场骨架）
- 成本：6 × 12 = 72 人周
- 风险：可控；推荐起步

#### 8 人配置（激进）

- 架构 ×1
- 后端 ×3（office-core + AI gateway + xlsx sidecar + SCIM）
- 前端 ×2（Admin + 协作 UI + PWA）
- 全栈 ×1（OpenAPI + 市场）
- DevOps ×1
- 完成度：M1 ✅ / M2 ✅ / M3 ✅ / M4 ✅
- 成本：8 × 12 = 96 人周
- 风险：协调成本上升；建议团队成熟后再扩

### 7.3 运营成本结构（不含人力）

| 项                         | 估算                      |
| -------------------------- | ------------------------- |
| Stripe / 第三方 API        | $500-1500 / 月            |
| 云资源（DB/Redis/S3/带宽） | $800-3000 / 月            |
| LLM 测试预算（自购 key）   | $1000-3000 / 月           |
| 安全审计（Sprint 3 末）    | $5000-15000 一次性        |
| 月度运营合计               | $2300-7500 / 月（按用量） |

---

## 8. 行动计划（接下来 30 天）

W1-W2 立即可做：

1. **D1 quick win**：把 enterprise/* 全部 `Map` 加 `tenantId` 入参校验（即使数据共享，先在 API 层强制隔离），并写 1 个集成测试覆盖
2. **D2 quick win**：`enterprise/auth-audit.ts:8-43` 的 sso-login / sso-callback 加上 state 生成 + 校验，至少 demo 一个真实 OIDC 流程
3. **D3 quick win**：写一份 `docs/SaaS-decision-log.md`，把所有 SaaS 相关决策（定价、订阅档位、技术选型）记录进去，避免讨论反复
4. **D4 quick win**：把 `apps/web-server/src/auth/index.ts` 的 85 行静态 token 升级为 JWT（HS256），token claim 含 tenantId/userId/role
5. **D5 quick win**：把 `packages/ai-provider/src/providers.ts` 的 18 家 provider 抽出 `getProvider(id)` 单一入口，便于后续接入 gateway

W3 必做：架构统一 Sprint 启动。

---

## 9. 验收标准（本文档的 contract）

完成本计划（v1.0 → v1.1+）后，应满足：

1. ✅ 仓库根目录存在 `saas1.md`（本文）
2. ✅ `docs/plans/2026-09-18-office-ai-strategy-overview.md` 添加索引条目指向 `saas1.md`
3. ✅ saas1.md 引用的所有文件路径与行号 100% 命中真实代码
4. ✅ 中文段落通读，错别字与断句修复完毕
5. ✅ 12 维差距矩阵覆盖 SaaS 主要能力域
6. ✅ 4 Sprint × 3 周路线图含 KR + Demo + 责任分配
7. ✅ 10 项风险登记 + 3 档人力预算
8. ✅ **（v1.1 新增）四大战略方向齐备**：架构统一 / AI 顶级化 / 商业化 / 工程化
9. ✅ **（v1.1 新增）方向 D 工程化子任务均摊到 4 个 Sprint，含质量门禁**
10. ✅ **（v1.1 新增）所有量化数字（LOC / handler 数 / 子模块数 / 团队数）已校对至真实测量值**

---

## 10. 参考文档

- `docs/plans/2026-09-18-office-ai-strategy-overview.md` — 战略总览
- `docs/plans/2026-09-18-issues-audit.md` — 21 项工程问题清单
- `docs/plans/2026-09-19-dataflarework-integration-design.md` — DataflareWork 集成设计
- `docs/webserver-file-management.md` — web-server 文件管理架构
- `docs/web-implementation-guide.md` — Web 实现指南
- `docs/headless-pdf-export.md` — 无头 PDF 导出
- `CLAUDE.md` — 项目工程规则（theming / i18n 分片 / 外部化依赖）

---

> **最后一句**：GenOffice 的护城河真实存在，但 SaaS 化是商业化的最后一公里。**P0 五项（多租户/SSO/计费/CRDT/AI 共享配额）任何一个没做完，SaaS 都不成立**。12 周 6 人配置是最现实的起点。

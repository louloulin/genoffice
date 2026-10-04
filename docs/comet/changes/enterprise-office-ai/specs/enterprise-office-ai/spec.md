# enterprise-office-ai 完整目标规格

GenOffice 的 AI 平台在企业级形态下的完整行为规格。全部基建位于 web-server 的 HTTP/IPC 边界层与 packages 的协议层，对 agent 实现零侵入。

## 1. 安全基座（认证与密钥）

### 1.1 认证 fail-closed
- `WEB_TOKEN` 未配置时，`resolveAuthority` 不再返回 `open`：所有受保护端点（`/api/ai/stream`、`/api/ipc/*` AI 相关、`/api/v1/*`）对未认证请求返回 401，启动日志输出明确警告，`/health` 的 `auth` 字段报告 `locked`。
- 唯一例外（见 brief D11）：配置了 `GENOFFICE_JWT_SECRET` 时，验证通过的 JWT 仍放行为 `jwt-open`——不走 route-policy 路由表，逐通道 `requireScopeFromHeaders` 仍是策略；JWT-only 嵌入部署（Dataflarework）行为不变，嵌入闭环保持 11/11。
- 本地开发可用 `GENOFFICE_ALLOW_OPEN=1|true` 显式恢复历史 open 姿态（其他值 fail-closed）；`HOST` 非回环且无 `WEB_TOKEN` 时启动直接报错拒绝（`GENOFFICE_ALLOW_OPEN` 也不能豁免）。
- 配置 `WEB_TOKEN` 后行为与现状一致（共享密钥即操作员）；JWT+scope 路由（route-policy 三态 authority）不变。

### 1.2 SSRF 分场景收敛
- **嵌入/JWT 模式**：请求 body 中的 `settings.baseUrl`、`settings.apiKey` 覆盖一律忽略，provider 配置以服务端（租户）设置为准。落点：`apps/web-server/src/ai/chat.ts` settings 解析前的 sanitize 层。
- **本地/桌面模式**：保留 BYOK。baseUrl 必须命中 allowlist（默认仅回环地址 127.0.0.1/localhost/::1 + 操作员显式配置条目）；未命中返回结构化错误（含 reason），不发起上游请求。
- settings 覆盖中的模型名、温度等非网络参数不受 sanitize 影响。

### 1.3 密钥加密存储
- 新增 `apps/web-server/src/common/secret-store.ts`：AES-256-GCM，主密钥来自环境变量 `GENOFFICE_MASTER_KEY`（64 hex 字符或经 KDF）；密文格式 `v1:<keyId>:<iv>:<ciphertext>:<tag>`，keyId 支持主密钥轮换。
- `DATA_DIR/ai-settings.json` 落盘时 provider apiKey 经 secret-store 加密；读取时解密；主密钥缺失时启动报错并拒绝解密（不静默回退明文）。
- 所有 settings 读取 API 返回 redacted key（如 `sk-***abcd`）；嵌入模式下 renderer 永远拿不到明文 key——AI 请求由服务端代理携带。
- 桌面端明文 localStorage 为已登记债（Non-goal），不在本 capability 内。

### 1.4 租户贯通
- JWT claims 携带租户标识（tenantId/spaceId），经 route-policy 解析后写入请求上下文。
- audit-log 每条记录含 tenantId；双租户并发写入互不串数据。
- 全仓硬编码 `'default'` 租户替换为上下文取值（无 JWT 时回退 `default` 并在审计中标记）。

### 1.5 AI 调用全量审计
- chat/stream/translate/image 等 AI 调用统一写 audit-log：tenant、endpoint、provider、model、tokens（prompt/completion）、耗时、结果状态。

## 2. 翻译企业级

### 2.1 单元级重试
- `packages/translation-core/src/document.ts` 的批次 settle 循环内：单元失败按 ai-provider errorCode 分类——可重试（timeout/network/overloaded/5xx）自动重试（指数退避+抖动，≤3 次）；不可重试（credits/认证/内容策略）跳过并记录。
- 成功单元不重复调用；结束后产出失败单元清单（unitId/原因），整篇结果标记 `completed-with-failures` 或 `failed`。

### 2.2 断点续翻（checkpoint）
- `TranslateDocumentOptions` 新增 checkpoint adapter 接口：`load(unitId)` / `save(unitId, result)`。
- 每单元翻译成功即 save；重跑同一文档时已翻单元直接复用。
- web-server `translate-http.ts` 提供基于翻译会话的 store 实现；桌面/嵌入宿主可各自提供实现或省略（省略=无续翻）。
- 取消语义不变：取消一律不写回文档，但 checkpoint 保留已翻单元供续翻。

### 2.3 并发收敛
- `translateBatch`（非流式）与词典构建改用有界并发（复用 stream 版 worker-pool 模式），并发上限可配置，默认与 stream 版一致（25）。

### 2.4 markdown/html 翻译接入
- 两应用新增宿主实现：extract 单元（markdown 按块、html 按可翻译文本节点）+ apply 回写（复用 `apply_ops`/`write_document` 现有原语）。
- 支持：整篇翻译、选区翻译、双语模式；走 translateDocument 同一管线（含 2.1–2.3 全部能力）。
- `check-app-translation-parity.mjs` 声明矩阵补齐两应用（wholeDocument/hostCommand/bilingual/writeBack），门禁全绿。

### 2.5 一致性小修
- persistent-memory 阈值：常量与注释统一为 0.7（以现行为为准）。
- `translation-dictionaries/` 运行产物加入 `.gitignore`，现存产物移出跟踪。

## 3. AI 韧性与成本

### 3.1 provider 重试与 failover
- per-request retry：`packages/ai-provider/src/stream.ts` 内，errorCode ∈ {timeout, network, overloaded} 触发，指数退避+抖动，≤3 次；流式请求仅在未收到首字节前可重试。
- registry failover：租户可配置 fallback provider 序列（`AiSettings` 扩展）；主 provider 重试耗尽后按序切换；每次切换写审计。
- `agent-core/loop.ts` 不修改。

### 3.2 限流与配额
- 新增 `apps/web-server/src/common/rate-limit.ts`：per-tenant per-endpoint token bucket；挂载 `/api/v1` 全部路由与 `/api/ai/stream`。
- 超限返回 429 + `Retry-After`；租户间完全隔离。
- 限流参数按租户可配（默认全局默认值），配置存服务端。

### 3.3 用量核算
- 新增 `apps/web-server/src/common/usage-meter.ts`（落盘模式沿用 audit-log）：每次 AI 调用记录 provider/model/tokens/耗时/tenant。
- 查询 API（`/api/v1`）返回按 tenant 聚合的用量汇总（时间窗可参数化）。

### 3.4 面板统一
- markdown/html AI 面板迁移至 `chat-runtime`（与 docs/sheets/pdf/slides 同构）；六应用共享 EditQueueCard、edit-queue、composer 等组件（收敛至 `packages/chat-runtime` 或 `packages/ui` 单一来源）。
- 迁移后六应用 AI 面板启动 0 console errors，既有功能（apply_ops/write_document/编辑队列）不回退。

### 3.5 skill 体系打通
- `packages/agent-core/src/skill.ts` 新增适配器：marketplace `SkillPackage` 的工具可被 AgentLoop 消费（工具名/schema/执行映射）；至少一个官方 skill（如 text-summarize）端到端验证。

## 4. 平台化

### 4.1 OIDC/OAuth2
- `apps/web-server/src/enterprise/` 实现真实 OIDC 授权码流程（发现文档、PKCE、token 交换、claims → 本地 JWT 签发）；scope 经 route-policy 既有硬表路由。
- 替换现有假 SSO URL placeholder；OIDC 测试容器 e2e 覆盖登录→JWT→受保护 API 全链路。

### 4.2 可观测性
- `packages/agent-telemetry` 新增 OTel OTLP exporter；`/api/ai/stream` 与翻译主链路埋 span（入口→provider 调用→写回）。
- 测试 collector 断言收到完整 span 链。

### 4.3 对象存储
- `packages/file-management` 的 StorageBackend 实现 s3/minio（沿用既有接口骨架）；容器测试覆盖上传/下载/删除 roundtrip。

### 4.4 决策项登记
- docs 新增决策文档：pi 化评估（现状/收益/风险/迁移边界）、主进程双轨债、桌面 safeStorage 债。

## 5. 不变量

- 嵌入闭环 `e2e/embed-loop-probe.mjs` 保持 `LOOP OK`（11/11）。
- 六应用 web/Electron 启动 0 console errors。
- 既有门禁全绿：theme-colors、翻译四脚本、`npm test`。
- 本地 BYOK 模式在 allowlist 约束下保持可用。
- 文档内容与主题规则（CLAUDE.md Theming rules）不受影响。

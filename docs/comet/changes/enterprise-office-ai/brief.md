# Outcome

将 GenOffice 的 AI 能力（翻译 + 全量 AI 面板能力）升级到企业级：以**服务端/嵌入优先**为方向，补齐认证 fail-closed、SSRF 防护、密钥加密、多租户贯通、翻译可靠性（单元级重试/断点续翻/六应用全覆盖）、provider 韧性（重试/failover）、限流/配额/用量核算，以及 OIDC/OTel/S3 平台化能力。所有企业级基建做在 HTTP/IPC 边界层，与 agent 实现解耦（pi 化迁移不阻塞本计划）。

# Scope

需求来源：用户在本会话批准的改造计划（`/Users/louloulin/.claude/plans/office-ai-office-ai-composed-lightning.md`），及用户两项前置选择：目标形态=服务端/嵌入优先；范围=翻译+全量 AI 能力均衡。

## Source coverage

| 来源单元 | 定位 | 读取状态 | 保留语义 | Spec 位置 | 验收 ID | 覆盖状态 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 计划 §一 背景与目标 | 计划文件 | complete | 总纲：边界层基建、pi 北解耦 | spec 总述 | A1–A25 | covered | 全部验收项的共同约束 |
| 计划 §三 P0 安全 1–3 | 计划文件 | complete | fail-open/SSRF/明文 key 三缺陷 | spec 安全基座 | A1–A5 | covered | |
| 计划 §三 P1 企业级 4–6 | 计划文件 | complete | tenantId/限流配额/审计 | spec 安全基座+平台化 | A6,A7,A17,A18,A22 | covered | |
| 计划 §三 P2 翻译 7–9 | 计划文件 | complete | 单元重试/裸并发/markdown-html 缺口 | spec 翻译企业级 | A8–A14 | covered | |
| 计划 §四 Phase 1 任务表 1-1..1-5 | 计划文件 | complete | 五项任务与文件落点 | spec 安全基座 | A1–A7 | covered | 1-5 流式旁路并入 A7 场景（大文件路径）不单列验收 |
| 计划 §四 Phase 2 任务表 2-1..2-5 | 计划文件 | complete | 五项任务与文件落点 | spec 翻译企业级 | A8–A14 | covered | |
| 计划 §四 Phase 3 任务表 3-1..3-5 | 计划文件 | complete | 五项任务与文件落点 | spec AI 均衡补强 | A15–A20 | covered | |
| 计划 §四 Phase 4 任务表 4-1..4-5 | 计划文件 | complete | 五项任务与文件落点 | spec 平台化 | A21–A25 | covered | |
| 计划 §三 P3 技术债 | 计划文件 | complete | 登记不修或择机 | spec 决策项 | A25 | covered | 双轨债/pi 化/桌面 safeStorage 仅登记 |
| 用户答复合并：出范围项 | 会话确认 | complete | 协作/桌面重构/移动端不做 | Non-goals | — | non-goal | |

# Non-goals

- 协作/CRDT（collab/ 空壳保持不动）。
- 桌面端大重构：主进程双轨合并、shell 单体拆分（仅登记为债）。
- 桌面 API key safeStorage 改造（仅登记为债；本轮只做 web-server 侧加密）。
- pi.dev 迁移的实施本身（仅立项评估文档）。
- 移动端 SDK。
- 翻译引擎算法/分段策略重写（只做可靠性与覆盖补齐）。

# Acceptance examples

- A1 未配置 `WEB_TOKEN` 时启动 web-server，对 `/api/ai/stream` 与受保护 IPC 端点的未认证请求返回 401；服务日志明确提示未配置认证。配置后同请求通过。
- A2 嵌入模式（JWT 认证请求）body 中注入 `settings.baseUrl`/`settings.apiKey` 覆盖，集成测试证明上游请求仍发往服务端配置的 endpoint、使用服务端持有的 key，注入值被忽略。
- A3 本地/桌面模式保留 BYOK：baseUrl 在 allowlist（默认仅回环 + 显式配置条目）内可用；白名单外地址被拒绝并返回明确错误。
- A4 配置 `GENOFFICE_MASTER_KEY` 后保存 AI settings，`DATA_DIR/ai-settings.json` 中 key 字段为 AES-256-GCM 密文（带 keyId）；磁盘文件全文搜索不到明文 key。
- A5 settings 读取 API 对 key 返回 redacted 形态；嵌入模式 renderer 持久化存储中无明文 key。
- A6 双租户（不同 JWT tenant claim）并发使用，audit-log 中各自记录正确 tenantId，互相不可见对方记录。
- A7 chat/stream/translate 全部 AI 调用进 audit-log，含 tenant、endpoint、tokens 用量字段。
- A8 1000+ 段大文档翻译中注入部分单元失败：仅失败单元被重试（成功单元无重复 LLM 调用），最终整篇完成或给出明确失败单元清单。
- A9 翻译进程中断后重启续翻：已翻单元从 checkpoint 直接复用（无重复调用/重复计费），剩余单元继续。
- A10 `translateBatch`（非流式）并发受上限约束：并发压测峰值 ≤ 配置上限。
- A11 markdown 应用：整篇翻译与选区翻译可用，译文写回编辑器，双语模式正确，Playwright e2e 通过。
- A12 html 应用：同 A11。
- A13 `check-app-translation-parity` 门禁声明覆盖 markdown/html 且全绿（--require=whole-document --require=host-command）。
- A14 persistent-memory 阈值常量与注释一致；`translation-dictionaries/` 运行产物被 gitignore，`git status` 干净。
- A15 故障注入 provider 返回 timeout/network/overloaded：自动重试（指数退避+抖动，≤3 次；流式仅在首字节前），注入测试证明重试发生且最终成功。
- A16 配置 fallback 链的租户在主 provider 持续失败时自动切换备用 provider 完成请求（failover 测试）。
- A17 超过限流配额的请求收到 429 + Retry-After；per-tenant 隔离（A 租户打满不影响 B 租户）。
- A18 usage-meter 记录每次 AI 调用的 provider/model/tokens/耗时；查询 API 返回 per-tenant 汇总。
- A19 markdown/html 的 AI 面板迁移到 chat-runtime；六应用面板一致；EditQueueCard 等复制组件收敛为共享实现（组件单一来源）。
- A20 AgentLoop 经适配器消费至少一个 marketplace SkillPackage 工具并端到端验证。
- A21 OIDC/OAuth2 测试容器 e2e：登录→签发 JWT→携带 JWT 调用受保护 API 成功；替换 enterprise/ 中假 SSO URL。
- A22 用量/配额查询 API 返回 per-tenant 汇总（依赖 A18 数据）。
- A23 OTel OTLP exporter 上报 `/api/ai/stream` 与翻译主链路 span，测试 collector 收到完整调用链。
- A24 S3/MinIO StorageBackend 容器测试：上传/下载/删除 roundtrip 成功。
- A25 决策项文档落地：pi 化评估、主进程双轨债、桌面 safeStorage 债登记到 docs（编号、现状、建议）。

# Constraints and invariants

- 不修改 `packages/agent-core/src/loop.ts` ReAct 核心循环行为。
- 企业级基建（认证/租户/配额/审计/加密/重试策略）全部落在 HTTP/IPC 边界层，对 agent 实现无侵入。
- 既有质量门禁不得回退：`tools/check-theme-colors.mjs`、翻译四脚本（parity/copy-save/apply-hardening/storage-panel）、`npm test` 全绿。
- 嵌入闭环不回退：`e2e/embed-loop-probe.mjs` 保持 `LOOP OK`。
- 桌面 BYOK 体验保留（本地模式仍可自配 provider/baseUrl，仅加 allowlist 约束）。
- WEB_TOKEN fail-closed 属行为变更：本地无 token 开发工作流受影响，需在 docs 提供一条命令的本地 token 配置说明。

# Decisions

- D1 目标形态=服务端/嵌入优先（用户选定）：优先保障 Dataflare 等 SaaS 宿主嵌入场景。
- D2 范围=翻译+全量 AI 能力均衡推进（用户选定）。
- D3 SSRF 分场景：嵌入模式忽略 body 内 settings 覆盖；本地模式保留 BYOK+allowlist（默认回环+显式配置）。
- D4 key 加密：AES-256-GCM + 环境变量主密钥 `GENOFFICE_MASTER_KEY` + keyId 轮换；嵌入模式 key 不下发 renderer。
- D5 provider 韧性两层：per-request retry（errorCode 驱动）+ registry 级 failover 链；不动 loop.ts。
- D6 翻译重试/checkpoint 落 translation-core 协议层（translateDocument 选项扩展），三宿主同享。
- D7 markdown/html 翻译复用 apply_ops/write_document 现有写回原语，不自建链路。
- D8 限流/配额做 web-server 中间件（per-tenant per-endpoint token bucket）。
- D9 pi 化为 Phase 4 决策项，不阻塞任何阶段。
- D10 拓扑=单一 change（用户选定 2026-10-04）：四阶段作为验收分组顺序推进，不拆 Supervisor/children。
- D11 fail-closed 下的 JWT 例外：`WEB_TOKEN` 未配置且未 `GENOFFICE_ALLOW_OPEN` 时，无凭据请求 401（`locked`）；验证通过的 JWT 仍放行为 `jwt-open` authority（不走 route-policy 三态路由表，逐通道 `requireScopeFromHeaders` 仍是策略），使 Dataflarework 式 JWT-only 部署（无 `WEB_TOKEN`）与嵌入闭环 11/11 行为不变。`WEB_TOKEN` 已配置时的 JWT 走 `jwt` authority + 路由表（现状不变）。

# Open questions

（无未解决用户问题；Shape 已于 2026-10-04 经用户确认：目标/范围 25 项验收/关键决定 D1–D10/非目标均确认。）

# Verification expectations

- 每阶段结束：`npm test` 全绿 + 对应静态门禁脚本。
- 安全项（A1–A7）：新增 web-server 集成测试 + curl 实测 401/注入拒绝/密文落盘断言。
- 翻译项（A8–A14）：故障注入单测 + 中断续翻集成测试 + markdown/html Playwright e2e + parity 门禁全绿。
- 韧性项（A15–A20）：故障注入测试（429/5xx/timeout）+ 限流压测断言 + 面板启动 0 console errors。
- 平台项（A21–A24）：OIDC 测试容器 e2e + OTel collector 收包断言 + MinIO 容器 roundtrip。

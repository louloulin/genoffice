---
generated_from_state_version: 10
---

# Verification

## Current result

- Result: **Failed**
- Assurance: **skill-coordinated**
- Goal cycle: 2
- Iteration: 2
- Verifier attempt: 1
- Completed: 2026-10-04T06:11:40.482Z
- Summary: Iteration 2 的修复本身正确且经过双监听 e2e 证明：jwtPayloadFromRequest 统一四传输 JWT 解析，/api/ipc dispatcher、/api/ai/stream 与 /api/v1/ai/chat、/api/v1/ai/skill 的嵌入判定均已闭环（iter-1 的两条 exploit 路径复现不出来了）。但按『逐一枚举 settings 消费点』的排查要求，发现翻译 HTTP 面层（/api/ai/translate、/api/ai/translate/stream、/api/v1/ai/translate units[]，即 Dataflare 嵌入桥主路径）仍对 body.settings 零消毒，JWT 调用者可注入 baseUrl/apiKey 且在 jwt-open boot 无需任何 scope——A2/A31 的『一律忽略』仍未成立，判 failed 回 Build。其余 73 项维持 iter-1 结论：10 项 passed（含嵌入闭环 11/11 与本地 BYOK 不变量），63 项 blocked（密钥加密、租户/审计、翻译企业级、韧性、平台化待后续 iteration）。

## Acceptance

| ID | Result | Source | Criterion | Reason |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | A1 未配置 `WEB_TOKEN` 时启动 web-server，对 `/api/ai/stream` 与受保护 IPC 端点的未认证请求返回 401；服务日志明确提示未配置认证。配置后同请求通过。 | route-policy.ts resolveAuthority 在 WEB_TOKEN 未配置时默认 locked（:163-182）；index.ts:460-471 locked→401 并点名未配置认证；startup-checks.ts:161-166 启动 [auth] LOCKED 警告。tests/auth-fail-closed-e2e.test.ts 9 项 e2e（locked 401 于 /api/ai/stream、IPC、/api/v1、/health auth:locked；armed 后放行且裸请求仍 401）全绿；iter-2 Runtime vitest 全量 1278 passed。 |
| A2 | failed | brief.md | A2 嵌入模式（JWT 认证请求）body 中注入 `settings.baseUrl`/`settings.apiKey` 覆盖，集成测试证明上游请求仍发往服务端配置的 endpoint、使用服务端持有的 key，注入值被忽略。 | iter-2 修复确实关闭了 iter-1 两条路径（/api/v1/ai/chat 经 invokeIpc userId 覆盖；/api/ipc cookie-JWT 经 jwtPayloadFromRequest，新 e2e ai-stream-ssrf-e2e.test.ts:198-233 双监听证明 evil 0 命中），但排查发现同类残余入口未修：翻译 HTTP 面层 pickSettings（src/ai/translate-http.ts:170-172）原样返回 req.settings（无 sanitize），resolveProvider（:468/:637）把注入的 apiKey/baseUrl 直接送进 translateBatch/translateBatchStream 上游调用；POST /api/ai/translate 与 /api/ai/translate/stream 在 jwt-open 嵌入 boot 下 jwt-open 跳过路由表且路由本身无逐路由 scope 检查（index.ts:1096-1125），任意验证通过的 JWT（如 files:read）即可注入；/api/v1/ai/translate units[]（api/v1/ai.ts:111-113→translateBatchCore）与 /api/v1/ai/translate/stream（:171→handleTranslateStreamHttp）同样未消毒。『注入值被忽略』仍未对全部 JWT 认证请求成立。 |
| A3 | passed | brief.md | A3 本地/桌面模式保留 BYOK：baseUrl 在 allowlist（默认仅回环 + 显式配置条目）内可用；白名单外地址被拒绝并返回明确错误。 | 本地分支 checkBaseUrl（settings-sanitize.ts:146-161）强制 http(s)+回环/GENOFFICE_BASEURL_ALLOWLIST，未命中在发起上游前结构化拒绝；e2e 证明回环 BYOK（Ollama）保留生效、169.254.169.254→400 INVALID_ARGUMENT(allowlist) 且 evil listener 0 命中；本地分支 4 例单测全绿。iter-2 未触及该分支。 |
| A4 | blocked | brief.md | A4 配置 `GENOFFICE_MASTER_KEY` 后保存 AI settings，`DATA_DIR/ai-settings.json` 中 key 字段为 AES-256-GCM 密文（带 keyId）；磁盘文件全文搜索不到明文 key。 | 未实现——排期于后续 iteration（Phase 1 任务 1-3 secret-store 密钥加密）。 |
| A5 | blocked | brief.md | A5 settings 读取 API 对 key 返回 redacted 形态；嵌入模式 renderer 持久化存储中无明文 key。 | 未实现——排期于后续 iteration（Phase 1 任务 1-3，settings 读取 redacted）。 |
| A6 | blocked | brief.md | A6 双租户（不同 JWT tenant claim）并发使用，audit-log 中各自记录正确 tenantId，互相不可见对方记录。 | 未实现——排期于后续 iteration（Phase 1 任务 1-4 tenantId 贯通）。 |
| A7 | blocked | brief.md | A7 chat/stream/translate 全部 AI 调用进 audit-log，含 tenant、endpoint、tokens 用量字段。 | 未实现——排期于后续 iteration（Phase 1 任务 1-4 AI 调用审计）。 |
| A8 | blocked | brief.md | A8 1000+ 段大文档翻译中注入部分单元失败：仅失败单元被重试（成功单元无重复 LLM 调用），最终整篇完成或给出明确失败单元清单。 | 未实现——排期于后续 iteration（Phase 2 任务 2-1 单元级重试）。 |
| A9 | blocked | brief.md | A9 翻译进程中断后重启续翻：已翻单元从 checkpoint 直接复用（无重复调用/重复计费），剩余单元继续。 | 未实现——排期于后续 iteration（Phase 2 任务 2-2 checkpoint 续翻）。 |
| A10 | blocked | brief.md | A10 `translateBatch`（非流式）并发受上限约束：并发压测峰值 ≤ 配置上限。 | 未实现——排期于后续 iteration（Phase 2 任务 2-3 并发收敛）。 |
| A11 | blocked | brief.md | A11 markdown 应用：整篇翻译与选区翻译可用，译文写回编辑器，双语模式正确，Playwright e2e 通过。 | 未实现——排期于后续 iteration（Phase 2 任务 2-4 markdown 翻译接入）。 |
| A12 | blocked | brief.md | A12 html 应用：同 A11。 | 未实现——排期于后续 iteration（Phase 2 任务 2-4 html 翻译接入）。 |
| A13 | blocked | brief.md | A13 `check-app-translation-parity` 门禁声明覆盖 markdown/html 且全绿（--require=whole-document --require=host-command）。 | 未实现——排期于后续 iteration（Phase 2 任务 2-4 parity 门禁补齐）。 |
| A14 | blocked | brief.md | A14 persistent-memory 阈值常量与注释一致；`translation-dictionaries/` 运行产物被 gitignore，`git status` 干净。 | 未实现——排期于后续 iteration（Phase 2 任务 2-5 一致性小修）。 |
| A15 | blocked | brief.md | A15 故障注入 provider 返回 timeout/network/overloaded：自动重试（指数退避+抖动，≤3 次；流式仅在首字节前），注入测试证明重试发生且最终成功。 | 未实现——排期于后续 iteration（Phase 3 任务 3-1 per-request retry）。 |
| A16 | blocked | brief.md | A16 配置 fallback 链的租户在主 provider 持续失败时自动切换备用 provider 完成请求（failover 测试）。 | 未实现——排期于后续 iteration（Phase 3 任务 3-1 registry failover）。 |
| A17 | blocked | brief.md | A17 超过限流配额的请求收到 429 + Retry-After；per-tenant 隔离（A 租户打满不影响 B 租户）。 | 未实现——排期于后续 iteration（Phase 3 任务 3-2 rate-limit）。 |
| A18 | blocked | brief.md | A18 usage-meter 记录每次 AI 调用的 provider/model/tokens/耗时；查询 API 返回 per-tenant 汇总。 | 未实现——排期于后续 iteration（Phase 3 任务 3-3 usage-meter）。 |
| A19 | blocked | brief.md | A19 markdown/html 的 AI 面板迁移到 chat-runtime；六应用面板一致；EditQueueCard 等复制组件收敛为共享实现（组件单一来源）。 | 未实现——排期于后续 iteration（Phase 3 任务 3-4 面板统一）。 |
| A20 | blocked | brief.md | A20 AgentLoop 经适配器消费至少一个 marketplace SkillPackage 工具并端到端验证。 | 未实现——排期于后续 iteration（Phase 3 任务 3-5 skill 适配器）。 |
| A21 | blocked | brief.md | A21 OIDC/OAuth2 测试容器 e2e：登录→签发 JWT→携带 JWT 调用受保护 API 成功；替换 enterprise/ 中假 SSO URL。 | 未实现——排期于后续 iteration（Phase 4 任务 4-1 OIDC）。 |
| A22 | blocked | brief.md | A22 用量/配额查询 API 返回 per-tenant 汇总（依赖 A18 数据）。 | 未实现——排期于后续 iteration（Phase 4，依赖 A18 usage 数据）。 |
| A23 | blocked | brief.md | A23 OTel OTLP exporter 上报 `/api/ai/stream` 与翻译主链路 span，测试 collector 收到完整调用链。 | 未实现——排期于后续 iteration（Phase 4 任务 4-2 OTel）。 |
| A24 | blocked | brief.md | A24 S3/MinIO StorageBackend 容器测试：上传/下载/删除 roundtrip 成功。 | 未实现——排期于后续 iteration（Phase 4 任务 4-3 S3/MinIO）。 |
| A25 | blocked | brief.md | A25 决策项文档落地：pi 化评估、主进程双轨债、桌面 safeStorage 债登记到 docs（编号、现状、建议）。 | 未实现——排期于后续 iteration（Phase 4 任务 4-4 决策项文档）。 |
| A26 | blocked | specs/enterprise-office-ai/spec.md | GenOffice 的 AI 平台在企业级形态下的完整行为规格。全部基建位于 web-server 的 HTTP/IPC 边界层与 packages 的协议层，对 agent 实现零侵入。 | 未实现——spec 总述项，待四阶段基建全部落地后整体验收。 |
| A27 | passed | specs/enterprise-office-ai/spec.md | `WEB_TOKEN` 未配置时，`resolveAuthority` 不再返回 `open`：所有受保护端点（`/api/ai/stream`、`/api/ipc/*` AI 相关、`/api/v1/*`）对未认证请求返回 401，启动日志输出明确警告，`/health` 的 `auth` 字段报告 `locked`。 | resolveAuthority 无 WEB_TOKEN 返回 locked（route-policy.ts:163-182），不再有 open；index.ts:452-471 对受保护 /api/* 401（e2e 覆盖 /api/ai/stream、/api/ipc、/api/v1）；启动明确警告（startup-checks.ts:161-166）；/health auth 报 locked（index.ts:520，e2e 断言）。 |
| A28 | passed | specs/enterprise-office-ai/spec.md | 唯一例外（见 brief D11）：配置了 `GENOFFICE_JWT_SECRET` 时，验证通过的 JWT 仍放行为 `jwt-open`——不走 route-policy 路由表，逐通道 `requireScopeFromHeaders` 仍是策略；JWT-only 嵌入部署（Dataflarework）行为不变，嵌入闭环保持 11/11。 | jwt-open authority（route-policy.ts:79-83/:179-180）不走路由表（index.ts:488-490），逐通道 requireScopeFromHeaders 仍是策略（index.ts:779-793 保留）；iter-2 对 dispatcher/embed 判定改用 jwtPayloadFromRequest 不改变该语义；Runtime 检查 e2e/embed-loop-probe.mjs → LOOP OK 11/11。 |
| A29 | passed | specs/enterprise-office-ai/spec.md | 本地开发可用 `GENOFFICE_ALLOW_OPEN=1\|true` 显式恢复历史 open 姿态（其他值 fail-closed）；`HOST` 非回环且无 `WEB_TOKEN` 时启动直接报错拒绝（`GENOFFICE_ALLOW_OPEN` 也不能豁免）。 | openModeAllowed 仅接受 '1'/'true'（route-policy.ts:91-94，含 fail-closed 反例单测）；非回环 HOST+无 WEB_TOKEN 记 problem→runStartupChecks exit(1) 且不受 GENOFFICE_ALLOW_OPEN 豁免（startup-checks.ts:154-159 先于 openAllowed 判断）；tests/startup-checks.test.ts:149-155 断言。 |
| A30 | passed | specs/enterprise-office-ai/spec.md | 配置 `WEB_TOKEN` 后行为与现状一致（共享密钥即操作员）；JWT+scope 路由（route-policy 三态 authority）不变。 | armed 分支共享密钥原语义保留（route-policy.ts:168-175）；JWT 走 jwt authority + jwtScopeFor 路由表不变；auth.test.ts armed/四传输凭证用例、auth-fail-closed-e2e armed 姿态用例全绿。 |
| A31 | failed | specs/enterprise-office-ai/spec.md | **嵌入/JWT 模式**：请求 body 中的 `settings.baseUrl`、`settings.apiKey` 覆盖一律忽略，provider 配置以服务端（租户）设置为准。落点：`apps/web-server/src/ai/chat.ts` settings 解析前的 sanitize 层。 | iter-2 修复正确关闭了已证两条入口（v1/ai/chat 与 ai:skill 经 invokeIpc eventOverrides 透传 JWT sub（api/v1/ai.ts:74/:285，sub 在签发时校验非空 auth.ts:401-405）；/api/ipc dispatcher 与 /api/ai/stream 的 embed 判定改用四传输 jwtPayloadFromRequest（index.ts:811/:974）），但 spec『嵌入/JWT 模式覆盖一律忽略』在翻译面仍被违反：src/ai/translate-http.ts pickSettings（:170-172）对 body.settings 零消毒地整体采纳并经 resolveProvider 进入上游 provider 调用（:468/:637），该面层自述为『Dataflare bridge 的主路径』（:59）——正是嵌入模式；且 /api/ai/translate(/stream) 在 jwt-open boot 无逐路由 scope 检查，/api/v1/ai/translate units[] 形状（api/v1/ai.ts:111-113）同样未消毒。 |
| A32 | passed | specs/enterprise-office-ai/spec.md | **本地/桌面模式**：保留 BYOK。baseUrl 必须命中 allowlist（默认仅回环地址 127.0.0.1/localhost/::1 + 操作员显式配置条目）；未命中返回结构化错误（含 reason），不发起上游请求。 | checkBaseUrl（settings-sanitize.ts:56-70）默认回环 + GENOFFICE_BASEURL_ALLOWLIST 显式条目；未命中返回含 reason 的结构化错误并在任何上游请求前拒绝（e2e evil 0 命中）。本地分支（无 JWT）在所有入口一致执行。 |
| A33 | passed | specs/enterprise-office-ai/spec.md | settings 覆盖中的模型名、温度等非网络参数不受 sanitize 影响。 | stripNetworkFields 仅删 apiKey/baseUrl（settings-sanitize.ts:75-92），provider 选择/model/maxOutputTokens 保留并经 backfill 存活；单测断言 model 保留，e2e embed 请求带 model:'gpt-4o' 正常出流。 |
| A34 | blocked | specs/enterprise-office-ai/spec.md | 新增 `apps/web-server/src/common/secret-store.ts`：AES-256-GCM，主密钥来自环境变量 `GENOFFICE_MASTER_KEY`（64 hex 字符或经 KDF）；密文格式 `v1:<keyId>:<iv>:<ciphertext>:<tag>`，keyId 支持主密钥轮换。 | 未实现——排期于后续 iteration（Phase 1 任务 1-3，src/common/secret-store.ts）。 |
| A35 | blocked | specs/enterprise-office-ai/spec.md | `DATA_DIR/ai-settings.json` 落盘时 provider apiKey 经 secret-store 加密；读取时解密；主密钥缺失时启动报错并拒绝解密（不静默回退明文）。 | 未实现——排期于后续 iteration（Phase 1 任务 1-3，ai-settings.json 落盘加密）。 |
| A36 | blocked | specs/enterprise-office-ai/spec.md | 所有 settings 读取 API 返回 redacted key（如 `sk-***abcd`）；嵌入模式下 renderer 永远拿不到明文 key——AI 请求由服务端代理携带。 | 未实现——排期于后续 iteration（Phase 1 任务 1-3，redacted key 读取 API）。 |
| A37 | blocked | specs/enterprise-office-ai/spec.md | 桌面端明文 localStorage 为已登记债（Non-goal），不在本 capability 内。 | Non-goal 登记项，随 Phase 4 决策文档一并落地（后续 iteration）。 |
| A38 | blocked | specs/enterprise-office-ai/spec.md | JWT claims 携带租户标识（tenantId/spaceId），经 route-policy 解析后写入请求上下文。 | 未实现——排期于后续 iteration（Phase 1 任务 1-4，JWT tenant claims 入上下文）。 |
| A39 | blocked | specs/enterprise-office-ai/spec.md | audit-log 每条记录含 tenantId；双租户并发写入互不串数据。 | 未实现——排期于后续 iteration（Phase 1 任务 1-4，audit-log tenantId）。 |
| A40 | blocked | specs/enterprise-office-ai/spec.md | 全仓硬编码 `'default'` 租户替换为上下文取值（无 JWT 时回退 `default` 并在审计中标记）。 | 未实现——排期于后续 iteration（Phase 1 任务 1-4，硬编码 'default' 租户替换）。 |
| A41 | blocked | specs/enterprise-office-ai/spec.md | chat/stream/translate/image 等 AI 调用统一写 audit-log：tenant、endpoint、provider、model、tokens（prompt/completion）、耗时、结果状态。 | 未实现——排期于后续 iteration（Phase 1 任务 1-4，AI 调用全量审计）。 |
| A42 | blocked | specs/enterprise-office-ai/spec.md | `packages/translation-core/src/document.ts` 的批次 settle 循环内：单元失败按 ai-provider errorCode 分类——可重试（timeout/network/overloaded/5xx）自动重试（指数退避+抖动，≤3 次）；不可重试（credits/认证/内容策略）跳过并记录。 | 未实现——排期于后续 iteration（Phase 2 任务 2-1，translation-core 单元重试）。 |
| A43 | blocked | specs/enterprise-office-ai/spec.md | 成功单元不重复调用；结束后产出失败单元清单（unitId/原因），整篇结果标记 `completed-with-failures` 或 `failed`。 | 未实现——排期于后续 iteration（Phase 2 任务 2-1，失败单元清单）。 |
| A44 | blocked | specs/enterprise-office-ai/spec.md | `TranslateDocumentOptions` 新增 checkpoint adapter 接口：`load(unitId)` / `save(unitId, result)`。 | 未实现——排期于后续 iteration（Phase 2 任务 2-2，checkpoint adapter 接口）。 |
| A45 | blocked | specs/enterprise-office-ai/spec.md | 每单元翻译成功即 save；重跑同一文档时已翻单元直接复用。 | 未实现——排期于后续 iteration（Phase 2 任务 2-2，逐单元 save/复用）。 |
| A46 | blocked | specs/enterprise-office-ai/spec.md | web-server `translate-http.ts` 提供基于翻译会话的 store 实现；桌面/嵌入宿主可各自提供实现或省略（省略=无续翻）。 | 未实现——排期于后续 iteration（Phase 2 任务 2-2，translate-http store 实现）。 |
| A47 | blocked | specs/enterprise-office-ai/spec.md | 取消语义不变：取消一律不写回文档，但 checkpoint 保留已翻单元供续翻。 | 未实现——排期于后续 iteration（Phase 2 任务 2-2，取消语义 + checkpoint 保留）。 |
| A48 | blocked | specs/enterprise-office-ai/spec.md | `translateBatch`（非流式）与词典构建改用有界并发（复用 stream 版 worker-pool 模式），并发上限可配置，默认与 stream 版一致（25）。 | 未实现——排期于后续 iteration（Phase 2 任务 2-3，translateBatch 有界并发）。 |
| A49 | blocked | specs/enterprise-office-ai/spec.md | 两应用新增宿主实现：extract 单元（markdown 按块、html 按可翻译文本节点）+ apply 回写（复用 `apply_ops`/`write_document` 现有原语）。 | 未实现——排期于后续 iteration（Phase 2 任务 2-4，markdown/html 宿主实现）。 |
| A50 | blocked | specs/enterprise-office-ai/spec.md | 支持：整篇翻译、选区翻译、双语模式；走 translateDocument 同一管线（含 2.1–2.3 全部能力）。 | 未实现——排期于后续 iteration（Phase 2 任务 2-4，整篇/选区/双语）。 |
| A51 | blocked | specs/enterprise-office-ai/spec.md | `check-app-translation-parity.mjs` 声明矩阵补齐两应用（wholeDocument/hostCommand/bilingual/writeBack），门禁全绿。 | 未实现——排期于后续 iteration（Phase 2 任务 2-4，parity 门禁矩阵补齐）。 |
| A52 | blocked | specs/enterprise-office-ai/spec.md | persistent-memory 阈值：常量与注释统一为 0.7（以现行为为准）。 | 未实现——排期于后续 iteration（Phase 2 任务 2-5，persistent-memory 阈值 0.7）。 |
| A53 | blocked | specs/enterprise-office-ai/spec.md | `translation-dictionaries/` 运行产物加入 `.gitignore`，现存产物移出跟踪。 | 未实现——排期于后续 iteration（Phase 2 任务 2-5，translation-dictionaries gitignore）。 |
| A54 | blocked | specs/enterprise-office-ai/spec.md | per-request retry：`packages/ai-provider/src/stream.ts` 内，errorCode ∈ {timeout, network, overloaded} 触发，指数退避+抖动，≤3 次；流式请求仅在未收到首字节前可重试。 | 未实现——排期于后续 iteration（Phase 3 任务 3-1，ai-provider/stream.ts retry）。 |
| A55 | blocked | specs/enterprise-office-ai/spec.md | registry failover：租户可配置 fallback provider 序列（`AiSettings` 扩展）；主 provider 重试耗尽后按序切换；每次切换写审计。 | 未实现——排期于后续 iteration（Phase 3 任务 3-1，fallback provider 链）。 |
| A56 | blocked | specs/enterprise-office-ai/spec.md | `agent-core/loop.ts` 不修改。 | 负向不变量（loop.ts 不修改），待全量 capability 最终验收时统一确认（iter-2 diff 未触及，后续仍需复核）。 |
| A57 | blocked | specs/enterprise-office-ai/spec.md | 新增 `apps/web-server/src/common/rate-limit.ts`：per-tenant per-endpoint token bucket；挂载 `/api/v1` 全部路由与 `/api/ai/stream`。 | 未实现——排期于后续 iteration（Phase 3 任务 3-2，rate-limit.ts）。 |
| A58 | blocked | specs/enterprise-office-ai/spec.md | 超限返回 429 + `Retry-After`；租户间完全隔离。 | 未实现——排期于后续 iteration（Phase 3 任务 3-2，429 + Retry-After）。 |
| A59 | blocked | specs/enterprise-office-ai/spec.md | 限流参数按租户可配（默认全局默认值），配置存服务端。 | 未实现——排期于后续 iteration（Phase 3 任务 3-2，按租户限流配置）。 |
| A60 | blocked | specs/enterprise-office-ai/spec.md | 新增 `apps/web-server/src/common/usage-meter.ts`（落盘模式沿用 audit-log）：每次 AI 调用记录 provider/model/tokens/耗时/tenant。 | 未实现——排期于后续 iteration（Phase 3 任务 3-3，usage-meter.ts）。 |
| A61 | blocked | specs/enterprise-office-ai/spec.md | 查询 API（`/api/v1`）返回按 tenant 聚合的用量汇总（时间窗可参数化）。 | 未实现——排期于后续 iteration（Phase 3 任务 3-3，用量聚合查询 API）。 |
| A62 | blocked | specs/enterprise-office-ai/spec.md | markdown/html AI 面板迁移至 `chat-runtime`（与 docs/sheets/pdf/slides 同构）；六应用共享 EditQueueCard、edit-queue、composer 等组件（收敛至 `packages/chat-runtime` 或 `packages/ui` 单一来源）。 | 未实现——排期于后续 iteration（Phase 3 任务 3-4，markdown/html 面板迁移 chat-runtime）。 |
| A63 | blocked | specs/enterprise-office-ai/spec.md | 迁移后六应用 AI 面板启动 0 console errors，既有功能（apply_ops/write_document/编辑队列）不回退。 | 未实现——排期于后续 iteration（Phase 3 任务 3-4，0 console errors 回归）。 |
| A64 | blocked | specs/enterprise-office-ai/spec.md | `packages/agent-core/src/skill.ts` 新增适配器：marketplace `SkillPackage` 的工具可被 AgentLoop 消费（工具名/schema/执行映射）；至少一个官方 skill（如 text-summarize）端到端验证。 | 未实现——排期于后续 iteration（Phase 3 任务 3-5，skill.ts marketplace 适配器）。 |
| A65 | blocked | specs/enterprise-office-ai/spec.md | `apps/web-server/src/enterprise/` 实现真实 OIDC 授权码流程（发现文档、PKCE、token 交换、claims → 本地 JWT 签发）；scope 经 route-policy 既有硬表路由。 | 未实现——排期于后续 iteration（Phase 4 任务 4-1，真实 OIDC 授权码流程）。 |
| A66 | blocked | specs/enterprise-office-ai/spec.md | 替换现有假 SSO URL placeholder；OIDC 测试容器 e2e 覆盖登录→JWT→受保护 API 全链路。 | 未实现——排期于后续 iteration（Phase 4 任务 4-1，替换假 SSO URL + 容器 e2e）。 |
| A67 | blocked | specs/enterprise-office-ai/spec.md | `packages/agent-telemetry` 新增 OTel OTLP exporter；`/api/ai/stream` 与翻译主链路埋 span（入口→provider 调用→写回）。 | 未实现——排期于后续 iteration（Phase 4 任务 4-2，OTel OTLP exporter）。 |
| A68 | blocked | specs/enterprise-office-ai/spec.md | 测试 collector 断言收到完整 span 链。 | 未实现——排期于后续 iteration（Phase 4 任务 4-2，collector span 断言）。 |
| A69 | blocked | specs/enterprise-office-ai/spec.md | `packages/file-management` 的 StorageBackend 实现 s3/minio（沿用既有接口骨架）；容器测试覆盖上传/下载/删除 roundtrip。 | 未实现——排期于后续 iteration（Phase 4 任务 4-3，s3/minio StorageBackend）。 |
| A70 | blocked | specs/enterprise-office-ai/spec.md | docs 新增决策文档：pi 化评估（现状/收益/风险/迁移边界）、主进程双轨债、桌面 safeStorage 债。 | 未实现——排期于后续 iteration（Phase 4 任务 4-4，决策文档）。 |
| A71 | passed | specs/enterprise-office-ai/spec.md | 嵌入闭环 `e2e/embed-loop-probe.mjs` 保持 `LOOP OK`（11/11）。 | iter-2 Runtime 检查 e2e/embed-loop-probe.mjs：LOOP OK，11/11 invariants 全绿，在 fail-closed gate + sanitize（含 iter-2 四传输 embed 判定）同时生效的构建上运行。 |
| A72 | blocked | specs/enterprise-office-ai/spec.md | 六应用 web/Electron 启动 0 console errors。 | 本轮检查计划未含六应用 web/Electron 启动 console 检查；属全量不变量，排期于后续 iteration 验收。 |
| A73 | blocked | specs/enterprise-office-ai/spec.md | 既有门禁全绿：theme-colors、翻译四脚本、`npm test`。 | iter-2 Runtime 已覆盖 typecheck、vitest 全量（1278 passed / 23 skipped，154 files）、node:test 40/40；但 theme-colors 门禁与翻译四脚本不在检查计划，待后续 iteration 一并验收。 |
| A74 | passed | specs/enterprise-office-ai/spec.md | 本地 BYOK 模式在 allowlist 约束下保持可用。 | e2e『still honors a loopback BYOK baseUrl override (local Ollama use case)』通过（operator 回环 BYOK key 原样到达上游）；ai-settings-sanitize.test.ts 本地分支 4 例全绿；iter-2 的 embed 判定收紧（jwtPayloadFromRequest）不影响无 JWT 的本地调用者路径。 |
| A75 | blocked | specs/enterprise-office-ai/spec.md | 文档内容与主题规则（CLAUDE.md Theming rules）不受影响。 | iter-1/iter-2 候选均未触及 theming/文档内容代码（typecheck 与全量 vitest 通过），但该不变量属最终状态确认，待全量 capability 完成后验收。 |

## Checks

| Check | Command | Working directory | Status | Exit | Duration |
| --- | --- | --- | --- | ---: | ---: |
| web-server TypeScript typecheck (tsc --noEmit) | typecheck | apps/web-server | passed | 0 | 5492 ms |
| web-server full vitest suite (154 files) — excludes tests/sidecar-pool-readrouting.test.ts only because that file hard-requires an untracked scratch fixture (.playwright-mcp/verify-supplier.xlsx) absent from this machine, a pre-existing environmental gap unrelated to this candidate | vitest run --exclude tests/sidecar-pool-readrouting.test.ts --reporter=dot | apps/web-server | passed | 0 | 29615 ms |
| web-server node:test HTTP suites (npm run test:http, 40 tests) | run test:http | apps/web-server | passed | 0 | 1392 ms |
| Embed closed-loop probe (LOOP OK invariant, JWT-only boot) | e2e/embed-loop-probe.mjs | . | passed | 0 | 6279 ms |

## Blockers

_None._

## Risks and skipped work

- 残余 SSRF 入口（A2/A31 失败根因）：src/ai/translate-http.ts pickSettings（:170-172）对 body.settings 零消毒，resolveProvider（:468/:637）将注入的 apiKey/baseUrl 直接送入 translateBatch/translateBatchStream 上游；该面层是 Dataflare 嵌入桥的主路径。建议修复：在 handleTranslateBatchHttp/handleTranslateStreamHttp/translateBatchCore 入口按调用者身份走 sanitizeRequestSettings（embed 剥离+回填 / 本地 allowlist），并补双监听 e2e。
- 放大因素：POST /api/ai/translate 与 /api/ai/translate/stream（index.ts:1096-1125）无逐路由 scope 检查，jwt-open 嵌入 boot 下任意验证通过的 JWT（包括最窄的 files:read）即可达——比 iter-1 的 v1/chat 缺口（需 ai:chat scope）更宽；修复时建议同时给这两个 legacy 路由补 route-policy scope（ai:translate）。
- api/v1/ai.ts handleAiImage / ai:fetch-image 是服务端任意 URL 拉取面（非 settings 类 SSRF），属预存问题、不在 A2/A31 文本内，建议纳入后续加固任务（Phase 3 或任务 1-5 流式/旁路加固）显式排期。
- 全量套件预存环境缺口不变：tests/sidecar-pool-readrouting.test.ts 依赖本机不存在的未跟踪 fixture（.playwright-mcp/verify-supplier.xlsx），与本 change 无关但持续污染『全绿』判定。
- GENOFFICE_BASEURL_ALLOWLIST 按主机名精确匹配、仅校验 http(s)，本地模式回环放行意味着可命中本机任意端口服务；符合 D3 设计意图，提请设计知悉。

## Previous iterations

| Goal cycle | Iteration | Attempt | Outcome | Unresolved | Summary | Completed |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 0 | recovery | — | Formal requirement write requested for brief.md | 2026-10-04T03:31:47.010Z |
| 2 | 1 | 1 | fail | A2, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A31, A34, A35, A36, A37, A38, A39, A40, A41, A42, A43, A44, A45, A46, A47, A48, A49, A50, A51, A52, A53, A54, A55, A56, A57, A58, A59, A60, A61, A62, A63, A64, A65, A66, A67, A68, A69, A70, A72, A73, A75 | Iteration 1 交付了安全切片（任务 1-1 fail-closed 五态认证 + 任务 1-2 SSRF sanitize），A1/A3 及 spec 认证项（A27–A30、A32、A33）经代码、新增测试（9+4 e2e、11 单测）与 Runtime 四项检查独立验证通过，嵌入闭环不变量保持 LOOP OK 11/11。但发现一个真实实现缺陷：sanitize 的嵌入判定在 /api/v1 入口失效（ipc-bridge 事件无 JWT subject），JWT 调用者注入的 apiKey 在 POST /api/v1/ai/chat 上不被忽略，A2/A31 判 failed，需回 Build 修复后重验。其余 63 项（密钥加密、租户/审计、翻译企业级、韧性、平台化及全量不变量确认）尚未实现，排期于后续 iteration。 | 2026-10-04T05:02:07.075Z |
| 2 | 2 | 1 | fail | A2, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A31, A34, A35, A36, A37, A38, A39, A40, A41, A42, A43, A44, A45, A46, A47, A48, A49, A50, A51, A52, A53, A54, A55, A56, A57, A58, A59, A60, A61, A62, A63, A64, A65, A66, A67, A68, A69, A70, A72, A73, A75 | Iteration 2 的修复本身正确且经过双监听 e2e 证明：jwtPayloadFromRequest 统一四传输 JWT 解析，/api/ipc dispatcher、/api/ai/stream 与 /api/v1/ai/chat、/api/v1/ai/skill 的嵌入判定均已闭环（iter-1 的两条 exploit 路径复现不出来了）。但按『逐一枚举 settings 消费点』的排查要求，发现翻译 HTTP 面层（/api/ai/translate、/api/ai/translate/stream、/api/v1/ai/translate units[]，即 Dataflare 嵌入桥主路径）仍对 body.settings 零消毒，JWT 调用者可注入 baseUrl/apiKey 且在 jwt-open boot 无需任何 scope——A2/A31 的『一律忽略』仍未成立，判 failed 回 Build。其余 73 项维持 iter-1 结论：10 项 passed（含嵌入闭环 11/11 与本地 BYOK 不变量），63 项 blocked（密钥加密、租户/审计、翻译企业级、韧性、平台化待后续 iteration）。 | 2026-10-04T06:11:40.482Z |

## Conclusion

Iteration 2 的修复本身正确且经过双监听 e2e 证明：jwtPayloadFromRequest 统一四传输 JWT 解析，/api/ipc dispatcher、/api/ai/stream 与 /api/v1/ai/chat、/api/v1/ai/skill 的嵌入判定均已闭环（iter-1 的两条 exploit 路径复现不出来了）。但按『逐一枚举 settings 消费点』的排查要求，发现翻译 HTTP 面层（/api/ai/translate、/api/ai/translate/stream、/api/v1/ai/translate units[]，即 Dataflare 嵌入桥主路径）仍对 body.settings 零消毒，JWT 调用者可注入 baseUrl/apiKey 且在 jwt-open boot 无需任何 scope——A2/A31 的『一律忽略』仍未成立，判 failed 回 Build。其余 73 项维持 iter-1 结论：10 项 passed（含嵌入闭环 11/11 与本地 BYOK 不变量），63 项 blocked（密钥加密、租户/审计、翻译企业级、韧性、平台化待后续 iteration）。

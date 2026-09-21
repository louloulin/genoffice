- **RFC 编号**：0001
- **标题**：GenOffice 开放计划 v1（三层开放模型 + SDK/API + AI 生态 + 社区）
- **作者**：louloulin
- **状态**：accepted
- **创建日期**：2026-09-15
- **最后更新**：2026-09-22

## Summary

把 GenOffice 从"可运行的 monorepo"升级为"全球开发者可用的开放平台"。核心抓手：**三层开放模型**（Tier 1 SDK/API · Tier 2 AI/Skill 生态 · Tier 3 社区开源），稳定 v1 契约 + npm publish + iframe Embed + Provider/Skill 插件市场 + 完整社区治理。

## Motivation

AI 办公赛道的格局：

- **Google Docs** — UI 漂亮但没有完整可嵌入 SDK，AI 锁定在 Workspace 套餐里。
- **WPS AI** — 仅对企业开放 SDK / API，个人开发者摸不到。
- **OnlyOffice** — 可嵌入但不带 AI，编辑器内核陈旧。
- **Microsoft Office** — Graph API 复杂、绑定 Azure AD、生态封闭。

GenOffice 已经有 Apache-2.0 monorepo + 6 编辑器 + 27 packages + 内置 AI 编排 + i18n。如果把"开放"这件事做透，能填补 Google / WPS / OnlyOffice 三角都没覆盖的空隙：个人开发者既能跑又能嵌入还能挂自己的 AI。

## Detailed Design

### 顶层模型

```
Tier 3: Community 开源（最广）    Apache-2.0 · CONTRIBUTING · RFC · 公开 issue/discussion
Tier 2: 开放 AI / Skill 生态        Provider 插件市场 · Skill 仓库 · KB/TM 分享 · Agent 协议
Tier 1: 开放 SDK / API（最直接商业化）  @genoffice/web-sdk · REST API v1 · iframe Embed · Webhooks
```

### Tier 1（必须稳定）

- **REST API v1**：10 端点（auth / files / ai / kb / webhooks / health / changelog）。承诺 `v1.x` 不破坏 URL / 字段 / 错误码；`v2` 留 6 个月过渡。
- **`@genoffice/web-sdk`**：UMD + ESM + CJS 三产物；`createEditor` / `buildEmbedUrl` / `<script>` 三种集成形态。
- **iframe Embed 端点**：`/embed/:docId`，含 nonce + origin allowlist 握手。
- **Webhook 事件**：HMAC-SHA256 签名（`X-GenOffice-Signature` 头）保证出站请求可信。
- **JWT scope RBAC**：默认 scope + 通配 scope + admin bypass 三层权限模型。

### Tier 2（AI 生态）

- **`AiProviderPlugin` 接口** + `ProviderRegistry`：第三方 provider 通过 npm 包即插即用。
- **`SkillPackage` 接口** + `getDefaultSkillRegistry`：skill 与 provider 同级解耦。
- **KB/TM 开放格式**（`.genkb` / `.gentm`）：脱离 GenOffice 也能读写。
- **Agent Loop 协议 v1**：5 步循环（observe / think / act / observe / commit）标准化。
- **Marketplace loader**：web-server 启动时扫 `node_modules/@genoffice/*` 自动注册。

### Tier 3（社区）

- 6 个治理文档：`ROADMAP` / `GOVERNANCE` / `CONTRIBUTING` / `CODE_OF_CONDUCT` / `SECURITY` / `CHANGELOG`。
- GitHub 模板：3 个 issue + 1 个 discussion + 1 个 PR。
- CI 全套：lint / typecheck / test / build / bundle / docker。
- `Dockerfile`（多阶段 Node 22，non-root，内置 healthcheck）。
- `examples/` 5 个 worked example：embed-basic / embed-react / embed-vue / custom-provider / custom-skill。
- **本 RFC 流程**：见 `docs/rfcs/README.md`。

## Drawbacks

- **v1 稳定性承诺是双刃剑**：一旦发布 v1，以后想改字段就要走 6 个月 deprecation 周期。前期 API 设计需要反复 review。
- **npm 包粒度**：`@genoffice/*` 27 个包对消费者心智负担大，需要 `installation.md` + 选型矩阵做引导。
- **三方 provider / skill 质量参差**：marketplace 模式无法强制审查，需要在 manifest 层声明能力 + 在 web-server 层做 grace degrade。
- **双语文档维护成本**：中英同步更新容易漂移，目前用"EN 为准 + zh-CN 镜像"流程。

## Alternatives

- **方案 A — 全部走 SDK，不开放 REST API**：更简单，但企业集成方（无 Node 环境）拿不到能力。
- **方案 B — REST API + Web SDK，但 Provider / Skill 全部内置**：更可控，但第三方贡献者无法扩展，与"开放"自相矛盾。
- **方案 C — 仅开源 monorepo 不做 SDK 包装**：维护成本低，但用户要自己解 IPC / 协议层，门槛太高。
- **选定方案**：综合 A/B/C，取长补短 — Tier 1 强契约（API + SDK），Tier 2 插件化（Provider / Skill），Tier 3 社区化（治理 + 文档）。

## Adoption / Migration

- **新用户**：直接 `npm install @genoffice/web-sdk` → 5 分钟跑通。
- **老用户**（monorepo 开发者）：无破坏；`apps/web-server` 启动方式不变。
- **企业迁移**（从 WPS / OnlyOffice）：参考 `docs/guide/migration-from-wps.md`（待写）。

## Open Questions / Unresolved

- 双语文档是用 VitePress `locales` 还是两套独立站点？目前用 `locales`，但翻译同步流程要补 CI。
- Marketplace 是否引入"评分 / 评论"系统？目前只有 npm 版本号引用，引入评分需要后台服务。

## Test Plan

- 单元测试：每个 npm 包带 vitest，CI 强制 ≥ 80% 覆盖（实际已 1345 测试 / 125 文件）。
- 端到端：web-server `npm run test:e2e` 跑全链路；`examples/custom-provider` + `custom-skill` 用 `npm publish --dry-run` 验证 tarball 完整性。
- 手工冒烟：每月一次 Office Hours 演示（计划中）+ 月度 release notes。

## References

- 完整计划：`sdk1.md`（仓库根）。
- 实施状态：同文件附录 A（A.1 / A.2 / A.3 / A.4 / A.5 / A.6）。
- WPS 对照分析：同文件附录 B。
- 路线图：同文件附录 C（M4+）。
- 执行原则：同文件附录 D。

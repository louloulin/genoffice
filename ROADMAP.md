# GenOffice Roadmap

> 公开路线图。社区可通过 [GitHub Discussions](https://github.com/genoffice/genoffice/discussions) 或 RFC 流程影响优先级。

## 当前里程碑：M0 — 开放基础（Day 1-14）

- [ ] 注册 npm scope `@genoffice`、GitHub org、域名
- [ ] README / CONTRIBUTING / CODE_OF_CONDUCT / LICENSE（已存在）
- [ ] GitHub Actions: CI（typecheck + test + lint）+ release（npm + docker）
- [ ] typedoc 配置 + REST API 文档骨架
- [ ] 1 个 example: `examples/embed-basic/`
- [ ] 整理 `apps/sdk/` 基础骨架 + `npm publish --dry-run`
- [ ] 公开仓库 + npm publish v0.1.0-beta + GitHub Discussion 开放

## M1 — Web SDK + REST API + iframe Embed（Week 1-4）

- [ ] `apps/sdk/` 包骨架（ESM + CJS + UMD + types）
- [ ] iframe Embed 端点 `GET /embed/:docId?token=...`
- [ ] JWT 签发与验证（HS256 + RS256 双算法）
- [ ] postMessage 协议 v1.0
- [ ] REST API v1 端点实现
- [ ] SDK README + 5 分钟上手指南
- [ ] 3 个 example: embed-basic / embed-react / embed-vue
- [ ] Webhook 事件分发
- [ ] SDK 单元测试 + E2E

## M2 — Provider 插件市场 + Skill 仓库 + Agent 协议（Week 5-8）

- [ ] `packages/ai-provider/src/provider-plugin.ts` 接口定义
- [ ] 官方 provider 包: `@genoffice/provider-{anthropic,gemini,openai,...}`
- [ ] Skill 协议 `packages/agent-skills/src/skill-protocol.ts`
- [ ] KB/TM 开放格式（.genkb / .gentm）
- [ ] Agent 协议 `genoffice.agent.v1`
- [ ] Skill 官方市场 + GitHub 仓库
- [ ] 10 个官方 skill 发布

## M3 — GA v1.0（Week 9-12）

- [ ] 文档站完整（中英双语）
- [ ] 性能与稳定性 SLA
- [ ] Docker 镜像 + Helm chart
- [ ] OAuth 2.0 企业版
- [ ] 商业版（Pro / Enterprise）发布
- [ ] 企业销售启动

## 长期（6-12 月）

- 协作实时多端（CRDT / Loro）
- 会议纪要 / 语音转写
- 跨应用 AI 调度（一句话做 PPT）
- 移动端 SDK
- 私有化部署包

## 不在路线图上

以下功能 **不会** 进入主线（避免 scope 漂移）：

- ❌ 移动端原生 App（建议用 PWA + Web SDK）
- ❌ 完整 CRM / ERP（GenOffice 专注办公）
- ❌ 自研向量数据库（采用 hnswlib-node 或 Qdrant 客户端）
- ❌ 自研 CRDT（采用 Loro 或 Yjs）

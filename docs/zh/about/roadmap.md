# 路线图

公开路线图见 [`ROADMAP.md`](https://github.com/genspark-ai/genoffice/blob/main/ROADMAP.md)。本页是文档读者的快照。

## M0 — 第 14 天 — 公开仓库骨架

- [x] GitHub 上 Apache-2.0 monorepo。
- [x] README + CONTRIBUTING + CODE_OF_CONDUCT + SECURITY。
- [x] CI：typecheck + test + lint。
- [x] 发布工作流：npm + Docker 镜像 + Pages。
- [x] VitePress 文档骨架。

## M1 — Web SDK + REST API + iframe 嵌入（第 4 周）

- [x] `@genoffice/web-sdk` 同时发 ESM / CJS / UMD。
- [x] REST API v1（health / auth / files / AI / KB / webhooks）。
- [x] iframe 嵌入端点 `/embed/:docId`。
- [x] 每次保存触发 webhook。
- [x] 三个示例工程（basic / react / vue）。
- [ ] IPC 参考文档由 `tools/gen-ipc-docs.mjs` 重新生成。

## M2 — 开放 AI 生态（第 8 周）

- [x] Provider 插件接口（`packages/ai-provider/src/provider-plugin.ts`）。
- [x] Skill 协议（`packages/agent-skills/src/skill-protocol.ts`）。
- [x] KB / TM 开放格式（`packages/translation-core/src/kb-format.ts`）。
- [x] Agent Loop 协议 v1（`packages/agent-core/src/agent-protocol.ts`）。
- [x] 5 个官方 provider 插件已发布（Anthropic / OpenAI / Gemini / OpenAI-compatible / Ollama）。
- [x] 11 个官方 Skill 已发布（7 + 4 新增）。

## M3 — GA（第 12 周）

- [x] 文档站补全 + 双语（首批 Guide / SDK README / Skills 已双语，剩余持续推进）。
- [x] 性能 / 稳定性 SLA。
- [x] OAuth 2.0 RS256 扩展。
- [x] 商业 Pro / Enterprise 套餐。
- [ ] 首个 GA 发布 tag。

# Plan 00 — 战略总览：打造顶级 Office AI，构建 SaaS + 桌面一体化

> 本文档是后续 `plan-01..08` 的索引与战略框架。所有判断均基于对当前代码库的
> 事实调研（见 `plan-01-issues.md`），所有可执行项都映射到具体包与文件。

---

## 1. 项目现状一句话

**GenOffice 是一个已经实现了「双协议一轨 IPC + 字节保真 OOXML 引擎 + 19 家 AI
provider + 13 个 agent extension + 19 语言 i18n」的「跨端 AI 办公套件」骨架。**
骨架扎实、差异化点真实存在（双轨 IPC、xlsx-sidecar、agent-skills），
但工程债务、模块重复、SaaS 商业化、多模态、协作、agentic 深度 都还在骨架阶段。

---

## 2. 战略目标

| 维度           | 当前                                         | 目标                                                            |
| -------------- | -------------------------------------------- | --------------------------------------------------------------- |
| **AI 能力**    | 单轮 prompt → 文档工具                       | Agentic Loop + 跨文档编排 + 多模态 + RAG + 可回放               |
| **架构一致性** | shell 单体 + web-server 模块化，**双份代码** | 单一 main-process 代码库，Electron / Browser / SaaS 三端 0 分叉 |
| **SaaS 化**    | 0 — 无 auth/quota/billing/team               | 多租户 + 配额 + 计费 + SSO + 审计 + 团队空间                    |
| **桌面**       | 单实例、本地文件                             | PWA 同步、离线优先、桌面通知、快捷键宇宙、Command Palette       |
| **协作**       | 骨架（8 大 channel 注册）                    | Yjs CRDT + WebSocket + Presence + Comment 实时 + 冲突合并       |
| **DX**         | npm workspaces + 1374→159 lint 债            | Turborepo + 0 lint error + 全链路 e2e + 录制回放                |
| **商业化**     | 捐赠 + 自行接 provider key                   | Free / Pro / Team / Enterprise 四档、Server-side AI 共享配额    |

---

## 3. 现状量化（基于代码库调研）

```
代码量:  约 62 万行 TS/TSX 源（不含 node_modules / dist）
包数:    23 packages + 8 apps（apps 含 shell / web-server / 6 编辑器）
IPC channel:
   - shell (Electron)    60 个 ipcMain.handle inline 在 4580 行 main/index.ts
   - web-server (HTTP)   522 个 registerHandle，分布在 17 个模块
   - 各编辑器 main        docs 77 / sheets 50 / slides 136 / pdf 32 (Electron 端)
编辑器渲染层 LOC:    docs 99245 / sheets 103393 / slides 74253 / pdf 30554 / md 12394 / html 17073
AI provider:        19 家（genspark/codex/anthropic/gemini/deepseek/openai/kimi/
                    glm/qwen/doubao/minimax/xai/mistral/openrouter/requesty/
                    opencode-zen/opencode-go/custom + 媒体/搜索）
agent extension:    13+ 个（docs-skill 11 tools, sheets-skill 7, slides-skill 4,
                    translate-skill, ocr-skill, office-safety, office-workflow,
                    skill-market, web-search-skill, image-search-skill,
                    agent-team, audit-log, verify-response, frozen-selection,
                    local-models）
测试:                单元测试 ~440 个，e2e 38 个；lint 0-error 但欠 159 个
i18n:               19 语言
关键差异化已实装:
   ✓ @genoffice/ipc-bridge — 拦截 ipcMain 同时暴露 HTTP+SSE
   ✓ xlsx-sidecar (Rust) — 字节保真 xlsx 读写
   ✓ docx-engine + pptx-engine — OOXML 字节保真
   ✓ translation-core — KB + Dictionary + Memory + Quality 五位一体
   ✓ agent-skills — 真实读写文档的工具（不是聊天框）
```

---

## 4. 战略三大方向

### 方向 A — **架构统一化**（首要，1 个月）

消灭「shell 单体 vs web-server 模块化」的双份代码，把所有 main-process 业务逻辑
搬到共享 package；Electron / 浏览器 / SaaS 三端共享同一份 handler。

> 详见 `plan-02-architecture-refactor.md`

### 方向 B — **AI 顶级化**（核心，3 个月）

把当前「prompt → tool → return」的 L1 agent 升级到 L3：

- **Agentic Loop** — 自主规划 / 多步推理 / 中途纠正
- **跨文档编排** — Cross-Office Workflow 实质化
- **多模态** — 视觉理解 / OCR 内置 / 视频关键帧 / 音频转写
- **RAG** — 通用知识库（不只翻译 KB）
- **可回放** — 每个 AI 动作成为 first-class timeline entry

> 详见 `plan-03-top-tier-office-ai.md`

### 方向 C — **SaaS + 桌面一体化**（商业化，4 个月）

让桌面用户无缝升级到 SaaS，反之亦然：

- 同一份账号、同步的项目、同步的 KB / Dictionary
- Web 端能编辑 xlsx（消灭当前 `WEB_UNSUPPORTED: workbook:save`）
- Free / Pro / Team / Enterprise 四档，server-side AI 共享配额
- OAuth / SSO / 团队空间 / 审计日志

> 详见 `plan-04-saas-and-desktop.md`

---

## 5. 文件索引

| 文件                               | 主题                                      | 优先级 |
| ---------------------------------- | ----------------------------------------- | ------ |
| `plan-00-overview.md`              | 本文档：战略 + 目标 + 现状                | —      |
| `plan-01-issues.md`                | 问题清单（事实驱动，21 项）               | —      |
| `plan-02-architecture-refactor.md` | 架构重构（双轨 → 单轨 IPC）               | P0     |
| `plan-03-top-tier-office-ai.md`    | AI 顶级化（agentic / 多模态 / RAG）       | P0     |
| `plan-04-saas-and-desktop.md`      | SaaS + 桌面一体化（多租户 / 计费 / 团队） | P0     |
| `plan-05-collab.md`                | 实时协作（Yjs CRDT / Presence / WS）      | P1     |
| `plan-06-quality.md`               | 工程化（DX / CI / 测试 / 监控）           | P1     |
| `plan-07-roadmap.md`               | 12 周路线图 + KPI + 责任分配              | P0     |
| `plan-08-quick-wins.md`            | 立即可做的 12 项 quick wins               | P0     |

---

## 6. 风险与对策

| 风险                                    | 概率 | 对策                                                                             |
| --------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| 架构重构破坏现有 522 个 web IPC channel | 高   | 先做 channel 兼容层（保留旧 channel 名 → 转发到新模块），用 adapter 模式逐步迁移 |
| 大文件 OOXML 编辑器无法直接重写         | 中   | 维持 byte-preserving 不变；只把"业务逻辑"提到共享包，引擎不动                    |
| Rust xlsx-sidecar 难以在 SaaS 中运行    | 中   | sidecar 是普通子进程，container/lambda 都能跑；先 docker 化                      |
| LLM provider 价格波动                   | 中   | 抽象 model tier（cheap/balanced/premium），provider 故障自动降级                 |
| i18n 重新迁移成本高                     | 低   | 维持现有 key/value 模式，引入 `@formatjs/intl` 在新页面里渐进迁移                |
| 团队扩招节奏                            | 中   | 路线图按 4 人 / 6 人 / 8 人三档设计，P0 任务 4 人 12 周可完成                    |

---

## 7. 立即行动（Week 0，本周内）

1. **认领 Quick Wins**：从 `plan-08-quick-wins.md` 选 4-5 项本周完成
2. **冻结新功能**：12 周内不接受新 feature request，只做 P0 重构 + AI 顶级化
3. **建立 metric baseline**：跑 1 次完整 lint/test/typecheck/build，记录时长
4. **建立双协议一轨的契约测试**：web 和 electron 共用同一份 contract test
5. **宣布 RFC 流程**：所有架构变更走 `docs/rfcs/`，3 人 review

---

## 8. 不做什么（明确排除）

- ❌ 不重写 OOXML 引擎（docx/xlsx/pptx/pptx-render 字节保真工作得很好）
- ❌ 不做自有 LLM（与 19 家 provider 合作的策略正确）
- ❌ 不重新设计 UI 主题系统（`packages/ui/src/tokens.css` 已成熟）
- ❌ 不做私有云（先跑 SaaS 单一 region，后续按需求扩展）
- ❌ 不做移动原生 app（PWA 优先，iPad 优化放到 Phase 2）

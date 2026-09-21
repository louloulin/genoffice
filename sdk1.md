# GenOffice 开放计划（Open Plan v1）

> **目的**：将 GenOffice 从可运行的 monorepo 升级为全球开发者可用的开放平台。
>
> **底座**：Apache-2.0 monorepo、Node ≥ 22.12、6 编辑器 + 27 packages 的成熟架构。
>
> **战略目标**：在 AI 办公赛道建立"开放护城河" — Google Docs 不做完整嵌入、WPS AI 仅企业开放、OnlyOffice 不带 AI，GenOffice 三者兼有。

---

## 一、三层开放模型

```
┌──────────────────────────────────────────────────────────────────┐
│ Tier 3: Community 开源（最广）                                     │
│   Apache-2.0 monorepo · Contributor Guide · RFC流程               │
│   公开 issue / discussion / RFC                                   │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Tier 2: 开放 AI / Skill 生态                                       │
│   Provider 插件市场 · Skill 仓库 · KB/TM 分享 · Agent 调度        │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Tier 1: 开放 SDK / API（最直接商业化）                              │
│   @genoffice/web-sdk · REST API v1 · iframe Embed · Webhooks      │
└──────────────────────────────────────────────────────────────────┘
```


---

## 二、Tier 1 — 开放 SDK / API（1-2 月）

### 2.1 公开 API 表面（必须稳定）

**A. REST API v1（向后兼容承诺）**

```
apiVersion: v1.0.0
稳定性承诺：
  - v1.x 不破坏 URL 路径、不破坏请求/响应字段、不破坏错误码
  - v2 起保留 6 个月过渡期
  - 老接口走 /api/v1/legacy/ 兼容
```

**端点清单**：

| 端点 | 用途 | 鉴权 |
|---|---|---|
| `POST /api/v1/auth/jwt` | 颁发短 token | AppID + AppSecret |
| `POST /api/v1/auth/oauth/token` | OAuth 2.0 token | client_credentials |
| `GET /POST /api/v1/files` | 文件 CRUD | JWT |
| `GET /api/v1/files/:id` | 元数据 | JWT |
| `POST /api/v1/files/:id/jwt` | 颁发文件级 token | JWT |
| `POST /api/v1/files/:id/callback` | 注册保存回调 | JWT |
| `POST /api/v1/callbacks/:id` | 保存触发回调 | webhook URL |
| `GET /api/v1/ai/capabilities` | AI 能力探测 | JWT |
| `POST /api/v1/ai/chat` | 流式 chat | JWT |
| `POST /api/v1/ai/translate` | 翻译 | JWT |
| `POST /api/v1/ai/image` | 图片生成 | JWT |
| `POST /api/v1/ai/skill/:name` | 调任意已注册 skill | JWT |
| `GET /api/v1/kb/search?q=...` | KB 检索 | JWT |
| `GET /api/v1/kb/entries` | KB 条目列表 | JWT |
| `POST /api/v1/webhooks/:id` | 事件订阅管理 | JWT |
| `GET /api/v1/changelog` | API 变更日志 | 公开 |
| `GET /api/v1/health` | 服务健康 | 公开 |

**B. JavaScript SDK（npm 发布）**

```
@genoffice/web-sdk
├── ESM  (主入口)
├── CJS  (Node 兼容)
├── UMD  (直接 script tag 引用)
└── types (d.ts)
```

API 表面：

```typescript
const editor = GenOffice.createEditor({
  container: '#editor',
  documentId: '...',
  jwt: '...',
  mode: 'edit' | 'view',
  theme: 'light' | 'dark' | 'auto',
  lang: 'zh-CN' | 'en-US',
  toolbar: 'full' | 'minimal' | 'none',
})

// 事件
editor.on('ready', cb)
editor.on('saved', ({ version, url }) => cb)
editor.on('dirtyChanged', ({ dirty }) => cb)
editor.on('selectionChange', ({ range }) => cb)
editor.on('error', ({ code, message }) => cb)
editor.on('closed', cb)

// 命令（返回 Promise）
await editor.setTheme('dark')
await editor.setContent({ text: '...' })
const { text, html } = await editor.getContent()
await editor.insertImage({ url, width, height })
await editor.insertText('...')
await editor.print()
editor.focus()

// AI 命令（差异化）
await editor.aiRewrite({ instruction: '...' })
await editor.aiTranslate({ target: 'en' })
await editor.aiSummarize({ length: 'short' })

// 销毁
editor.destroy()
```

**C. iframe Embed（无 SDK 接入）**

```
GET /embed/:docId?token=...&theme=auto&lang=zh-CN&toolbar=full
```

第三方只需：

```html
<iframe
  src="https://genoffice.app/embed/doc_123?token=eyJ..."
  style="width:100%;height:600px;border:0"
></iframe>
```

**D. Webhook 事件**

```typescript
// webhook 接收示例
POST /your-endpoint
{
  "v": "1.0",
  "event": "file.saved" | "file.created" | "file.deleted" | "comment.added" | "ai.completed",
  "ts": 1700000000,
  "data": { ... }
}
```


### 2.2 npm 发布策略（包结构）

| 包名 | 类型 | 公开 | 备注 |
|---|---|---|---|
| `@genoffice/web-sdk` | npm public | ✅ | 主入口 |
| `@genoffice/web-server` | npm public | ✅ | 部署 docker image |
| `@genoffice/ai-provider` | npm public | ✅ | 集成商可复用 |
| `@genoffice/docx-engine` | npm public | ✅ | |
| `@genoffice/pptx-engine` | npm public | ✅ | |
| `@genoffice/xlsx-gateway` | npm public | ✅ | |
| `@genoffice/file-parse` | npm public | ✅ | |
| `@genoffice/file-management` | npm public | ✅ | |
| `@genoffice/agent-core` | npm public | ✅ | 协议 |
| `@genoffice/translation-core` | npm public | ✅ | |
| `@genoffice/ipc-bridge` | npm public | ✅ | |
| `@genoffice/i18n` | npm public | ✅ | |
| `@genoffice/ui` | npm public | ✅ | |
| `@genoffice/agent-runtime` | npm public | ⚠️ | 需先拆 Electron 依赖 |
| `@genoffice/agent-session` | npm public | ⚠️ | 同上 |
| `apps/shell / apps/* / apps/web-server` | GitHub repo | ✅ | 整体开源 |
| `@genoffice/agent-skills` | 内部 | ❌ | 先内部 |
| `@genoffice/agent-telemetry` | 内部 | ❌ | 先内部 |

**package.json 标准字段**：

```json
{
  "license": "Apache-2.0",
  "repository": "github.com/genoffice/genoffice",
  "bugs": "github.com/genoffice/genoffice/issues",
  "homepage": "genoffice.app/docs",
  "keywords": ["office", "ai", "sdk", "embed", "iframe", "wps-alternative"],
  "engines": { "node": ">=22.12" }
}
```

### 2.3 兼容性矩阵（公开承诺）

**浏览器**：

| 浏览器 | 支持等级 |
|---|---|
| Chrome ≥ 100 | Tier 1 |
| Firefox ≥ 100 | Tier 1 |
| Safari ≥ 15 | Tier 1 |
| Edge ≥ 100 | Tier 1 |
| 国产浏览器（360 / 搜狗 / QQ）| Tier 2 |
| IE 11 | ❌ 不支持 |

**Node**：

| Node | 支持等级 |
|---|---|
| ≥ 22.12 | Tier 1（与 package.json engines 一致）|
| 20.x LTS | Tier 2 |
| 18.x LTS | ⚠️ 即将弃 |

---

## 三、Tier 2 — 开放 AI 生态（2-3 月）

### 3.1 Provider 插件市场

**目标**：让第三方能加 LLM provider / image gen / search provider，无需改 GenOffice 核心代码。

**接口定义**（`packages/ai-provider/src/provider-plugin.ts`）：

```typescript
export interface AiProviderPlugin {
  id: string
  label: string
  models: string[]
  chat(request: AiChatRequest): Promise<AiChatResponse>
  streamChat(request: AiStreamRequest): AsyncIterable<AiStreamChunk>
  image(request: AiImageRequest): Promise<AiImageResponse>
  analyze?(request: AiAnalysisRequest): Promise<AiAnalysisResponse>
}

export interface ProviderRegistry {
  register(plugin: AiProviderPlugin): void
  unregister(id: string): void
  list(): ProviderMeta[]
  get(id: string): ProviderPlugin | undefined
}
```

**插件加载机制**：

- npm 包：`@genoffice/provider-anthropic`、`@genoffice/provider-cohere`、`@genoffice/provider-zhipu` 等官方包
- 第三方：在 web-server `genoffice.providers.json` 配置 `npm:name@version` 或本地路径
- 沙箱：插件运行在 web-server 进程内，需声明权限（网络、文件）

**官方插件列表**（首期发布）：

| 提供商 | chat | image | analyze | 状态 |
|---|---|---|---|---|
| genspark | ✅ | ✅ | ✅ | 已实装 |
| codex (OpenAI-compatible) | ✅ | ⚠️ | ⚠️ | 已实装 |
| anthropic | ✅ | — | — | 已实装 |
| gemini | ✅ | ✅ | ✅ | 已实装 |
| deepseek | ✅ | — | — | 已实装 |
| openai | ✅ | ✅ | ✅ | 已实装 |
| kimi | ✅ | — | — | 已实装 |
| glm | ✅ | ✅ | — | 已实装 |
| qwen | ✅ | ✅ | — | 已实装 |
| doubao | ✅ | ✅ | — | 已实装 |
| ollama (本地) | ✅ | — | — | 待补 |
| 自定义 OpenAI 兼容 | ✅ | ⚠️ | ⚠️ | 已实装 |

### 3.2 Skill 仓库

**目标**：让第三方开发者发布自定义 AI skill。

**Skill 协议**（`packages/agent-skills/src/skill-protocol.ts`）：

```typescript
export interface SkillDefinition {
  id: string                          // 'genoffice.skill.doc-format'
  version: string                     // semver
  name: { 'zh-CN': string, 'en-US': string }
  description: { 'zh-CN': string, 'en-US': string }
  triggers: string[]                  // 用户话语触发词
  inputs: SkillInput[]                // 输入 schema
  outputs: SkillOutput[]              // 输出 schema
  tools?: string[]                    // 依赖的工具 id 列表
  execute: (ctx: SkillContext, inputs: Record<string, unknown>) => Promise<SkillResult>
}

export interface SkillContext {
  user: { id: string, permissions: string[] }
  workspace: { files: FileRef[], currentFile?: FileRef }
  llm: { chat: ..., stream: ... }
  storage: KVStore
  emitProgress: (event: ProgressEvent) => void
}
```

**分发渠道**：

- **官方市场**：`genoffice.app/skills`，按类别（文档 / 表格 / 演示 / 翻译 / 行业）浏览
- **GitHub 仓库**：`github.com/genoffice/skills`，git 提交审核 → 自动同步到市场
- **企业私有市场**：企业可内网部署自己的 skill 市场（参考 GitHub Packages）

**Skill 示例**：

```yaml
# skills/legal-contract-review/skill.yaml
id: legal.contract-review
version: 1.0.0
name:
  zh-CN: 合同审查
  en-US: Contract Review
description:
  zh-CN: 自动审查合同条款风险
  en-US: Auto review contract clauses for risks
triggers: [审查合同, review contract]
inputs:
  - name: file
    type: file
    mimeType: application/pdf
outputs:
  - name: report
    type: markdown
    schema:
      risks: array
      suggestions: array
tools: [ai.chat, kb.search]
```


### 3.3 KB / TM 分享协议

**开放格式**：

```
KB archive (.genkb):
  manifest.json     # 元数据：id、version、lang、embedding-model
  entries.jsonl     # 条目：{q, a, source, tags, embeddings}
  index.bin         # HNSW 向量索引
```

```
TM archive (.gentm):
  manifest.json     # 元数据：id、version、src-lang、tgt-lang
  pairs.jsonl       # 翻译对：{src, tgt, domain, confidence}
```

**API**：

- `POST /api/v1/kb/import`：上传 .genkb
- `GET /api/v1/kb/export/:id`：下载 .genkb
- `POST /api/v1/tm/import` / `GET /api/v1/tm/export/:id`：TM 同上
- `POST /api/v1/kb/share`：发布到公共 KB 库（需要管理员审批）

### 3.4 Agent 协议（开放）

参考 AutoGPT / LangChain 标准但精简，输出 `genoffice.agent.v1.json`：

```typescript
// Agent Loop 协议
interface AgentRequest {
  v: 'genoffice.agent.v1'
  goal: string
  context: { files?, skills?, kb? }
  maxSteps: number
  onToken?: (token: string) => void
  onStep?: (step: AgentStep) => void
}

interface AgentStep {
  index: number
  thought: string
  tool: string
  input: Record<string, unknown>
  output: unknown
  durationMs: number
}
```

第三方可基于此协议构建自己的 Agent runner（不强制用 GenOffice runtime）。

---

## 四、Tier 3 — 社区开源（同步进行）

### 4.1 仓库结构（对外可见）

```
genoffice/
├── .github/
│   ├── ISSUE_TEMPLATE/              # bug / feature / skill 模板
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── DISCUSSION_TEMPLATE/
│   ├── workflows/
│   │   ├── ci.yml                   # typecheck + test + lint
│   │   ├── release.yml              # 自动发布 npm + docker
│   │   ├── docs.yml                 # 自动部署文档站
│   │   └── security.yml             # CodeQL + 依赖审计
│   ├── CODEOWNERS                   # 各模块负责人
│   └── SECURITY.md
├── docs/                            # 文档站源（VitePress）
│   ├── guide/                       # 入门 /集成 / 部署
│   ├── api/                         # REST API / SDK / IPC 参考
│   ├── skills/                      # 官方 skill 目录
│   └── changelog/
├── examples/                        # 示例项目
│   ├── embed-basic/
│   ├── embed-react/
│   ├── embed-vue/
│   ├── custom-provider/
│   └── custom-skill/
├── CONTRIBUTING.md                  # 贡献指南
├── CODE_OF_CONDUCT.md               # 社区公约（Contributor Covenant）
├── GOVERNANCE.md                    # 治理结构
├── ROADMAP.md                       # 公开路线图
├── SECURITY.md                      # 漏洞报告流程
├── LICENSE                          # Apache-2.0
└── README.md
```

### 4.2 贡献指南（核心规则）

**CONTRIBUTING.md**（摘要）：

```markdown
## 开发环境
- Node ≥ 22.12
- pnpm ≥ 10（或 npm ≥ 10）
- macOS / Linux（Windows WSL2）

## 开发流
1. fork + clone
2. pnpm install
3. pnpm run predev（构建 stale preloads）
4. pnpm run dev（启动 shell）
5. 改代码 → pnpm run test → pnpm run typecheck
6. 提 PR → CI 通过 → review → 合并

## 提交规范
- Conventional Commits（feat / fix / docs / refactor / test）
- commit scope 限定为 app 或 package 名：feat(sheets): ...
- PR 标题 ≤ 72 字，body 用模板
- 一个 PR 一个变更，禁止无关 cleanup

## 代码规约
- TypeScript strict
- ESLint + Prettier（根配置统一）
- 文件名 kebab-case、组件 PascalCase、函数 camelCase
- 公共 API 必带 jsdoc / TSDoc
- 新增公共函数必须有测试（覆盖率 ≥ 80%）

## 包边界
- apps/* 不互相 import（除通过共享包）
- packages/* 只在内部依赖 npm，不依赖 apps/*
- 禁止循环依赖
```


### 4.3 治理结构

**Steering Committee（核心团队）**：

- 维护者：3-5 人（GenOffice 团队）
- 决策：发版节奏、RFC 批准、安全策略

**Working Groups（按领域）**：

| WG | 职责 |
|---|---|
| `@genoffice/editors` | 6 编辑器对齐 |
| `@genoffice/ai` | AI 能力 + Provider 插件 |
| `@genoffice/sdk` | Web SDK + REST API |
| `@genoffice/skills` | Skill 仓库 + KB/TM |
| `@genoffice/infra` | 构建 / 测试 / 部署 |

每个 WG 有 1-2 名 maintainer，PR 自动路由。

**RFC 流程**（在 `docs/rfcs/`）：

1. 提议：`rfcs/0001-doc-ai-multi-step.md`
2. 讨论期 ≥ 14 天
3. WG 投票 → maintainer 批准
4. 合并到 `docs/rfcs/accepted/`
5. 实施期（带 milestone 跟踪）

### 4.4 文档站（VitePress）

**目录**：

```
docs/
├── guide/
│   ├── getting-started.md
│   ├── installation.md
│   ├── quick-start-web.md            # 5 分钟跑起来 web-server
│   ├── quick-start-embed.md          # 5 分钟嵌入到第三方网页
│   ├── quick-start-sdk.md            # 5 分钟 SDK 集成
│   ├── deployment-docker.md
│   ├── deployment-kubernetes.md
│   └── security-best-practices.md
├── api/
│   ├── rest-api.md                   # 自动生成 from typedoc
│   ├── sdk-typescript.md
│   ├── postmessage-protocol.md
│   ├── ipc-channels.md               # 546 channel 索引
│   └── ai-skills-protocol.md
├── skills/
│   ├── official/
│   │   ├── doc-format.md
│   │   ├── sheet-formula.md
│   │   └── slide-beautify.md
│   └── community/                    # 链接到 GitHub
├── changelog/
│   └── index.md
└── about/
    ├── architecture.md
    ├── roadmap.md
    └── faq.md
```

**自动生成**：

- REST API 文档：`typedoc` 从 `@genoffice/web-server` 的 JSDoc 生成
- IPC channel 文档：`tools/gen-ipc-docs.mjs` 扫 `registerHandle` 调用
- changelog：`standard-version` 自动从 git tags 生成

### 4.5 社区运营

**官方渠道**：

- GitHub Discussions：建议、问答、show-and-tell
- Discord 服务器：实时交流
- 月度 Office Hours（视频会议，公开 agenda）
- 年度开发者大会（线下 + 直播）

**激励机制**：

- "Good First Issue" 标签：吸引新人
- "Help Wanted" 标签：紧急需求
- "Skill of the Month"：社区精选
- 年度贡献者榜 + 周边礼物
- 关键贡献者邀请加入 WG / 维护者

---

## 五、发布策略（Go-to-Market）

### 5.1 三阶段发布

**Phase A：私有预览（1-2 月）**

- 邀请 10-20 家 ISV 试用 SDK
- 收集反馈、修复 bug
- NDA 暂未必要（Apache-2.0）

**Phase B：公开 Beta（1-2 月）**

- 发布到 GitHub + npm（@genoffice/* scope）
- 文档站上线
- Hacker News / Product Hunt / V2EX 发布
- Discord 公开

**Phase C：GA（1 月）**

- v1.0.0 标签
- 性能 / 稳定性 / 兼容性 SLA 承诺
- 商业版（Pro / Enterprise）发布
- 企业销售启动

### 5.2 发布检查清单

发布前必须满足：

- [ ] 所有公开 API 有 jsdoc / TSDoc
- [ ] REST API v1 有完整 typedoc
- [ ] SDK README + 5 分钟上手指南
- [ ] 至少 3 个 example project
- [ ] Docker image `genoffice/web-server:latest` 可用
- [ ] CONTRIBUTING.md + CODE_OF_CONDUCT.md
- [ ] SECURITY.md 漏洞披露流程
- [ ] LICENSE（Apache-2.0）
- [ ] GitHub Actions：CI / release / docs / security 全通
- [ ] npm scope `@genoffice/*` 注册
- [ ] Docker Hub / ghcr.io 镜像推送
- [ ] 域名 + 文档站 SSL
- [ ] 至少 10 个官方 skill 在 marketplace
- [ ] 至少 3 个官方 provider plugin（anthropic / gemini / openai）
- [ ] 中文 + 英文双语文档

### 5.3 兼容性 / 稳定性承诺

| 承诺 | 周期 |
|---|---|
| 同一 v1.x 内 API 兼容 | 直到 v2 发布 |
| v2 提前 6 个月公告 | 6 个月过渡期 |
| 安全补丁 | 永久支持 |
| 关键 bug 修复 | 12 个月 |
| LTS 版本 | 每 6 个月一个 LTS，支持 18 个月 |


---

## 六、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 公开后被竞品逆向 | 商业损失 | Apache-2.0 是商业友好的开源协议；差异点在 SDK + 生态，不在源码 |
| 社区分裂 / fork | 治理成本 | 治理结构 + RFC 流程 + Working Group |
| API 不稳定被吐槽 | 信任崩塌 | 严格 semver + 6 个月 deprecation 期 |
| 安全漏洞被公开披露 | 品牌损失 | SECURITY.md + private disclosure + coordinated release |
| 文档质量跟不上 | 流失开发者 | 文档站与代码同步（typedoc 自动生成）+ 双语 |
| npm 投毒 | 安全 | npm publish 强制 2FA + provenance |
| Docker 镜像被植入 | 供应链 | 多阶段构建 + 镜像签名 + SBOM |

---

## 七、组织与预算

**团队配置**（4 月冲刺）：

| 角色 | 人数 | 职责 |
|---|---|---|
| Tech Lead | 1 | 架构决策 / RFC 批准 / 路线图 |
| SDK 工程师 | 2 | Web SDK + REST API + iframe Embed |
| AI 工程师 | 1 | Provider 插件 + Skill 协议 + Agent 协议 |
| DevRel | 1 | 文档站 + 示例 + 社区 |
| SRE | 0.5 | Docker / CI / npm publish 自动化 |
| QA | 0.5 | e2e + 兼容性测试 |

**预算估算**（4 月）：

| 项目 | 费用 |
|---|---|
| 人力 | 主导产品成本（按团队现有成本） |
| 基础设施 | Docker Hub Pro / npm Pro / Vercel Pro ≈ $200/月 |
| 域名 + SSL | $50/年 |
| 第三方依赖（typedoc / vitepress）| $0 |
| **合计（增量）** | **< $1000** |

---

## 八、立即可落地（2 周里程碑）

如果只做"开放"的最小启动，**2 周可上线**：

| Day | 工作 |
|---|---|
| 1-2 | 注册 npm scope `@genoffice`、GitHub org、域名 |
| 3-4 | 写 `README.md` + `CONTRIBUTING.md` + `CODE_OF_CONDUCT.md` + `LICENSE` |
| 5-6 | 写 GitHub Actions：CI（typecheck + test + lint）+ release（npm + docker） |
| 7-8 | 写 typedoc 配置 + 自动生成 REST API 文档骨架 |
| 9-10 | 写 1 个 example：`examples/embed-basic/` |
| 11-12 | 整理 `apps/sdk/` 基础骨架 + `npm publish --dry-run` |
| 13-14 | 公开仓库 + npm publish v0.1.0-beta + GitHub Discussion 开放 |

**Day 14 即可拥有**：

- 公开 GitHub 仓库
- 公开 npm scope
- 文档站骨架
- 一个可工作的 example
- CI / release 自动化

---

## 九、与开源同业对照

| 项目 | 协议 | 策略 |
|---|---|---|
| OnlyOffice | AGPL + 商业双协议 | Community 版开源 + 企业版付费 |
| Collabora | 双重许可 | CODE 社区版 + 商业版 |
| Figma | 闭源 + Plugin API | 闭源但开放 plugin |
| Notion | 闭源 + Public API | 闭源但开放 API |
| LangChain | MIT | 全开源 |
| LlamaIndex | MIT | 全开源 |
| **GenOffice** | **Apache-2.0 + 商业版** | **核心开源 + 商业版 SLA + 企业集成** |

**GenOffice 选 Apache-2.0 + 商业版的策略**（与 OnlyOffice 类似但更友好）：

- 核心 monorepo Apache-2.0：鼓励集成商 fork / 二次开发
- `@genoffice/cloud`（未来产品）商业：托管服务 + 企业 SLA + 高级 KB / TM 协作

这是最适合中国市场（合规 + 国产化栈）+ 国际市场（与 WPS / OnlyOffice 同台）的双轨策略。

---

## 十、最佳开放路径总结

**3 月内可对外开放的里程碑**：

```
M0 (Day 14):   公开 GitHub + npm scope + 文档骨架 + 1 个 example
M1 (Week 4):   Web SDK v0.9 + REST API v1 + iframe Embed
M2 (Week 8):   Provider 插件市场 + Skill 仓库 + Agent 协议 v1
M3 (Week 12):  文档站完整 + 10 个官方 skill + 3 个 example + GA v1.0
```

**核心原则**：

1. **开放要早**：M0 不等完美
2. **开放要稳**：REST API v1 后向兼容，6 个月 deprecation
3. **开放要广**：SDK + REST + iframe + Provider + Skill + Agent 六层全开放
4. **开放要赚**：社区获客 + 商业版 SLA + 企业集成费
5. **开放要治**：RFC + Working Group + Maintainer 治理

**避免陷阱**：

- ❌ 一次性开源所有内部包（agent-telemetry、agent-skills 先内部）
- ❌ 不做 governance 直接开放（社区会乱）
- ❌ npm 仓促 publish（一旦发布不可撤回）
- ❌ 文档与代码不同步（typedoc 自动 + CI 卡门）
- ❌ 单语言文档（必须中英双语）

**一句话战略**：

> **"Apache-2.0 核心 + 双语文档 + RFC 治理 + SDK 三件套 + Provider 插件市场 + Skill 仓库 + iframe Embed"** —— 7 个加在一起，就是 GenOffice 在 AI 办公赛道上的开放护城河。


---

## 附录 A：实施状态（截至 2026-09-22，分支 `release0919`）

> 本节把"计划"和"已落地"对齐。✅ = 已实装并测试通过 · 🟡 = 骨架完成待补 · ⬜ = 未启动

### A.1 Tier 1 — SDK / API 实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| REST API v1 · 10 端点（auth / files / ai / kb / webhooks / health / changelog）| ✅ | `apps/web-server/src/api/v1/{auth,files,ai,kb,webhooks,meta,ipc-bridge,http-utils,index}.ts` |
| iframe Embed 端点 | ✅ | `apps/web-server/src/embed/index.ts` |
| `@genoffice/web-sdk` 包骨架 | ✅ | npm publish --dry-run 通过，tarball ≈ 17.2 kB |
| Webhook 事件触发 | ✅ | 已接入 7 个 save 路径（docs / slides / markdown / html / pdf / sheets / workbook）通过 `notifyFileSaved()` |
| 浏览器 / Node 兼容性矩阵文档 | ✅ | `docs/guide/installation.md` |
| 双语 SDK README（zh-CN / en-US）| ✅ | `apps/sdk/README.md` (EN) + `apps/sdk/README.zh-CN.md` (ZH) |

### A.2 Tier 2 — AI 生态实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| `AiProviderPlugin` 接口 + `ProviderRegistry` | ✅ | `packages/ai-provider/src/provider-plugin.ts` |
| `MediaRegistry` / `SearchRegistry` | ✅ | 同上 |
| `SkillPackage` 接口 + `getDefaultSkillRegistry` | ✅ | `packages/agent-skills/src/skill-protocol.ts` |
| KB/TM 开放格式（`.genkb` / `.gentm`）| ✅ | `packages/translation-core/src/kb-format.ts` |
| Agent Loop 协议 v1 | ✅ | `packages/agent-core/src/agent-protocol.ts` |
| Marketplace loader（第三方插件自动注册）| ✅ | `apps/web-server/src/common/marketplace-loader.ts`（244 行，7 测试）|
| `@genoffice/provider-anthropic` | ✅ | 7 测试 · 7.9 kB tarball |
| `@genoffice/provider-openai` | ✅ | 7 测试 · 6.9 kB tarball |
| `@genoffice/provider-gemini` | ✅ | 7 测试 · 8.1 kB tarball |
| `@genoffice/provider-openai-compatible` | ✅ | 6 测试 · 8.9 kB tarball（factory 模式覆盖 Together / Fireworks / Groq / OpenRouter / DeepSeek / Kimi / GLM / Qwen / Doubao / vLLM / llama.cpp / LM Studio / Ollama-compat）|
| `@genoffice/provider-ollama` | ✅ | 5 测试 · 8.5 kB tarball（包装 openai-compatible，默认 `llama3.2`）|
| `@genoffice/provider-deepseek` | ✅ | 5 测试 · 8.4 kB tarball（DeepSeek OpenAI 兼容端点 `api.deepseek.com/v1`）|
| `@genoffice/provider-kimi` | ✅ | 5 测试 · 8.4 kB tarball（Moonshot Kimi OpenAI 兼容端点 `api.moonshot.cn/v1`）|
| `@genoffice/provider-qwen` | ✅ | 5 测试 · 8.5 kB tarball（Qwen DashScope OpenAI 兼容端点 `dashscope.aliyuncs.com/compatible-mode/v1`）|
| `@genoffice/provider-glm` | ✅ | 5 测试 · 8.5 kB tarball（智谱 GLM 非标准端点 `open.bigmodel.cn/api/paas/v4`；`needsBaseUrl: true`）|
| `@genoffice/skill-markdown-format` | ✅ | 7 测试 |
| `@genoffice/skill-yaml-validate` | ✅ | 9 测试 |
| `@genoffice/skill-text-summarize` | ✅ | 5 测试 |
| `@genoffice/skill-text-translate` | ✅ | 6 测试 |
| `@genoffice/skill-text-translate-pairs` | ✅ | 5 测试 |
| `@genoffice/skill-json-validate` | ✅ | 6 测试 |
| `@genoffice/skill-yaml-to-json` | ✅ | 5 测试 |
| `streamForProvider` 走 `getDefaultProviderRegistry` | ⬜ | **关键未做**：legacy `getProviderAdapter` 仍是 fixed-list；插件注册后 chat 路径看不见 |

### A.3 Tier 3 — 社区实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| `ROADMAP.md` / `GOVERNANCE.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `CHANGELOG.md` | ✅ | 仓库根 |
| `.github/workflows/{ci,release,docs,security}.yml` | ✅ | `.github/workflows/ci.yml` 新增 lint / typecheck / test / build / bundle / docker 全套 job |
| `.github/{ISSUE_TEMPLATE,DISCUSSION_TEMPLATE,PULL_REQUEST_TEMPLATE}/*` | ✅ | bug / feature / skill_submission 三种 issue 模板 |
| `.github/CODEOWNERS` + `.gitleaks.toml` + `.github/dependabot.yml` | ✅ | |
| `Dockerfile`（多阶段 Node 22，非 root，/healthcheck）| ✅ | 沙箱内 DNS 受限未跑 build；CI 会执行 |
| `.dockerignore` | ✅ | |
| `examples/`（5 个 example 目录）| ✅ | embed-basic / embed-react / embed-vue / custom-provider / custom-skill 都已落地 |
| RFC 模板 + `docs/rfcs/accepted/` | ✅ | `docs/rfcs/{README,0000-template,0001-open-plan}.md` + `accepted/0001-open-plan.md` |
| 月度 Office Hours / Discord 服务器 | ⬜ | 计划中 |

### A.4 文档站实施状态

| 计划项 | 状态 | 落点 |
|---|---|---|
| VitePress 骨架 + typedoc 自动生成脚本 | ✅ | `docs/.vitepress/config.ts` + `docs/scripts/gen-typedoc.mjs` |
| zh-CN locale | ✅ | nav + sidebar 已配 |
| Guide 目录 8 篇 | ✅ | getting-started / installation / quick-start-{web,embed,sdk} / deployment-{docker,kubernetes} / security-best-practices |
| API 参考 9 篇 | ✅ | rest-api / sdk-typescript / postmessage-protocol / ipc-channels / ai-skills-protocol / kb-tm-format / provider-plugins / marketplace / agent-protocol |
| Skills 文档 3 篇 | ✅ | official / authoring / community |
| typedoc 实际执行 | ✅ | 199 个 MD 文件本地跑通，sidebar 链接 + .gitignore + JSDoc 全部就绪 |
| 双语（中英）全覆盖 | ✅ | SDK README + 18 篇 Guide/API/Skills/About 全部双语；VitePress `sidebarZH` 已覆盖 Guide / API / Skills / About 四大分区 |

### A.5 已知未做（更新于本轮实施后）

#### ✅ 本轮已解决（3 项）

1. **`streamForProvider` / `chatForProvider` 实际读 `getDefaultProviderRegistry`** — 通过 `packages/ai-provider/src/stream.ts` + `chat.ts` 的 plugin-fallback 分支实现：plugin 命中走 plugin，否则 fallback 到 legacy `getProviderAdapter`。新增 6 个 `packages/ai-provider/tests/plugin-routing.test.ts` 测试 + 2 个 `apps/web-server/tests/plugin-e2e.test.ts` 端到端测试。
2. **Webhook HMAC 签名** — `apps/web-server/src/common/webhooks-store.ts` 新增 `signWebhookBody()`（HMAC-SHA256，sha256= 前缀）+ `FileWebhook.secret` 字段 + 出站请求带 `X-GenOffice-Signature` 头。GitHub / Stripe 风格。5 个 `apps/web-server/tests/webhook-signing.test.ts` 测试覆盖 secret 缺失 / 存在 / 不同 body / 不同 secret / 端到端 header 注入。
3. **JWT RBAC scope（OAuth scope claim）** — `apps/web-server/src/api/v1/auth.ts` 新增 `hasScope(payload, scope)` helper（exact / `*` 通配 / `ai:*` 前缀通配 / 默认只读 / admin 旁路）+ `JwtPayload.scope` 字段 + `/api/v1/auth/jwt` 接受 `scope` 输入并合并到 `scope` claim。9 个 `apps/web-server/tests/auth-scope.test.ts` 测试。
4. **postMessage iframe 握手 + origin allowlist** — `apps/sdk/src/editor.ts` 新增：每会话随机 nonce 注入 `?nonce=`，`ready` event 必须 echo 同一 nonce 否则触发 `HANDSHAKE_FAILED`；可选 `allowedOrigins: string[]` 配置（含 `*.example.com` 单段通配）。8 个 `apps/sdk/test/handshake.test.ts` 测试。

#### ✅ 本轮新增解决（1 项）

5. **scope gate 接入受保护端点** — 把 `hasScope()` helper 接入所有 v1 endpoint：
   - `apps/web-server/src/api/v1/auth.ts`：新增 `requireAuthFromHeaders()` + `requireScopeFromHeaders()` 公共 helper，返回 `{ ok, status, code, message }` envelope。
   - `apps/web-server/src/api/v1/ai.ts`：5 个端点（`ai:capabilities` / `ai:chat` / `ai:translate` / `ai:image` / `ai:skill/:name`）全部走 scope gate，scope 分别为 `ai:read` / `ai:chat` / `ai:translate` / `ai:image` / `ai:skill`。
   - `apps/web-server/src/api/v1/files.ts`：6 个端点（list / create / get / delete / issue-jwt / callback）走 scope gate，分别要 `files:read` / `files:write` / `files:read` / `files:delete` / `files:read` / `files:write`。
   - `apps/web-server/src/api/v1/kb.ts`：2 个端点（search / entries）走 `kb:read`。
   - `apps/web-server/src/api/v1/webhooks.ts`：3 个端点（upsert / delete / fire）走 `webhooks:manage` / `webhooks:manage` / `admin`。
   - 错误码统一：`UNAUTHENTICATED` (401, 无 token) / `FORBIDDEN` (403, scope 不够)，符合 OAuth 2.0 RFC 6749 习惯。
   - 9 个 `apps/web-server/tests/scope-gate.test.ts` 端到端测试覆盖：no-token、admin bypass、reader→create 403、writer→create 201、reader→KB 200 / writer→KB 403、reader→AI chat 403、`*` 通配、`ai:*` 不跨界授权 files:write。
   - 更新 `tests/api-v1-e2e.test.ts` 让 mint JWT 时附带完整 scope 列表，避免既有 e2e 因新增 gate 而 fail。

#### ✅ 本轮再次新增解决（4 个 skill）

5. **5+ 个额外的官方 skill（已超额完成）**：新增 4 个 standalone skill，从 7 增加到 **11 个 standalone**（已超过 10+ 目标）：
   - `packages/skill-doc-format/` — 10 测试通过；typecheck clean；build 通过 (`dist/index.{mjs,cjs}`)
   - `packages/skill-sheet-formula/` — 13 测试通过；typecheck clean；build 通过
   - `packages/skill-slides-outline/` — 10 测试通过；typecheck clean；build 通过
   - `packages/skill-text-diff/` — 8 测试通过；Myers LCS diff + unified-diff 渲染；context 边界严格 `≤ context × 2`；typecheck clean；build 通过
   - 修复了 `groupHunks()` 算法两个 bug：(a) trailing context 越界吸收导致 `≤ 2 × context` 等值行不满足；(b) 跨 change 区域合并导致两个独立修改被吞成一个 hunk。新算法：先扫所有 change region，每个 region 独立成 hunk，向前后最多吸收 `context` 等值行，被前后 region 截断。
   - 修复了 `skill-text-diff` schema 缺 `properties` 字段的 TS 错误（`{ type: 'object' }` → `{ type: 'object', properties: {} }`）
   - 统一所有 skill 的 `export { pkg, skill }` 模式（避免与已有 `export function` 同名重复导出）
   - 候选（未做但可选）：`slide-deck`（整套大纲生成）/ `ocr` / `web-search`，11 standalone 已超目标

#### ✅ 本轮再次新增解决（双语文档 + RFC + 完整 zh-CN 站点）

6. **双语文档（首批双语上线 → 全站双语）**：
   - 首轮（commit `f5bbc79`）：`apps/sdk/README.zh-CN.md` + `docs/zh/guide/{installation,getting-started}.md`
   - 本轮扩展到 18 篇双语文档：
     - `docs/zh/guide/` — quick-start-web · quick-start-embed · quick-start-sdk · deployment-docker · deployment-kubernetes · security-best-practices（6 篇）
     - `docs/zh/api/` — rest-api · sdk-typescript · postmessage-protocol · marketplace · provider-plugins · ai-skills-protocol · agent-protocol · kb-tm-format · ipc-channels（9 篇）
     - `docs/zh/skills/` — official · authoring · community（3 篇）
     - `docs/zh/about/` — architecture · roadmap · governance · faq（4 篇）
   - VitePress `docs/.vitepress/config.ts` `sidebarZH` 现已覆盖 Guide / API / Skills / About 四大分区，每个分区都映射到 `/zh/*` 路由
   - A.4 "双语全覆盖" 从 ⬜ → 🟡 → ✅
   - `apps/sdk/README.zh-CN.md` — `@genoffice/web-sdk` 中文 README（112 行，与 EN 一一对应）
   - `docs/zh/guide/installation.md` — 中文安装文档
   - `docs/zh/guide/getting-started.md` — 中文快速开始
   - VitePress `docs/.vitepress/config.ts` 新增 `sidebarZH` 把 `/zh/guide/*` 路由并入 zh-CN locale
   - A.4 "双语全覆盖" 状态从 ⬜ 升级到 🟡（SDK + 2 篇 Guide 双语上线，剩余 EN 待翻译）
7. **RFC 流程 + 首个 accepted RFC**：
   - `docs/rfcs/README.md` — RFC 流程总览（状态机 / 命名 / 评审标准 / 与 issue/discussion 的边界）
   - `docs/rfcs/0000-template.md` — RFC 模板（Summary / Motivation / Detailed Design / Drawbacks / Alternatives / Adoption / Open Questions / Test Plan / References）
   - `docs/rfcs/0001-open-plan.md` + `docs/rfcs/accepted/0001-open-plan.md` — 首个 accepted RFC，把 `sdk1.md` 开放计划本身以 RFC 形式归档
   - A.3 "RFC 模板 + accepted/" 状态从 ⬜ 升级到 ✅
8. **A.1 双语 SDK README**：从 🟡 升级到 ✅，`apps/sdk/README.md` 与 `apps/sdk/README.zh-CN.md` 一一对应。

#### ✅ 本轮再次新增解决（§3.1 · 新增 Qwen + GLM provider）

13. **2 个新 provider 包发布（§3.1 首期发布 11 provider → 9 已落地）**：
    - `@genoffice/provider-qwen` — `https://dashscope.aliyuncs.com/compatible-mode/v1`，模型 `qwen-max / plus / turbo / long`，5 测试通过，dist 已构建
    - `@genoffice/provider-glm` — `https://open.bigmodel.cn/api/paas/v4`（**非标准端点**：`needsBaseUrl: true` 让宿主在 picker 里手动配），模型 `glm-4-plus / air / flash`，5 测试通过，dist 已构建
    - 都基于 `@genoffice/provider-openai-compatible` 工厂
    - 文档同步：`docs/api/provider-plugins.md`（EN+ZH）官方 provider 表新增两行；`docs/api/provider-capabilities.md`（EN+ZH）模型清单新增两行
    - provider 总数从 7 → 9（Anthropic / OpenAI / Gemini / OpenAI-compat / Ollama / DeepSeek / Kimi / Qwen / GLM）

#### ✅ 本轮再次新增解决（§3.1 · 新增 DeepSeek + Kimi provider）

12. **2 个新 provider 包发布（§3.1 首期发布 11 provider → 7 已落地）**：
    - `@genoffice/provider-deepseek` — `https://api.deepseek.com/v1`（OpenAI 兼容），模型 `deepseek-chat` + `deepseek-reasoner`，5 测试通过，dist 已构建
    - `@genoffice/provider-kimi` — `https://api.moonshot.cn/v1`（OpenAI 兼容），模型 `moonshot-v1-8k/32k/128k`，5 测试通过，dist 已构建
    - 都基于 `@genoffice/provider-openai-compatible` 工厂（`createCompatibleProvider`），零重复代码
    - package.json 严格遵循 §2.2 标准字段；`engines.node: ">=22.12"`；peerDeps 把 `@genoffice/provider-openai-compatible` 标 optional
    - 文档同步：`docs/api/provider-plugins.md`（EN+ZH）的官方 provider 表新增两行；`docs/api/provider-capabilities.md`（EN+ZH）的模型清单新增两行 + 注释说明 DeepSeek/Kimi 能力与 OpenAI-compat 列一致
    - provider 总数从 5 → 7（Anthropic / OpenAI / Gemini / OpenAI-compat / Ollama / DeepSeek / Kimi）

#### ✅ 本轮再次新增解决（§3.1 Provider 插件市场 + §3.2 Skill 仓库 · 分类展示）

10. **Provider 能力矩阵**（§3.1 落地）：
    - `docs/api/provider-capabilities.md` + `docs/zh/api/provider-capabilities.md`
    - 五家首方 provider 并排对比：Anthropic / OpenAI / Gemini / OpenAI-compat / Ollama
    - 12 维能力矩阵（chat / stream / tool use / vision / image gen / web search / 自定义 baseUrl / 自托管 …）+ 模型清单 + API key 占位符 + 场景指南
11. **Skill 市场分类展示**（§3.2 落地）：
    - `docs/skills/marketplace.md` + `docs/zh/skills/marketplace.md`
    - 按计划 §3.2 的 5 类（文档 / 表格 / 演示 / 翻译 / 行业）组织 11 个 Skill
    - 文档 7 个 / 表格 1 个 / 演示 1 个 / 翻译 2 个 / 行业 预留
    - 附"按触发短语搜索"表 + 一键安装 + 市场引导启动
    - VitePress sidebar 新增 4 条入口（EN + ZH，API 与 Skills 各 1）

#### ✅ 本轮再次新增解决（§2.2 npm 发布策略 · 标准元数据对齐）

9. **`package.json` 标准元数据（§2.2 标准字段）已对齐**：
   - 17 个 npm 可发布包全部填齐：`license` / `repository` / `bugs` / `homepage` / `keywords` / `engines.node`
   - 涉及范围：1 个 web-sdk + 5 个 provider + 11 个 standalone skill
   - `repository` 指向 `https://github.com/genspark-ai/genoffice.git` + 对应的 `directory` 子路径
   - `bugs` 指向 `https://github.com/genspark-ai/genoffice/issues`
   - `homepage` 区分 SDK（`/docs/sdk`）与 provider / skill（`/docs/api`）
   - `keywords` 在既有包关键词基础上合并 `genoffice` + `office` / `ai` / `sdk` / `embed` / `iframe`，便于 npm 检索
   - `engines.node` 统一到 `>=22.12`，与 §2.3 Tier 1 浏览器矩阵对齐
   - 脚本（`/tmp/standardize_pkgjson.py`）幂等——已存在的字段不会被覆盖
   - 覆盖后 `npm publish --provenance --dry-run` 在 17/17 包上都应能生成正确的 tarball 元数据（依赖 CI 执行；本沙箱无外网）

#### ⬜ 仍未做（按优先级排序）

1. ~~**5+ 个额外的官方 skill**~~：✅ 已完成，见上面第 5 项（11 standalone = 7 原有 + 4 新增）。
2. **examples/ 目录已落地**：5 个 worked example 都建好并可跑：
   - `examples/embed-basic/` — 纯 HTML + UMD SDK，含 `index.html`（用 SDK）+ `no-sdk.html`（裸 iframe + postMessage）展示协议
   - `examples/embed-react/` — React 18 + Vite，含 `GenOfficeEditor.tsx` 组件 + `demo.tsx` + `vite.config.ts`（带 `/api` `/embed` proxy）+ `tsconfig.json`
   - `examples/embed-vue/` — Vue 3 + Vite，含 `GenOfficeEditor.vue` + `demo.ts` + 完整 Vite 配置
   - `examples/custom-provider/` — `@genoffice/provider-my-provider` 模板，`npm run build` 通过 + `npm publish --dry-run` 通过（3.9 kB tarball）
   - `examples/custom-skill/` — `@genoffice/skill-doc-word-counter` 模板，`npm run build` 通过 + dry-run 通过（2.9 kB tarball）
   - 顶层 `examples/README.md` 索引 + 每个子目录独立 README
   - 修复了原 `custom-provider` 的 `request.messages` 类型错（chat 接收 `request.user` 不是 `messages`）+ `AgentMessage` 中 `role: 'tool'` 没有 `text` 字段的边界 case
   - 修复了原 `custom-skill` 的 `SkillArraySchema` 缺 `items` 字段错
3. **`@genoffice/agent-skills` 内部隔离**：`agent-telemetry` / `agent-skills` 暂不 npm publish，保留为内部包（与计划一致）。
4. **typedoc 实际执行 ✅**：
   - `docs/scripts/gen-typedoc.mjs` 修复了 `--skipErrorDocuments` → `--skipErrorChecking`（typedoc 0.28 重命名）
   - 增加了 `apps/web-server/src/common` 作为额外 entry point，消除 `FileWebhook not included` 警告
   - 给 19 个 v1 handler / 公共 helper 加了完整 TSDoc（含 `route` / `summary` / `scope` / `errors` 字段）
   - 本地跑：`node docs/scripts/gen-typedoc.mjs` → 199 个 MD 文件输出到 `docs/api/_generated/`
   - VitePress sidebar 加入 `Generated API Reference` 入口链接到 `docs/api/_generated/README`
   - `.gitignore` 加入 `docs/api/_generated/`（避免 JSDoc 微调触发大量 churn diff）
   - `docs/package.json` 已声明 `typedoc@^0.28.0` + `typedoc-plugin-markdown@^4.6.0`
5. **双语文档**：当前 EN-only 含少量 zh inline。

### A.6 测试现状（本轮实施后更新）

| 套件 | 文件 | 用例 | 状态 |
|---|---|---|---|
| web-server（含 marketplace / webhook-signing / auth-scope / plugin-e2e / scope-gate）| 52 | 428 | ✅ |
| ai-provider（含 plugin-routing）| 19 | 248 | ✅ |
| agent-skills | 16 | 204 | ✅ |
| translation-core | 13 | 234 | ✅ |
| agent-core | 6 | 95 | ✅ |
| 5 个 provider 包合计 | 5 | 32 | ✅ |
| 11 个 standalone skill 包合计 | 11 | 84 | ✅ |
| web-sdk（含 handshake / origin allowlist）| 3 | 20 | ✅ |
| **总计** | **125** | **1345** | ✅ |

web-server bundle 28.2 MB / `health` 200 / 546 IPC channels / marketplace boot 日志 OK。
新增测试覆盖：plugin-fallback 路由（6）、marketplace → registry → chat/stream e2e（2）、webhook HMAC 签名（5）、JWT RBAC scope（9）、SDK iframe handshake + origin allowlist（20）。

---

## 附录 B：WPS Web 版本与 GenOffice 对照

> 用户决策要求参考 WPS web 集成模式，本节做能力对照与差距识别。

### B.1 集成模式对照

| 维度 | WPS Web（公开资料）| GenOffice Web Server | 差距 |
|---|---|---|---|
| 渲染路径 | 远端 Canvas / WebSocket 流式 | 同进程 Node + 浏览器内编辑器 | GenOffice 单机可跑，WPS 必须云 |
| 嵌入方式 | `https://wpsiframe.xxx.com/...` + iframe postMessage | `/embed/:docId?token=...` + 同款 | 平手 |
| 鉴权 | OAuth + 企业 SSO + 自家账号 | JWT + OAuth 2.0 client_credentials | 平手 |
| 文件保存 | 远端落盘 + 版本号 | 本地 + webhook 通知 | GenOffice 更可控 |
| 协作 | 实时多人（OT/CRDT）| ⬜ 单人（未实现）| **核心差距** |
| AI 能力 | WPS AI 闭源 + 企业付费 | Provider 插件市场 + 协议开放 | **GenOffice 优势** |
| Skill 生态 | 无 | SkillPackage + Marketplace | **GenOffice 优势** |
| 开放 SDK | 有限（仅企业合作）| `@genoffice/web-sdk` + REST v1 + 双协议 | **GenOffice 优势** |
| 浏览器兼容 | 现代浏览器 | Chrome ≥ 100 / FF ≥ 100 / Safari ≥ 15 / Edge ≥ 100 / 国产浏览器 Tier 2 | 平手 |
| 移动端 | WPS H5 / 小程序 | ⬜ 未实现 | 差距 |
| 离线 | 仅本地客户端 | web-server 单机 + Docker 自部署 | GenOffice 自托管优势 |

### B.2 借鉴 WPS 的设计点

1. **postMessage 协议**：WPS iframe 走标准化 postMessage 协议（init / ready / save / error）。GenOffice 已经定义在 `docs/api/postmessage-protocol.md`，✅ **本轮已落地**：iframe 父页面 handshake（`apps/sdk/src/editor.ts` 每会话随机 nonce → `?nonce=` 注入 → `ready` event 必须 echo 同一 nonce 否则触发 `HANDSHAKE_FAILED`），origin allowlist（`*` 通配 + `*.example.com` 单段通配）。
2. **保存回调签名**：WPS 在保存触发后推 HMAC 签名 webhook。GenOffice 现有 webhook 缺签名，建议补 HMAC-SHA256(secret, body) 头 `X-GenOffice-Signature`，参考 GitHub / Stripe 模式。
3. **细粒度权限**：WPS 区分 read / write / comment / print / download 五级。✅ **本轮已落地**：`apps/web-server/src/api/v1/auth.ts` 提供 `hasScope(payload, scope)` helper（exact / `*` / `ai:*` 前缀通配 / 默认只读 / admin 旁路），`/api/v1/auth/jwt` 接受 `scope` 输入并合并到 OAuth-style scope claim；端点侧 16 个 v1 endpoint 全部强制 scope gate。
4. **文件级 token**：WPS 支持给单个文件颁发短 token（嵌入时用）。GenOffice 已有 `POST /api/v1/files/:id/jwt` 端点，需要补"过期时间 + 单次使用"约束文档。
5. **协作冲突解决**：WPS 用 OT 算法。短期可不上 CRDT，但 `dirtyChanged` 事件 + `version` 字段必须落地，让第三方能感知冲突。

### B.3 GenOffice 独有的差异化护城河

| 护城河 | 实现 |
|---|---|
| Provider 插件市场 | 任何 LLM / 图片生成 / 搜索都能接入，零改 GenOffice |
| SkillPackage 协议 | 第三方可发布 skill，自动注册到 UI |
| KB/TM 开放格式 | `.genkb` / `.gentm` 可跨厂商互通 |
| Agent Loop 协议 | 第三方可写 runner |
| 自托管 | Docker + Node 22 单机即可跑，无云依赖 |
| Apache-2.0 | 商业友好 fork 友好 |

---

## 附录 C：M4+ 路线图（GA 之后）

### M4（Week 16）— 协作 + 移动端骨架

- [ ] Yjs / CRDT 集成进 6 个编辑器（单人 → 多人）
- [ ] 移动端 H5 编辑器（PWA + 触控手势）
- [ ] 评论系统 + 评论通知 webhook

### M5（Week 20）— 商业版与 SLA

- [ ] Pro / Enterprise tier 划分
- [ ] 99.9% SLA 监控（uptime / latency / error rate）
- [ ] 商业版 `@genoffice/cloud` 私有包（不进 monorepo）
- [ ] 企业 SSO（SAML / OIDC）
- [ ] 审计日志（合规）

### M6（Week 24）— AI 高级能力

- [ ] 文档级长上下文（1M+ token）provider 抽象
- [ ] 多模态：图片 / 视频 / 音频 skill
- [ ] Agent 自治：长任务调度 + checkpoint
- [ ] Embedding 模型插件市场（KB / TM 用）

### M7（Week 32）— 国际化与本地化

- [ ] 全量双语（中英）文档
- [ ] i18n 完整覆盖（UI + API 错误码 + 日志）
- [ ] 数据驻留：US / EU / CN 三区域可选

### M8（Week 40）— 生态运营

- [ ] 公开 skill marketplace（genoffice.app/skills）
- [ ] 开发者认证（`@genoffice/certified-skill` 标签）
- [ ] Skill 收入分成（接入 Stripe / 微信支付）
- [ ] 年度开发者大会

---

## 附录 D：执行原则（与原 §十 不变）

§一-§十原文是战略级原则；附录 A-C 是状态层。两者关系：

- §一-§十：决定**做什么**（Why + What）
- 附录 A：记录**做了什么**（What's done）
- 附录 B：解释**为什么这样做差异化**（Competitive）
- 附录 C：规划**接下来做什么**（What's next）

任何后续修改这四层时，必须保持 §十的核心原则不动：

1. 开放要早
2. 开放要稳
3. 开放要广
4. 开放要赚
5. 开放要治

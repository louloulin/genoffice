---
layout: home
title: GenOffice
hero:
  name: GenOffice
  text: 开源 AI 办公套件
  tagline: 文档、表格、演示、PDF、Markdown、HTML —— 可嵌入、可脚本化、属于你。
  actions:
    - theme: brand
      text: 快速上手
      link: /zh/guide/getting-started
    - theme: alt
      text: REST API
      link: /zh/api/rest-api
    - theme: alt
      text: SDK 参考
      link: /zh/api/sdk-typescript
features:
  - title: 六个编辑器，一个引擎
    details: 文档、表格、演示、PDF、Markdown、HTML 共用同一套 IPC、AI 与最近文件栈。无需 Electron —— web-server bundle 作为单个 Node 进程发布。
  - title: 可嵌入
    details: 一行 HTML 即可把 `<iframe>` 嵌入任何网页。或导入 `@genoffice/web-sdk` 获取类型化事件与命令。
  - title: AI 原生
    details: 12 个 LLM provider、10 个官方 Skill、agent loop、KB / TM。可自带 provider 或 Skill —— 插件就是普通 npm 包。
  - title: 开放格式
    details: .docx、.xlsx、.pptx、.pdf、.md、.html 通过我们维护的开放引擎往返。`.genkb` / `.gentm` 用于分享知识库和翻译记忆。
  - title: Apache-2.0
    details: 整个核心采用 Apache-2.0 许可。商业 SLA 与 Pro 功能作为增强层叠加，而不是反过来。
  - title: 稳定 SDK
    details: REST API v1、postMessage v1 信封、JS SDK 都承诺向后兼容 —— v1.x 版本内不会引入破坏性变更。
---

## 关于本站

GenOffice 是一套**端到端开源的 AI 办公套件**，覆盖文档、表格、演示、PDF、Markdown、HTML 六大编辑器；并通过 `@genoffice/web-sdk`、REST API v1 与 iframe Embed 三种方式开放给第三方集成。

- **REST API v1** — 10 个稳定端点（auth / files / ai / kb / webhooks / health / changelog），v1.x 内不破坏
- **iframe Embed** — `<iframe src="/embed/:docId?token=...">` 一行集成，含 postMessage v1 协议
- **`@genoffice/web-sdk`** — ESM / CJS / UMD，类型化事件（`ready` / `saved` / `dirtyChanged` / `selectionChange` / `error` / `closed`）与命令
- **Provider 插件** — Anthropic / OpenAI / Gemini / DeepSeek / Kimi / Qwen / GLM / Doubao / Ollama 等 10 家
- **Skill 仓库** — 11 个官方 Skill，触发短语匹配，npm 包分发
- **KB / TM 开放格式** — `.genkb` / `.gentm` 归档
- **Agent Loop v1** — `genoffice.agent.v1` 信封，可接入第三方 agent 循环

## 五分钟上手

```sh
npm install @genoffice/web-sdk
```

```html
<iframe
  src="https://genoffice.app/embed/doc_abc?token=eyJ..."
  style="width:100%;height:600px;border:0"
></iframe>
```

或通过 SDK：

```ts
import { createEditor } from '@genoffice/web-sdk'

const editor = createEditor({
  container: '#editor',
  documentId: 'doc_abc',
  jwt: 'eyJ...',
  mode: 'edit',
  lang: 'zh-CN',
})

editor.on('saved', ({ url }) => console.log('saved', url))
await editor.aiTranslate({ target: 'en' })
```

## 选 Apache-2.0 + 商业版的策略

核心 monorepo Apache-2.0，鼓励集成商 fork 与二次开发；`@genoffice/cloud`（未来产品）以商业版提供托管服务、企业 SLA 与高级 KB / TM 协作。

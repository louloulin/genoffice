# 架构

GenOffice 是一个拥有 28 个 packages 与 8 个 apps 的 monorepo。架构有意分层，让每一块都可以替换或抽出，而不影响其余部分。

## 分层图

```
┌────────────────────────────────────────────────────────────────┐
│ Apps — 编辑器 + shell + web-server + sdk                       │
│   docs · sheets · slides · pdf · markdown · html · shell · sdk │
└────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   领域引擎               AI / Skills            IPC / 存储
   docx-engine            ai-provider            ipc-bridge
   pptx-engine            agent-core             file-management
   xlsx-gateway           agent-skills           file-parse
   pdf2docx               translation-core       project-store
   html2docx              ai-search
   pptx-render            agent-runtime
   pptx-ops
   pipelines
```

## 编辑器 ↔ 服务端传输

每个编辑器 app 都使用同一套传输层：

```
┌──────────────┐     postMessage / IPC       ┌─────────────────┐
│ Renderer     │ ──────────────────────────► │ 主进程 /        │
│ (React UI)   │ ◄────────────────────────── │ web-server      │
└──────────────┘                              └─────────────────┘
```

- Electron shell 使用 Electron 的 `ipcRenderer` / `ipcMain`。
- 独立 web-server 提供同样的 renderer 打包产物，把同样的 IPC 通道通过 HTTP（`/api/ipc/:channel`）或 SSE（`/api/ipc/events`）代理。
- `@genoffice/ipc-bridge` 包负责编码 —— 每个通道都讲同一套线协议格式。

## 存储

文件层（`@genoffice/file-management`）把存储后端抽象到一个统一接口后面：

```ts
interface StorageBackend {
  put(key: string, data: Uint8Array, meta: { contentType?: string }): Promise<void>
  get(key: string): Promise<Uint8Array>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<{ key: string; size: number; mtime: number }[]>
}
```

默认后端是本地文件系统；S3 / MinIO / GCS 后端位于同一包，通过 `STORAGE_BACKEND` 环境变量热切换。

## AI

AI 层（`@genoffice/ai-provider`）把 12 家 LLM provider 包装到统一的 `chat` / `streamChat` API 后面。Provider 配置存放在 `genoffice.providers.json`；首方 provider 硬编码进打包产物，第三方 provider 通过 npm 加载。

## Skill 协议

Skill 是实现了 `SkillDefinition` 的可移植 npm 包。运行时通过 `genoffice.skills.json` 发现它们，并注册进 Agent Loop。见 [AI Skills 协议](/zh/api/ai-skills-protocol)。

## 接下来读什么

- [REST API](/zh/api/rest-api)
- [SDK 参考](/zh/api/sdk-typescript)
- [IPC 通道](/zh/api/ipc-channels)
- [Agent 协议](/zh/api/agent-protocol)

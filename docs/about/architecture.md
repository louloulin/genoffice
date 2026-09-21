# Architecture

GenOffice is a monorepo with 28 packages and 8 apps. The architecture
is intentionally layered so each piece can be swapped or extracted
without disturbing the rest.

## Layer diagram

```
┌────────────────────────────────────────────────────────────────┐
│ Apps — editors + shell + web-server + sdk                      │
│   docs · sheets · slides · pdf · markdown · html · shell · sdk │
└────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   Domain engines         AI / Skills           IPC / storage
   docx-engine            ai-provider           ipc-bridge
   pptx-engine            agent-core            file-management
   xlsx-gateway           agent-skills          file-parse
   pdf2docx               translation-core      project-store
   html2docx              ai-search
   pptx-render            agent-runtime
   pptx-ops
   pipelines
```

## Editor ↔ server transport

Every editor app uses the same transport layer:

```
┌──────────────┐     postMessage / IPC       ┌─────────────────┐
│ Renderer     │ ──────────────────────────► │ Main process /  │
│ (React UI)   │ ◄────────────────────────── │ web-server      │
└──────────────┘                              └─────────────────┘
```

- The Electron shell uses Electron's `ipcRenderer` / `ipcMain`.
- The standalone web-server serves the same renderer bundles and
  proxies the same IPC channels over HTTP (`/api/ipc/:channel`) or
  SSE (`/api/ipc/events`).
- The `@genoffice/ipc-bridge` package owns the encoding — every
  channel speaks the same wire format.

## Storage

The file layer (`@genoffice/file-management`) abstracts the storage
backend behind a single interface:

```ts
interface StorageBackend {
  put(key: string, data: Uint8Array, meta: { contentType?: string }): Promise<void>
  get(key: string): Promise<Uint8Array>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<{ key: string; size: number; mtime: number }[]>
}
```

Default backend is local filesystem; S3 / MinIO / GCS backends live in
the same package and can be hot-swapped via `STORAGE_BACKEND`.

## AI

The AI layer (`@genoffice/ai-provider`) wraps 12 LLM providers
behind a single `chat` / `streamChat` API. Provider configuration is
held in `genoffice.providers.json`; first-party providers are
hard-coded in the bundle, third-party providers are loaded via npm.

## Skill protocol

Skills are portable npm packages implementing `SkillDefinition`. The
runtime discovers them through `genoffice.skills.json` and registers
them in the Agent Loop. See [AI Skills Protocol](/api/ai-skills-protocol).

## Where to read next

- [REST API](/api/rest-api)
- [SDK Reference](/api/sdk-typescript)
- [IPC Channels](/api/ipc-channels)
- [Agent Protocol](/api/agent-protocol)

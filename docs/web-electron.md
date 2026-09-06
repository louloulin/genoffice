# Web server + Electron compatibility

GenOffice Web mode is moving to a standalone Node HTTP server. The server owns HTTP/SSE transport and receives transport-agnostic handlers through `IpcHandlerRegistry`; it does not import or start Electron. Electron support remains an optional compatibility adapter.

## Architecture

- **Standalone Web server (primary):** call `createStandaloneWebServer`, register Node-safe handlers on its registry, and serve the renderer plus `/api/ipc/*` from one Node process.
- **Electron adapter (compatibility):** `installHttpIpcBridge` mirrors `ipcMain.handle/on` registrations into the same HTTP server. This path is retained for desktop compatibility, but is not required by Web mode.
- **Browser transport:** `createHttpIpcTransport` runs in a normal browser and receives server-to-renderer events through SSE.
- **Shared contracts:** API factories are transport-agnostic; Electron preload uses IPC while Web bootstrap uses HTTP/SSE.

## Standalone server API

```ts
import { createStandaloneWebServer } from '@genoffice/ipc-bridge'

const { server, registry } = await createStandaloneWebServer({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 5273),
  staticDir: 'apps/docs/out/renderer',
})

registry.registerHandle('app:get-language', () => 'zh')

// on shutdown
await server.close()
```

The standalone entry owns server lifecycle, health, JSON/binary IPC payloads, SSE sessions, static hosting, body limits, native-only rejections, and loopback binding. Existing Electron-heavy handlers are not automatically Node-safe: handlers using `BrowserWindow`, `dialog`, `app.getPath`, native fonts, or Electron printing must first be extracted behind platform-neutral services.

## Migration order

1. Move pure document, workbook, slide, PDF, Markdown, project-storage, and AI services out of `apps/*/src/main` into Node-safe packages.
2. Register those services in a standalone Web composition root.
3. Replace browser web-bridge fallbacks with server APIs where the operation is server-owned; keep file picker/download/print as browser APIs.
4. Add standalone HTTP/E2E coverage for every migrated capability.
5. Keep `installHttpIpcBridge` as a thin Electron adapter and validate desktop behavior separately.

Do not add new Web features by importing an Electron main module. That recreates the coupling this server split removes.

## Protocol

The standalone server exposes:

- `POST /api/ipc/:channel` for invoke/send.
- `GET /api/ipc/events?session=<id>` for SSE pushes.
- `GET /api/ipc/health` for readiness and channel counts.

The default bind address is `127.0.0.1`. Remote deployment requires explicit authentication and reverse-proxy controls. HTTP errors preserve structured `IPC_NO_HANDLER` and `WEB_UNSUPPORTED` codes. Binary values use tagged base64 encoding for `ArrayBuffer` and typed arrays. The server can serve a built renderer from `staticDir`, allowing the Web application and API to use one origin.

## Browser-owned capabilities

These remain browser APIs and do not require Electron:

- File selection: `<input type=file>` followed by `web:write-temp-file`.
- Save/export: server bytes followed by a browser Blob download.
- Print: `window.print()`.
- Clipboard: `navigator.clipboard`.
- Fullscreen: `requestFullscreen`.
- Screen capture: `getDisplayMedia`.
- Windows/tabs: `window.open`.

## Runtime and verification status

The standalone registry/server is implemented and covered by package integration tests. `@genoffice/ipc-bridge` typecheck passes and the bridge test suite passes, including standalone server startup without `ipcMain` or Electron.

The full business-handler migration is intentionally not complete yet. Current app main modules still own many Electron-specific handlers; those modules must not be imported by the standalone server until their dependencies are extracted.

The previous Electron-backed commands remain compatibility/development commands only. They are not the standalone Web server entry point and are not the acceptance target for this migration.

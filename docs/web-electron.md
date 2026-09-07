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

Static hosting serves the built renderer from `staticDir`, and navigation GETs
without a file extension fall back to `index.html`, so a browser reload on a
client-side route ("/doc/123") still boots the renderer. `/api/*` paths and
paths with an extension never fall back, and traversal attempts stay `404`.

When `authToken` is set, every route requires `Authorization: Bearer <token>`
and the comparison is constant-time. A non-loopback bind without `authToken` is
rejected at startup.

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

## Node-safe service packages

Capabilities are extracted out of `apps/*/src/main` into packages the standalone
server can import, and the old app path stays as a one-line re-export shim so the
Electron main process keeps working unchanged:

| Package                            | Extracted from                                                          | Web channels                                                        |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@genoffice/docx-service`          | docs main                                                               | `docs:*`                                                            |
| `@genoffice/office-file-service`   | pdf/slides main                                                         | `pdf:*`, `slides:*` file IO                                         |
| `@genoffice/workbook-service`      | sheets main                                                             | `workbook:*`                                                        |
| `@genoffice/pdf-export-service`    | `apps/pdf/src/main/font-cmap.ts`, `font-subset.ts`                      | `pdf:font-covers-text`, `pdf:subset-font`                           |
| `@genoffice/slides-render-service` | `apps/slides/src/main/font-catalog.ts`, `media-mime.ts`, `cfb-sniff.ts` | `slides:font-catalog`, `slides:media-mime`, `slides:container-kind` |
| `@genoffice/project-store`         | shared                                                                  | `markdown:*`, `project:*`                                           |

`SavedSignature` / `SignatureData` / `SignatureStrokes` are declared in
`@genoffice/pdf-export-service` and re-exported from `apps/pdf/src/shared/ipc.ts`,
so the desktop main process and the Web server validate the same shapes. Saved
signatures are desktop `userData` state; the standalone server keeps them under
its own data root (`pdf-signatures.json`) with the same serialized
read-modify-write, so several browser tabs cannot clobber each other.

Still Electron-owned and not yet extractable: `pdf-main.ts`, `image-edit.ts`,
`slides-main.ts`, `font-store.ts`, `presenter-show.ts`, `session-state.ts`,
`ai-ipc.ts`, `attachments-ipc.ts` — they depend on `BrowserWindow`, `dialog`,
`app.getPath`, native fonts, or Electron printing.

## Running the Web server

```bash
npm run web        # tsx apps/web-server/src/main.ts
# env: HOST, PORT (5273), GENOFFICE_DATA_DIR, XLSX_SIDECAR_PATH
```

## Runtime and verification status

The standalone registry/server is implemented and covered by package integration tests. `@genoffice/ipc-bridge` typecheck passes and the bridge test suite passes, including standalone server startup without `ipcMain` or Electron.

`npm run test:e2e:web` (`e2e/web-server-verify.mjs`) is the automated form of
that verification: it boots the real composition root in a child process exactly
like `npm run web`, then asserts 36 checks over HTTP — auth, project/markdown
round-trip, data-root containment, PDF/slides bytes, the extracted font,
sniffing, signature, export-naming, media-normalizer and page-operation
channels,
`IPC_NO_HANDLER`, SSE, static hosting, SPA fallback, missing asset and
traversal. It needs no browser and no Electron, and runs as its own
`web-server-e2e` CI job plus the first step of `npm run test:e2e`.

The verify script refuses to start when its port is already serving, so a stale
server from an earlier run cannot silently make the suite test the wrong build.

Verified against a really running server (`npm run web`, no Electron in the
process): `GET /api/ipc/health` reports 48 registered channels;
`project:create` / `project:list` / `markdown:write-file` / `markdown:read-file`
round-trip; `pdf:create-blank` and `slides:create-blank` return tagged-base64
bytes; a read outside the configured data root is rejected; an unknown channel
returns `404 IPC_NO_HANDLER`; `GET /api/ipc/events` opens an SSE stream; with
`authToken` set, a missing or same-length-wrong bearer returns `401` while the
exact token passes; `staticDir` serves `index.html` and assets, falls back to
`index.html` for `/doc/123`, and still returns `404` for a missing asset and for
traversal. Workbook channels return the structured
"build xlsx-sidecar" error until the Rust sidecar is built.

Page operations were driven against the same live server and re-parsed with
pdf-lib: extract 4 -> 2 pages, blank insert 4 -> 5, document insert count 4 and
8 pages, split into 2 chunks of 2, 2-up imposition to 2 sheets of width 300,
split-pages 4 -> 16, replace 2 removed and 4 inserted, A4 resize to 595x842 with
the /Rotate 90 page correctly swapped to 842x595, crop to a 100x150 CropBox, and
a multi-file merge appending 4 pages. Malformed input returns 500 with a
structured message.

The full business-handler migration is intentionally not complete yet. Current app main modules still own many Electron-specific handlers; those modules must not be imported by the standalone server until their dependencies are extracted.

The previous Electron-backed commands remain compatibility/development commands only. They are not the standalone Web server entry point and are not the acceptance target for this migration.

# @genoffice/office-ai

Headless Office document engine (docx / xlsx / pptx / pdf) plus an **in-process
UI host** that puts the real GenOffice editors on screen from a Node process.

No Electron, no separate web-server deployment, no model calls in the core —
the four editors run in the consumer's own browser, talking to the consumer's
own process over a loopback HTTP face.

```ts
const host = await startUiHost({ apps: ['docs'] }) // Node, in-process
host.url // → http://127.0.0.1:<ephemeral>
```

---

## Install

```jsonc
{
  "dependencies": {
    "@genoffice/office-ai": "^0.1.0",
    "@genoffice/office-ai-ui-assets": "^2026.10.6", // required for the UI tier
  },
  "engines": { "node": ">=22.12.0" },
}
```

Three things that will bite you otherwise:

1. **Both packages go in `dependencies`.** Never in `peerDependencies`.
   Consumers with `auto-install-peers=true` in `.npmrc` (pnpm's default since
   v8) try to resolve peers as ordinary packages; an unpublished peer fails
   install with a hard `ERR_PNPM_FETCH_404`.
2. **`office-ai-ui-assets` is not optional** if you use the UI tier. It carries
   the four compiled renderer bundles (~62 MB unpacked) and nothing else.
3. **The two versions must be from the same release.** The asset package is
   matched to the host by app name and channel contract, so it tracks the repo's
   CalVer (`2026.10.06`) while `office-ai` itself is still on `0.1.0`. Mixing
   versions makes renderers call channels the host hasn't registered — which
   surfaces only as a blank editor in the browser, with no error anywhere.

The headless tier (`import { readDocument } from '@genoffice/office-ai'`) needs
neither the asset package nor Node ≥ 22 beyond `engines`.

---

## Entry points

| Import                      | File                                        | Runs in | Contents                                                       |
| --------------------------- | ------------------------------------------- | ------- | -------------------------------------------------------------- |
| `@genoffice/office-ai`      | `dist/office-ai.cjs` (26 MB, wasm included) | Node    | read / write / convert / render / ops / sessions / agent tools |
| `@genoffice/office-ai/host` | `dist/host.cjs` (3.5 MB)                    | Node    | `startUiHost`, `attachUi`, IPC handlers, static serving        |
| `@genoffice/office-ai/ui`   | `dist/ui/index.js` (7.6 KB)                 | Browser | `mountEditor`, `buildEmbedUrl`                                 |

`dist/host.mjs` is **not** a separate ESM bundle — it is a ~2 KB `createRequire`
shim that forwards to `host.cjs`. If you bundle for the browser or use a
strict-ESM bundler, import the `/host` entry from Node code only; the browser
side is `./ui`.

---

## UI tier

### Mode A — `startUiHost()`

The host binds its own loopback port and serves everything. The lifecycle is
tied to the handle: `close()` closes the server and removes the workspace.

```ts
import { startUiHost } from '@genoffice/office-ai/host'

const host = await startUiHost({
  apps: ['docs', 'sheets', 'slides', 'pdf'], // default: all four
  ai: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: process.env.AI_KEY! },
})

const staged = host.open('docs', bytes, { name: 'report.docx' })
// staged.url → http://127.0.0.1:53211/docs?open=/…/report.docx
```

`options.host` (default `127.0.0.1`) and `options.port` (default ephemeral) are
the only knobs beyond `CreateHostContextOptions`.

### Mode B — `attachUi()`

For hosts that already have an `http.Server` — no new port, no new listener
ownership. Requests under `basePath` go to office-ai; **everything else falls
through to the original listeners**, which are preserved, not replaced.

```ts
import { attachUi } from '@genoffice/office-ai/host'

const { context, detach } = attachUi(server, {
  basePath: '/office-ai',
  ai: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: key },
})
// browser side
mountEditor({ baseUrl: '/office-ai', app: 'docs', docId, container: '#editor' })
```

Both modes share one request dispatcher, so channels, routes, and the token
gate behave identically. Only the binding differs.

### Routes

| Route                    | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `POST /api/ipc/:channel` | renderer IPC invoke                        |
| `GET /api/ipc/events`    | SSE event stream                           |
| `GET /embed/:docId`      | framed wrapper page + `postMessage` bridge |
| `GET /<app>/…`           | that app's renderer bundle                 |
| `GET /health`            | readiness probe                            |
| `POST /api/ai/stream`    | SSE chat completions for the AI panel      |

### Browser side — `mountEditor()`

```ts
import { mountEditor } from '@genoffice/office-ai/ui'

const ed = mountEditor({
  baseUrl: host.url, // or '/office-ai' in mode B
  app: 'docs',
  docId: 'doc-1',
  container: document.querySelector('#editor')!,
  open: staged.path, // optional; omit for an empty document
  theme: 'auto', // 'light' | 'dark' | 'auto'
  lang: 'zh-CN', // 'zh-CN' | 'en-US' | 'ja-JP'
  token: host.token, // only if you passed one to startUiHost
})

await ed.whenReady()
ed.on('dirtyChanged', ({ dirty }) => {
  /* … */
})
ed.on('saved', ({ version, bytes }) => {
  /* `bytes` is a byte count, not the file */
})
const { dirty } = await ed.command('isDirty')
ed.destroy()
```

Command and event names follow the `@genoffice/sdk` contract (`apps/sdk/src/types.ts`)
rather than being invented here, so a host written against the SDK's `EditorCommands`
works unchanged whichever server is behind it.

Note what `saved` does **not** carry: the edited bytes. Pull them from the host —
`host.readFile(path)` — rather than expecting them over postMessage.

`destroy()` is idempotent and rejects every in-flight `command()`, so no
`await` hangs past teardown. The container needs a real height — the iframe is
stretched to `100%`, and a zero-height parent collapses the editor canvas.

---

## The `open` parameter is not the same for every app

docs, sheets and slides read their initial path from `?open=`. **pdf reads it
from `#open=`**, because its host page also carries `?app=` / `?mode=` /
`?theme=` embed parameters that must not be confused with a document path.

Getting this wrong fails silently: a `?open=` URL boots the pdf app into its
empty state, with nothing in the console.

Never hand-build the URL. `host.open()` and `mountEditor()` both route through
`setOpenParam`, which is exported from both the `/host` and `/ui` entries:

```ts
import { setOpenParam } from '@genoffice/office-ai/ui'

const url = new URL('http://127.0.0.1:1234/pdf')
setOpenParam(url, 'pdf', '/abs/path/report.pdf') // → #open=%2Fabs%2F…
setOpenParam(url, 'docs', '/abs/path/report.docx') // → ?open=%2Fabs%2F…
```

---

## Asset resolution

The host finds each app's compiled renderer in three tiers, in order:

1. an explicit `assetsDir` from the caller (a root containing `docs/`,
   `sheets/`, `slides/`, `pdf/`);
2. `require.resolve('@genoffice/office-ai-ui-assets/package.json')` — the
   published asset package, keyed by app name;
3. a sibling checkout's `apps/<app>/out/renderer` — for in-repo dev and CI only.

**Tier 2 is the production path**, which is why the asset package is a
dependency rather than an optional extra. Tier 3 resolves only when the bundle
still lives inside the monorepo layout; if you vendor `host.cjs` somewhere else,
set `assetsDir` explicitly.

---

## AI panel

The renderer's web transport sends **no provider selection** — the request body
carries only messages and tools. The host must therefore hold the credentials
itself; there is no per-request override.

```ts
startUiHost({ ai: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey } })
```

Without `ai`, `/api/ai/stream` answers every request with a readable `error`
frame naming what is missing — deliberately **not** a 404, so the panel shows a
real message instead of a generic "no route".

`ai:get-settings` returns the real `provider` and `model` so the UI can label
itself, but **`apiKey` is always returned as an empty string** — the key stays in
the host process and is never sent to the browser. The stream itself does not
depend on that field, so masking costs nothing.

Two providers are refused outright, and `aiConfigProblem()` will say so before
you start: `genspark`, which authenticates through a shared gsk login this
process does not carry, and `codex`, which drives a Node subprocess. Neither
would fail loudly — `genspark` ships a default model with an empty key, so the
request would leave for the public endpoint and come back as an opaque 403.
`provider: 'custom'` with a `baseUrl` works, for any OpenAI-compatible endpoint.

---

## Security model

| Control           | Default          | Notes                                                                |
| ----------------- | ---------------- | -------------------------------------------------------------------- |
| bind address      | `127.0.0.1`      | loopback only unless you override `host`                             |
| port              | ephemeral        | no port guessing, no conflicts                                       |
| token             | random, per host | required on every request; pass to `mountEditor({token})`            |
| `pathAccess`      | `'workspace'`    | renderer-supplied paths outside the workspace root resolve to `null` |
| `frame-ancestors` | `'self'`         | see below                                                            |

**`frame-ancestors` needs your attention.** The default `'self'` is correct for
a same-origin mount but wrong for every `startUiHost()` deployment: the host
binds its own port, so the embedding page is always a different origin and the
browser refuses the frame — leaving an empty iframe with no client-side error.
Name the embedding origin:

```ts
startUiHost({ frameAncestors: "'self' http://127.0.0.1:3000 https://app.example.com" })
```

Unset, it falls back to the `EMBED_FRAME_ANCESTORS` environment variable;
malformed values fall back to `'self'` rather than failing open.

`pathAccess: 'any'` lifts the workspace restriction for renderer-supplied paths.
Only do that when the host page and everything framing it are fully trusted —
it is the difference between "a document path the user chose" and "any path the
process can read".

This library deliberately does **not** ship the web-server's route policy: no
JWT scopes, no channel-level authz table, no rate limiting, no audit log. It is
a library bound to loopback with a per-host token; the embedding host owns
network isolation and user-facing authorization.

---

## What is and isn't wired

Per-app handlers are ported from `apps/web-server`: docs, sheets (including the
chunked save protocol), slides, and pdf all round-trip real bytes through the
real editors.

Channels outside those four apps' editing loops — projects, collaboration,
notifications, the file manager, markdown/html apps — are **stubbed, not
missing**. A stub returns the shape the renderer expects for "unsupported";
nothing 404s. `STUBBED_SLIDES_CHANNELS` and `STUBBED_PDF_CHANNELS` are exported
from `/host` if you want to enumerate them.

Of the 34 SDK editor commands, 8 are host-backed (comments and version
snapshots). The other 26 mutate the live editor model or need a browser dialog
and are serviced by the renderer's own command sink; the host only sees them if
the renderer failed to load, and answers 501 with a remediation hint rather than
hanging.

Comments and the version index are **per-host in-memory** — a library host has
no durable data directory and its workspace is a temp tree torn down with the
handle. Version _payloads_ are real bytes written into the workspace, so a
snapshot restores an actual document.

---

## Headless tier

Unchanged and independent of everything above:

```ts
import {
  readDocument,
  writeDocument,
  convert,
  render,
  applyDocumentOps,
} from '@genoffice/office-ai'

const doc = await readDocument(bytes) // { format, text, … }
const md = await convert(pdfBytes, 'pdf', 'md') // pdf → markdown, in-process
const pages = await render(pdfBytes, { format: 'pdf', scale: 2 }) // Uint8Array[]
```

`convert` only serves the in-process routes — `NODE_ROUTES`, i.e. pdf → docx /
pptx / xlsx, md ↔ docx, xlsx → csv and friends. Anything needing page layout
(docx → pdf, md → pdf) throws `OFFICE_NEEDS_APP` rather than shelling out;
those directions need the desktop app's renderer, which the library does not
ship. `render` is pdf-only for the same reason.

`openSession()` and `officeTools` provide a stateful, host-agnostic tool set for
an agent loop — no agent-runtime dependency, so any host can map them onto its
own tool type.

---

## Building from source

```bash
npm run build:office-ai        # esbuild → dist/
npm run build:ui-assets        # build the four renderers, then stage them
```

The asset package is a copy step, not a build: `scripts/build-assets.mjs` copies
each `apps/<app>/out/renderer` into `packages/office-ai-ui-assets/<app>`. It
fails loudly if an app has not been built, rather than shipping a package with
a silently missing editor.

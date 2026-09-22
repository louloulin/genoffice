# `@genoffice/web-sdk`

> Embeddable editor SDK for [GenOffice](https://genoffice.app).
> Three integration shapes: iframe `<script>` (UMD), npm `import` (ESM/CJS), or hand-rolled iframe (`buildEmbedUrl`).

## Install

```sh
npm install @genoffice/web-sdk
```

Or via `<script>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genoffice/web-sdk/dist/index.umd.js"></script>
<script>/* window.GenOffice is now available */</script>
```

## 5-minute Quick Start

```ts
import { createEditor } from '@genoffice/web-sdk'

// 1. Mint a JWT (server side):
//    POST /api/v1/auth/jwt  { sub: 'user-123' }
//    → { token: 'eyJ…' }

// 2. Drop the editor into a container:
const editor = createEditor({
  host: 'https://genoffice.app',
  documentId: 'doc_abc',
  app: 'docs',
  jwt: '<short-lived-token>',
  container: '#editor',
  mode: 'edit',
  theme: 'auto',
  lang: 'zh-CN',
  toolbar: 'full',
})

editor.on('ready', () => console.log('editor ready'))
editor.on('saved', ({ version, url }) => console.log('saved v', version))
editor.on('dirtyChanged', ({ dirty }) => console.log('dirty?', dirty))
editor.on('error', ({ code, message }) => console.error(code, message))

await editor.command('focus')
await editor.command('insertText', { text: 'Hello from the SDK!' })

// When you're done:
editor.destroy()
```

## Integration Shapes

| Shape | Use when |
|---|---|
| `createEditor({ container })` | You want the SDK to manage the iframe lifecycle. |
| `buildEmbedUrl({ … })` | You want to hand-roll the `<iframe>` and drop it into your SSR template / email. |
| `<script src=…>` | You can't ship a build pipeline (CMS / no-bundler legacy app). |

## Defense-in-depth handshake (v2)

The default `createEditor` / `buildEmbedUrl` paths use a **client-side** nonce check (the iframe echoes a host-generated nonce in `ready`; the host SDK verifies the match). This is sufficient when the host page is fully trusted.

When you want the **server** to also participate — e.g. you're embedding into a third-party portal where you can't trust the surrounding JS — call `createEmbedNonce()` first to mint a server-bound session, then drop the resulting URL into your iframe:

```ts
import { createEmbedNonce, createEditor } from '@genoffice/web-sdk'

const { embedUrl, sessionId, nonce } = await createEmbedNonce({
  documentId: 'doc_abc',
  app: 'docs',
  jwt: 'eyJ…', // must have `files:read` scope
  host: 'https://genoffice.app',
  ttlMs: 5 * 60 * 1000, // optional, default 5 min
})

// Either pass the URL to createEditor({ url }) …
const editor = createEditor({
  documentId: 'doc_abc', app: 'docs', jwt: 'eyJ…', host: 'https://genoffice.app',
  url: embedUrl, container: '#genoffice-mount',
})

// …or drop it straight into your own <iframe src={embedUrl} />.
```

The web-server will refuse to render the editor unless the URL `?nonce=` matches the server-minted one for `?sessionId=`. Tampered or replayed URLs get `401 NONCE_SESSION_INVALID` instead of the editor HTML. See `sdk1.md §11.26 / §11.27 / §11.28` for the protocol details.

To audit the iframe **after** it's mounted, pair `createEmbedNonce()` with `verifyEmbedNonce()`:

```ts
import { verifyEmbedNonce } from '@genoffice/web-sdk'

const audit = await verifyEmbedNonce({
  sessionId, nonce, host: 'https://genoffice.app', jwt: 'eyJ…',
})
if (!audit.valid) {
  // iframe was tampered / proxy-replayed / session expired
  editor.destroy()
  showBanner('Editor integrity check failed')
}
```

`verifyEmbedNonce()` returns `{valid:true, expiresAt}` on success or `{valid:false, reason:'unknown'|'expired'}` on failure — failures are not throws, only HTTP / network / parse errors are. See `sdk1.md §11.29`.

When the iframe is torn down, free the server-side slot eagerly with `releaseEmbedNonce()`:

```ts
import { releaseEmbedNonce } from '@genoffice/web-sdk'

editor.on('closed', () => {
  void releaseEmbedNonce({ sessionId, host: 'https://genoffice.app', jwt: 'eyJ…' })
  // released:true → server evicted; released:false → already gone (race with TTL).
  // Only HTTP / network / parse errors throw.
})
```

See `sdk1.md §11.30` for the DELETE-style endpoint contract.

### All-in-one: `createEditor({ sessionBinding })` (v2 §11.32)

If you don't want to wire `releaseEmbedNonce()` into your unmount handler by hand, pass the `(sessionId, nonce)` pair back into `createEditor()` via `sessionBinding`. The SDK will:

1. Stamp `?sessionId=…&nonce=…` onto the iframe URL (when it builds the URL itself).
2. Reuse the server-minted nonce as the handshake nonce (no second random generation).
3. Auto-call `releaseEmbedNonce()` from `destroy()` (fire-and-forget — failures are swallowed because the 5-min TTL is the safety net).

```ts
import { createEmbedNonce, createEditor } from '@genoffice/web-sdk'

const { embedUrl, sessionId, nonce } = await createEmbedNonce({
  documentId: 'doc_abc',
  app: 'docs',
  jwt: 'eyJ…',
  host: 'https://genoffice.app',
})

const editor = createEditor({
  documentId: 'doc_abc',
  app: 'docs',
  jwt: 'eyJ…',
  host: 'https://genoffice.app',
  url: embedUrl,
  container: '#genoffice-mount',
  // Pass the minted session back in; destroy() will release it.
  sessionBinding: { sessionId, nonce },
})

// No need to manually wire releaseEmbedNonce — destroy() does it.
editor.destroy()
```

Pass `autoRelease: false` if you want to manage release yourself (e.g. release from a global page-unload handler that fires after `destroy()`):

```ts
sessionBinding: { sessionId, nonce, autoRelease: false }
```

### Auditing after mount: `verifyEmbedSession()` (v2 §11.32)

A more lifecycle-friendly alias for `verifyEmbedNonce()`. Same wire protocol, same return shape; the distinct name reads better in the `mint → mount → audit → release` flow:

```ts
import { verifyEmbedSession } from '@genoffice/web-sdk'

editor.on('ready', async () => {
  const audit = await verifyEmbedSession({
    sessionId, nonce, host: 'https://genoffice.app', jwt: 'eyJ…',
  })
  if (!audit.valid) {
    editor.destroy()
    showBanner('Editor integrity check failed')
  }
})
```

Use either `verifyEmbedNonce()` or `verifyEmbedSession()` — they're aliases over the same `POST /api/v1/embed/verify-nonce` endpoint. Pick the one that reads better at your call site.

## Multi-instance (Kestrel M1)

> SDK 2.0 Kestrel milestone 1 landed in `release0919`. See `sdk1.md` §B.5.1 #1 / §A.5 #38.

Two changes that make mounting more than one editor on a single page trivial:

```ts
// Each editor gets a stable per-instance id. Look it up from anywhere
// in the host code without threading the EditorHandle through props.
const editorA = createEditor({ container: '#left',  documentId: 'doc-1', jwt, host, instanceId: 'split-left' })
const editorB = createEditor({ container: '#right', documentId: 'doc-2', jwt, host, instanceId: 'split-right' })

// Anywhere in the host code:
import { getEditor, listEditors } from '@genoffice/web-sdk'

getEditor('split-left').command('setTheme', { theme: 'dark' })
listEditors() // [editorA, editorB] in insertion order
```

Three contract pins:

- **`instanceId` is always present** on `EditorHandle`. Omit the option to let the SDK auto-mint a `ed_<base64url>` id; pass a string to pin it. Two `createEditor()` calls with the same id throw a remediation error — call `getEditor(id).destroy()` first.
- **`<iframe name>` is `genoffice-{instanceId}`** so postMessage `event.source` matching has a strong anchor (not just window equality).
- **`destroy()` removes from the registry** — `getEditor(id)` returns `undefined` afterward.

Three new commands (renderer-side wiring is renderer-team work; SDK round-trip is ready):

```ts
await editor.command('undo')                                  // roll back last edit
await editor.command('redo')                                  // redo last undone edit
const { length, current } = await editor.command('getUndoStack') // {length: number, current: number}
```

Editors that don't support undo (e.g. read-only mode) reject with `{ code: 'UNSUPPORTED' }`.

## Comments API (Kestrel M2)

> SDK 2.0 Kestrel milestone 2 landed in `release0919`. See `sdk1.md` §B.5.1 #4 / §A.5 #39.

Four commands + two events for comment / annotation workflows. The
backing store is on the web-server (`/api/v1/files/:id/comments` REST
endpoints, scope `files:comment`); the SDK round-trips through the
same postMessage protocol as the rest of the surface.

```ts
// Add a comment anchored at the current selection.
const { id } = await editor.command('addComment', {
  anchor: { range: { start: 0, end: 5 } },
  text: 'Reviewer note',
})

// List top-level (unresolved) comments.
const { comments } = await editor.command('listComments', { resolved: false })

// Resolve / unresolve (sticky `resolvedAt` on first resolve).
await editor.command('resolveComment', { id, resolved: true })

// Hard-delete.
await editor.command('removeComment', { id })

// Live updates — both events fire for the local user AND remote collaborators.
editor.on('commentAdded',   (e) => console.log('new comment', e.comment))
editor.on('commentResolved', (e) => console.log('resolved', e.comment))
```

## Versions API (Kestrel M3)

> SDK 2.0 Kestrel milestone 3 landed in `release0919`. See `sdk1.md` §B.5.1 #3 / §A.5 #40.

Three commands for snapshot / restore workflows. The backing store is
the disk-based `common/version-history.ts` already used by every save
pipeline (10-version cap, dedupe against the newest snapshot); the
SDK round-trips through `files:list-versions` / `files:restore-version`
IPC + the OAuth-scoped `files:restore` v1 endpoint.

```ts
// List captured versions (oldest first).
const { versions } = await editor.command('listVersions')
// versions: Array<{ id, docId, index, timestamp, size, sha256, message? }>

// Manually capture a "save point" before risky edits.
const { id } = await editor.command('createSnapshot', { label: 'pre-rewrite' })

// Restore — current state is captured as a new version so the user can roll forward.
const { version } = await editor.command('restoreVersion', { versionId: id })
```

OAuth separation: `files:restore` is intentionally NOT implied by
`files:write`. A token with only `files:write` can save but cannot
restore. Hosts that want commenter-only power mint a token with
`files:read + files:comment + files:write` and leave out
`files:restore`.

## Plugin Runtime (Kestrel M3.5)

> SDK 2.0 Kestrel milestone 3.5 landed in `release0919`. See `sdk1.md` §B.5.1 #8 / §A.5 #41.

Three commands + one event for mounting taskpane / sidebar plugins
(equivalent to Microsoft Office taskpane / WPS 「轻应用」). The SDK
only brokers postMessage between the host and the panel iframe —
it never inspects panel contents.

```ts
// Mount a sidebar plugin (panelUrl can be on any origin you trust).
const { panelId } = await editor.command('mountSidebar', {
  panelUrl: 'https://plugins.example.test/ai-assistant/',
  width: 360,
  title: 'AI Assistant',
})

// Push messages from the host to the panel (fire-and-forget).
editor.command('postToSidebar', {
  panelId,
  message: { type: 'ASK', prompt: 'summarise this document' },
})

// Receive replies from the panel.
editor.on('sidebarMessage', (e) => {
  // e.panelId, e.message — the panel protocol stays open
  // (postToSidebar.message is `unknown` by design)
})

// Tear down.
await editor.command('unmountSidebar', { panelId })
```

## File Picker (Kestrel M4)

> SDK 2.0 Kestrel milestone 4 landed in `release0919`. See `sdk1.md` §B.5.1 #7 / §A.5 #42.

One command for opening a host-side file picker. The renderer fires a
native `<input type='file'>` (or `showOpenFilePicker` when available),
reads each File via FileReader, and ships it back to the host as
base64 over postMessage (File objects don't cross the structured-clone
boundary).

```ts
const result = await editor.command('openFileDialog', {
  accept: 'image/*',
  multiple: true,
})

if ('canceled' in result) {
  console.log('user dismissed the picker')
} else {
  for (const file of result.files) {
    // file.name, file.size, file.type, file.lastModified, file.dataBase64
    console.log(file.name, file.size, 'bytes')
  }
}
```

Editors that don't support file picking (e.g. PDF view-only) reject
with `{ code: 'UNSUPPORTED' }`.

## Telemetry (Kestrel M4)

> SDK 2.0 Kestrel milestone 4 landed in `release0919`. See `sdk1.md` §B.5.1 #9 / §A.5 #42.

Opt-in via `createEditor({ telemetry: true })`. The SDK aggregates
host-visible signals (bytes sent to the editor via setContent /
insertText / insertImage; AI calls + character totals for
aiRewrite / aiTranslate / aiSummarize; total session duration) and
fires a `UsageEvent` every 30 seconds via `editor.on('usage', cb)`.

```ts
const editor = createEditor({
  // ...other options...
  telemetry: true,
})

editor.on('usage', (e) => {
  // e.instanceId, e.docBytesWritten, e.aiCalls,
  // e.aiTokensIn, e.aiTokensOut, e.sessionDurationMs
  analytics.track('editor_usage', e)
})
```

The interval is cleared on `destroy()` so a torn-down editor never
fires another event. Default off — telemetry is a host-visible audit,
not a wire-level LLM instrument. Hosts that want per-second rates
should diff successive event payloads.

## SDK 2.0 (Kestrel) — surface map

| # | Surface | Milestone | New commands | New events |
|---|---|---|---|---|
| 1 | Multi-instance | M1 | — | — |
| 2 | Undo / Redo | M1 | `undo`, `redo`, `getUndoStack` | — |
| 3 | Versions API | M3 | `listVersions`, `restoreVersion`, `createSnapshot` | — |
| 4 | Comments API | M2 | `addComment`, `listComments`, `resolveComment`, `removeComment` | `commentAdded`, `commentResolved` |
| 5 | Track Changes | _v3 backlog_ | (needs `docx-engine/revision-tracking.ts`) | — |
| 6 | Export | _v3 backlog_ | (needs `converters/` directory + PDF/docx/xlsx/pptx/png dispatch) | — |
| 7 | File Picker | M4 | `openFileDialog` | — |
| 8 | Plugin Runtime | M3.5 | `mountSidebar`, `unmountSidebar`, `postToSidebar` | `sidebarMessage` |
| 9 | Telemetry | M4 | — | `usage` |

All surface commands are **additive** — existing 1.x hosts that don't
call them see zero behaviour change. Backward compat is enforced by
`envelope.v === '1.0'` (no bump) and the `EditorCommands` /
`EditorEventMap` unions being type-level additive. Full plan in
`sdk1.md` §B.5.

## Typed Surface




| Event | Fires when |
|---|---|
| `ready` | Iframe has booted and is ready to accept commands. |
| `saved` | A save completed (post version + URL). |
| `dirtyChanged` | Edit buffer became dirty / clean. |
| `selectionChange` | User moved the caret / selection. |
| `error` | Recoverable editor error. |
| `closed` | User closed the editor (returned from a back-nav or explicit close). |

| Command | Args | Result |
|---|---|---|
| `setTheme` | `{ theme }` | — |
| `setLang` | `{ lang }` | — |
| `setMode` | `{ mode }` | — |
| `setContent` | `{ text?, html?, immediate? }` | — |
| `getContent` | — | `{ text?, html?, bytes? }` |
| `insertImage` | `{ url, width?, height?, alt? }` | — |
| `insertText` | `{ text }` | — |
| `print` | — | — |
| `focus` | — | — |
| `aiRewrite` | `{ instruction, selection? }` | `{ text }` |
| `aiTranslate` | `{ target, source? }` | `{ text }` |
| `aiSummarize` | `{ length? }` | `{ text }` |

All commands round-trip via `postMessage` and resolve when the editor
acknowledges. A 30-second hard cap prevents a hung editor from hanging the
host page.

## postMessage Envelope (v1.0)

```ts
type Envelope = {
  v: '1.0',
  dir: 'host→editor' | 'editor→host',
  kind: 'event' | 'command' | 'command-result',
  correlationId?: string,
  payload: unknown,
}
```

`command-result` always carries a `correlationId` so the host can match it
to the outstanding command even when several commands are in flight.

## Security Notes

- **JWT must be short-lived.** A leaked token = edit access. Mint per-session
  tokens via `POST /api/v1/files/:id/jwt` for file-scoped access.
- **Host origin.** The embed iframe validates that inbound `postMessage`
  events come from a configured allowlist of origins. Make sure your embed
  origin is whitelisted on the server (TODO: pre-flight to confirm).
- **CSP.** Add `frame-src https://genoffice.app` (or your self-hosted
  origin) to your `Content-Security-Policy`.

## License

Apache-2.0 — see `LICENSE` in the monorepo root.

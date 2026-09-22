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

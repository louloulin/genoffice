# Dataflarework Quick Start

Drop a GenOffice editor into a Dataflarework page. One call mints the embed
session; the host bridge does the rest. This guide assumes a working
Dataflarework backend (weknora-java) with the office-engine reverse proxy
already wired up.

> **Scope note.** The integration plan (§5.2) specified a single-call
> composite that would perform the handshake round-trips atomically and return
> a ready-to-mount bundle. **That composite ships as `openEmbedSession()`** —
> see [Step 2a](#2a-open-the-embed-session) for the one-call form, and
> [Embed Session (one call)](./dataflarework-embed-session.md) for the guide.
> The individual clients it composes (`FileJwtClient`, `EmbedNonceClient`,
> `buildDataflareEmbedUrl`, `installDataflareHostBridge`) remain exported and
> usable if you need finer control. The rest of the SDK's surface
> (`FileClient`, `VersionsClient`, …) is real and usable today.

## Prerequisites

- A running web-server instance. If it has `WEB_TOKEN` set, the embed host
  needs to satisfy that gate too — see [Auth Model](../architecture/auth-model.md).
- `@genoffice/web-sdk` ≥ 0.9.0-beta.1 installed in the Dataflarework frontend
- A Dataflarework backend that proxies `/office-engine` to the web-server
  (same-origin)
- `EMBED_FRAME_ANCESTORS` set on the web-server to include the Dataflarework
  host origin (see [Framing the editor](#framing-the-editor))

## Framing the editor

`/embed/<docId>` answers with `Content-Security-Policy: frame-ancestors …`. The
directive is emitted as an HTTP header, not a `<meta>` tag, because
`frame-ancestors` is ignored in meta tags. The value comes from the
`EMBED_FRAME_ANCESTORS` env var:

```bash
EMBED_FRAME_ANCESTORS="'self' https://app.dataflarework.com"
```

It is a space- or comma-separated allowlist. **The default is `'self'`, so a
cross-origin host is blocked until you set this** — the iframe renders blank
with a CSP violation in the console. Parsing is fail-closed: every token must
be `'self'`, `'none'`, `*`, or a bare origin (`https://host[:port]`), and any
malformed token makes the whole value fall back to `'self'` rather than
silently dropping just that token. `*` and `'none'` are only honoured when
they are the entire value.

The other half of the pair lives on the host: the host's own CSP needs
`frame-src` to permit the engine origin (e.g. `frame-src 'self' /office-engine;`).
A `frame-ancestors` block and a `frame-src` block look identical from the
browser console but have different fixes — `frame-ancestors` is the *engine*
refusing to be framed, `frame-src` is the *host* refusing to frame.

## Step 1 · Install the SDK

```bash
pnpm add @genoffice/web-sdk
```

The package is **zero-dependency** and ships 18 sub-path entries. The
Dataflarework front-end needs these:

```ts
import { openEmbedSession } from '@genoffice/web-sdk/file/embed'
import { FileClient } from '@genoffice/web-sdk/file/management'
import {
  buildDataflareEmbedUrl,
  installDataflareHostBridge,
} from '@genoffice/web-sdk/dataflare/host'
```

## Step 2 · Wire the host bridge

The host bridge is the parent-side `postMessage` handler that:

- receives `ready` / `dirty` / `saved` events from the iframe
- forwards HTTP and SSE proxy requests to the web-server
- routes commands (`init`, `set-readonly`, `focus-ai`, …) into the editor

### 2a. Open the embed session

One call. It mints the file-scoped JWT, mints the session nonce, verifies the
pair, and builds the iframe URL:

```ts
const baseUrl = '/office-engine'

// A bearer for the web-server. In WEB_TOKEN mode this is the shared secret;
// otherwise mint a JWT. See createAuthedClient() in the Auth Model doc.
const bearer = () => localStorage.getItem('genoffice-jwt') ?? ''

const session = await openEmbedSession({
  baseUrl,
  documentId: knowledgeId,
  app: 'docs',
  bearer,
})
// → { url, jwt, jwtExp, sessionId, nonce, expiresAt, cleanup() }
```

Under the hood it makes two round-trips in this order — the JWT is file-scoped,
the nonce is session-scoped:

| # | Request | Returns |
|---|---|---|
| 1 | `POST /api/v1/files/:id/jwt` | `{ token, exp, ttlSeconds, oneTime, jti? }` |
| 2 | `POST /api/v1/embed/nonce` | `{ sessionId, nonce, expiresAt, ttlMs }` |

`ttlSeconds` outside `[30, 86400]` is rejected locally, before the request — the
server clamps the same range, but you get an `INVALID_ARGUMENT` without a
network round-trip. The nonce defaults to a 5-minute TTL and caps at 1 hour.

The third round-trip, `POST /api/v1/embed/verify-nonce`, runs unless you pass
`verifyNonce: false`. Keep it on: it turns a failed handshake into an immediate
throw instead of a blank iframe. Verification does **not** consume the nonce —
only `DELETE` evicts it — so verifying before the iframe mounts is safe.

If you need finer control than this composite offers, the underlying clients
(`FileJwtClient`, `EmbedNonceClient`) are still exported and compose by hand;
[Embed Session (one call)](./dataflarework-embed-session.md) covers the
trade-offs.

### 2b. Mount the bridge

```ts
const iframe = document.createElement('iframe')
iframe.src = session.url
document.body.appendChild(iframe)

const uninstall = installDataflareHostBridge(
  iframe.contentWindow!,
  new URL(baseUrl, window.location.href).origin,
  session.sessionId,
  {
    onEvent: (evt) => {
      if (evt.type === 'ready') console.log('editor ready', evt.capabilities)
      if (evt.type === 'saved') {
        const versions = new VersionsClient({ baseUrl, bearer })
        void versions.create({ fileId: knowledgeId, label: `edit-${Date.now()}` })
      }
    },
    onRequest: async (request) => {
      // Forward to your own backend; return a response body + status.
      return proxyToBackend(request)
    },
    onStreamRequest: (request, emit, close, signal) => {
      // Subscribe upstream and relay; call close(status) when done.
    },
  },
)
```

`session.url` is
`{baseUrl}/embed/{docId}?app=…&token=…&nonce=…&sessionId=…`, plus optional
`mode` / `lang` / `theme` / `toolbar`. The document id is a path segment and
the credential parameter is named `token` (not `jwt`) — see
[Embed Session](./dataflarework-embed-session.md#mounting-your-own-iframe) for
the full shape. If you build the URL yourself instead, `buildDataflareEmbedUrl`
takes the same fields.

### 2c. Cleanup

```ts
const detach = () => {
  uninstall()                 // remove the message listener
  iframe.remove()
  void session.cleanup()      // invalidate the nonce session
}
window.addEventListener('beforeunload', detach)
```

`cleanup()` is idempotent and best-effort: repeated calls share one `DELETE`,
and a transport failure resolves to `{ released: false }` rather than throwing.
If you handed the session to `createEditor` (which releases on `destroy()` by
default via `sessionBinding.autoRelease`), `cleanup()` may report
`{ released: false }` — that is the editor having released it first, not an
error.

Note the two lifetimes are independent: releasing the nonce session does not
revoke the JWT. A one-time JWT is revoked by the *server* on its first verify,
so a second mount needs a fresh `openEmbedSession()` regardless.

## What the handshake guarantees

| Endpoint | Returns |
|---|---|
| `POST /api/v1/files/:id/jwt` | `{ token, exp, ttlSeconds, oneTime, jti? }` |
| `POST /api/v1/embed/nonce` | `{ sessionId, nonce, expiresAt, ttlMs }` |
| `POST /api/v1/embed/verify-nonce` | `{ valid: true }` or `{ valid: false, reason }` |
| `DELETE /api/v1/embed/nonce` | releases the session |

Three checks the host bridge enforces on every inbound message:

1. **`event.source === guestWindow`** — the iframe identity. Spoofed envelopes
   from a different iframe are dropped.
2. **`event.origin === expectedOrigin`** — the host's origin. Cross-origin
   envelopes are dropped.
3. **`envelope.sessionId === sessionId`** — every envelope carries the session
   id, and the bridge rejects anything with a different one. A second iframe in
   the same page can't impersonate this one.

## Reusing the SDK for file CRUD

Each capability is its own client class, all constructed from the same
`{ baseUrl, bearer }` config:

```ts
import { FileClient } from '@genoffice/web-sdk/file/management'
import { VersionsClient } from '@genoffice/web-sdk/file/versions'
import { CommentsClient } from '@genoffice/web-sdk/file/comments'
import { CallbackClient } from '@genoffice/web-sdk/file/callback'
import { TranslationClient } from '@genoffice/web-sdk/ai/translation'

const config = { baseUrl: '/office-engine', bearer: () => token }

const files = new FileClient(config)
await files.list()                                     // FileListEntry[]
await files.get(docId)                                 // FileMetadata
await files.create({ name: 'plan.docx', bytes })       // FileCreateResult
await files.delete(docId)                              // { ok: true, deleted }
files.getDownloadUrl(docId)                            // string (no request)

const versions = new VersionsClient(config)
await versions.list(docId)                             // { fileId, count, versions }
await versions.create({ fileId: docId, label: 'edit-1' })
await versions.restore(docId, vid)                     // positional id args
await versions.delete(docId, vid)

const comments = new CommentsClient(config)
await comments.list({ fileId: docId, resolved: false })
await comments.add({ fileId: docId, anchor, text })
await comments.patch({ fileId: docId, commentId: cid, resolved: true })

const callbacks = new CallbackClient(config)
await callbacks.register({ fileId: docId, url, events: ['file.saved'] })

const translations = new TranslationClient(config)
const stream = translations.translate({
  units: [{ unitId: 'u1', sourceText: 'Hello' }],
  targetLanguage: 'zh-CN',
})
stream.subscribe({
  next: (evt) => console.log(evt.type, evt),
  error: (err) => console.error(err),
  complete: () => console.log('done'),
})
// stream.requestId, await stream.cancel()
```

Two shape notes worth internalizing:

- **There is no `files.update`.** Replacing a document's bytes is
  create-a-new-file, or a version restore — not an in-place PUT.
- **`FileClient.create` takes bytes, not a path**, and the server caps the
  upload at 100 MiB. `VersionsClient` snapshots are capped at 16 MiB and come
  back base64-encoded through `get`.

## Common pitfalls

1. **Base URL mismatch** — every client and the iframe must point at the same
   `/office-engine`. If the iframe loads `https://genoffice.app/...` while the
   clients use `https://api.genoffice.app/...`, the `auth_token` cookie is
   stripped (different origin) and the bridge 401s immediately.
2. **`oneTime: true` token replay** — the JWT's `jti` is revoked on first
   verify. Reusing a URL loads a page whose bridge can't authenticate. Mint a
   fresh JWT per mount.
3. **Cross-origin iframe** — if the iframe is on a different origin from the
   host page, the parent cannot read `iframe.contentWindow` and the bridge
   cannot be installed at all. Same-origin proxying
   (`/office-engine` → web-server) is required.
4. **`event.source` is null in older Safari** — `installDataflareHostBridge`
   does a strict `event.source !== guestWindow` comparison, so a null source is
   dropped rather than falling back to origin-only matching. If you need to
   support pre-15 Safari, don't rely on this bridge.
5. **`sessionId` mismatch** — the value you pass to
   `installDataflareHostBridge` must be the same one you put in the URL via
   `buildDataflareEmbedUrl`. Don't reuse one across multiple iframes.
6. **Blank iframe + "Refused to display … in a frame because an ancestor
   violates the following Content Security Policy directive: frame-ancestors
   'self'"** — `EMBED_FRAME_ANCESTORS` doesn't list your host origin. This is
   the most common cross-origin failure and it produces no server-side log
   line: the engine served a perfectly good 200 and the *browser* discarded
   it. See [Framing the editor](#framing-the-editor).

## Not built yet

Stated plainly so nobody plans around them:

- **A Dataflarework sample app.** The plan referenced
  `apps/docs/src/renderer/samples/dataflarework-host.tsx`; that file does not
  exist in the tree.

## Where to read more

- [Embed Session (one call)](./dataflarework-embed-session.md) — the
  `openEmbedSession()` guide: what it does step by step, the `autoRelease`
  interaction, and the error/retry matrix
- [Embed Session API](../api/sdk-embed-session.md) — every option and return
  type
- [SDK Verification](./sdk-verification.md) — the `npm run verify:sdk`
  contract gate, and what it deliberately does not cover
- [Auth Model](../architecture/auth-model.md) — the two gates, `WEB_TOKEN` transports, and
  `createAuthedClient()`
- [AI Routing](../architecture/ai-routing.md) — provider selection + audit log
- SDK source — `apps/sdk/src/{dataflare,file,ai,auth,collab}/*.ts`

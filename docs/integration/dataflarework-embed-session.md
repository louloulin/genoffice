# Embed Session (one call)

`openEmbedSession()` mints everything an embedded editor needs — a
file-scoped JWT, a handshake nonce, and the iframe URL — in one call. Use it
instead of hand-assembling the handshake described in the
[Dataflarework Quick Start](./dataflarework-quickstart.md).

```ts
import { createEditor } from '@genoffice/web-sdk'
import { openEmbedSession } from '@genoffice/web-sdk/file/embed'

const session = await openEmbedSession({
  baseUrl: '/office-engine',
  documentId: knowledgeId,
  bearer: () => localStorage.getItem('genoffice-jwt') ?? '',
})

const editor = createEditor({
  host: window.location.origin,
  documentId: knowledgeId,
  app: 'docs',
  jwt: session.jwt,
  container: '#editor',
  // autoRelease defaults to true → createEditor releases the nonce on destroy().
  sessionBinding: { sessionId: session.sessionId, nonce: session.nonce },
})
```

That is the whole integration. The rest of this page is the details you need
when something goes wrong.

## What the call does

Four steps, in a fixed order. Each reuses an existing capability client — no
new transport, no hidden HTTP client.

| # | Request | Scope | Returns |
|---|---|---|---|
| 1 | `POST /api/v1/files/:id/jwt` | `files:read` | `{ token, exp, ttlSeconds, oneTime, jti? }` |
| 2 | `POST /api/v1/embed/nonce` | `files:read` | `{ sessionId, nonce, expiresAt, ttlMs }` |
| 3 | `POST /api/v1/embed/verify-nonce` | `files:read` | `{ valid: true }` or `{ valid: false, reason }` |
| 4 | *(local)* `buildDataflareEmbedUrl(...)` | — | the iframe URL |

Step 3 is skippable with `verifyNonce: false`. It is **non-consuming**: only
`DELETE` evicts a session, so verifying before mounting does not burn the
nonce. Leave it on — it turns a failed handshake into an immediate, local
error instead of a blank iframe.

`baseUrl` must be the same origin the iframe will load from. A mismatch
between the two strips the `auth_token` cookie and the bridge 401s.

## The `autoRelease` interaction

This is the one thing that bites people. `createEditor` releases the
server-side nonce session when you call `destroy()` **by default**, because
`sessionBinding.autoRelease` defaults to `true`.

| Your setup | Who releases | `cleanup()` returns |
|---|---|---|
| `sessionBinding` set, `autoRelease` omitted/`true` (default) | `createEditor` on `destroy()` | `{ released: false }` — harmless |
| `sessionBinding: { …, autoRelease: false }` | you, via `session.cleanup()` | `{ released: true }` (first call) |
| You mount your own `<iframe>` without `createEditor` | you, via `session.cleanup()` | `{ released: true }` (first call) |

`cleanup()` is idempotent and best-effort: repeated calls share one promise
and issue one `DELETE`, and a transport failure resolves to
`{ released: false }` rather than throwing. So calling it defensively is
safe even in the default case — you just get a `false`.

Note the two lifetimes are **independent**. Releasing a nonce session does not
revoke the JWT, and a `oneTime: true` JWT is revoked by the *server* on its
first verify. A remount needs a fresh `openEmbedSession()` regardless.

## Errors and retry

`openEmbedSession` throws `RequestError` with a `.code`:

| `code` | Trigger | Retry? |
|---|---|---|
| `INVALID_ARGUMENT` | missing/blank `baseUrl` or `documentId` | no — fix the call |
| `UNAUTHENTICATED` | 401 from either mint | no — refresh the bearer, then re-call |
| `FORBIDDEN` | 403 — the bearer lacks `files:read` | no — fix the scope, then re-call |
| `NETWORK` | transport failure | **yes** |
| `INTERNAL` | 5xx | **yes** |
| `EMBED_NONCE_INVALID` | `verify-nonce` answered `valid: false` | **no** — the nonce is already spent |

`isRetryable(code)` encodes the last column, so callers don't have to
hard-code the table:

```ts
import { isRetryable } from '@genoffice/web-sdk/file/embed'

try {
  session = await openEmbedSession(opts)
} catch (err) {
  if (err.code && isRetryable(err.code)) { /* back off and retry */ }
  throw err
}
```

A failed verification **releases the session it just minted** before
throwing, so a tampered handshake never leaves a live nonce sitting in the
server's LRU for its full TTL.

## Options

| Option | Default | Notes |
|---|---|---|
| `baseUrl` | — | **required**; trailing slashes are stripped |
| `documentId` | — | **required**; also the subject of the JWT mint |
| `app` | `'docs'` | `docs` / `sheets` / `slides` / `pdf` / `markdown` / `html` |
| `bearer` | — | a string or a `() => string \| Promise<string>` |
| `fileId` | `documentId` | set when the doc id and the stored file id differ |
| `ttlSeconds` | server (`3600`) | 30 … 86400; validated locally, no round-trip on failure |
| `oneTime` | `false` | single-use JWT, revoked on first verify |
| `nonceTtlMs` | server (`300_000`) | server caps at 1 h |
| `readonly` / `locale` / `theme` | — | passed through to the URL (`readonly` / `lang` / `theme`) |
| `verifyNonce` | `true` | the round-trip in step 3 |
| `fetch` / `timeoutMs` / `signal` | — | standard request knobs |
| `buildUrl` | `buildDataflareEmbedUrl` | replace the URL builder wholesale |

`app` and `readonly` reach the iframe; `locale` maps to the `lang` query
param and `theme` to `theme`.

## Mounting your own iframe

If you don't want `createEditor` to own the DOM, skip it — `openEmbedSession`
already returned a ready URL. `buildDataflareEmbedUrl` produces:

```
{baseUrl}/apps/{app}/embedded?embed=1&app=…&doc=…&jwt=…&sessionId=…&nonce=…
```

Pass that to your own `<iframe>` and mount
`installDataflareHostBridge` against its `contentWindow`. The cleanup
contract is then yours alone: `await session.cleanup()` on unmount.

Cross-origin framing still needs `EMBED_FRAME_ANCESTORS` on the web-server
and `frame-src` on your host — see
[Framing the editor](./dataflarework-quickstart.md#framing-the-editor).

## Verifying it against a real server

The mocked unit tests cannot catch a drifted contract here. Run the live
contract gate before you wire this into a host:

```bash
npm run verify:sdk
```

See [SDK Verification](./sdk-verification.md) for what the probe covers and
what it deliberately does not.

## Where to read more

- [Embed Session API reference](../api/sdk-embed-session.md) — every option,
  the return type, the sub-path import
- [Dataflarework Quick Start](./dataflarework-quickstart.md) — the host
  bridge, CSP framing, file CRUD
- [Auth Model](../architecture/auth-model.md) — the two gates and how to mint
  a bearer
- [SDK Verification](./sdk-verification.md) — the contract gate

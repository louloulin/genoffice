# Embed Session API

Reference for `openEmbedSession()` and the `EmbedSession` it returns.

- **Added in** `@genoffice/web-sdk` 0.9.0-beta.1
- **Sub-path** `@genoffice/web-sdk/file/embed`
- **Also exported from** the package root (`@genoffice/web-sdk`)
- **Zero dependencies**

```ts
import { openEmbedSession, isRetryable } from '@genoffice/web-sdk/file/embed'
import type { EmbedSession, EmbedSessionOptions } from '@genoffice/web-sdk/file/embed'
```

The sub-path import is the recommended one: it keeps the Dataflare host
bridge (and its UMD bundle) out of a bundle that only needs to mint a
session.

## `openEmbedSession(options): Promise<EmbedSession>`

### `EmbedSessionOptions`

| Field | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | `string` | — | **required.** Web-server base, e.g. `/office-engine`. Trailing slashes stripped. |
| `documentId` | `string` | — | **required.** Trimmed; blank values are rejected locally. |
| `app` | `string` | `'docs'` | Trimmed; a blank value falls back to `docs`. |
| `bearer` | `string \| () => string \| Promise<string>` | — | Reaches all three requests. Needed for `files:read`. |
| `fileId` | `string` | `documentId` | Subject of `POST /api/v1/files/:id/jwt`. |
| `ttlSeconds` | `number` | server default (`3600`) | `30 … 86400`. Out-of-range rejects locally with `INVALID_ARGUMENT` — no round-trip. |
| `oneTime` | `boolean` | `false` | Single-use JWT; the server revokes the `jti` on first verify. |
| `nonceTtlMs` | `number` | server default (`300_000`) | Server caps at 1 h. |
| `readonly` | `boolean` | — | URL param `readonly`. |
| `locale` | `string` | — | URL param `lang`. |
| `theme` | `'light' \| 'dark' \| 'system'` | — | URL param `theme`. |
| `verifyNonce` | `boolean` | `true` | Round-trip the minted pair through `verify-nonce`. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Injected for tests / custom transports. |
| `timeoutMs` | `number` | — | Applied to the three requests. |
| `signal` | `AbortSignal` | — | Aborts the three requests. **Does not abort `cleanup()`** — see below. |
| `buildUrl` | `(input: DataflareEmbedUrlInput) => string` | `buildDataflareEmbedUrl` | Replace the URL builder wholesale. |

`app`, `readonly`, `locale` and `theme` are the only fields that reach the
URL. Everything else selects or authenticates the session.

### `EmbedSession`

```ts
interface EmbedSession {
  url: string            // iframe URL, credentials included — treat as a secret
  jwt: string            // file-scoped JWT
  jwtExp: number         // unix seconds
  sessionId: string
  nonce: string
  expiresAt: number      // unix milliseconds
  cleanup(): Promise<{ released: boolean }>
}
```

`url` carries the JWT, `sessionId` and `nonce` as query parameters. Do not
log it, and do not put it in an analytics payload.

### `cleanup()`

Evicts the server-side nonce session via `DELETE /api/v1/embed/nonce`.

- **Idempotent** — every call returns the same promise; one `DELETE` total.
- **Best-effort** — a transport failure or a 5xx resolves to
  `{ released: false }`, never throws.
- **Ignores `options.signal`** deliberately. `cleanup()` is exactly the call
  that must still run when the caller aborted, since that is when a nonce is
  most likely orphaned.

If you passed the session to `createEditor` without
`autoRelease: false`, the editor releases it on `destroy()` and your call
reports `{ released: false }`. That is expected, not an error — see
[the `autoRelease` interaction](../integration/dataflarework-embed-session.md#the-autorelease-interaction).

## `isRetryable(code): boolean`

```ts
import { isRetryable } from '@genoffice/web-sdk/file/embed'

isRetryable('NETWORK')             // true
isRetryable('INTERNAL')            // true
isRetryable('EMBED_NONCE_INVALID') // false — the nonce is already spent
isRetryable('FORBIDDEN')           // false
```

True only for `NETWORK` and `INTERNAL`. Every other code needs a change
before a retry can succeed: a new bearer, a fixed scope, different arguments.

## Errors

All failures are a `RequestError`:

```ts
class RequestError extends Error {
  readonly code: RequestErrorCode
  readonly status: number
  readonly channel: string
  readonly detail: unknown
}
```

| `code` | `channel` | Trigger |
|---|---|---|
| `INVALID_ARGUMENT` | `file:embed:open` | missing `baseUrl` / `documentId` |
| `INVALID_ARGUMENT` | `files:jwt` / `embed:nonce` | `ttlSeconds` / `nonceTtlMs` out of range |
| `UNAUTHENTICATED` | `files:jwt` / `embed:nonce` | 401 |
| `FORBIDDEN` | `files:jwt` / `embed:nonce` | 403 — bearer lacks `files:read` |
| `NOT_FOUND` | `files:jwt` | 404 — the file for `fileId` does not exist |
| `NETWORK` / `INTERNAL` | any | transport failure / 5xx |
| `EMBED_NONCE_INVALID` | `file:embed:open` | `verify-nonce` returned HTTP 200 with `{ valid: false }` |

### `EMBED_NONCE_INVALID` is the one to watch

`POST /api/v1/embed/verify-nonce` answers **200** for both outcomes:

```json
{ "valid": true,  "expiresAt": 1750000000000 }
{ "valid": false, "reason": "expired" }
```

Any `response.ok`-based success check treats a rejected handshake as a
success. `openEmbedSession` compares `valid === true` and raises
`EMBED_NONCE_INVALID` (`reason` is `'unknown'` or `'expired'`) otherwise.
Before throwing it releases the session it minted, so a failed handshake
leaves no live nonce behind.

Nonce verification is **non-consuming** — only `DELETE` evicts — so you can
verify the pair as many times as you like before the iframe mounts.

## Handoff to `createEditor`

```ts
const editor = createEditor({
  host, documentId, app: 'docs', jwt: session.jwt, container: '#editor',
  sessionBinding: { sessionId: session.sessionId, nonce: session.nonce },
})
```

`createEditor` extends the iframe URL with `?sessionId=…&nonce=…` when
`sessionBinding` is present, and validates both fields eagerly —
`createEditor: sessionBinding.nonce required when sessionBinding is set` is a
configuration error, not a network one.

## See also

- [Embed Session guide](../integration/dataflarework-embed-session.md)
- [SDK TypeScript reference](./sdk-typescript.md)
- [REST API v1](./rest-api.md)

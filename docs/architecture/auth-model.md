# Auth Model

GenOffice web-server has **two independent auth gates**. "Independent" is the
load-bearing word: they are not alternatives to each other, and satisfying one
does not satisfy the other. A third-party integration that misses this
distinction sees a 401 with no actionable error, which is why this page exists.

## TL;DR

| Gate | Env | What it protects | Transport | Enforced |
|---|---|---|---|---|
| **Gate 1 — shared secret** | `WEB_TOKEN` | every `/api/*` request, minus the public allowlist | `Authorization: Bearer`, `X-GenOffice-Token`, `auth_token` cookie, `?token=` | globally, in `src/index.ts` before dispatch |
| **Gate 2 — JWT + scope** | `GENOFFICE_JWT_SECRET` (or `GENOFFICE_JWT_ALG=RS256` + keys) | per-channel, only channels that declare a `scope` | `Authorization: Bearer <jwt>` | inside each dispatcher, via `requireScopeFromHeaders` |

- **Gate 1 unset ⇒ gate 1 is a no-op.** That is the desktop / e2e / dev
  posture: no `WEB_TOKEN`, everything under `/api/*` is accepted.
- **Gate 1 set ⇒ every non-allowlisted `/api/*` request must carry the secret**,
  *in addition to* whatever Gate 2 wants. A valid JWT does not substitute for
  the shared secret, and the shared secret does not substitute for a JWT.
- **Gate 2 is per-channel.** A channel with no `scope` annotation never
  consults a JWT at all. Gate 1 is the only thing standing in front of it.

The single exception list is `isPublicApiPath` (`apps/web-server/src/auth/index.ts`):

```
/health, /api/channels, /api/v1/health, /api/v1/changelog
/api/html/preview/*            (prefix)
```

These bypass **Gate 1**. They are not a general-purpose bypass — a public path
that also has a scope annotation still has Gate 2 applied.

## Gate 1 — `WEB_TOKEN`

```
WEB_TOKEN=<32+ char secret>
```

The shared secret is accepted through **four** transports, and the same value
is compared in each:

| Transport | Why it exists |
|---|---|
| `Authorization: Bearer <token>` | normal API consumers |
| `X-GenOffice-Token: <token>` | `EventSource` strips `Authorization` on cross-origin |
| `Cookie: auth_token=<token>` | browsers auto-attach it to every same-origin request; the only transport that works for an iframe whose code can't set headers |
| `?token=<token>` | curl / non-browser clients, older `EventSource` paths |

When the server serves **HTML** on a `WEB_TOKEN`-configured boot it stamps the
cookie on the response — but only if the request itself carried the secret.
An anonymous `GET /docs/` gets the page with no token in it:

```
Set-Cookie: auth_token=<urlencoded>; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800
```

The cookie value is only accepted when it decodes to the env secret, so a
forged cookie is just another 401. That rule protects what the server
*accepts*; it says nothing about what the server *hands out*, which is the
other half. The same request check gates the readable
`<meta name="genoffice-token">` the renderer reads its credential from, and the
`/embed/:docId` wrapper's cookie. It matters because `/docs/` is not under
`/api/`, so Gate 1 never sees it: without the check, an anonymous page load
returned the operator secret to anyone who could reach the port. A reverse
proxy that injects `X-GenOffice-Token` (as Dataflarework does on every
`/office-engine/**` request) satisfies the check transparently.

### Configuration knobs

| Env | Default | What |
|---|---|---|
| `WEB_TOKEN` | unset | The secret. Unset ⇒ Gate 1 is a no-op. |
| `HOST` | `127.0.0.1` | The bind address (`src/common/paths.ts`). `0.0.0.0` exposes everything on the LAN — pair it with `WEB_TOKEN`. |
| `PORT` | `18081` | The listen port. |

There is no `WEB_PUBLIC_PATHS` knob — the allowlist is hardcoded in
`isPublicApiPath`.

### What a Gate-1 rejection looks like

`writeUnauthorized()` emits this, with a `WWW-Authenticate: Bearer
realm="genoffice-web-server"` header:

```json
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": { "code": "UNAUTHORIZED", "message": "Missing or invalid token for /api/ipc/files:read" }
}
```

A **Gate-2** rejection has a different code (`UNAUTHENTICATED` for a missing
Bearer, `FORBIDDEN` for an insufficient scope) and carries the channel name.
Distinguishing the two codes is the fastest way to tell which gate you tripped.

## Gate 2 — JWT + scope

```
GENOFFICE_JWT_SECRET=<hmac secret>            # HS256 (default)
GENOFFICE_JWT_ALG=RS256 + key pair            # RS256
```

Tokens are minted by `POST /api/v1/auth/jwt` (`handleAuthJwt`,
`src/api/v1/auth.ts`). The request body accepts:

| Field | Rule |
|---|---|
| `sub` | required, non-empty after trim (whitespace-only is rejected) |
| `doc` | optional single-document binding |
| `scope` / `perm` | optional; both must be arrays of non-empty strings |
| `exp` | optional absolute epoch seconds |
| `ttl` | optional relative seconds; **wins over `exp` when both are sent** |

`ttl` is clamped to `[30, 86400]` rather than rejected, so a typo can't mint an
eternal token — but note this means a caller asking for `ttl: 5` silently gets
`30`. An absent or empty `scope` is read as read-only (`files:read`).

The response is:

```json
{ "token": "eyJhbGciOi…", "exp": 1758900000, "ttlSeconds": 3600, "alg": "HS256" }
```

### Minting

```bash
curl -X POST http://localhost:18081/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <WEB_TOKEN, if Gate 1 is on>' \
  -d '{"sub":"user-123","scope":["files:read","files:write"],"ttl":3600}'
```

There is **no `?discover=true` mode.** To find the scopes the server knows
about, read the channel registry through `/api/channels` and look at each
entry's `scope` field.

### Scope gating (soft vs hard)

Scopes are declared per channel in the registry. A leading `soft:` prefix
changes the enforcement policy (`src/index.ts`):

| Declaration | No `Authorization` header | With `Authorization` header |
|---|---|---|
| `files:read` (hard) | **401 UNAUTHENTICATED** | gate enforced |
| `soft:marketplace:install` (soft) | falls through to Gate 1 only | gate enforced |

Soft scopes exist so renderer-driven UI channels (marketplace install, user
preferences, update checks) can advertise a scope without forcing every
renderer IPC call to mint a JWT. **Soft scopes are still enforced for every
authenticated caller** — the prefix only relaxes the "you must present a
Bearer at all" requirement.

### Route table

Gate 2 applies only to routes whose channel declares a scope. The route groups
that exist today:

| Route | Method | Required scope |
|---|---|---|
| `/api/v1/health`, `/api/v1/changelog` | GET | none — also on the public allowlist |
| `/api/v1/metrics`, `/api/v1/meta` | GET | **none** — Gate 1 only (see note) |
| `/api/v1/auth/jwt`, `/api/v1/auth/oauth/token` | POST | mint endpoints |
| `/api/v1/files` | GET | `files:read` |
| `/api/v1/files` | POST | `files:write` |
| `/api/v1/files/:id` | GET | `files:read` |
| `/api/v1/files/:id` | DELETE | `files:delete` |
| `/api/v1/files/:id/jwt` | POST | `files:read` |
| `/api/v1/files/:id/callback` | POST | `files:write` |
| `/api/v1/files/:id/versions[/:vid]` | GET | `files:read` |
| `/api/v1/files/:id/versions` | POST | `files:write` |
| `/api/v1/files/:id/versions/:vid[/restore]` | POST / DELETE | `files:restore` |
| `/api/v1/files/:id/comments[/:cid]` | GET | `files:read` |
| `/api/v1/files/:id/comments[/:cid]` | POST / PATCH / DELETE | `files:comment` |
| `/api/v1/ai/capabilities` | GET | `ai:read` |
| `/api/v1/ai/chat` | POST | `ai:chat` |
| `/api/v1/ai/translate` | POST | `ai:translate` |
| `/api/v1/ai/image` | POST | `ai:image` |
| `/api/v1/ai/skill/:skill` | POST | `ai:skill` |
| `/api/v1/kb/search`, `/api/v1/kb/entries` | GET | `kb:read` |
| `/api/v1/webhooks` | POST / DELETE | `webhooks:manage` |
| `/api/v1/webhooks/dlq/*` | GET | `webhooks:manage` |
| `/api/v1/callbacks` | POST | `admin` |
| `/api/v1/embed/nonce`, `/api/v1/embed/verify-nonce` | POST / DELETE | `files:read` |
| `/api/ipc/*` | POST | the channel's own `scope`, else Gate 1 only |

These are the scopes the handlers actually pass to `requireScopeFromHeaders` —
a JWT carrying `files:read` will **not** open `/api/v1/ai/chat`, and there is no
implicit scope inheritance beyond the `*` / `action:*` wildcards.

> **`/api/v1/metrics` and `/api/v1/meta` declare no scope.** They are the
> exception in the table: with `WEB_TOKEN` unset they are fully open, and with
> it set they need only the shared secret. Both leak operational detail —
> per-tenant audit record counts and queue depths in the Prometheus exposition,
> and the server/SDK/protocol versions in `/api/v1/meta`. If your deployment is
> not already behind a private network, set `WEB_TOKEN`.

There is no `/api/v1/agents/*` route group and no `/api/v1/translate/*` group.
Agent-shaped work goes through `/api/v1/ai/chat`; translation through
`/api/v1/ai/translate`. There is no `/api/v1/settings/ai` and no
`/api/v1/audit` REST route — both are IPC-only (see
[AI Routing](./ai-routing.md)).

### Revocation

Revocation is **IPC-only**. There is no `POST /api/v1/auth/jwt/revoke`.

| Channel | Scope | Effect |
|---|---|---|
| `auth:revoke-jti` | `auth:rotate` | adds a `jti` to the admin revocation registry |
| `auth:list-revoked-jtis` | `auth:read` | reads it back (paged via `limit` / `offset`) |

`verifyJwtWithRevocation` (`src/api/v1/auth.ts`) consults both the admin
registry and a file-scoped hook installed by `src/api/v1/files.ts`. The
file-scoped hook auto-revokes a token on first verify when it was minted with
`oneTime=true`, which is what makes an embed URL single-use.

## IPC session ID

Both gates share the SSE session header:

```
X-IPC-Session: <id>
```

The renderer opens `/api/ipc/events/<sessionId>` to subscribe to server-pushed
events, and the embed bridge forwards the same header on the iframe's behalf
(`src/embed/bridge.ts`). The session id is not a credential — `/api/ipc/events/*`
is **not** on the public allowlist, and requests to it are subject to both
gates like any other `/api/*` path.

## Common pitfalls

1. **Both env vars set, so you send one credential.** Gate 1 and Gate 2 are
   cumulative, not alternative. A request needs the `WEB_TOKEN` transport
   *and* — if the target channel declares a scope — a Bearer JWT. The common
   failure is minting a perfectly good JWT and then getting `UNAUTHORIZED`
   from Gate 1 because the shared secret was never sent.
2. **`Authorization: Bearer` over 4096 chars** — rejected before the
   signature check (B.9). Shorten the `scope` array or the subject claim. This
   also means a very long token fails identically to a malformed one, so check
   the length before debugging the signature.
3. **Expecting a 401 from `/api/ipc/events/<sessionId>` and not getting one.**
   In the default (no `WEB_TOKEN`) posture there is no gate at all, so the SSE
   stream is open. If you need it closed, set `WEB_TOKEN` — the session id is
   not a credential and the path is not allowlisted.
4. **iframe inside `WEB_TOKEN` mode** — the bridge in `/embed/<docId>` relies
   on the `auth_token` cookie, which only travels same-origin. Load the iframe
   cross-origin and the cookie is stripped, so the bridge 401s immediately.
   Same-origin proxying (e.g. `/office-engine` → the web-server) is required.
5. **Revoked one-time token on second view** — `/api/v1/files/:id/jwt?oneTime=true`
   mints a token revoked on first verify. Embedding the URL twice fails the
   second view with `EMBED_JWT_REVOKED`. Mint a fresh session per mount.
6. **Embed 401 codes are distinct (B.12)** — a rejected embed token reports
   *why*:

   | code | meaning | remedy |
   |---|---|---|
   | `EMBED_JWT_EXPIRED` | signature valid, `exp` in the past | refresh the token |
   | `EMBED_JWT_REVOKED` | signature valid, `jti` on a revocation list | mint a new session |
   | `EMBED_JWT_INVALID` | malformed, wrong `alg`, or bad signature | fix the token source |

   The signature is always verified *before* `exp` is read, so a forged token
   with a past `exp` reports `EMBED_JWT_INVALID` — it can't disguise itself as
   a benign expiry.
7. **Blank cross-origin iframe, no server log** — `/embed/<docId>` sends
   `Content-Security-Policy: frame-ancestors …` from the
   `EMBED_FRAME_ANCESTORS` env var, defaulting to `'self'`. A host on another
   origin is blocked until its origin is listed. The server logs a 200, so
   there is nothing to find server-side. See [Framing the
   editor](../integration/dataflarework-quickstart.md#framing-the-editor).
8. **Dataflare backend → GenOffice service-to-service calls 401 the moment
   you arm `WEB_TOKEN`.** The browser / iframe path is fine — Dataflarework's
   `OfficeEngineProxyController` injects `X-GenOffice-Token: <operator>` on
   every `/office-engine/**` outbound request, so GenOffice sees the operator
   secret and Gate 1 accepts. The backend → backend path (`GenOfficeTranslationTools
   .postTranslate` → `POST /api/ai/translate`) does **not** go through the
   proxy: it is a plain `java.net.http.HttpClient` call that sets only
   `Content-Type` / `Accept`. With `WEB_TOKEN` unset the call works because
   Gate 1 is a no-op; the instant `WEB_TOKEN` is armed, every such call 401s
   and the GenOffice-driven translation path silently breaks. The fix lives
   in Dataflarework (forward `properties.webToken` on `postTranslate` the
   same way the proxy does), not here. Symptom: log line
   `GenOffice 翻译调用失败:status=401 body={"error":{"code":"UNAUTHORIZED",…}}`.

## What runs in the SDK

`@genoffice/web-sdk` ships `createAuthedClient()`
(`apps/sdk/src/auth/client.ts`) to pick a bearer for you:

```ts
import { createAuthedClient } from '@genoffice/web-sdk/auth/client'

// Gate 1 only — you already hold the shared secret.
const cookieAuth = await createAuthedClient({
  baseUrl: 'https://genoffice.example',
  webToken: process.env.WEB_TOKEN,
})

// Gate 1 + Gate 2 — mint a JWT at boot and cache it.
const jwtAuth = await createAuthedClient({
  baseUrl: 'https://genoffice.example',
  mint: { sub: 'host-app', scope: ['files:read'] },
  ttlSeconds: 3600,
})
```

The two options are **mutually exclusive in effect**: if `webToken` is a
non-empty string the client returns `mode: 'web-token'` and never mints;
otherwise `mint` is required and the client returns `mode: 'jwt'`. Passing
neither throws
`createAuthedClient: either \`webToken\` or \`mint\` is required`. There is no
`WWW-Authenticate` discovery probe — the client does not interrogate the
server, it branches on the options you gave it.

The returned object is:

```ts
interface AuthedClient {
  mode: 'web-token' | 'jwt'
  bearer: () => string            // synchronous, drop into any capability client
  refresh(): Promise<string>      // re-mint (no-op in web-token mode)
  last: MintResult | null         // the mint result, so you can read exp / alg
}
```

Note the trade-off: choosing `webToken` satisfies **Gate 1 only**. If the
channel you're calling also declares a scope, a `web-token` client will still
be rejected — that case needs the `mint` form. See
[Dataflarework Quick Start](../integration/dataflarework-quickstart.md) for
the embed handshake built on top of this.

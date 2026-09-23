# Changelog

All notable changes to GenOffice are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Releases are tagged in git; the most recent tag is also the current
`@genoffice/*` package version on npm.

## [Unreleased]

### Fixed

- **comments `:id/comments` POST** — `parentId` must point to an existing
  comment on the same file; orphan replies are now rejected (400 / 404)
  instead of silently creating dangling pointers. (sdk1 §11.97)
- **webhooks `POST /api/v1/callbacks` (admin fire)** — failed deliveries
  are now pushed to the DLQ, mirroring the save-path behaviour.
  Previously admin-fired callbacks with 5xx receivers disappeared
  silently. (sdk1 §11.98)
- **KB `GET /api/v1/kb/search` / `/kb/entries`** — REST shim was
  dispatching to the wrong IPC handlers with mismatched field names
  (`{ term }` vs `{ query }`, `{ lang, domain }` vs `{ schema }`); every
  search returned `{ ok:false, error:"expected non-empty 'targetLang'" }`
  and `/entries` was silently no-op filtering. Now routed through
  `home:translate-kb-search` / `ai:translation-kb-list` with matching
  shapes and proper `limit` validation (1..1000 clamp + non-numeric 400).
  (sdk1 §11.100)
- **files `POST /api/v1/files/:id/callback`** — was silently registering
  per-file webhooks for nonexistent fileIds (returned `201 ok:true` even
  for `"nonexistent"`), creating dangling subscriptions that never fire.
  Now 404 NOT_FOUND on unknown fileId, mirroring the contract of
  `/files/:id/jwt`. (sdk1 §11.101)
- **AI `POST /api/v1/ai/translate` / `ai/image` REST ↔ IPC shape adapter**
  — both endpoints were forwarding the request body verbatim to the IPC
  layer, so the wrong field names caused two distinct silent-failure
  bugs:
  - `ai/translate` REST contract is `{ text, from?, to }` (host-friendly),
    but IPC `ai:translate` requires `{ instruction, sourceLang, targetLang, ... }`.
    Without the adapter the IPC rejected every call with
    `expected non-empty 'instruction'`, surfacing an internal IPC field
    name to hosts that follow the documented REST shape.
  - `ai/image` REST contract is `{ url }` (the IPC `ai:fetch-image`
    fetches an image FROM a URL and returns base64; it is not an
    image-generation endpoint). Without validation the handler forwarded
    the raw body, the IPC rejected non-string URLs as `null`, and the
    REST returned `{"null":null}` looking like success — the worst kind
    of silent failure.
  Now `handleAiTranslate` accepts both REST and IPC shapes and emits
  clean 400s on missing `text`/`to` with host-readable messages;
  `handleAiImage` validates `url` is a non-empty string ≤ 4096 chars
  before invoking `ai:fetch-image`. (sdk1 §11.103)
- **AI `POST /api/v1/ai/chat` / `ai/skill/:name` REST ↔ IPC shape adapter**
  — same bug class as §11.103. REST contract is OpenAI-style
  `{ messages: [{ role, content }] }` (host-friendly) but IPC
  `ai:chat` requires `{ settings, system, user }`. Without the adapter
  every chat / skill call returned
  `Invalid argument for 'ai:chat': expected { settings, system, user }`,
  leaking an internal IPC field name to hosts that follow the
  documented REST shape. Now both handlers route through a shared
  `adaptChatShape()` helper that converts OpenAI messages to IPC shape
  (concatenates `system` turns into one, takes the last `user` turn)
  while still accepting the IPC shape directly for renderer-internal
  callers. Missing/empty user message returns clean 400 INVALID_ARGUMENT
  instead of silent IPC rejection. (sdk1 §11.104)
- **`POST /api/v1/auth/jwt` whitespace-only `sub` accepted** — the
  validator only rejected empty string; `"   "` (3 spaces) and `"		"`
  were both accepted and minted JWTs with meaningless sub claims that
  surfaced as `"   "` in audit logs / event subscribers. Now uses
  `body.sub.trim().length === 0` for validation and stores the trimmed
  value in the JWT. (sdk1 §11.106)
- **`hasScope` not honoring documented `scope: 'admin'` bypass** — v1
  docs (`comments.ts:13`, `ai.ts:38`, `files.ts`, etc.) all advertise
  "Admins (`scope: 'admin'` or `*`) bypass scope checks" but the
  implementation only honored `sub === 'admin'`, `claim === '*'`, and
  `prefix:*` wildcards. Hosts that followed the documented convention
  got 403 on every admin-only endpoint (DELETE files, admin
  `callbacks:fire`, IPC handlers tagged `{ scope: 'admin' }`). Now
  `claims.includes('admin')` is also honored; `*` and `sub === 'admin'`
  continue to work as before. (sdk1 §11.106)
- **`POST /api/channels` and `GET /api/ai/pi-prompt` fell through to
  SPA HTML** — both endpoints had method gates that only matched their
  documented method; any other method (POST for channels, GET for
  pi-prompt) fell through to the SPA static fallback and returned
  `200 + <!doctype html>`. Host SDKs couldn't tell the difference
  between a successful render and a wrong-method request. Now both
  return 405 with a structured `{error:{code: 'METHOD_NOT_ALLOWED',
  message, channel, allow}}` envelope (allow field per RFC 7231). Also
  covers PUT/DELETE on both endpoints. (sdk1 §11.107)
- **`/api/ai/pi-prompt` error envelope inconsistent with v1** — error
  responses (`invalid JSON body`, `empty text`) returned
  `{ok:false, error: "pi-prompt: ..."}` while every other v1 + legacy
  REST endpoint uses `{error:{code, message, channel}}`. Host SDKs
  needed special-case branches for pi-prompt. Now aligned with the v1
  envelope (SSE happy-path stream events are unchanged — those use
  `{type:'error', message, requestId}` per SSE convention). (sdk1 §11.107)
- **`POST /api/ipc/:channel` non-array `args` returned 500 with internal
  JS error** — the handler cast `parsed.args ?? []` to `unknown[]` and
  immediately called `.map(...)`; a caller-supplied
  `{"args":"not-an-array"}` would throw `TypeError: args.map is not a
  function` and bubble up as 500 INTERNAL with an internal JS error
  message leaking implementation details. Now `args` is validated to be
  `undefined` or `Array.isArray()`; non-array values return a clean 400
  INVALID_ARGUMENT with the channel-bound envelope. (sdk1 §11.108)
- **`POST /api/collab/sessions` fell through to SPA HTML** — same
  pattern as the §11.107 fixes; only GET was matched, POST / PUT /
  DELETE returned `200 + <!doctype html>`. Now wrong-method requests
  return 405 with the structured envelope. (sdk1 §11.108)
- **`POST /api/v1/files/:id/jwt` malformed body silently succeeded with
  defaults** — the handler's `parseBody()` helper silently caught both
  JSON parse errors AND malformed form-encoded pairs and returned `{}`,
  so `not-json` / `{` / `ttlSeconds=60&malformed` all got 200 + a token
  with `ttlSeconds:3600, oneTime:false`. Host SDK bugs (typos, malformed
  JSON, double-encoding) silently produced tokens with all-default
  parameters. Now JSON parse errors throw `InvalidArgumentError`
  (`'request body is not valid JSON'`), form-encoded pair errors throw
  `'request body is not valid form data'`, both surface as 400 with the
  v1 envelope. Empty body (renderer-internal callers) still uses
  defaults — backwards compatible. (sdk1 §11.109)
- **`POST /embed/:docId` (and PUT / DELETE) fell through to SPA HTML**
  — the caller in `index.ts` only invoked `handleEmbed` for GET, so the
  405 path inside the handler was unreachable; non-GET requests got
  `200 + <!doctype html>`. Now the caller matches all methods and
  `handleEmbed` rejects non-GET with 405 + `allow:'GET'`. This is the
  fourth endpoint with the SPA-fallback-on-wrong-method pattern;
  `/embed/:docId` is the host-SDK mount point (§2.1.C), so this fix is
  critical for integrations that probe the endpoint with HEAD / OPTIONS
  / POST during setup. (sdk1 §11.109)
- **7 non-v1 / legacy REST endpoints returned 200 + HTML on wrong method
  instead of 405** — `POST /health`, `DELETE /health`,
  `PUT /api/ipc/events`, `GET /api/ai/stream`,
  `GET /api/ai/stream/cancel`, `GET /api/ai/translate`,
  `GET /api/ai/translate/stream`, `GET /api/ai/translate/stream/cancel`
  all fell through to the SPA-fallback handler because only the
  documented method was matched. Same SPA-fallback pattern as
  §11.107 / §11.108 / §11.109; the §11.110 fix adds an explicit
  `method !== allow → 405 + envelope` inner return to each handler,
  pinned by the new e2e. Host SDK endpoint enumeration that probes
  with the wrong method now correctly receives 405 instead of 200 +
  HTML. (sdk1 §11.110)
- **`POST /api/ipc/events` returned 404 `IPC_NO_HANDLER` instead of 405**
  — secondary bug found by the §11.110 sweep: the `/api/ipc/` POST
  catch-all in `index.ts` runs before the dedicated `/api/ipc/events`
  GET-only handler and shadows its 405 gate. POST `events` was
  interpreted as an IPC channel lookup; `events` has no handler so the
  catch-all returned 404 `{code:'IPC_NO_HANDLER'}`. The fix adds an
  explicit `if (url.pathname === '/api/ipc/events') { /* fall through */
  } else { … }` carve-out inside the catch-all so POST `events` reaches
  the dedicated handler below, where the 405 gate now fires correctly.
  This is the §11.110 double-closure: 7 wrong-method endpoints + 1
  secondary catch-all-shadowed endpoint. (sdk1 §11.110)
- **`/api/v1/*` wrong-method returned 404 `NOT_FOUND` instead of 405
  `METHOD_NOT_ALLOWED`** — the v1 dispatcher (`handleApiV1`) writes each
  handler as a literal `pathname === X && method === Y` test; when a
  request came in with the wrong method the dispatcher returned
  `false`, then the outer catch-all issued 404 NOT_FOUND regardless of
  whether the path existed at all. RFC 7231 requires 405 + `Allow:`
  for an existing path reached with the wrong method; 404 is reserved
  for paths that don't exist at any method. Roughly 30 v1 routes
  (`/api/v1/webhooks` × 3, `/api/v1/files`, `/api/v1/files/:id`,
  `/api/v1/files/:id/jwt`, `/api/v1/files/:id/callback`,
  `/api/v1/files/:id/comments`, `/api/v1/files/:id/comments/:cid`,
  `/api/v1/files/:id/versions`, `/api/v1/files/:id/versions/:vid`,
  `/api/v1/files/:id/versions/:vid/restore`, `/api/v1/ai/{chat,
  translate, image, capabilities, skill/:name}`, `/api/v1/kb/{search,
  entries}`, `/api/v1/auth/{jwt, oauth/token}`,
  `/api/v1/embed/{nonce, verify-nonce}`,
  `/api/v1/callbacks`, `/api/v1/{health, metrics, changelog, meta}`)
  were affected. The §11.111 fix adds an exported `v1Routes` table
  (`RegExp` pattern → documented methods[]) and a `findV1Route` helper
  in `apps/web-server/src/api/v1/index.ts`; the dispatcher catch-all
  consults it BEFORE falling through to 404 — a matching pattern +
  wrong method now returns 405 with `{code:'METHOD_NOT_ALLOWED',
  channel, allow: '<comma-separated methods>'}`; non-matching pattern
  keeps the existing 404. The pre-existing tests
  `api-v1-unknown-route-404-e2e.test.ts` and
  `v1-smoke-comprehensive-e2e.test.ts` were updated to assert 405 on
  wrong-method (their old 404 expectations were pinning the bug). The
  in-process unit test `api-v1-unknown-route-404.test.ts` is unchanged
  because `handleApiV1` itself still returns `false` for wrong-method;
  the dispatcher's 405 layer is what changed. (sdk1 §11.111)
- **`POST` / `PUT` / `DELETE` on `/api/v1/webhooks/dlq` returned 200 +
  the entries array instead of 405** — secondary bug found by the
  §11.111 sweep: `handleDlqList` was missing a method gate entirely.
  POST/PUT/DELETE fell through to `listDeadLetters({ limit })` and
  returned 200 with the entries. The fix adds a top-of-function
  `ctx.method !== 'GET'` gate returning 405 with the standard
  envelope (`allow: 'GET'`, `channel: ctx.pathname`); the collection
  is read-only. `handleDlqEntry` (which handles the `/dlq/:id[/replay]`
  sub-paths) already had a 405 catch-all — that catch-all was also
  upgraded to include an `allow` field keyed to the matched segment
  shape (`GET, DELETE` for `/dlq/:id`, `POST` for `/dlq/:id/replay`).
  This is the §11.111 double-closure: 30 routes dispatcher-level +
  1 route handler-level. (sdk1 §11.111)
- **`POST` / `PUT` / `DELETE` on `/api/html/preview/<id>` returned 200
  + HTML instead of 405** — §11.111 continuation: the caller-side
  `request.method === 'GET'` gate in `index.ts` meant non-GET requests
  silently fell through to the SPA static fallback (200 + `<!doctype
  html>`), exactly the same SPA-fallback-on-wrong-method pattern that
  §11.107 / §11.108 / §11.110 swept, but this pre-v1 legacy path was
  missed in those earlier rounds. The fix matches §11.109 embed
  pattern: caller-side gate relaxed so the handler block can decide
  whether to emit 405 (non-GET) or 200 (GET). The `/api/html/preview/*`
  handler now returns the standard envelope
  `{error:{code:'METHOD_NOT_ALLOWED', message:'GET required', channel,
  allow:'GET'}}` for non-GET methods. (sdk1 §11.111 continuation)
  This is the §11.111 triple-closure: 30 v1 dispatcher routes +
  1 dlq collection handler + 1 html/preview handler. (sdk1 §11.111)
- **`GET /api/v1/kb/search?q=<whitespace>` returned 200 + IPC-shape
  `{ok:false, error:'kb_search: \`query\` is required'}`** — the
  REST handler only checked `if (!q)` (truthy gate), so a whitespace-
  only query passed through to IPC which rejected it; the REST layer
  forwarded the IPC error envelope straight to the client at HTTP 200,
  violating the §11.0 REST envelope convention (a 200 must be a real
  success, not a contract-failed success that the SDK has to dig into
  the body to detect). The fix adds `q = qRaw?.trim() ?? ''` then
  `if (!q) → 400 "expected non-empty ?q= query parameter"` so empty /
  whitespace-only queries are rejected deterministically at the REST
  layer. Real searches with leading/trailing whitespace are now
  trimmed before delegation (`?q=  abc  ` becomes `q="abc"`) so the
  IPC layer never has to deal with the malformed input. This is the
  fourth `{ok:false}` IPC-shape leak closed across the sweep
  (§11.103 + §11.104 + §11.110 + §11.112). (sdk1 §11.112)
- **`POST` / `PUT` / `DELETE` / `PATCH` on SPA sub-routes (`/`,
  `/manage`, `/management`, `/docs/...`, `/sheets/...`, `/slides/...`,
  `/pdf/...`, `/markdown/...`, `/html/...`, `/shell/...`) returned 200
  + `index.html` instead of 405** — §11.112 continuation: the same
  SPA-fallback-on-wrong-method pattern that the §11.107 / §11.108 /
  §11.110 / §11.111 sweep was hunting. SPA sub-routes are HTML pages,
  which browsers only fetch with GET (or HEAD for resource discovery);
  the previous implementation let POST/PUT/DELETE/PATCH fall through
  to the static fallback which served `index.html` with status 200
  and Content-Type text/html. The fix adds a method gate at the
  top of the static-fallback section in `src/index.ts` that returns
  the standard envelope
  `{error:{code:'METHOD_NOT_ALLOWED', allow:'GET, HEAD', channel}}`
  for any non-GET/non-HEAD request before any HTML is served. The fix
  covers 11 SPA sub-routes × 4 wrong methods = 44 wrong-method cases.
  This is the §11.112 double-closure: 1 trim+IPC-shape-leak fix +
  1 SPA-fallback-405-gate fix. (sdk1 §11.112 continuation)
- **Webhook DLQ polluted by `events`-whitelist-filtered deliveries** —
  `deliverOne` early-returns `{attempts:0, delivered:false,
  lastStatus:null}` when the subscriber's `events` whitelist does not
  include the fired event (correctly expressing "not attempted — this
  subscriber opted out"), but `pushFailedDeliveriesToDlq` only checked
  `!r.delivered` and therefore wrote a dead-letter entry with
  `reason:'max_attempts', attempts:0, lastError:null` for every
  filtered-out event. These entries can never be replayed (the target
  URL is never touched for that event type by design), so they were
  pure noise that degraded the DLQ signal/noise ratio for hosts using
  `GET /api/v1/webhooks/dlq`. The fix adds an explicit
  `WebhookDeliveryResult.filtered?: boolean` discriminator (set to
  `true` on the whitelist early-return path) and changes the DLQ
  filter to `!r.delivered && !r.filtered`. The three states are now
  unambiguous: `delivered:true` = 2xx; `delivered:false,
  filtered:true` = never attempted (policy); `delivered:false,
  filtered:undefined` = real attempt failure (4xx/5xx/network). A
  boolean discriminator was chosen over an `attempts === 0` sentinel
  so future dead-letter replay work can classify cleanly. (sdk1 §11.113)
- **SECURITY — v1 `:id` path traversal → arbitrary file read** —
  every `:id` route in the v1 shim did `join(FILES_DIR, id)` on the
  percent-decoded path segment with no containment check. A
  percent-encoded traversal escaped managed storage and turned the
  version-history surface into an arbitrary-file-read primitive:
  `POST /api/v1/files/..%2Fwebhooks.json/versions` snapshotted
  `DATA_DIR/webhooks.json` (the webhook HMAC-secret store) into
  `DATA_DIR/versions/webhooks.json/1.bin`, and
  `GET /api/v1/files/..%2Fwebhooks.json/versions/v-webhooks.json-1`
  streamed those bytes back base64-encoded. `..%2F..%2F..%2Fetc%2Fhosts`
  reached outside `DATA_DIR` entirely. `POST /files/:id/jwt` and
  `POST /files/:id/callback` were affected identically (a JWT whose
  `doc` claim pointed outside storage; webhook registration for
  out-of-storage paths). The IPC surface already refused this via
  `requireManagedPath` (sdk1 §11.63); only the v1 REST shim bypassed
  it. Fixed with a `requireSafeId` / `isSafeFileId` guard on all 15
  handlers that consume an `:id`, using `isWithin(FILES_DIR, …)` —
  deliberately NOT `isManagedPath(…)`, which accepts the whole
  `DATA_DIR` and would have let the sibling stores (`webhooks.json`,
  `comments.json`, `webhooks-dlq.json`) through. The guard also rejects
  NUL bytes and whitespace-only ids (`%20` / `%09`), both of which had
  produced either an `ERR_INVALID_ARG_TYPE` 500 or a file literally named
  with spaces. (sdk1 §11.114)
- **v1 malformed percent-encoding leaked `500 {"error":{"message":"URI
  malformed"}}`** — `decodeURIComponent('%')` throws `URIError` in the
  dispatcher; the catch-all classified it as 500 with no `code` and no
  `channel`, violating the §2.1.A REST envelope convention (`GET
  /api/v1/files/%/comments` was the repro). Bad encoding is
  unambiguously the caller's fault. Fixed with a `safeDecode()` helper
  (returns `null` instead of throwing) plus a shared
  `sendBadEncoding()` that answers 400 `INVALID_ARGUMENT` with the
  standard envelope; all 16 `decodeURIComponent` call sites in the v1
  dispatcher now route through it, and `/files/:id` GET/DELETE decode
  before dispatch so traversals hit the containment guard rather than
  being treated as literal filenames (404). Same defect class already
  fixed for `/api/ipc/%` channels (§11.108) and `/api/html/preview/%`.
  (sdk1 §11.114)
- **SECURITY — `/api/v1/auth/jwt` minted an immortal token from
  `exp: 1e999`** — `JSON.parse` turns `1e999` into `Infinity`; the old
  lifetime check (`typeof body.exp === 'number' && body.exp > now`) accepted
  it, `JSON.stringify({exp: Infinity})` serialised it to **`exp: null`**,
  and `verifyJwt` only guards expiry when `typeof payload.exp === 'number'`
  — so a `null`-`exp` token **never expires**. Any `exp` was also unbounded
  above. Fixed by resolving lifetime from a documented `ttl` (relative
  seconds) or legacy `exp` (absolute), requiring `Number.isFinite`, and
  clamping to `[30, 86400]` seconds — a non-finite `exp` can never be
  minted, and every minted `exp` is a finite number that survives
  serialisation. (sdk1 §11.115)
- **`/api/v1/auth/jwt` mistyped `scope`/`perm`/`doc`** — three related
  validation gaps on the same endpoint:
  - `scope: 123` (or any non-iterable) threw
    `(body.scope ?? []) is not iterable`, surfaced as
    `500 {"error":{"message":"(body.scope ?? []) is not iterable"}}` —
    an internal JS runtime string leaked as the API error message
    (violates sdk1 §2.1.A).
  - `scope: "admin"` was silently split into `['a','d','m','i','n']`,
    minting a 200 token whose scope claim matches nothing — a silent
    failure where the caller believes they granted admin.
  - `doc: 123` was signed verbatim, producing a spec-violating JWT whose
    `doc` claim is a number.
  All three are now 400 INVALID_ARGUMENT via an `isStringArray()` gate
  plus a `doc` type check; `null` is treated as "field not set" (JSON
  idiom) rather than an error. (sdk1 §11.115)
- **`hasScope` threw `500 claim.endsWith is not a function` on a token
  with a non-string scope claim** — a token minted before §11.115 landed
  (or hand-crafted) with `scope: [1,2,3]` crashed every scoped endpoint.
  `hasScope` now filters to string claims before matching; a garbage claim
  grants nothing (deny, never an accidental grant), so such a token simply
  gets a clean 403. (sdk1 §11.115)
- **`POST /api/v1/auth/jwt` ignored the documented `ttl` field** —
  `docs/api/rest-api.md` documents `{ "sub": "user-123", "ttl": 3600 }`,
  but the handler only read the legacy absolute `exp`, so `{ttl: 7200}`
  silently produced a 1-hour token. `ttl` is now the preferred field
  (clamped like `files/:id/jwt`), `exp` remains supported, and the
  response echoes `ttlSeconds` so hosts can confirm the effective
  lifetime. (sdk1 §11.115)
- **KB REST surfaced `200 {ok:false}` IPC-shape leaks for non-integer
  `limit` and unknown `schema`** — the v1 shim only checked `< 1` /
  non-numeric on `limit` and forwarded `schema` verbatim, so
  `?limit=1.5`, `?limit=101..1000` (REST clamped to 1000; IPC's real
  cap is 100), `?limit=1.5` on `/kb/entries`, and `?schema=nonsense`
  all produced `200` with the IPC's rejection envelope embedded
  (`{ok:false, error:"kb_search: `limit` must be an integer between 1
  and 100 (got 1.5)"}` etc.) — the §11.103/§11.112/§11.115 class
  where a 200 is not a real success and host SDKs can't see the
  failure. Fixed by aligning the REST clamp / validation with the IPC
  tool's actual contract (`Number.isInteger && n >= 1`, search clamp
  to 100, entries clamp to 1000) and validating `schema` against the
  five known keys; bad inputs now return 400 `INVALID_ARGUMENT` with
  the standard envelope. This closes the "clamp upper bound was
  guessed" gap that §11.100 left behind — REST and IPC now share the
  same upper bound. (sdk1 §11.116)

### Added

- **Test infrastructure** — `ServerHarness` picks a randomised
  ephemeral port (20000..50000) so 4+ bundle e2e can run in parallel
  without collision. (sdk1 §11.97)
- **e2e lifecycle coverage** — 3 new bundle-bootstrapping e2e files
  exercise the full v1 happy path + negative branches:
  - `tests/files-comments-versions-lifecycle-e2e.test.ts` (23
    assertions) — files / comments / versions full CRUD + scope gates
    + cleanup. (sdk1 §11.96)
  - `tests/webhooks-lifecycle-e2e.test.ts` (14 assertions) — webhook
    subscribe / fire / DLQ-on-failure / unsubscribe / idempotent
    re-delete, with in-test HTTP receiver. (sdk1 §11.98)
  - `tests/embed-nonce-lifecycle-e2e.test.ts` (13 assertions) — embed
    nonce mint / verify / release / verify-after-release / TTL clamp
    / scope gates. (sdk1 §11.99)
  - `tests/comments-parent-id-validation-e2e.test.ts` (6 assertions)
    — pins the orphan-reply boundary added by §11.97 fix above.
  - `tests/kb-search-lifecycle-e2e.test.ts` (11 assertions) — pins
    the search / entries contract added by §11.100 fix above.
  - `tests/files-callback-404-e2e.test.ts` (4 assertions) — pins
    the unknown-fileId boundary added by §11.101 fix above.
  - `tests/public-meta-lifecycle-e2e.test.ts` (5 assertions) —
    locks the content-type + body-shape contract of the public
    health / meta / changelog / metrics endpoints (§2.1.A).
    (sdk1 §11.102)
  - `tests/ai-translate-image-validation-e2e.test.ts` (16 assertions)
    — pins the REST ↔ IPC shape adapter + URL validator on
    `POST /api/v1/ai/translate` and `POST /api/v1/ai/image`. Covers
    REST shape happy path, IPC-shape compatibility, missing-field
    400s, invalid JSON, URL length cap, and JWT / scope gates.
    (sdk1 §11.103)
  - `tests/ai-chat-skill-shape-validation-e2e.test.ts` (16 assertions)
    — pins the OpenAI-style ↔ IPC `{settings, system, user}` shape
    adapter on `POST /api/v1/ai/chat` and `POST /api/v1/ai/skill/:name`.
    Covers REST happy path (single user, system+user), IPC-shape
    compatibility, missing/empty user → 400, invalid JSON, JWT / scope
    gates, and unknown-skill dispatch path. (sdk1 §11.104)
  - `tests/comments-versions-detail-e2e.test.ts` (16 assertions) —
    pins the wire-level contracts of `GET /api/v1/files/:id/comments/:cid`
    (single-comment), `PATCH /api/v1/files/:id/comments/:cid` (resolve
    toggle true/false), and `GET /api/v1/files/:id/versions/:vid`
    (single-version with bytes round-trip). Covers happy path,
    cross-file-id 404, unknown-id 404, missing/invalid body 400,
    JWT / scope gates. (sdk1 §11.105)
  - `tests/auth-scope-admin-bypass-e2e.test.ts` (9 assertions) —
    pins the §11.106 fixes: whitespace-only `sub` rejection (with
    trim-on-mint for `"  alice  "` → JWT `sub === "alice"`), and
    `scope: ['admin']` bypass for `DELETE /api/v1/files/:id` and
    every other admin-only endpoint. Regression coverage for `*`,
    `sub === 'admin'`, `files:write`-only (still 403 on delete), and
    empty-scope (default read-only). (sdk1 §11.106)
  - `tests/http-method-envelope-contract-e2e.test.ts` (9 assertions)
    — pins the §11.107 fixes: `/api/channels` + `/api/ai/pi-prompt`
    wrong-method 405 with `Allow` field, JSON Content-Type (NOT HTML),
    and pi-prompt error envelope aligned to v1 `{error:{code, message,
    channel}}`. Covers GET/POST/PUT branches on both endpoints +
    regression on `/api/ai/languages` (was already 405). (sdk1 §11.107)
  - `tests/ipc-args-collab-405-e2e.test.ts` (11 assertions) — pins
    the §11.108 fixes: `/api/ipc/:channel` `args` array validation
    (non-array → 400 INVALID_ARGUMENT with channel-bound envelope;
    was 500 INTERNAL leaking `args.map is not a function`), and
    `/api/collab/sessions` POST/PUT/DELETE → 405 (was 200 + HTML
    SPA fallback). Covers happy path (args: []/['x']/undefined),
    all non-array types (string/null/object/number), and the
    `/api/collab/sessions` method gate across GET/POST/PUT/DELETE.
    (sdk1 §11.108)
  - `tests/issue-jwt-embed-405-e2e.test.ts` (11 assertions) — pins
    the §11.109 fixes: `/api/v1/files/:id/jwt` malformed body
    (`not-json`, single `{`, form-encoded missing `=`) → 400
    INVALID_ARGUMENT (was 200 + all-defaults silent fallback); and
    `/embed/:docId` POST/PUT/DELETE → 405 (was 200 + HTML because
    caller-side `request.method === 'GET'` gate prevented the
    handler's 405 path from being reached). Covers happy paths for
    both endpoints (no body / valid JSON / valid form / GET HTML /
    bad-query JSON 400). (sdk1 §11.109)
  - `tests/legacy-endpoint-405-sweep-e2e.test.ts` (14 assertions) —
    pins the §11.110 fixes: walks wrong-method 405 + correct-method
    regression across the 7 endpoints (each tested with both its wrong
    method and its documented method). Wrong-method assertions cover
    `code='METHOD_NOT_ALLOWED'`, `allow` field, `channel` field, JSON
    `Content-Type`. Correct-method assertions verify the happy path is
    not 405 (SSE streams are checked for 200 / 400, never parsed for
    body shape — keeps the contract test independent of LLM / streaming
    behaviour). Final sweep of non-v1 REST IPC endpoint method-gate
    pattern. (sdk1 §11.110)
  - `tests/v1-wrong-method-405-sweep-e2e.test.ts` (96 assertions) —
    pins the §11.111 fixes: walks every documented v1 route (30
    distinct paths) with both a wrong-method probe (asserts 405 +
    `allow` field matching the documented methods + JSON
    `Content-Type` + `channel` field matching the full path) and a
    correct-method regression probe (asserts status not 405 and
    envelope `code` not `METHOD_NOT_ALLOWED` — resource-level 404 for
    paths like `/api/v1/files/<bad-id>` is allowed). Also asserts that
    a truly-unknown path (`/api/v1/this-route-totally-does-not-exist`)
    still returns 404 NOT_FOUND so the 4xx category split is enforced.
    Final sweep across all v1 routes; the `v1Routes` table in
    `apps/web-server/src/api/v1/index.ts` is the single source of
    truth for which methods each path documents, and any new route
    added without a corresponding `v1Routes` entry surfaces as a 404
    in this test. (sdk1 §11.111)
  - `tests/v1-input-validation-e2e.test.ts` (14 assertions) — pins
    the §11.112 fix: walks every documented v1 input path and
    asserts empty / whitespace-only inputs are rejected at the REST
    layer with a 400 INVALID_ARGUMENT / BAD_REQUEST envelope, NOT
    forwarded to IPC and surfaced as 200 + `{ok:false}` (which would
    be the §11.103-style IPC-shape leak). Coverage includes:
    `GET /api/v1/kb/search?q=` × 4 whitespace variants → 400; trimmed
    `?q=  abc  ` → 200 + entries (real searches unaffected);
    `?q=test&limit=0` → 400; `POST /auth/jwt` whitespace sub × 3 → 400;
    `sub:'  trim-me  '` → JWT signed with `sub='trim-me'` (verified by
    decoding the JWT payload); `POST /embed/nonce` empty / whitespace
    docId → 400; `POST /embed/verify-nonce {}` → 400 `sessionId and
    nonce required`; `oauth/token grant_type=password` → 400
    UNSUPPORTED_GRANT. Test uses literal whitespace characters (not
    URL-encoded) in JSON bodies to drive the trim gate. (sdk1 §11.112)
  - `tests/v1-wrong-method-405-sweep-e2e.test.ts` SPA fallback
    block (44 assertions) — pins the §11.112 continuation fix:
    walks the 11 SPA sub-routes (`/`, `/manage`, `/management`,
    `/docs`, `/docs/anything`, `/sheets/foo`, `/slides/bar`,
    `/pdf/baz`, `/markdown/qux`, `/html/doc`, `/shell/page`) with
    POST / PUT / DELETE / PATCH, asserting each combination returns
    405 with `{code:'METHOD_NOT_ALLOWED', allow:'GET, HEAD',
    channel=<full path>, JSON Content-Type}`. GET regression: each
    SPA sub-route GET must still serve the bundle (200 HTML). The
    SPA fallback is the same bug class as §11.107 / §11.108 / §11.109
    / §11.110 / §11.111 — wrong-method requests previously fell
    through to `index.html` with 200 + Content-Type text/html. (sdk1
    §11.112 continuation)
  - `tests/webhook-dlq-filtered-events-e2e.test.ts` (~14 assertions) —
    pins the §11.113 fix: 3 phases. Phase 0 asserts a fresh webhook
    DLQ starts empty. Phase 1 subscribes a reachable receiver with
    `events:['file.saved']`, fires `comment.added`, then asserts
    `deliveredCount:0` AND that the DLQ count did NOT grow (the
    filtered event must not enter the DLQ — this is the regression the
    fix targets). Phase 2 re-subscribes to an unreachable URL
    (`http://127.0.0.1:1/never-listening`) with `events:['file.saved']`,
    fires `file.saved`, polls the DLQ (up to 8s for backoff retries)
    and asserts: a new entry exists, it carries the correct
    event/url, `attempts >= 1` (real failed delivery, never 0),
    `reason:'max_attempts'`, and that no `comment.added` entry is
    present. (sdk1 §11.113)
  - `tests/v1-file-id-traversal-e2e.test.ts` (~40 assertions) — pins
    the §11.114 double-fix: 5 phases. Phase 1 asserts the four
    traversal `GET` routes (`/files/..%2Fwebhooks.json`,
    `.../comments`, `.../versions`, `.../etc/hosts/versions`) all
    return 400 INVALID_ARGUMENT. Phase 2 asserts the traversal did NOT
    create a snapshot directory on disk (proves the guard has no side
    effect even if a future regression made the status 400 but still
    wrote). Phase 3 asserts the POST routes (`/versions`,
    `/callback`, `/comments`, `/versions/:vid/restore`), `POST /jwt`,
    and `DELETE /files/:id` all refuse with 400. Phase 4 asserts
    malformed percent-encoding (`/files/%/comments` etc.) returns 400
    with `code:'INVALID_ARGUMENT'`, never a `URI malformed` 500, and
    that `/health` still answers afterwards. Phase 5 is the
    no-over-blocking check: a legitimate upload + version snapshot +
    list all succeed, proving the guard is a boundary, not a blanket
    refusal. (sdk1 §11.114)
  - `tests/auth-jwt-payload-validation-e2e.test.ts` (~30 assertions) —
    pins the §11.115 fixes: scope/perm type gates (6 + 3 bad shapes →
    400; bare-string scope NOT split into chars; `null` scope = unset),
    doc type gate (5 bad shapes → 400), non-finite `exp`/`ttl` sent as
    raw JSON text → 400 (the immortal-token payload), documented `ttl`
    honoured with `ttlSeconds` echo, ttl clamped at both ends
    (5 → 30, 9_999_999 → 86400), legacy absolute `exp` still works, a
    valid mint round-trips through `GET /api/v1/files`, and a
    hand-forged token with `scope:[1,2,3]` now gets 403 (not 500) while
    a mixed `[1,'files:read']` token still authorizes via the valid
    claim. (sdk1 §11.115)
  - `tests/kb-v1-input-validation-e2e.test.ts` (~30 assertions) —
    pins the §11.116 triple-fix. `/kb/search`: seven bad `limit`
    shapes (non-integer / negative / zero / non-numeric / NaN /
    Infinity / `1.5`) → 400; four over-cap limits (`101` / `500` /
    `1000` / `999999`) → 200 with `ok:true` (real success after
    clamp, no more `{ok:false}` leak); in-range limit → 200. `/kb/
    entries`: five bad `limit` shapes → 400; five over-cap limits →
    200 + ok:true; four bad `schema` shapes → 400; five valid schema
    keys → 200 + ok:true; missing schema → 200 (no over-blocking);
    `/health` 200. (sdk1 §11.116)

### Changed

- **Public open release.** Apache-2.0 across the entire monorepo.
- **REST API v1** (`@genoffice/web-server`)
  - `POST /api/v1/auth/jwt` · `POST /api/v1/auth/oauth/token`
  - `GET` / `POST` / `DELETE` `/api/v1/files[/:id]`
  - `POST /api/v1/files/:id/jwt` · `POST /api/v1/files/:id/callback`
  - `GET /api/v1/ai/capabilities` · `POST /api/v1/ai/{chat,translate,image,skill/:name}`
  - `GET /api/v1/kb/search` · `GET /api/v1/kb/entries`
  - `POST /api/v1/webhooks` · `DELETE /api/v1/webhooks`
  - Stable v1 contract; backward-compatible inside v1.x.
- **`@genoffice/web-sdk`** — iframe Embed SDK with ESM / CJS / UMD
  bundles, typed events (`ready` / `saved` / `dirtyChanged` /
  `selectionChange` / `error` / `closed`) and commands
  (`setTheme` / `setContent` / `getContent` / `insertImage` /
  `insertText` / `print` / `focus` / `aiRewrite` / `aiTranslate` /
  `aiSummarize`).
- **iframe Embed endpoint** at `GET /embed/:docId?token=…` with a
  v1.0 `postMessage` bridge to the host page.
- **Webhook firing on every save.** `notifyFileSaved(path, { size,
  format })` is called by `docs:save`, `web:save-file`,
  `markdown:save`, `html:save`, `html:save-file`, `workbook:save`,
  `slides:save` (bytes branch), and `pdf:save` (final path from
  `publishPdfAfterSave`).
- **Provider plugin interface** (`@genoffice/ai-provider/src/provider-plugin.ts`).
  - `AiProviderPlugin` · `AiMediaPlugin` · `AiSearchPlugin`
  - `ProviderRegistry` · `MediaRegistry` · `SearchRegistry`
  - Third-party providers ship as `@genoffice/provider-<name>` npm
    packages.
- **Skill protocol** (`@genoffice/agent-skills/src/skill-protocol.ts`).
  - `SkillDefinition` · `SkillPackage` · `SkillContext`
  - JSON-schema-ish input / output types
  - `SkillError` with structured codes
  - Registry with trigger / tag matching
- **KB / TM open format** (`@genoffice/translation-core/src/kb-format.ts`).
  - `.genkb` archive (manifest + entries.jsonl + optional index.bin)
  - `.gentm` archive (manifest + pairs.jsonl)
  - Validators with `FormatError` surface
- **Agent protocol v1** (`@genoffice/agent-core/src/agent-protocol.ts`).
  - `genoffice.agent.v1` envelope
  - `AgentRunner` interface for third-party agent loops
  - `validateAgentRequest` for fail-fast parsing
- **IPC channel reference generator** — `tools/gen-ipc-docs.mjs`
  scans every `registerHandle` call and emits
  `apps/web-server/IPC_CHANNELS.md` (514 channels at HEAD).
- **Documentation site** — VitePress site at `docs/` with `guide/`,
  `api/`, `skills/`, `about/` sections.
- **Examples** — `examples/embed-basic/`, `embed-react/`,
  `embed-vue/`, `custom-provider/`, `custom-skill/`.
- **Community files** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`.
- **GitHub Actions** — `release.yml` (npm + Docker publish),
  `docs.yml` (Pages deploy), `security.yml` (CodeQL + npm audit +
  gitleaks).
- **Governance** — `GOVERNANCE.md` (Steering Committee + 5 WGs +
  RFC flow), `ROADMAP.md` (M0–M3 milestones).

### Changed

- **v1 dispatcher fix.** `apps/web-server/src/api/v1/index.ts`
  properly routes `/api/v1/files/:id/jwt` and
  `/api/v1/files/:id/callback` (previously fell through to the
  SPA fallback).
- **`<meta name="genoffice-token">` injection** in
  `apps/web-server/src/index.ts` is now case-insensitive
  (`<HEAD>` vs `</head>`).
- **`@genoffice/provider-anthropic`** — Claude provider plugin
  (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`).
- **`@genoffice/provider-openai`** — OpenAI provider plugin
  (`gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`).
- **`@genoffice/provider-gemini`** — Google Gemini provider plugin
  (`gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`).
- **`@genoffice/skill-markdown-format`** — Skill that normalises
  Markdown (headings, bullets, code fences, links, whitespace).
- **`@genoffice/skill-yaml-validate`** — Skill that validates YAML
  against a small JSON-schema-style rule set.
- **`AiProviderPlugin` / `SkillDefinition` / `SkillPackage` interfaces**
  in `@genoffice/ai-provider` and `@genoffice/agent-skills` for
  shipping third-party provider plugins and Skills as npm packages.
- **`AiMediaPlugin` / `AiSearchPlugin`** interfaces for image generation,
  media analysis, and web/image search backends.
- **Docker image** (`Dockerfile`, multi-stage Node 22, non-root `node`
  user, `/health` healthcheck, `/data` persistent volume).
- **GitHub community files** — `ROADMAP.md`, `GOVERNANCE.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `.github/CODEOWNERS`, `.github/dependabot.yml`, `.gitleaks.toml`.
- **GitHub Actions** — `release.yml`, `docs.yml`, `security.yml`.
- **VitePress docs site** under `docs/` with guide / api / skills
  sections, EN + ZH content.

## [0.8.0] — internal preview

- Six editors (docs, sheets, slides, pdf, markdown, html) shipped as
  Electron shell + standalone web-server.
- 546 IPC channels.
- 12 LLM providers wired via `@genoffice/ai-provider`.
- Apache-2.0 declared across the monorepo.


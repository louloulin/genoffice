/**
 * Gate-1 authority resolution plus the route policy that a JWT-authenticated
 * caller must satisfy.
 *
 * # Why this exists
 *
 * Gate 1 (`isAuthorised` in `./index`) accepts exactly one credential: the
 * `WEB_TOKEN` shared secret. Whoever holds it *is* the operator, so it is
 * correct for Gate 1 to admit it on every route.
 *
 * `B1` (§45) widens Gate 1 to also accept a GenOffice JWT — the credential the
 * embed flow hands to a third-party host. A JWT is emphatically **not** the
 * operator: it is minted for a guest, often the narrowest possible
 * (`files:read`). Admitting it on every route would be a net regression, not a
 * fix: a `files:read` token would reach `/api/ai/*` (provider spend), every
 * `/api/ipc/*` channel, and `/api/v1/auth/jwt` (unlimited re-minting). Today
 * those requests are refused by Gate 1 with a 401; after a naive widening they
 * would succeed.
 *
 * # The rule
 *
 * A JWT-authenticated request is admissible **only** on a route that declares
 * a required scope, and the JWT must carry it. There is no default-allow:
 * `jwtScopeFor` returning `null` is a hard 403, not "fall through". That makes
 * "every route a JWT can reach has a scope" an invariant of the route table
 * rather than a property someone has to remember to maintain per handler.
 *
 * Two consequences worth stating outright:
 *
 *   - Routes whose handler has no scope gate (most of the ~530 IPC channels,
 *     `/api/v1/auth/jwt`, …) are simply **unreachable** with a JWT. That is the
 *     intended outcome of "give the scope-less routes a scope": an unscoped
 *     route gets `deny`, which is the only safe scope for a guest credential.
 *   - Nothing here changes the `WEB_TOKEN` path. An operator-authenticated
 *     request never consults this table, so no existing behaviour regresses.
 *
 * # Posture when no credential is configured
 *
 * `resolveAuthority` reports `{ kind: 'locked' }` when `WEB_TOKEN` is unset and
 * open mode was not explicitly requested: every gate-protected route answers
 * 401 rather than silently serving an unauthenticated API. Enterprise and
 * embedded deployments are the primary consumers of this server, and a
 * forgotten `WEB_TOKEN` there used to mean a wide-open AI spend surface.
 *
 * Two exceptions, both deliberate:
 *
 *   - A verifying JWT still admits in the locked posture, as `jwt-open`: the
 *     route policy below does **not** apply (the table was sized for armed
 *     boots and does not cover the renderer's channels); each dispatcher's own
 *     `requireScopeFromHeaders` stays the policy, exactly as before this gate
 *     existed. Embed deployments run `GENOFFICE_JWT_SECRET` with no
 *     `WEB_TOKEN` at all — auth is the gateway's job — so "locked" means
 *     "no anonymous access", not "no access".
 *   - Local development / e2e can restore the historical open posture
 *     explicitly with `GENOFFICE_ALLOW_OPEN=1` (or `true`) — a deliberate,
 *     visible opt-out rather than an accident of configuration.
 *
 * `resolveAuthority` reports `{ kind: 'open' }` only in the second case. The
 * route policy is deliberately **not** applied to `open` or `jwt-open`: with
 * Gate 1 already admitting, applying the table would only break flows without
 * adding a gate a third party faces. The policy constrains guest JWTs on an
 * armed boot, where an operator surface exists to protect.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyJwtWithRevocation, type JwtPayload } from '../api/v1/auth'
import { getHandlerEntry } from '../common/registry'

export type Authority =
  | { kind: 'open' }
  | { kind: 'locked' }
  | { kind: 'web-token' }
  /** A guest JWT on a `WEB_TOKEN`-armed boot: the route policy below applies. */
  | { kind: 'jwt'; payload: JwtPayload }
  /**
   * A guest JWT on a JWT-only boot (`GENOFFICE_JWT_SECRET` set, no
   * `WEB_TOKEN` — how embed deployments run). There is no operator surface to
   * protect, the route table does not cover the renderer's channel surface,
   * and the embed loop depends on the historical behavior: Gate 1 admits, and
   * each dispatcher's own `requireScopeFromHeaders` is the policy. Do not
   * widen this to armed boots.
   */
  | { kind: 'jwt-open'; payload: JwtPayload }

/**
 * Open mode must be requested explicitly. Accepting `1`/`true` keeps shell
 * profiles (`GENOFFICE_ALLOW_OPEN=1 npm run …`) and YAML env blocks (`true`)
 * both working; anything else is treated as not requested so a typo like
 * `GENOFFICE_ALLOW_OPEN=yes-please` fails closed.
 */
export function openModeAllowed(): boolean {
  const flag = process.env.GENOFFICE_ALLOW_OPEN
  return flag === '1' || flag === 'true'
}

/** A JWT is three base64url segments; anything else (e.g. the raw `WEB_TOKEN`) is not a candidate. */
function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3
}

/** The payload of the first candidate that verifies as a JWT, if any. */
function firstValidJwt(candidates: string[]): JwtPayload | null {
  for (const candidate of candidates) {
    if (!looksLikeJwt(candidate)) continue
    const payload = verifyJwtWithRevocation(candidate)
    if (payload) return payload
  }
  return null
}

/**
 * The verifying JWT this request carries, through **any** credential
 * transport (Bearer header / `X-GenOffice-Token` / `auth_token` cookie /
 * `?token=`), or null.
 *
 * Callers deciding *who the caller is* (embed vs operator vs local renderer)
 * must use this — not a raw Authorization-header slice — because the gate
 * admits a JWT through all four transports. A caller whose JWT arrived via
 * cookie would otherwise be misread as "local" and keep injected network
 * overrides (the SSRF sanitize decision in `settings-sanitize.ts`).
 */
export function jwtPayloadFromRequest(request: {
  headers: IncomingMessage['headers']
  url?: { searchParams?: { get(name: string): string | null } }
}): JwtPayload | null {
  return firstValidJwt(credentialCandidates(request))
}

/**
 * Collect the raw credential strings a request could be carrying, in the same
 * four transports `readToken` (`./index`) honours: `Authorization: Bearer`,
 * the `X-GenOffice-Token` header (EventSource strips `Authorization`
 * cross-origin), the `auth_token` cookie (auto-attached same-origin, and the
 * only transport an `EventSource` can use), and `?token=`.
 *
 * Order matters only for diagnostics; every candidate is verified.
 */
function credentialCandidates(request: {
  headers: IncomingMessage['headers']
  url?: { searchParams?: { get(name: string): string | null } }
}): string[] {
  const out: string[] = []
  const auth = request.headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match) out.push(match[1])
  }
  const custom = request.headers['x-genoffice-token']
  if (typeof custom === 'string') out.push(custom)
  const cookieHeader = request.headers.cookie
  if (typeof cookieHeader === 'string') {
    const match = /(?:^|;\s*)auth_token=([^;\s]+)/.exec(cookieHeader)
    if (match) {
      try {
        out.push(decodeURIComponent(match[1]))
      } catch {
        /* malformed percent-encoding — not a usable credential */
      }
    }
  }
  const query = request.url?.searchParams?.get('token')
  if (typeof query === 'string') out.push(query)
  return out
}

/**
 * Resolve which credential (if any) authorises this request.
 *
 * With `WEB_TOKEN` armed: a matching shared secret is the operator
 * (`web-token`); a verifying JWT is a guest (`jwt`) and the route policy
 * applies; anything else is `null` — the caller must answer 401.
 *
 * With `WEB_TOKEN` unset: open mode (`GENOFFICE_ALLOW_OPEN=1`) admits
 * everything; otherwise the posture is **locked** and a request with no valid
 * credential gets `{ kind: 'locked' }` — also a 401. The one exception is a
 * verifying JWT, which admits as `jwt-open` (see the type): the per-channel
 * dispatcher scope gates stay the policy, matching how embed deployments have
 * always run. With no `WEB_TOKEN` *and* no JWT secret, no candidate can verify
 * and every request is locked.
 */
export function resolveAuthority(request: {
  headers: IncomingMessage['headers']
  url?: { searchParams?: { get(name: string): string | null } }
}): Authority | null {
  const expected = process.env.WEB_TOKEN
  if (expected && expected.length > 0) {
    const candidates = credentialCandidates(request)
    // The shared secret is compared raw and first, so it is never run through
    // JWT parsing and the operator path keeps its exact previous meaning.
    if (candidates.includes(expected)) return { kind: 'web-token' }
    const payload = firstValidJwt(candidates)
    if (payload) return { kind: 'jwt', payload }
    return null
  }

  if (openModeAllowed()) return { kind: 'open' }
  const payload = firstValidJwt(credentialCandidates(request))
  if (payload) return { kind: 'jwt-open', payload }
  return { kind: 'locked' }
}

/**
 * The tenant context a verified credential operates in (A40 → A41/A42).
 *
 * The JWT `tenant` claim is the only tenant source; requests authenticated
 * any other way (operator WEB_TOKEN, local renderer, open mode) have no
 * tenant identity and fall back to `'default'` — callers stamp that provenance
 * on audit records (`tenantSource: 'fallback'`) so a shared 'default' bucket
 * is never mistaken for a real tenant.
 */
export function tenantFromPayload(payload: { tenant?: string } | null | undefined): string {
  return payload?.tenant ?? 'default'
}

interface JwtRouteRule {
  methods: readonly string[]
  pattern: RegExp
  scope: string
}

/**
 * Routes a JWT-authenticated caller may reach, with the scope each requires.
 *
 * Mirrors `v1Routes` (`../api/v1/index.ts`) one-for-one for the v1 surface, so
 * the two tables can be diffed by eye. Two deliberate omissions:
 *
 *   - `POST /api/v1/auth/jwt` and `POST /api/v1/auth/oauth/token` are absent:
 *     minting is an operator action. A JWT that could mint JWTs is a JWT that
 *     can escalate past every scope in this table.
 *   - `POST /api/v1/files/:id/jwt` is present only for `files:read` because it
 *     is file-scoped and additionally requires the document to exist in
 *     `FILES_DIR`; it cannot mint a broader token than the caller holds.
 */
const JWT_ROUTE_RULES: readonly JwtRouteRule[] = [
  // ---- v1: meta ----
  { methods: ['GET'], pattern: /^\/api\/v1\/metrics$/, scope: 'admin' },
  { methods: ['GET'], pattern: /^\/api\/v1\/meta$/, scope: 'files:read' },
  // ---- v1: files ----
  { methods: ['GET'], pattern: /^\/api\/v1\/files$/, scope: 'files:read' },
  { methods: ['POST'], pattern: /^\/api\/v1\/files$/, scope: 'files:write' },
  { methods: ['GET'], pattern: /^\/api\/v1\/files\/[^/]+$/, scope: 'files:read' },
  { methods: ['DELETE'], pattern: /^\/api\/v1\/files\/[^/]+$/, scope: 'files:write' },
  { methods: ['POST'], pattern: /^\/api\/v1\/files\/[^/]+\/jwt$/, scope: 'files:read' },
  { methods: ['POST'], pattern: /^\/api\/v1\/files\/[^/]+\/callback$/, scope: 'files:write' },
  // ---- v1: comments ----
  { methods: ['GET'], pattern: /^\/api\/v1\/files\/[^/]+\/comments$/, scope: 'files:read' },
  { methods: ['POST'], pattern: /^\/api\/v1\/files\/[^/]+\/comments$/, scope: 'files:comment' },
  { methods: ['GET'], pattern: /^\/api\/v1\/files\/[^/]+\/comments\/[^/]+$/, scope: 'files:read' },
  { methods: ['PATCH', 'DELETE'], pattern: /^\/api\/v1\/files\/[^/]+\/comments\/[^/]+$/, scope: 'files:comment' },
  // ---- v1: versions ----
  { methods: ['GET'], pattern: /^\/api\/v1\/files\/[^/]+\/versions$/, scope: 'files:read' },
  { methods: ['POST'], pattern: /^\/api\/v1\/files\/[^/]+\/versions$/, scope: 'files:write' },
  { methods: ['GET'], pattern: /^\/api\/v1\/files\/[^/]+\/versions\/[^/]+$/, scope: 'files:read' },
  { methods: ['DELETE'], pattern: /^\/api\/v1\/files\/[^/]+\/versions\/[^/]+$/, scope: 'files:write' },
  { methods: ['POST'], pattern: /^\/api\/v1\/files\/[^/]+\/versions\/[^/]+\/restore$/, scope: 'files:restore' },
  // ---- v1: ai ----
  { methods: ['GET'], pattern: /^\/api\/v1\/ai\/capabilities$/, scope: 'ai:read' },
  // Per-tenant usage query (A18/A22/A62/A63). `ai:read` rather than a new
  // scope: it is a read-only report over the caller's own tenant, and the
  // handler pins a non-operator to its JWT tenant regardless of `?tenant=`.
  { methods: ['GET'], pattern: /^\/api\/v1\/ai\/usage$/, scope: 'ai:read' },
  { methods: ['POST'], pattern: /^\/api\/v1\/ai\/chat$/, scope: 'ai:chat' },
  { methods: ['POST'], pattern: /^\/api\/v1\/ai\/translate$/, scope: 'ai:translate' },
  { methods: ['POST'], pattern: /^\/api\/v1\/ai\/translate\/stream$/, scope: 'ai:translate' },
  { methods: ['POST'], pattern: /^\/api\/v1\/ai\/translate\/stream\/cancel$/, scope: 'ai:translate' },
  { methods: ['POST'], pattern: /^\/api\/v1\/ai\/image$/, scope: 'ai:image' },
  { methods: ['POST'], pattern: /^\/api\/v1\/ai\/skill\/[a-z0-9._-]+$/, scope: 'ai:skill' },
  // ---- v1: kb ----
  { methods: ['GET'], pattern: /^\/api\/v1\/kb\/search$/, scope: 'kb:read' },
  { methods: ['GET'], pattern: /^\/api\/v1\/kb\/entries$/, scope: 'kb:read' },
  // ---- v1: webhooks ----
  { methods: ['POST', 'DELETE'], pattern: /^\/api\/v1\/webhooks$/, scope: 'webhooks:manage' },
  { methods: ['GET'], pattern: /^\/api\/v1\/webhooks\/dlq$/, scope: 'webhooks:manage' },
  { methods: ['GET', 'DELETE'], pattern: /^\/api\/v1\/webhooks\/dlq\/[^/]+$/, scope: 'webhooks:manage' },
  { methods: ['POST'], pattern: /^\/api\/v1\/webhooks\/dlq\/[^/]+\/replay$/, scope: 'webhooks:manage' },
  { methods: ['POST'], pattern: /^\/api\/v1\/callbacks$/, scope: 'files:write' },
  // ---- v1: embed nonce ----
  { methods: ['POST', 'DELETE'], pattern: /^\/api\/v1\/embed\/nonce$/, scope: 'files:read' },
  { methods: ['POST'], pattern: /^\/api\/v1\/embed\/verify-nonce$/, scope: 'files:read' },
  // ---- legacy /api/* (non-v1) — the transports the editor renderer uses ----
  { methods: ['GET'], pattern: /^\/api\/ai\/languages$/, scope: 'ai:read' },
  { methods: ['POST'], pattern: /^\/api\/ai\/translate$/, scope: 'ai:translate' },
  { methods: ['POST'], pattern: /^\/api\/ai\/translate\/stream$/, scope: 'ai:translate' },
  { methods: ['POST'], pattern: /^\/api\/ai\/translate\/stream\/cancel$/, scope: 'ai:translate' },
  { methods: ['POST'], pattern: /^\/api\/ai\/stream$/, scope: 'ai:chat' },
  { methods: ['POST'], pattern: /^\/api\/ai\/stream\/cancel$/, scope: 'ai:chat' },
  { methods: ['POST'], pattern: /^\/api\/ai\/pi-prompt$/, scope: 'ai:skill' },
  // ---- IPC push channel (the bridge subscribes to this with EventSource) ----
  { methods: ['GET'], pattern: /^\/api\/ipc\/events$/, scope: 'ipc:subscribe' },
]

/**
 * IPC channels a JWT-authenticated caller may invoke. The required scope is
 * the channel name itself, so `hasScope`'s existing wildcard rules apply
 * (`docs:*` grants every `docs:` channel).
 *
 * An in-source list rather than an env knob on purpose: widening it is a code
 * change that shows up in review. Each entry is justified by a caller that has
 * no other way in — the embed bridge (`sdk:command`, `events`) and the editor
 * renderer it loads (document open/save, file import, translation).
 *
 * `soft:`-prefixed registry scopes are also honoured (see `jwtScopeFor`): a
 * channel that has already declared a scope is self-describing, and the
 * `soft:` prefix only ever lowered the bar for *unauthenticated* renderer
 * traffic, which a JWT caller is not.
 */
export const JWT_IPC_CHANNELS: ReadonlySet<string> = new Set([
  'sdk:command',
  'docs:open-path',
  'docs:save',
  'docs:save-new',
  'files:add',
  'ai:translate',
  'ai:translate-batch',
  'ai:save-translation-memory',
  // The first half of "open a document" in a browser: the renderer lands the
  // bytes it received (host-embedded content, file picker, paste) into a temp
  // file before `docs:open-path` can open it. Listing `docs:open-path` without
  // this made the embedded editor render an empty document on WEB_TOKEN-armed
  // boots — the 403 silenced the import and nothing else reported it.
  // Same exposure class as `files:add` below: sanitized name, random
  // per-upload directory, per-request size cap.
  'web:write-temp-file',
  // Docs open flow resets stale password intents right after opening; without
  // it the armed-boot open path errors after the document is already loaded.
  'docs:discard-password-intents',
  // The AI panel loads the current project's chat history on mount; the
  // embedded editor's AI surface is blank without it.
  'project:loadChat',
  // Sheets/pdf/slides embed mirrors of the docs channels above. Their open
  // flows land bytes via `web:write-temp-file` then open through their own
  // app channel, and their Apply→save writes through the save channel — the
  // docs triple (`docs:open-path`/`docs:save`/`docs:save-new`) was listed but
  // the other three editors' equivalents were not, so on WEB_TOKEN-armed boots
  // the embedded spreadsheet/pdf/deck rendered an empty grid/page and Apply
  // failed, with only a silent 403 to show for it (`sheets:consume-new-blank`
  // is invoked unconditionally at the end of the sheets open sequence).
  'workbook:open-path',
  'workbook:save',
  'sheets:consume-new-blank',
  'pdf:open-path',
  'slides:open-path',
  'slides:save',
])

/**
 * The scope a JWT-authenticated caller must carry to reach `method pathname`.
 *
 * `null` means "not admissible with a JWT" and **must** be answered with 403.
 * There is intentionally no fall-through: see the module header.
 */
export function jwtScopeFor(method: string, pathname: string): string | null {
  const upper = method.toUpperCase()
  for (const rule of JWT_ROUTE_RULES) {
    if (rule.methods.includes(upper) && rule.pattern.test(pathname)) return rule.scope
  }

  // `/api/ipc/<channel>` — dynamic, so it cannot live in the static table.
  const match = /^\/api\/ipc\/([^/]+)$/.exec(pathname)
  if (match) {
    let channel: string
    try {
      channel = decodeURIComponent(match[1])
    } catch {
      return null
    }
    if (channel === 'events') return 'ipc:subscribe'
    if (JWT_IPC_CHANNELS.has(channel)) return channel
    const declared = getHandlerEntry(channel)?.scope
    if (declared) return declared.startsWith('soft:') ? declared.slice('soft:'.length) : declared
    return null
  }

  return null
}

export function writeForbidden(response: ServerResponse, message: string): void {
  response.writeHead(403, { 'Content-Type': 'application/json' })
  response.end(
    JSON.stringify({
      error: {
        code: 'FORBIDDEN',
        message,
      },
    }),
  )
}

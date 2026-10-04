/**
 * /api/v1/ai — AI capability surface.
 *
 * Each endpoint forwards to the underlying IPC handler so the REST surface
 * stays a thin shell over the same LLM / image / translate pipeline that
 * the in-renderer transport already uses. Adding a new LLM feature in IPC
 * automatically surfaces it in REST without duplication.
 * @public
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError, readBody } from './http-utils'
import { invokeIpc } from './ipc-bridge'
import { hasScope, requireScopeFromHeaders } from './auth'
import { tenantFromPayload } from '../../auth/route-policy'
import { aggregateUsage } from '../../common/usage-meter'
import { classifyRemoteUrl } from '@genoffice/electron-utils/safe-remote-url'
import { auditAiCall } from '../../ai/ai-audit'
import { translateBatchCore, handleTranslateStreamHttp, handleTranslateStreamCancelHttp, type TranslateBatchHttpRequest } from '../../ai/translate-http'

/**
 * The event overrides every gated v1 AI route threads onto its IPC event:
 * the verified subject and, when the JWT carries it, the `tenant` claim.
 * The claim spreads raw — an absent tenant must stay absent so audit records
 * mark provenance 'fallback' instead of pinning a literal 'default' tenant
 * as JWT-sourced.
 */
function aiEventOverrides(gate: { payload: { sub?: string; tenant?: string } }): {
  userId?: string
  tenantId?: string
} {
  return {
    ...(gate.payload.sub ? { userId: gate.payload.sub } : {}),
    ...(gate.payload.tenant ? { tenantId: gate.payload.tenant } : {}),
  }
}

/**
 * `POST /api/v1/ai/capabilities`
 *
 * Return the list of AI capabilities the server currently advertises (LLM models, image gen, search).
 *
 * **Required scope**: `ai:read`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleAiCapabilities(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:capabilities')
    return true
  }
  const result = await invokeIpc('home:ai-capabilities', [])
  sendJson(ctx.response, 200, result)
  return true
}

/**
 * `GET /api/v1/ai/usage?from=&to=&tenant=`
 *
 * Per-tenant aggregated AI usage over a parameterizable time window (A18 /
 * A22 / A62 / A63). `from` / `to` accept epoch milliseconds, epoch seconds,
 * or an ISO 8601 timestamp; both default to the trailing 24 hours. The
 * response is `{ from, to, tenants: [{ tenantId, calls, promptTokens,
 * completionTokens, totalTokens, avgLatencyMs }], totals }`, one entry per
 * tenant in the window, sorted by tenant id.
 *
 * Scope (A62): the caller must hold `ai:read`. A caller may only see its own
 * tenant — the `tenant` query parameter is honoured **only** for an
 * operator-level caller (`admin` scope or the `admin` subject, via `hasScope`
 * in `./auth.ts`); for everyone else it is ignored and the verified JWT's
 * tenant is forced, falling back to `'default'` exactly as the audit trail
 * does. This uses the existing scope model rather than inventing a new one.
 *
 * **Required scope**: `ai:read`
 *
 * **Errors**: `400 INVALID_ARGUMENT`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export function handleAiUsage(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:usage')
    return true
  }
  let query: URL
  try {
    query = new URL(ctx.request.url ?? '/', 'http://localhost')
  } catch {
    sendError(ctx.response, 400, 'malformed request URL', 'INVALID_ARGUMENT', 'ai:usage')
    return true
  }
  const now = Date.now()
  const rawFrom = query.searchParams.get('from')
  const rawTo = query.searchParams.get('to')
  const from = parseTimeParam(rawFrom, now - 24 * 60 * 60 * 1000)
  const to = parseTimeParam(rawTo, now)
  if (from === null || to === null) {
    sendError(
      ctx.response,
      400,
      'from/to must be epoch milliseconds, epoch seconds, or an ISO 8601 timestamp',
      'INVALID_ARGUMENT',
      'ai:usage',
    )
    return true
  }
  if (from > to) {
    sendError(ctx.response, 400, '`from` must not be after `to`', 'INVALID_ARGUMENT', 'ai:usage')
    return true
  }
  // Operator-level callers may widen the query (or filter to one tenant);
  // every other caller is pinned to its own tenant. `hasScope` already treats
  // the `admin` subject and the `admin` / `*` scopes as operator.
  const operator = hasScope(gate.payload, 'admin')
  const ownTenant = tenantFromPayload(gate.payload)
  const requestedTenant = query.searchParams.get('tenant')
  const tenantId = operator ? requestedTenant ?? undefined : ownTenant
  const result = aggregateUsage({ fromMs: from, toMs: to, tenantId })
  sendJson(ctx.response, 200, result)
  return true
}

/**
 * Resolve a `from`/`to` query value to epoch milliseconds. Returns the
 * `defaultMs` when the parameter is absent/empty; returns `null` (caller
 * answers 400) when a supplied value is present but unparseable. Bare integers
 * shorter than 13 digits are treated as epoch seconds; 13+ digits as ms.
 */
function parseTimeParam(raw: string | null, defaultMs: number): number | null {
  if (raw === null || raw.trim() === '') return defaultMs
  const trimmed = raw.trim()
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return null
    return Math.abs(n) < 1e12 ? n * 1000 : n
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * `POST /api/v1/ai/chat`
 *
 * One-shot or streaming chat completion. The `stream: true` body flag returns Server-Sent Events instead of a single JSON reply.
 *
 * **Required scope**: `ai:chat`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleAiChat(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:chat')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:chat')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let rawBody: { messages?: unknown; user?: unknown; system?: unknown; settings?: unknown }
  try {
    const raw = await readBody(ctx.request)
    rawBody = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'ai:chat')
    return true
  }
  // The REST contract (sdk1 §11.4 / docs/api/rest-api.md) is OpenAI-style
  // `{ messages: [{ role, content }] }` — host-friendly. The IPC shape is
  // `{ settings, system, user }`. Without this adapter the IPC rejects
  // every REST call with `expected { settings, system, user }`, surfacing
  // an internal IPC field name to hosts that follow the documented REST
  // shape (same class of bug as §11.103 ai:translate / ai:image fix).
  // Also accept the IPC shape directly for IPC-style callers.
  const ipcBody = adaptChatShape(rawBody)
  if (!ipcBody) {
    sendError(ctx.response, 400, 'expected { messages: [{role, content}] } with at least one user message', 'INVALID_ARGUMENT', 'ai:chat')
    return true
  }
  const result = await invokeIpc('ai:chat', [ipcBody], aiEventOverrides(gate))
  sendJson(ctx.response, 200, result)
  return true
}

/**
 * `POST /api/v1/ai/translate`
 *
 * Translate the supplied text into the requested target language, with optional domain hint and KB lookup.
 *
 * **Required scope**: `ai:translate`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleAiTranslate(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:translate')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:translate')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let rawBody: { text?: unknown; from?: unknown; to?: unknown; instruction?: unknown; sourceLang?: unknown; targetLang?: unknown; units?: unknown }
  try {
    const raw = await readBody(ctx.request)
    rawBody = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'ai:translate')
    return true
  }
  // Batch shape — `{ units: [...], targetLanguage }`. This is what the SDK's
  // `translateBatch()` sends, and what the legacy `/api/ai/translate` route
  // has always accepted. Without this branch the v1 route ignored `units`
  // entirely and answered 400 `expected { text, from?, to }`, so pointing the
  // SDK at v1 would have been a regression rather than a migration.
  // `translateBatchCore` takes the already-parsed body: `readBody` above has
  // consumed the stream, and a second read would silently return nothing.
  if (Array.isArray(rawBody.units)) {
    // The gate above verified a JWT — this caller is embed-mode for the
    // translate sanitize layer (network fields stripped/backfilled).
    await translateBatchCore(rawBody as TranslateBatchHttpRequest, ctx.response, {
      embedCaller: true,
      endpoint: '/api/v1/ai/translate',
      ...aiEventOverrides(gate),
    })
    return true
  }
  // The REST shape (sdk1 §11.4 / docs/api/rest-api.md) is
  // `{ text, from?, to }` — host-friendly. The IPC shape is
  // `{ instruction, sourceLang, targetLang, ... }`. Without this adapter
  // the IPC returns `{ ok:false, error:'ai:translate expected non-empty targetLang' }`
  // because the REST never sent `targetLang` (it sent `to`), and the IPC
  // treats the call as "client error: missing field". Translate the keys
  // + types here so hosts can use the documented REST shape.
  const instruction = typeof rawBody.text === 'string'
    ? rawBody.text
    : typeof rawBody.instruction === 'string'
      ? rawBody.instruction
      : ''
  const targetLang = typeof rawBody.to === 'string'
    ? rawBody.to
    : typeof rawBody.targetLang === 'string'
      ? rawBody.targetLang
      : ''
  if (!targetLang) {
    sendError(ctx.response, 400, 'expected { text, from?, to } with non-empty `to`', 'INVALID_ARGUMENT', 'ai:translate')
    return true
  }
  if (!instruction) {
    sendError(ctx.response, 400, 'expected { text, from?, to } with non-empty `text`', 'INVALID_ARGUMENT', 'ai:translate')
    return true
  }
  const sourceLang = typeof rawBody.from === 'string'
    ? rawBody.from
    : typeof rawBody.sourceLang === 'string'
      ? rawBody.sourceLang
      : undefined
  const ipcBody = {
    instruction,
    targetLang,
    ...(sourceLang ? { sourceLang } : {}),
  }
  const result = await invokeIpc('ai:translate', [ipcBody], aiEventOverrides(gate))
  sendJson(ctx.response, 200, result)
  return true
}

/**
 * `POST /api/v1/ai/translate/stream`
 *
 * SSE translation stream. Same event sequence as the legacy
 * `/api/ai/translate/stream` (`start` / `unit` / `quality` / `complete` /
 * `error`) — this v1 route only adds the scope gate and the v1 prefix.
 *
 * **Required scope**: `ai:translate`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`. Request-validation
 * failures before the stream opens keep the legacy envelope (no `channel`);
 * failures after it opens arrive as an SSE `error` event.
 * @public
 */
export function handleAiTranslateStream(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:translate')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:translate/stream')
    return true
  }
  // Not awaited: an SSE handler stays open until the stream terminates, and
  // awaiting it here would hold the dispatcher's promise for the whole run.
  // Mirrors the legacy registration in src/index.ts. The gate above verified
  // a JWT — embed-mode for the translate sanitize layer.
  void handleTranslateStreamHttp(ctx.request, ctx.response, {
    embedCaller: true,
    endpoint: '/api/v1/ai/translate/stream',
    ...aiEventOverrides(gate),
  })
  return true
}

/**
 * `POST /api/v1/ai/translate/stream/cancel`
 *
 * Abort an in-flight v1 translation stream by `requestId`.
 *
 * **Required scope**: `ai:translate`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export function handleAiTranslateStreamCancel(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:translate')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:translate/stream/cancel')
    return true
  }
  void handleTranslateStreamCancelHttp(ctx.request, ctx.response)
  return true
}

/**
 * `POST /api/v1/ai/image`
 *
 * Generate an image from a text prompt. The configured provider (Genspark, OpenAI, Gemini, etc.) decides model and resolution.
 *
 * **Required scope**: `ai:image`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleAiImage(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:image')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:image')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let rawBody: { url?: unknown; prompt?: unknown }
  try {
    const raw = await readBody(ctx.request)
    rawBody = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'ai:image')
    return true
  }
  // The IPC `ai:fetch-image` fetches an image FROM a URL and returns
  // base64-encoded bytes (see apps/web-server/src/ai/chat.ts:1806). It
  // does NOT generate an image from a prompt — there is no image-generation
  // IPC wired up in this build. The REST endpoint is therefore a
  // fetch-from-URL surface: hosts send `{ url }` and get the bytes back.
  // Previously the handler forwarded the body object straight through,
  // the IPC rejected non-string URLs as `null`, and the REST returned
  // `{ "null" }` looking like success. Validate the URL string here so
  // callers see a real 400 instead of a silent null. Image generation
  // via prompt is not yet implemented; the docs and capability list
  // correctly mark `image_generation` as not configured by default.
  const url = typeof rawBody.url === 'string' ? rawBody.url : ''
  if (!url) {
    sendError(ctx.response, 400, 'expected { url: string }', 'INVALID_ARGUMENT', 'ai:image')
    return true
  }
  if (url.length > 4096) {
    sendError(ctx.response, 400, 'url exceeds 4096 char cap', 'INVALID_ARGUMENT', 'ai:image')
    return true
  }
  // A76: this endpoint makes the server fetch a caller-chosen URL and hand the
  // bytes back — a fetch-any-URL surface. `fetchRemoteImage` already revalidates
  // every redirect hop, but it collapses a blocked target into the same `null`
  // it returns for a network failure, so the host cannot tell "refused by
  // policy" from "unreachable". Pre-flight the target here and answer with a
  // structured 403 before the fetch is attempted. Only a positively
  // non-public target is refused; an unresolvable public name falls through to
  // the fetch's own failure path (and keeps offline behaviour unchanged).
  if ((await classifyRemoteUrl(url)) === 'blocked') {
    sendError(
      ctx.response,
      403,
      'url must be a public address (private, link-local, cloud-metadata and loopback targets are refused)',
      'FORBIDDEN',
      'ai:image',
    )
    return true
  }
  // A43: this is a fetch surface, not a model turn — tokens are null. The IPC
  // handler writes the single `ai.call` record (covering both this HTTP route
  // and direct renderer IPC calls); it names this route via `auditEndpoint`.
  // The catch below only covers a thrown IPC dispatch, which the handler
  // itself never does, so it is a last-resort record rather than a duplicate.
  const startedAt = Date.now()
  let result: unknown
  try {
    result = await invokeIpc('ai:fetch-image', [url], {
      ...aiEventOverrides(gate),
      auditEndpoint: '/api/v1/ai/image',
    })
  } catch (error) {
    auditAiCall({
      endpoint: '/api/v1/ai/image',
      ...aiEventOverrides(gate),
      durationMs: Date.now() - startedAt,
      ok: false,
    })
    throw error
  }
  sendJson(ctx.response, 200, result)
  return true
}

/**
 * `POST /api/v1/ai/skill/:skillName`
 *
 * Invoke a registered skill by name. Skill bodies are dispatched through the same `ai:chat` IPC pipeline.
 *
 * **Required scope**: `ai:skill`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND (unknown skill)`
 * @public
 */
export async function handleAiSkill(ctx: { request: IncomingMessage; response: ServerResponse }, skillName: string): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:skill')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, `ai:skill:${skillName}`)
    return true
  }
  const caller = { sub: gate.payload.sub }
  let rawBody: { messages?: unknown; user?: unknown; system?: unknown; settings?: unknown }
  try {
    const raw = await readBody(ctx.request)
    rawBody = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', `ai:skill:${skillName}`)
    return true
  }
  // Skill invocations go through `ai:chat` (the renderer-side skill
  // dispatcher); the skill name is part of the request payload.
  // Same REST <-> IPC shape adapter as handleAiChat (sdk1 §11.104).
  const ipcBody = adaptChatShape(rawBody)
  if (!ipcBody) {
    sendError(ctx.response, 400, 'expected { messages: [{role, content}] } with at least one user message', 'INVALID_ARGUMENT', `ai:skill:${skillName}`)
    return true
  }
  const result = await invokeIpc('ai:chat', [{ ...ipcBody, skill: skillName }], aiEventOverrides(gate))
  sendJson(ctx.response, 200, result)
  return true
}

/**
 * Adapter: REST `{ messages: [{role, content}] }` -> IPC `{ settings?, system?, user }`.
 *
 * Used by handleAiChat and handleAiSkill to bridge the host-friendly
 * REST shape and the renderer-internal IPC shape. Returns null when the
 * input is malformed (no user message at all).
 *
 * Implementation note: this is a module-level helper so both REST
 * handlers share one definition; if either grows a third shape
 * (e.g. multipart with attachments), only this adapter changes.
 */
function adaptChatShape(raw: { messages?: unknown; user?: unknown; system?: unknown; settings?: unknown }): { settings?: unknown; system?: string; user: string } | null {
  // IPC-shape compat path: callers that already know the IPC shape
  // (renderer test scripts, internal callers) can pass `{ user, system, settings }` directly.
  if (typeof raw.user === 'string' && raw.user.length > 0) {
    return {
      user: raw.user,
      ...(typeof raw.system === 'string' ? { system: raw.system } : {}),
      ...(raw.settings ? { settings: raw.settings } : {}),
    }
  }
  // OpenAI-style messages array
  if (Array.isArray(raw.messages)) {
    const systemParts: string[] = []
    let lastUser: string | null = null
    for (const m of raw.messages) {
      if (!m || typeof m !== 'object') continue
      const role = (m as { role?: unknown }).role
      const content = (m as { content?: unknown }).content
      if (typeof content !== 'string') continue
      if (role === 'system') systemParts.push(content)
      else if (role === 'user') lastUser = content
      else if (role === 'assistant') {
        // Skip assistant turns for the user-prompt field — they're
        // already implicit in the conversation. Renderers that need
        // full multi-turn should switch to the IPC shape directly.
      }
    }
    if (lastUser === null) return null
    return {
      user: lastUser,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n") } : {}),
      ...(raw.settings ? { settings: raw.settings } : {}),
    }
  }
  return null
}

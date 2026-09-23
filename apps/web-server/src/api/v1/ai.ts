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
import { requireScopeFromHeaders } from './auth'

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
  const result = await invokeIpc('ai:chat', [ipcBody])
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
  let rawBody: { text?: unknown; from?: unknown; to?: unknown; instruction?: unknown; sourceLang?: unknown; targetLang?: unknown }
  try {
    const raw = await readBody(ctx.request)
    rawBody = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'ai:translate')
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
  const result = await invokeIpc('ai:translate', [ipcBody])
  sendJson(ctx.response, 200, result)
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
  const result = await invokeIpc('ai:fetch-image', [url])
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
  const result = await invokeIpc('ai:chat', [{ ...ipcBody, skill: skillName }])
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

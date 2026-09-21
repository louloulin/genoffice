/**
 * /api/v1/ai — AI capability surface.
 *
 * Each endpoint forwards to the underlying IPC handler so the REST surface
 * stays a thin shell over the same LLM / image / translate pipeline that
 * the in-renderer transport already uses. Adding a new LLM feature in IPC
 * automatically surfaces it in REST without duplication.
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
 */
export async function handleAiChat(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:chat')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:chat')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let body: unknown
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'ai:chat')
    return true
  }
  const result = await invokeIpc('ai:chat', [body])
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
 */
export async function handleAiTranslate(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:translate')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:translate')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let body: unknown
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'ai:translate')
    return true
  }
  const result = await invokeIpc('ai:translate', [body])
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
 */
export async function handleAiImage(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:image')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'ai:image')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let body: unknown
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'ai:image')
    return true
  }
  const result = await invokeIpc('ai:fetch-image', [body])
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
 */
export async function handleAiSkill(ctx: { request: IncomingMessage; response: ServerResponse }, skillName: string): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'ai:skill')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, `ai:skill:${skillName}`)
    return true
  }
  const caller = { sub: gate.payload.sub }
  let body: unknown
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', `ai:skill:${skillName}`)
    return true
  }
  // Skill invocations go through `ai:chat` (the renderer-side skill
  // dispatcher); the skill name is part of the request payload.
  const result = await invokeIpc('ai:chat', [{ ...((body && typeof body === 'object') ? body : {}), skill: skillName }])
  sendJson(ctx.response, 200, result)
  return true
}

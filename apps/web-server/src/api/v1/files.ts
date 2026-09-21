/**
 * /api/v1/files — file CRUD, file-scoped JWT issuance, save callbacks.
 *
 * Implementation note: this is a thin HTTP wrapper over the existing IPC
 * handlers (`web:save-file`, `files:read`, etc.). Re-using the IPC layer
 * means the REST API and the in-renderer transport share the same storage
 * backend, recents bookkeeping, and quota enforcement — a file uploaded
 * via REST shows up in `home:recents` immediately, and vice versa.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError, readBody } from './http-utils'
import { recordRecentDoc } from '../../common/document-stores'
import { FILES_DIR } from '../../common/index'
import { existsSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { verifyJwt, signJwt, requireScopeFromHeaders, type JwtPayload } from './auth'

function getJwtFromAuth(headers: IncomingMessage['headers']): { sub: string; doc?: string; perm?: string[]; scope?: string[] } | null {
  const auth = headers.authorization
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null
  const payload = verifyJwt(auth.slice('Bearer '.length))
  if (!payload) return null
  return {
    sub: payload.sub,
    ...(payload.doc ? { doc: payload.doc } : {}),
    ...(payload.perm ? { perm: payload.perm } : {}),
    ...(payload.scope ? { scope: payload.scope } : {}),
  }
}

/**
 * Per-endpoint scope gate. Returns the same envelope as
 * `requireScopeFromHeaders` so callers can hand the failure straight to
 * `sendError`. Wrapped here so endpoint code can do
 *   const gate = requireFilesScope(ctx.request.headers, 'files:read')
 *   if (!gate.ok) { sendError(...); return true }
 */
function requireFilesScope(
  headers: IncomingMessage['headers'],
  scope: string,
  channel: string,
): { ok: true; payload: JwtPayload } | { ok: false; status: number; code: string; message: string } {
  const gate = requireScopeFromHeaders(headers, scope)
  if (!gate.ok) return gate
  return { ok: true, payload: gate.payload }
}

/**
 * `GET /api/v1/files`
 *
 * List files in the FILES_DIR. Returns `{ files: Array<{ id, name, size, modifiedAt }> }`.
 *
 * **Required scope**: `files:read`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 */
export async function handleFilesList(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const caller = getJwtFromAuth(ctx.request.headers)
  if (!caller) {
    sendError(ctx.response, 401, 'Bearer token required', 'UNAUTHENTICATED', 'files:list')
    return true
  }
  const scopeGate = requireFilesScope(ctx.request.headers, 'files:read', 'files:list')
  if (!scopeGate.ok) {
    sendError(ctx.response, scopeGate.status, scopeGate.message, scopeGate.code, 'files:list')
    return true
  }
  if (!existsSync(FILES_DIR)) {
    sendJson(ctx.response, 200, { files: [] })
    return true
  }
  const names = readdirSync(FILES_DIR).filter((n) => !n.startsWith('.'))
  const files = names
    .map((name) => {
      const path = join(FILES_DIR, name)
      try {
        const stat = statSync(path)
        return { id: name, name, size: stat.size, mtime: stat.mtimeMs, path }
      } catch {
        return null
      }
    })
    .filter((f): f is { id: string; name: string; size: number; mtime: number; path: string } => f !== null)
  sendJson(ctx.response, 200, { files })
  return true
}

/**
 * `POST /api/v1/files`
 *
 * Upload a new file. Body: `{ name: string, bytes: string (base64) }`. Returns the file id and canonical storage path.
 *
 * **Required scope**: `files:write`
 *
 * **Errors**: `400 INVALID_ARGUMENT`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 */
export async function handleFilesCreate(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const caller = getJwtFromAuth(ctx.request.headers)
  if (!caller) {
    sendError(ctx.response, 401, 'Bearer token required', 'UNAUTHENTICATED', 'files:create')
    return true
  }
  const scopeGate = requireFilesScope(ctx.request.headers, 'files:write', 'files:create')
  if (!scopeGate.ok) {
    sendError(ctx.response, scopeGate.status, scopeGate.message, scopeGate.code, 'files:create')
    return true
  }
  let body: { name?: string; bytes?: string; base64?: string }
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'files:create')
    return true
  }
  if (typeof body.name !== 'string' || !body.name) {
    sendError(ctx.response, 400, 'expected { name, bytes }', 'INVALID_ARGUMENT', 'files:create')
    return true
  }
  let raw: Buffer
  try {
    raw = body.base64
      ? Buffer.from(body.base64, 'base64')
      : Buffer.from(body.bytes ?? '', 'base64')
  } catch {
    sendError(ctx.response, 400, 'bytes must be base64', 'INVALID_ARGUMENT', 'files:create')
    return true
  }
  if (raw.byteLength === 0) {
    sendError(ctx.response, 400, 'refusing a 0-byte upload', 'INVALID_ARGUMENT', 'files:create')
    return true
  }
  if (raw.byteLength > 100 * 1024 * 1024) {
    sendError(ctx.response, 413, 'upload exceeds 100 MiB cap', 'PAYLOAD_TOO_LARGE', 'files:create')
    return true
  }
  const safeName = basename(body.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
  if (!safeName) {
    sendError(ctx.response, 400, 'invalid file name', 'INVALID_ARGUMENT', 'files:create')
    return true
  }
  const id = `${randomBytes(8).toString('hex')}-${safeName}`
  const target = join(FILES_DIR, id)
  try {
    writeFileSync(target, raw)
  } catch (err) {
    sendError(ctx.response, 500, err instanceof Error ? err.message : String(err), 'INTERNAL', 'files:create')
    return true
  }
  void recordRecentDoc(target, {
    id: basename(id, extname(id)),
    name: safeName,
    modified: false,
  })
  sendJson(ctx.response, 201, { id, path: target, name: safeName, size: raw.byteLength })
  return true
}

/**
 * `GET /api/v1/files/:id`
 *
 * Return file metadata (name, size, modifiedAt) for the given id. Use `/files/:id/jwt` to get an embed URL.
 *
 * **Required scope**: `files:read`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`
 */
export async function handleFilesGet(ctx: { request: IncomingMessage; response: ServerResponse }, id: string): Promise<boolean> {
  const caller = getJwtFromAuth(ctx.request.headers)
  if (!caller) {
    sendError(ctx.response, 401, 'Bearer token required', 'UNAUTHENTICATED', 'files:get')
    return true
  }
  const scopeGate = requireFilesScope(ctx.request.headers, 'files:read', 'files:get')
  if (!scopeGate.ok) {
    sendError(ctx.response, scopeGate.status, scopeGate.message, scopeGate.code, 'files:get')
    return true
  }
  if (caller.doc && caller.doc !== id) {
    sendError(ctx.response, 403, 'token is not authorized for this file', 'FORBIDDEN', 'files:get')
    return true
  }
  const path = join(FILES_DIR, id)
  if (!existsSync(path)) {
    sendError(ctx.response, 404, `file not found: ${id}`, 'NOT_FOUND', 'files:get')
    return true
  }
  try {
    const stat = statSync(path)
    sendJson(ctx.response, 200, { id, name: basename(path), size: stat.size, mtime: stat.mtimeMs, path })
  } catch (err) {
    sendError(ctx.response, 500, err instanceof Error ? err.message : String(err), 'INTERNAL', 'files:get')
  }
  return true
}

/**
 * `DELETE /api/v1/files/:id`
 *
 * Delete a file and remove it from the recents index.
 *
 * **Required scope**: `files:delete`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`
 */
export async function handleFilesDelete(ctx: { request: IncomingMessage; response: ServerResponse }, id: string): Promise<boolean> {
  const caller = getJwtFromAuth(ctx.request.headers)
  if (!caller) {
    sendError(ctx.response, 401, 'Bearer token required', 'UNAUTHENTICATED', 'files:delete')
    return true
  }
  const scopeGate = requireFilesScope(ctx.request.headers, 'files:delete', 'files:delete')
  if (!scopeGate.ok) {
    sendError(ctx.response, scopeGate.status, scopeGate.message, scopeGate.code, 'files:delete')
    return true
  }
  if (caller.doc && caller.doc !== id) {
    sendError(ctx.response, 403, 'token is not authorized for this file', 'FORBIDDEN', 'files:delete')
    return true
  }
  const path = join(FILES_DIR, id)
  if (!existsSync(path)) {
    sendError(ctx.response, 404, `file not found: ${id}`, 'NOT_FOUND', 'files:delete')
    return true
  }
  try {
    unlinkSync(path)
    sendJson(ctx.response, 200, { ok: true, deleted: id })
  } catch (err) {
    sendError(ctx.response, 500, err instanceof Error ? err.message : String(err), 'INTERNAL', 'files:delete')
  }
  return true
}

/**
 * `POST /api/v1/files/:id/jwt`
 *
 * Mint a short-lived, file-scoped JWT (1 hour TTL) bound to a single document id. The token can be passed to the embed URL.
 *
 * **Required scope**: `files:read`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`
 */
export async function handleFilesIssueJwt(ctx: { request: IncomingMessage; response: ServerResponse }, id: string): Promise<boolean> {
  const caller = getJwtFromAuth(ctx.request.headers)
  if (!caller) {
    sendError(ctx.response, 401, 'Bearer token required', 'UNAUTHENTICATED', 'files:jwt')
    return true
  }
  const scopeGate = requireFilesScope(ctx.request.headers, 'files:read', 'files:jwt')
  if (!scopeGate.ok) {
    sendError(ctx.response, scopeGate.status, scopeGate.message, scopeGate.code, 'files:jwt')
    return true
  }
  const path = join(FILES_DIR, id)
  if (!existsSync(path)) {
    sendError(ctx.response, 404, `file not found: ${id}`, 'NOT_FOUND', 'files:jwt')
    return true
  }
  // Short-lived file-scoped token: `doc` claim binds the token to this file
  // so a leaked iframe URL cannot be reused against a different file.
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 3600
  const token = signJwt({
    sub: caller.sub,
    doc: id,
    ...(caller.perm ? { perm: caller.perm } : {}),
    iat: now,
    exp,
    iss: 'genoffice',
    aud: 'genoffice-web',
  })
  sendJson(ctx.response, 200, { token, exp })
  return true
}

/**
 * `POST /api/v1/files/:id/callback`
 *
 * Register a webhook URL that receives `file.saved` events for this file. HMAC-SHA256 signature is added when a `secret` is set.
 *
 * **Required scope**: `files:write`
 *
 * **Errors**: `400 INVALID_ARGUMENT`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 */
export async function handleFilesCallback(ctx: { request: IncomingMessage; response: ServerResponse }, id: string): Promise<boolean> {
  const caller = getJwtFromAuth(ctx.request.headers)
  if (!caller) {
    sendError(ctx.response, 401, 'Bearer token required', 'UNAUTHENTICATED', 'files:callback')
    return true
  }
  const scopeGate = requireFilesScope(ctx.request.headers, 'files:write', 'files:callback')
  if (!scopeGate.ok) {
    sendError(ctx.response, scopeGate.status, scopeGate.message, scopeGate.code, 'files:callback')
    return true
  }
  let body: { url?: string; events?: string[] }
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'files:callback')
    return true
  }
  if (typeof body.url !== 'string' || !body.url) {
    sendError(ctx.response, 400, 'expected { url, events? }', 'INVALID_ARGUMENT', 'files:callback')
    return true
  }
  try {
    const { saveCallback } = await import('../../common/webhooks-store')
    saveCallback({
      fileId: id,
      url: body.url,
      events: Array.isArray(body.events) ? body.events : ['file.saved'],
      createdAt: Date.now(),
    })
    sendJson(ctx.response, 201, { ok: true, fileId: id, url: body.url })
  } catch (err) {
    sendError(ctx.response, 500, err instanceof Error ? err.message : String(err), 'INTERNAL', 'files:callback')
  }
  return true
}

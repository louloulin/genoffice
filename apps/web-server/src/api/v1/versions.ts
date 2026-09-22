/**
 * /api/v1/files/:id/versions[…] — version history (Kestrel M3).
 *
 * Wraps the existing `common/version-history.ts` (which powers the
 * IPC channels `files:list-versions` / `files:read-version` /
 * `files:restore-version` / `files:delete-version`) with an OAuth-scoped
 * REST surface. The IPC channels remain unchanged for renderer parity;
 * this file is the v1-only entry point.
 *
 * Routes:
 *
 *   - `GET    /api/v1/files/:id/versions`              scope `files:read`
 *   - `GET    /api/v1/files/:id/versions/:vid`         scope `files:read`
 *   - `POST   /api/v1/files/:id/versions`              scope `files:write`
 *                                                     body: `{ label?: string }`
 *   - `POST   /api/v1/files/:id/versions/:vid/restore` scope `files:restore`
 *   - `DELETE /api/v1/files/:id/versions/:vid`         scope `files:restore`
 *
 * The new scope `files:restore` is intentionally NOT implied by
 * `files:write`: the B.5.1 #3 design called out that restore is a
 * privileged action (overwrites current state) and warrants its own
 * scope so hosts can mint a "commenter" token with `files:read +
 * files:comment + files:write` but no restore power.
 *
 * @public
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError, readBody } from './http-utils'
import { requireScopeFromHeaders } from './auth'
import {
  listVersions,
  readVersion,
  deleteVersion,
  restoreVersion,
} from '../../common/version-history'

function badRequest(response: ServerResponse, op: string, message: string): void {
  sendError(response, 400, message, 'INVALID_ARGUMENT', op)
}

function notFound(response: ServerResponse, op: string, message: string): void {
  sendError(response, 404, message, 'NOT_FOUND', op)
}

function serverError(response: ServerResponse, op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  sendError(response, 500, message, 'INTERNAL', op)
}

/**
 * GET /api/v1/files/:id/versions
 * @public
 */
export async function handleFilesVersionsList(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
): Promise<boolean> {
  const op = 'files:versions:list'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  const versions = listVersions(fileId)
  // The backend `FileVersionMeta` shape is already the wire shape
  // (1:1 with `apps/sdk/src/types.ts:VersionMeta`). No projection
  // needed; pass through.
  const wireVersions = versions.map((v) => ({
    id: v.id,
    docId: v.docId,
    index: v.index,
    timestamp: v.timestamp,
    size: v.size,
    sha256: v.sha256,
    ...(v.message ? { message: v.message } : {}),
  }))
  sendJson(ctx.response, 200, { fileId, count: wireVersions.length, versions: wireVersions })
  return true
}

/**
 * GET /api/v1/files/:id/versions/:vid
 *
 * Returns the snapshot's bytes base64-encoded in JSON. The SDK
 * round-trips this through `Buffer.from(b64, 'base64')`; the renderer
 * then runs the same preview pipeline as the IPC `files:read-version`
 * channel.
 *
 * We deliberately do NOT stream binary as `application/octet-stream`
 * here because the SDK consumer is JSON-typed and base64 keeps the
 * envelope uniform. For files > 16 MB we recommend the host fetch the
 * raw bytes via the IPC channel instead — the v1 endpoint caps at 16 MB.
 * @public
 */
export async function handleFilesVersionsGet(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
  versionId: string,
): Promise<boolean> {
  const op = 'files:versions:get'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  const snap = readVersion(fileId, versionId)
  if (!snap) {
    notFound(ctx.response, op, `unknown version id: ${versionId}`)
    return true
  }
  if (snap.bytes.length > 16 * 1024 * 1024) {
    sendError(ctx.response, 413, 'version bytes exceed 16 MB; fetch via IPC files:read-version', 'PAYLOAD_TOO_LARGE', op)
    return true
  }
  sendJson(ctx.response, 200, {
    id: snap.meta.id,
    docId: snap.meta.docId,
    index: snap.meta.index,
    timestamp: snap.meta.timestamp,
    size: snap.bytes.length,
    sha256: snap.meta.sha256,
    ...(snap.meta.message ? { message: snap.meta.message } : {}),
    bytes: snap.bytes.toString('base64'),
  })
  return true
}

/**
 * POST /api/v1/files/:id/versions
 *
 * Body: `{ label?: string }`. Creates a manual snapshot of the
 * current file bytes. Returns the new version id.
 * @public
 */
export async function handleFilesVersionsCreate(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
): Promise<boolean> {
  const op = 'files:versions:create'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:write')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  let body: { label?: unknown } = {}
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    badRequest(ctx.response, op, 'invalid JSON body')
    return true
  }
  const label = typeof body.label === 'string' ? body.label : undefined
  if (label !== undefined && label.length > 200) {
    badRequest(ctx.response, op, 'label exceeds 200 chars')
    return true
  }
  try {
    const { captureBeforeSave } = await import('../../common/version-history')
    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { FILES_DIR } = await import('../../common/index')
    const currentPath = join(FILES_DIR, fileId)
    if (!existsSync(currentPath)) {
      notFound(ctx.response, op, `file not found: ${fileId}`)
      return true
    }
    const bytes = readFileSync(currentPath)
    const meta = captureBeforeSave(fileId, bytes, label ?? 'manual snapshot')
    if (!meta) {
      sendError(ctx.response, 409, 'snapshot dedup: identical content already exists', 'NOOP', op)
      return true
    }
    sendJson(ctx.response, 201, {
      id: meta.id,
      docId: meta.docId,
      index: meta.index,
      timestamp: meta.timestamp,
      size: meta.size,
      sha256: meta.sha256,
      ...(meta.message ? { message: meta.message } : {}),
    })
  } catch (err) {
    serverError(ctx.response, op, err)
  }
  return true
}

/**
 * POST /api/v1/files/:id/versions/:vid/restore
 *
 * Captures the current bytes as a "pre-restore snapshot" then swaps
 * the chosen version onto the file path. Returns the new (post-restore)
 * version id which equals the chosen version's id (since the chosen
 * version is now the head).
 * @public
 */
export async function handleFilesVersionsRestore(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
  versionId: string,
): Promise<boolean> {
  const op = 'files:versions:restore'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:restore')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  try {
    const result = restoreVersion(fileId, versionId)
    if (!result.ok) {
      notFound(ctx.response, op, result.error ?? `unknown versionId: ${versionId}`)
      return true
    }
    // The chosen version is now the head; report its id as `version`.
    sendJson(ctx.response, 200, { version: versionId, fileId })
  } catch (err) {
    serverError(ctx.response, op, err)
  }
  return true
}

/**
 * DELETE /api/v1/files/:id/versions/:vid
 *
 * Hard delete a single snapshot. 204 on success, 404 on unknown id.
 * @public
 */
export async function handleFilesVersionsDelete(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
  versionId: string,
): Promise<boolean> {
  const op = 'files:versions:delete'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:restore')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  const ok = deleteVersion(fileId, versionId)
  if (!ok) {
    notFound(ctx.response, op, `unknown version id: ${versionId}`)
    return true
  }
  ctx.response.writeHead(204)
  ctx.response.end()
  return true
}

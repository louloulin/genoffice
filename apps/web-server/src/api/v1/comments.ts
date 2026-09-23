/**
 * /api/v1/files/:id/comments — comments / annotations (Kestrel M2).
 *
 * Five routes per file id:
 *
 *   - `GET    /api/v1/files/:id/comments`     list   (scope `files:read`)
 *   - `POST   /api/v1/files/:id/comments`     add    (scope `files:comment`)
 *   - `PATCH  /api/v1/files/:id/comments/:cid`  resolve toggle (scope `files:comment`)
 *   - `DELETE /api/v1/files/:id/comments/:cid`  remove (scope `files:comment`)
 *
 * The `files:comment` scope is new in Kestrel M2; hosts minting a JWT
 * for a commenter must include it. Read-only viewers only need
 * `files:read`. Admins (`scope: 'admin'` or `*`) bypass scope checks.
 *
 * Comment authors are stamped from the JWT `sub` claim at insert time
 * (the client-supplied author is never trusted). Anchors are passed
 * through opaquely — the renderer + backend pair define the per-app
 * anchor shape (see `CommentAnchor` in `apps/sdk/src/types.ts`).
 *
 * @public
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError, readBody } from './http-utils'
import { requireScopeFromHeaders } from './auth'
import { FILES_DIR, isWithin } from '../../common/index'
import { join } from 'node:path'
import {
  addComment,
  getComment,
  listComments,
  removeComment,
  resolveComment,
  type CommentAnchor,
} from '../../common/comments-store'

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
 * Containment guard for a decoded `:id` path segment.
 *
 * The comments routes key their store on `fileId` rather than a joined
 * path, so a raw traversal does not read disk directly — but accepting
 * `../../etc` as a valid fileId still lets a caller mint comment threads
 * against files that do not exist and pollute the store with entries the
 * file listing can never surface. Reject anything that would escape
 * `FILES_DIR` before it reaches the store. Mirrors the §11.114 guard in
 * `files.ts` / `versions.ts`.
 *
 * Note: this rejects traversal and absolute paths, not "file does not
 * exist" — the comment store intentionally allows anchors on not-yet-saved
 * documents (offline-first drafts), so existence is NOT checked here.
 */
function isSafeFileId(id: string): boolean {
  if (typeof id !== 'string' || id.trim().length === 0 || id.includes('\0')) return false
  return isWithin(FILES_DIR, join(FILES_DIR, id))
}

/**
 * GET /api/v1/files/:id/comments?resolved=true|false
 * @public
 */
export async function handleFilesCommentsList(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
): Promise<boolean> {
  const op = 'files:comments:list'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  if (!isSafeFileId(fileId)) {
    sendError(ctx.response, 400, 'file id is outside managed storage', 'INVALID_ARGUMENT', op)
    return true
  }
  // URL query parsing: `?resolved=true|false`. parentId filter not
  // exposed in v1 (renderer fans out replies client-side).
  const url = new URL(ctx.request.url ?? '/', 'http://placeholder')
  const opts: { resolved?: boolean } = {}
  const r = url.searchParams.get('resolved')
  if (r === 'true') opts.resolved = true
  else if (r === 'false') opts.resolved = false
  const comments = listComments(fileId, opts)
  sendJson(ctx.response, 200, { fileId, count: comments.length, comments })
  return true
}

/**
 * POST /api/v1/files/:id/comments
 *
 * Body: `{ anchor, text, parentId? }`. Author is taken from the JWT
 * `sub` claim; client-supplied `author` is ignored.
 * @public
 */
export async function handleFilesCommentsAdd(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
): Promise<boolean> {
  const op = 'files:comments:add'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:comment')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  if (!isSafeFileId(fileId)) {
    sendError(ctx.response, 400, 'file id is outside managed storage', 'INVALID_ARGUMENT', op)
    return true
  }
  let body: { anchor?: CommentAnchor; text?: string; parentId?: string }
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    badRequest(ctx.response, op, 'invalid JSON body')
    return true
  }
  if (!body.anchor || typeof body.anchor !== 'object') {
    badRequest(ctx.response, op, 'expected { anchor, text, parentId? }')
    return true
  }
  if (typeof body.text !== 'string' || body.text.length === 0) {
    badRequest(ctx.response, op, 'text must be a non-empty string')
    return true
  }
  if (body.text.length > 16_000) {
    badRequest(ctx.response, op, 'text exceeds 16 KB cap')
    return true
  }
  // Reject orphan replies: parentId must point to an existing comment on
  // the SAME file. Without this, an offline-first client that retried a
  // reply after losing the parent (or a buggy renderer) would create
  // dangling pointers that thread UIs can never resolve. Strict on the
  // REST surface (sdk1 §11.4 stable contract); the IPC surface can stay
  // permissive later if a sync story requires it.
  if (body.parentId !== undefined) {
    if (typeof body.parentId !== 'string' || body.parentId.length === 0) {
      badRequest(ctx.response, op, 'parentId must be a non-empty string when provided')
      return true
    }
    const parent = getComment(fileId, body.parentId)
    if (!parent) {
      notFound(ctx.response, op, `parent comment not found: ${body.parentId}`)
      return true
    }
  }
  try {
    const comment = addComment(fileId, {
      author: gate.payload.sub,
      text: body.text,
      anchor: body.anchor,
      ...(body.parentId ? { parentId: body.parentId } : {}),
    })
    sendJson(ctx.response, 201, { comment })
  } catch (err) {
    serverError(ctx.response, op, err)
  }
  return true
}

/**
 * PATCH /api/v1/files/:id/comments/:cid
 *
 * Body: `{ resolved: boolean }`.
 * @public
 */
export async function handleFilesCommentsPatch(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
  commentId: string,
): Promise<boolean> {
  const op = 'files:comments:patch'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:comment')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  if (!isSafeFileId(fileId)) {
    sendError(ctx.response, 400, 'file id is outside managed storage', 'INVALID_ARGUMENT', op)
    return true
  }
  let body: { resolved?: unknown }
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    badRequest(ctx.response, op, 'invalid JSON body')
    return true
  }
  if (typeof body.resolved !== 'boolean') {
    badRequest(ctx.response, op, 'expected { resolved: boolean }')
    return true
  }
  const updated = resolveComment(fileId, commentId, body.resolved)
  if (!updated) {
    notFound(ctx.response, op, `unknown comment id: ${commentId}`)
    return true
  }
  sendJson(ctx.response, 200, { comment: updated })
  return true
}

/**
 * DELETE /api/v1/files/:id/comments/:cid
 *
 * Hard-delete. Returns 204 on success, 404 on unknown id.
 * @public
 */
export async function handleFilesCommentsDelete(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
  commentId: string,
): Promise<boolean> {
  const op = 'files:comments:delete'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:comment')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  if (!isSafeFileId(fileId)) {
    sendError(ctx.response, 400, 'file id is outside managed storage', 'INVALID_ARGUMENT', op)
    return true
  }
  const ok = removeComment(fileId, commentId)
  if (!ok) {
    notFound(ctx.response, op, `unknown comment id: ${commentId}`)
    return true
  }
  ctx.response.writeHead(204)
  ctx.response.end()
  return true
}

/**
 * GET /api/v1/files/:id/comments/:cid
 *
 * Returns a single comment. Optional convenience endpoint for hosts
 * that don't want to fetch the full list and filter client-side.
 * @public
 */
export async function handleFilesCommentsGet(
  ctx: { request: IncomingMessage; response: ServerResponse },
  fileId: string,
  commentId: string,
): Promise<boolean> {
  const op = 'files:comments:get'
  const gate = requireScopeFromHeaders(ctx.request.headers, 'files:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, op)
    return true
  }
  if (!isSafeFileId(fileId)) {
    sendError(ctx.response, 400, 'file id is outside managed storage', 'INVALID_ARGUMENT', op)
    return true
  }
  const c = getComment(fileId, commentId)
  if (!c) {
    notFound(ctx.response, op, `unknown comment id: ${commentId}`)
    return true
  }
  sendJson(ctx.response, 200, { comment: c })
  return true
}

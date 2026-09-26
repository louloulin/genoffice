/**
 * Generic comments capability — `/api/v1/files/:id/comments[/:cid]`.
 *
 * Five routes per file id (see `apps/web-server/src/api/v1/comments.ts`):
 *   - GET    /api/v1/files/:id/comments              list   (scope `files:read`)
 *   - POST   /api/v1/files/:id/comments              add    (scope `files:comment`)
 *   - PATCH  /api/v1/files/:id/comments/:cid         patch  (scope `files:comment`)
 *   - DELETE /api/v1/files/:id/comments/:cid         delete (scope `files:comment`)
 *   - GET    /api/v1/files/:id/comments/:cid         get    (scope `files:read`)
 *
 * Comment authors are stamped from the JWT `sub` claim; the
 * client-supplied author is never trusted. Anchors are app-specific.
 *
 * Zero dataflare coupling.
 */

import {
  RequestError,
  requestJson,
  requestVoid,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'

export interface CommentAnchor {
  range?: unknown
  cell?: unknown
  slideId?: unknown
  [key: string]: unknown
}

export interface CommentRecord {
  id: string
  fileId: string
  author: string
  text: string
  anchor: CommentAnchor
  parentId?: string
  resolved: boolean
  createdAt: number
  updatedAt: number
}

export interface ListCommentsInput {
  fileId: string
  resolved?: boolean
}

export interface ListCommentsResult {
  fileId: string
  count: number
  comments: CommentRecord[]
}

export interface AddCommentInput {
  fileId: string
  anchor: CommentAnchor
  text: string
  parentId?: string
}

export interface PatchCommentInput {
  fileId: string
  commentId: string
  resolved: boolean
}

export interface DeleteCommentInput {
  fileId: string
  commentId: string
}

export interface CommentEnvelope {
  comment: CommentRecord
}

export interface CommentsClientConfig extends RequestConfig {}

const TEXT_MAX = 16_000

export class CommentsClient {
  readonly #config: CommentsClientConfig

  constructor(config: CommentsClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('CommentsClient: baseUrl is required')
    }
    this.#config = config
  }

  async list(
    input: ListCommentsInput,
    options: RequestOptions = {},
  ): Promise<ListCommentsResult> {
    assertFileId(input?.fileId, 'comments:list')
    const params = new URLSearchParams()
    if (input.resolved !== undefined) {
      // Server is strict on `?resolved=` — only "true" or "false", never
      // anything else. Pass it through verbatim.
      params.set('resolved', input.resolved ? 'true' : 'false')
    }
    const path =
      `/api/v1/files/${encodeURIComponent(input.fileId)}/comments` +
      (params.toString() ? `?${params.toString()}` : '')

    const raw = await requestJson<{ fileId?: unknown; count?: unknown; comments?: unknown }>(
      this.#config,
      'GET',
      path,
      undefined,
      'files:comments:list',
      options,
    )
    if (
      !raw ||
      typeof raw.fileId !== 'string' ||
      typeof raw.count !== 'number' ||
      !Array.isArray(raw.comments)
    ) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CommentsClient.list: malformed response',
        status: 200,
        channel: 'files:comments:list',
        detail: raw,
      })
    }
    return {
      fileId: raw.fileId,
      count: raw.count,
      comments: raw.comments.filter(isCommentRecord),
    }
  }

  async add(input: AddCommentInput, options: RequestOptions = {}): Promise<CommentRecord> {
    assertFileId(input?.fileId, 'comments:add')
    if (!isPlainAnchor(input.anchor)) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CommentsClient.add: anchor must be a plain object',
        status: 0,
        channel: 'files:comments:add',
      })
    }
    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CommentsClient.add: text must be a non-empty string',
        status: 0,
        channel: 'files:comments:add',
      })
    }
    if (input.text.length > TEXT_MAX) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: `CommentsClient.add: text exceeds ${TEXT_MAX} char cap`,
        status: 0,
        channel: 'files:comments:add',
      })
    }
    if (input.parentId !== undefined) {
      if (typeof input.parentId !== 'string' || input.parentId.length === 0) {
        throw new RequestError({
          code: 'INVALID_ARGUMENT',
          message: 'CommentsClient.add: parentId must be a non-empty string when provided',
          status: 0,
          channel: 'files:comments:add',
        })
      }
    }
    const body: { anchor: CommentAnchor; text: string; parentId?: string } = {
      anchor: input.anchor,
      text: input.text,
    }
    if (input.parentId !== undefined) body.parentId = input.parentId

    const raw = await requestJson<CommentEnvelope>(
      this.#config,
      'POST',
      `/api/v1/files/${encodeURIComponent(input.fileId)}/comments`,
      body,
      'files:comments:add',
      options,
    )
    if (!raw || !isCommentRecord(raw.comment)) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CommentsClient.add: malformed response',
        status: 201,
        channel: 'files:comments:add',
        detail: raw,
      })
    }
    return raw.comment
  }

  async patch(input: PatchCommentInput, options: RequestOptions = {}): Promise<CommentRecord> {
    assertFileId(input?.fileId, 'comments:patch')
    assertCommentId(input?.commentId, 'comments:patch')
    if (typeof input.resolved !== 'boolean') {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CommentsClient.patch: resolved must be a boolean',
        status: 0,
        channel: 'files:comments:patch',
      })
    }
    const raw = await requestJson<CommentEnvelope>(
      this.#config,
      'PATCH',
      `/api/v1/files/${encodeURIComponent(input.fileId)}/comments/${encodeURIComponent(input.commentId)}`,
      { resolved: input.resolved },
      'files:comments:patch',
      options,
    )
    if (!raw || !isCommentRecord(raw.comment)) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CommentsClient.patch: malformed response',
        status: 200,
        channel: 'files:comments:patch',
        detail: raw,
      })
    }
    return raw.comment
  }

  async delete(
    input: DeleteCommentInput,
    options: RequestOptions = {},
  ): Promise<{ ok: true; fileId: string; commentId: string }> {
    assertFileId(input?.fileId, 'comments:delete')
    assertCommentId(input?.commentId, 'comments:delete')
    await requestVoid(
      this.#config,
      'DELETE',
      `/api/v1/files/${encodeURIComponent(input.fileId)}/comments/${encodeURIComponent(input.commentId)}`,
      undefined,
      'files:comments:delete',
      options,
    )
    return { ok: true, fileId: input.fileId, commentId: input.commentId }
  }

  async get(
    fileId: string,
    commentId: string,
    options: RequestOptions = {},
  ): Promise<CommentRecord> {
    assertFileId(fileId, 'comments:get')
    assertCommentId(commentId, 'comments:get')
    const raw = await requestJson<CommentEnvelope>(
      this.#config,
      'GET',
      `/api/v1/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`,
      undefined,
      'files:comments:get',
      options,
    )
    if (!raw || !isCommentRecord(raw.comment)) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CommentsClient.get: malformed response',
        status: 200,
        channel: 'files:comments:get',
        detail: raw,
      })
    }
    return raw.comment
  }
}

// ── Module-local helpers ────────────────────────────────────────────────────

function assertFileId(fileId: unknown, op: string): asserts fileId is string {
  if (typeof fileId !== 'string' || fileId.length === 0 || fileId.includes('\0')) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: `CommentsClient: fileId must be a non-empty path segment (op=${op})`,
      status: 0,
      channel: `files:${op}`,
    })
  }
}

function assertCommentId(commentId: unknown, op: string): asserts commentId is string {
  if (typeof commentId !== 'string' || commentId.length === 0 || commentId.includes('\0')) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: `CommentsClient: commentId must be a non-empty path segment (op=${op})`,
      status: 0,
      channel: `files:${op}`,
    })
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPlainAnchor(anchor: unknown): anchor is CommentAnchor {
  return isObject(anchor)
}

function isCommentRecord(v: unknown): v is CommentRecord {
  if (!isObject(v)) return false
  return (
    typeof v.id === 'string' &&
    typeof v.fileId === 'string' &&
    typeof v.author === 'string' &&
    typeof v.text === 'string' &&
    isPlainAnchor(v.anchor) &&
    typeof v.resolved === 'boolean' &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number' &&
    (v.parentId === undefined || typeof v.parentId === 'string')
  )
}

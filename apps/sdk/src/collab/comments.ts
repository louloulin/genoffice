/**
 * Collab comments capability — per-document comment threads.
 *
 * Web-server IPC contract (see
 * `apps/web-server/src/collab/history-comments-templates.ts`):
 *
 *   - `comments:list`     POST /api/ipc/comments:list
 *   - `comments:add`      POST /api/ipc/comments:add
 *   - `comments:reply`    POST /api/ipc/comments:reply
 *   - `comments:resolve`  POST /api/ipc/comments:resolve
 *   - `comments:delete`   POST /api/ipc/comments:delete
 *
 * Comment ids and reply ids are server-generated (`comment-<ts>` /
 * `reply-<ts>`); the SDK just relays them back. Replies live inside the
 * parent comment's `replies: CommentReply[]` array.
 *
 * Out of scope: subscribing to comment-add events across tabs. Hook the
 * editor's `comments:added` event for now; W6 adds a `collab:events`
 * SSE channel.
 */
import {
  RequestError,
  ipcError,
  requestIpc,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'

export interface CollabCommentsClientConfig extends RequestConfig {}

export interface CommentReply {
  id: string
  userId: string
  userName: string
  content: string
  timestamp: number
}

export interface DocComment {
  id: string
  userId: string
  userName: string
  content: string
  timestamp: number
  resolved: boolean
  replies: CommentReply[]
  selection?: { start: number; end: number; text: string }
}

export interface CommentAddInput {
  docId: string
  userId: string
  userName: string
  content: string
  selection?: { start: number; end: number; text: string }
}

export interface CommentReplyInput {
  docId: string
  commentId: string
  userId: string
  userName: string
  content: string
}

export interface CommentMutationResult {
  ok: true
  commentId?: string
  replyId?: string
}

export class CollabCommentsClient {
  readonly #config: CollabCommentsClientConfig

  constructor(config: CollabCommentsClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('CollabCommentsClient: baseUrl is required')
    }
    this.#config = config
  }

  async list(docId: string, options: RequestOptions = {}): Promise<DocComment[]> {
    if (typeof docId !== 'string' || !docId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabCommentsClient.list: docId is required',
        status: 0,
        channel: 'comments:list',
      })
    }
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/comments:list',
      { args: [{ docId }] },
      'comments:list',
      options,
    )
    if (!Array.isArray(result)) return []
    const out: DocComment[] = []
    for (const entry of result) {
      const parsed = parseComment(entry)
      if (parsed) out.push(parsed)
    }
    return out
  }

  async add(input: CommentAddInput, options: RequestOptions = {}): Promise<CommentMutationResult> {
    assertAdd(input)
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/comments:add',
      { args: [input] },
      'comments:add',
      options,
    )
    const error = ipcError(result)
    if (error) {
      throw new RequestError({
        code: /not found/i.test(error) ? 'NOT_FOUND' : 'UNKNOWN',
        message: error,
        status: /not found/i.test(error) ? 404 : 200,
        channel: 'comments:add',
        detail: result,
      })
    }
    const commentId = (result as { commentId?: unknown }).commentId
    if (typeof commentId !== 'string') {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CollabCommentsClient.add: response missing commentId',
        status: 200,
        channel: 'comments:add',
        detail: result,
      })
    }
    return { ok: true, commentId }
  }

  async reply(input: CommentReplyInput, options: RequestOptions = {}): Promise<CommentMutationResult> {
    assertReply(input)
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/comments:reply',
      { args: [input] },
      'comments:reply',
      options,
    )
    const error = ipcError(result)
    if (error) {
      throw new RequestError({
        code: /not found/i.test(error) ? 'NOT_FOUND' : 'UNKNOWN',
        message: error,
        status: /not found/i.test(error) ? 404 : 200,
        channel: 'comments:reply',
        detail: result,
      })
    }
    const replyId = (result as { replyId?: unknown }).replyId
    if (typeof replyId !== 'string') {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CollabCommentsClient.reply: response missing replyId',
        status: 200,
        channel: 'comments:reply',
        detail: result,
      })
    }
    return { ok: true, replyId }
  }

  async resolve(
    docId: string,
    commentId: string,
    options: RequestOptions = {},
  ): Promise<{ ok: true }> {
    assertDocCommentId(docId, commentId, 'resolve')
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/comments:resolve',
      { args: [{ docId, commentId }] },
      'comments:resolve',
      options,
    )
    throwIfIpcFailed(result, 'comments:resolve', 'CollabCommentsClient.resolve')
    return { ok: true }
  }

  async delete(
    docId: string,
    commentId: string,
    options: RequestOptions = {},
  ): Promise<{ ok: true }> {
    assertDocCommentId(docId, commentId, 'delete')
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/comments:delete',
      { args: [{ docId, commentId }] },
      'comments:delete',
      options,
    )
    throwIfIpcFailed(result, 'comments:delete', 'CollabCommentsClient.delete')
    return { ok: true }
  }
}

function throwIfIpcFailed(value: unknown, channel: string, label: string): void {
  const error = ipcError(value)
  if (!error) return
  const notFound = /not found/i.test(error)
  throw new RequestError({
    code: notFound ? 'NOT_FOUND' : 'UNKNOWN',
    message: error,
    status: notFound ? 404 : 200,
    channel,
    detail: value,
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseComment(value: unknown): DocComment | null {
  if (!isObject(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.userName !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.timestamp !== 'number' ||
    typeof value.resolved !== 'boolean' ||
    !Array.isArray(value.replies)
  ) {
    return null
  }
  const replies: CommentReply[] = []
  for (const r of value.replies) {
    if (
      isObject(r) &&
      typeof r.id === 'string' &&
      typeof r.userId === 'string' &&
      typeof r.userName === 'string' &&
      typeof r.content === 'string' &&
      typeof r.timestamp === 'number'
    ) {
      replies.push({ id: r.id, userId: r.userId, userName: r.userName, content: r.content, timestamp: r.timestamp })
    }
  }
  const out: DocComment = {
    id: value.id,
    userId: value.userId,
    userName: value.userName,
    content: value.content,
    timestamp: value.timestamp,
    resolved: value.resolved,
    replies,
  }
  if (isObject(value.selection) && typeof value.selection.start === 'number' && typeof value.selection.end === 'number' && typeof value.selection.text === 'string') {
    out.selection = { start: value.selection.start, end: value.selection.end, text: value.selection.text }
  }
  return out
}

function assertAdd(input: CommentAddInput): void {
  if (!input || typeof input !== 'object') {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.add: input is required', status: 0, channel: 'comments:add' })
  }
  if (typeof input.docId !== 'string' || !input.docId) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.add: docId is required', status: 0, channel: 'comments:add' })
  }
  if (typeof input.userId !== 'string' || !input.userId) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.add: userId is required', status: 0, channel: 'comments:add' })
  }
  if (typeof input.userName !== 'string' || !input.userName) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.add: userName is required', status: 0, channel: 'comments:add' })
  }
  if (typeof input.content !== 'string' || !input.content) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.add: content is required', status: 0, channel: 'comments:add' })
  }
}

function assertReply(input: CommentReplyInput): void {
  if (!input || typeof input !== 'object') {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.reply: input is required', status: 0, channel: 'comments:reply' })
  }
  if (typeof input.docId !== 'string' || !input.docId) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.reply: docId is required', status: 0, channel: 'comments:reply' })
  }
  if (typeof input.commentId !== 'string' || !input.commentId) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.reply: commentId is required', status: 0, channel: 'comments:reply' })
  }
  if (typeof input.userId !== 'string' || !input.userId) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.reply: userId is required', status: 0, channel: 'comments:reply' })
  }
  if (typeof input.userName !== 'string' || !input.userName) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.reply: userName is required', status: 0, channel: 'comments:reply' })
  }
  if (typeof input.content !== 'string' || !input.content) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: 'CollabCommentsClient.reply: content is required', status: 0, channel: 'comments:reply' })
  }
}

function assertDocCommentId(docId: string, commentId: string, op: string): void {
  if (typeof docId !== 'string' || !docId) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: `CollabCommentsClient.${op}: docId is required`, status: 0, channel: `comments:${op}` })
  }
  if (typeof commentId !== 'string' || !commentId) {
    throw new RequestError({ code: 'INVALID_ARGUMENT', message: `CollabCommentsClient.${op}: commentId is required`, status: 0, channel: `comments:${op}` })
  }
}
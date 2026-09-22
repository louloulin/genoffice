/**
 * Workbook-specific IPC error codes (sdk1 §11.59 — Workbook error code
 * unification).
 *
 * The renderer's error-handling branches want workbook-specific signals,
 * not generic `INVALID_ARGUMENT` / `NOT_FOUND` / `CORRUPT`. A `workbook:save`
 * failure caused by an unknown sessionId, for example, should be
 * distinguishable from a `workbook:open-path` failure caused by a missing
 * file — both are 404-ish but the recovery path differs (reopen file vs.
 * prompt "session expired, re-open the document?").
 *
 * Every class keeps the same `.message / .code / .channel / .cause` shape
 * `apps/web-server/src/index.ts:sendIpcError()` already serialises, so the
 * envelope changes zero — only the `code` string is more specific.
 *
 * HTTP status mapping is added in `apps/web-server/src/ai/errors.ts`
 * `ipcErrorStatus()`. Workbook codes share status semantics with the
 * generic ones they replaced (404 / 422 / 400 / 500).
 */
export type WorkbookErrorCode =
  | 'WORKBOOK_NOT_FOUND'
  | 'WORKBOOK_CORRUPT'
  | 'WORKBOOK_OPEN_FAILED'
  | 'WORKBOOK_SAVE_FAILED'
  | 'WORKBOOK_INVALID_ARGUMENT'

export class WorkbookError extends Error {
  readonly code: WorkbookErrorCode
  readonly channel: string
  /**
   * Mirror of the optional `cause` chain — kept on the instance so logs
   * retain the underlying parser / sidecar stack. `sendIpcError` does not
   * serialise `cause` (the envelope only carries message/code/channel),
   * but server logs do see it via `console.error(err)`.
   */
  override readonly cause?: unknown

  constructor(
    channel: string,
    code: WorkbookErrorCode,
    reason: string,
    cause?: unknown,
  ) {
    super(reason, cause === undefined ? undefined : { cause })
    this.name = 'WorkbookError'
    this.code = code
    this.channel = channel
    if (cause !== undefined) this.cause = cause
  }
}

export class WorkbookNotFoundError extends WorkbookError {
  constructor(channel: string, reason: string) {
    super(channel, 'WORKBOOK_NOT_FOUND', reason)
    this.name = 'WorkbookNotFoundError'
  }
}

export class WorkbookCorruptError extends WorkbookError {
  constructor(channel: string, reason: string, cause?: unknown) {
    super(channel, 'WORKBOOK_CORRUPT', reason, cause)
    this.name = 'WorkbookCorruptError'
  }
}

export class WorkbookOpenFailedError extends WorkbookError {
  constructor(channel: string, reason: string, cause?: unknown) {
    super(channel, 'WORKBOOK_OPEN_FAILED', reason, cause)
    this.name = 'WorkbookOpenFailedError'
  }
}

export class WorkbookSaveFailedError extends WorkbookError {
  constructor(channel: string, reason: string, cause?: unknown) {
    super(channel, 'WORKBOOK_SAVE_FAILED', reason, cause)
    this.name = 'WorkbookSaveFailedError'
  }
}

export class WorkbookInvalidArgumentError extends WorkbookError {
  constructor(channel: string, reason: string) {
    super(channel, 'WORKBOOK_INVALID_ARGUMENT', reason)
    this.name = 'WorkbookInvalidArgumentError'
  }
}

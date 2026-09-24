/**
 * Typed error thrown by AI handlers that fail with a structured code.
 *
 * The IPC wrapper in `apps/web-server/src/index.ts` reads `.message` to
 * surface the failure; we put a human-readable summary there and keep
 * the machine-readable code/channel/reason on the instance for callers
 * that want to branch on them.
 */
export type WebUnsupportedReason =
  | 'renderer-side skill'
  | 'not implemented'
  | 'no upstream provider'

export class WebUnsupportedError extends Error {
  readonly code = 'WEB_UNSUPPORTED' as const
  readonly channel: string
  readonly reason: WebUnsupportedReason

  constructor(channel: string, reason: WebUnsupportedReason = 'renderer-side skill') {
    super(`Channel '${channel}' is not supported on web; ${reason}.`)
    this.name = 'WebUnsupportedError'
    this.channel = channel
    this.reason = reason
  }

  toJSON(): { code: string; channel: string; reason: WebUnsupportedReason } {
    return { code: this.code, channel: this.channel, reason: this.reason }
  }
}

export class InvalidArgumentError extends Error {
  readonly code: 'INVALID_ARGUMENT'
  readonly channel: string
  constructor(channel: string, reason: string) {
    super(`Invalid argument for '${channel}': ${reason}`)
    this.name = 'InvalidArgumentError'
    this.code = 'INVALID_ARGUMENT'
    this.channel = channel
  }
}

export class NotFoundError extends Error {
  readonly code: 'NOT_FOUND'
  readonly channel: string
  constructor(channel: string, reason: string) {
    super(reason)
    this.name = 'NotFoundError'
    this.code = 'NOT_FOUND'
    this.channel = channel
  }
}

export class CorruptError extends Error {
  readonly code: 'CORRUPT'
  readonly channel: string
  /**
   * `cause` keeps the parser's own stack attached: without it the reason
   * string is all a server log shows, and the throw site inside the parser
   * is lost. The IPC envelope (apps/web-server/src/index.ts sendIpcError)
   * only serializes message/code/channel/reason, so a `cause` here does not
   * reach the client.
   */
  constructor(channel: string, reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause })
    this.name = 'CorruptError'
    this.code = 'CORRUPT'
    this.channel = channel
  }
}

/**
 * HTTP status for a structured IPC error code.
 *
 * Every code except `WEB_UNSUPPORTED` used to answer 500, so a caller that
 * forgot a required argument could not tell its own malformed request from a
 * server fault — and neither could the retry logic.
 */
export function ipcErrorStatus(code: string | undefined): number {
  switch (code) {
    case 'WEB_UNSUPPORTED':
      return 501
    case 'INVALID_ARGUMENT':
      return 400
    case 'NOT_FOUND':
      return 404
    case 'CORRUPT':
      return 422
    case 'WORKBOOK_NOT_FOUND':
      return 404
    case 'WORKBOOK_CORRUPT':
      return 422
    case 'WORKBOOK_OPEN_FAILED':
    case 'WORKBOOK_SAVE_FAILED':
      return 422
    case 'WORKBOOK_INVALID_ARGUMENT':
      return 400
    case 'PAYLOAD_TOO_LARGE':
      return 413
    case 'CLIENT_ABORTED':
      return 400
    default:
      return 500
  }
}

/**
 * A handler that destructures its single object argument
 * (`(_event, args) => { const { docId } = args as … }`) throws a raw
 * `TypeError` when the caller omits `args` altogether: "Cannot destructure
 * property 'docId' of 'args' as it is undefined". `args` is optional on the
 * wire (`{ args = [] }` in the dispatcher), so this is a malformed request —
 * but it surfaced as HTTP 500, and 85 of the 531 registered channels answered
 * a no-argument call that way.
 *
 * Defaulting `args` to `{}` in the dispatcher would be worse than the 500: a
 * handler like `collab:join` would go on to build the session key
 * `"undefined:undefined"` instead of failing. Classify it instead.
 */
const MISSING_ARGS_TYPE_ERROR =
  /Cannot destructure property .* of .*as it is undefined|Cannot read properties of undefined \(reading/

/**
 * Best-effort classifier: if the IPC reply is already a structured error
 * code (the renderer emitted one via `throw { code, channel, reason }`),
 * surface the matching class; otherwise wrap the original.
 */
export function classifyWebError(err: unknown, fallbackChannel: string): Error {
  if (err instanceof Error) {
    if (err.name === 'TypeError' && MISSING_ARGS_TYPE_ERROR.test(err.message)) {
      return new InvalidArgumentError(
        fallbackChannel,
        `${fallbackChannel} was called without its required argument object`,
      )
    }
    return err
  }
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; channel?: unknown; reason?: unknown }
    if (e.code === 'WEB_UNSUPPORTED') {
      return new WebUnsupportedError(
        typeof e.channel === 'string' ? e.channel : fallbackChannel,
        (typeof e.reason === 'string' ? e.reason : 'renderer-side skill') as WebUnsupportedReason,
      )
    }
    if (e.code === 'INVALID_ARGUMENT') {
      return new InvalidArgumentError(
        typeof e.channel === 'string' ? e.channel : fallbackChannel,
        typeof e.reason === 'string' ? e.reason : 'invalid argument',
      )
    }
    if (e.code === 'NOT_FOUND') {
      return new NotFoundError(
        typeof e.channel === 'string' ? e.channel : fallbackChannel,
        typeof e.reason === 'string' ? e.reason : 'not found',
      )
    }
    if (e.code === 'CORRUPT') {
      return new CorruptError(
        typeof e.channel === 'string' ? e.channel : fallbackChannel,
        typeof e.reason === 'string' ? e.reason : 'corrupt data',
      )
    }
  }
  return err instanceof Error ? err : new Error(String(err))
}

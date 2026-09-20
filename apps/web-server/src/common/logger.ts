/**
 * The single funnel for structured server output.
 *
 * `console.log` scattered across handlers produces unstructured lines that no
 * log collector can index, and it cannot be captured in a test without
 * monkey-patching the global. Every record here is one JSON object on stderr:
 *
 * ```json
 * {"ts":"2026-09-19T22:13:55.123Z","level":"warn","module":"file-index",
 *  "msg":"flush failed","err":{"name":"Error","message":"…","stack":"…"}}
 * ```
 *
 * One record per line means `grep`/`jq` work without a parser, and `err` is
 * flattened so the record stays JSON-clean (an `Error` serialises to `{}`,
 * which is why it cannot simply be passed through).
 */
import { inspect } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: string
  level: LogLevel
  module: string
  msg: string
  [key: string]: unknown
}

export type LogSink = (record: LogRecord) => void

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let minLevel: LogLevel = (process.env.GENOFFICE_LOG_LEVEL as LogLevel) || 'info'

let sink: LogSink = (record) => {
  /* stderr, not stdout: stdout is the server's data channel in some
   * deployments, and mixing diagnostics into it corrupts the stream. */
  process.stderr.write(`${JSON.stringify(record)}\n`)
}

/** Replace the destination. Returns the previous sink so a test can restore
 *  it instead of leaking a capture across suites. */
export function installLoggerSink(next: LogSink): LogSink {
  const previous = sink
  sink = next
  return previous
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/** Flatten an unknown thrown value into a JSON-safe shape. */
function flattenError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (value === undefined || value === null) return value
  if (typeof value === 'object') {
    /* Circular references would make JSON.stringify throw, which would take
     * the logger (and the caller) down while reporting a failure. */
    try {
      JSON.stringify(value)
      return value
    } catch {
      return inspect(value, { depth: 3, breakLength: Infinity })
    }
  }
  return value
}

function emit(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return
  const record: LogRecord = { ts: new Date().toISOString(), level, module, msg }
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      record[key] = key === 'err' ? flattenError(value) : flattenError(value)
    }
  }
  try {
    sink(record)
  } catch {
    /* A failing sink must never break the request that was being logged. */
  }
}

export const log = {
  debug: (module: string, msg: string, meta?: Record<string, unknown>) =>
    emit('debug', module, msg, meta),
  info: (module: string, msg: string, meta?: Record<string, unknown>) =>
    emit('info', module, msg, meta),
  warn: (module: string, msg: string, meta?: Record<string, unknown>) =>
    emit('warn', module, msg, meta),
  error: (module: string, msg: string, meta?: Record<string, unknown>) =>
    emit('error', module, msg, meta),
}

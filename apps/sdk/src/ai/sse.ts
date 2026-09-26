/**
 * Minimal SSE (text/event-stream) parser over a fetch `Response`.
 *
 * Implements the subset the web-server emits:
 *   event: <name>\n
 *   data: <json-or-text>\n
 *   \n
 *
 * Multiple `data:` lines per event are concatenated with '\n' (per spec),
 * but every server event in this build is single-line JSON, so the loop
 * emits one parsed value per terminator.
 *
 * The parser is deliberately lenient:
 *   - Blank lines are event terminators (per spec).
 *   - Lines without `event:` / `data:` are ignored (comment lines, id:, retry:).
 *   - A `data:` line whose payload is not valid JSON is delivered as a raw
 *     string — that lets the SSE error handler surface `message: "..."`
 *     fragments without inventing JSON shape.
 */
export interface SseEvent {
  event: string
  data: string
}

export interface SseParser {
  /**
   * Pull the next parsed event from the stream. Resolves to `null` when
   * the underlying response body ends cleanly (no more chunks). Throws
   * `RequestError` on network failure or abort.
   */
  next(): Promise<SseEvent | null>
  /** Release the underlying reader. Safe to call multiple times. */
  close(): void
}

import { RequestError } from '../internal/request'

export async function openSseStream(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  channel: string,
): Promise<{ response: Response; parser: SseParser }> {
  const response = await fetchImpl(url, init)
  if (!response.ok) {
    // The server's SSE endpoint falls back to JSON errors before the SSE
    // headers go out, so a non-2xx here is a real HTTP error — surface it.
    const text = await safeReadText(response)
    throw new RequestError({
      code: 'INTERNAL',
      message: `${channel}: HTTP ${response.status}` + (text ? ` — ${text}` : ''),
      status: response.status,
      channel,
    })
  }
  if (!response.body) {
    throw new RequestError({
      code: 'INTERNAL',
      message: `${channel}: response has no body`,
      status: response.status,
      channel,
    })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let closed = false

  const parser: SseParser = {
    async next() {
      if (closed) return null
      // Loop until either we have a complete event or the stream ends.
      // The server only ever emits single-line JSON, so the buffer rarely
      // holds more than one event at a time; this loop is the safety net
      // for back-to-back events that arrive in the same TCP packet.
      while (true) {
        const idx = buffer.indexOf('\n\n')
        if (idx >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const parsed = parseEvent(raw)
          if (parsed) return parsed
          // A blank line with no event/data — keep scanning.
          continue
        }
        const { value, done } = await reader.read()
        if (done) {
          closed = true
          if (buffer.trim().length > 0) {
            const parsed = parseEvent(buffer)
            buffer = ''
            return parsed
          }
          return null
        }
        buffer += decoder.decode(value, { stream: true })
      }
    },
    close() {
      if (closed) return
      closed = true
      // `reader.cancel()` returns a promise, and it rejects with the abort
      // reason whenever the fetch signal already fired — i.e. on every
      // unsubscribe-from-a-live-stream, the common path. Left floating that
      // rejection surfaces as an `unhandledrejection` in a browser and takes
      // down a Node host, so it is swallowed here. A synchronous throw from
      // an already-torn-down reader is swallowed too; there is nothing to
      // recover either way.
      try {
        void reader.cancel().catch(() => {})
      } catch {
        /* ignore */
      }
    },
  }
  return { response, parser }
}

function parseEvent(raw: string): SseEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
    // ignore id:, retry:, comments (starting with `:`)
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
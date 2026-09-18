import type { AgentImage, AgentMessage, AgentToolCall, AgentToolDef } from '../agent-protocol'

// ---- streaming (SSE line splitting shared by all providers) ----

export async function* sseLines(
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  onBytes?: () => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const stream = body as ReadableStream<Uint8Array>
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onBytes?.()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) yield line
    }
    if (buffer) yield buffer
  } finally {
    // The consumer may abandon this generator mid-stream (an in-band gateway
    // error thrown inside the for-await loop calls .return()). Without this
    // cleanup the reader stays locked and the underlying socket is not
    // returned to the pool until GC nondeterministically finalizes it.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export interface StreamCallbacks {
  onDelta: (text: string) => void
  onToolCall: (call: AgentToolCall) => void
  /** raw model reasoning deltas (reasoning_content); stored so interleaved-thinking models get it echoed back */
  onReasoningDelta?: (text: string) => void
  /** normalized stop reason ('max_tokens' when the output was cut off by the token limit) */
  onStopReason?: (reason: string) => void
  /** bytes arrived on the wire (fires per network chunk, including SSE pings; used for keepalive) */
  onActivity?: () => void
  /** Stable renderer transport id for providers with native sessions. */
  sessionId?: string
  signal: AbortSignal
}

/**
 * Models occasionally emit unescaped " inside string values (e.g. English quotes in Chinese copy).
 * Single-pass scan: a " inside a string whose next non-whitespace char is not structural gets escaped.
 */
function repairUnescapedQuotes(json: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!
    if (!inStr) {
      if (c === '"') inStr = true
      out += c
      continue
    }
    if (c === '\\') {
      out += c + (json[++i] ?? '')
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < json.length && ' \n\r\t'.includes(json[j]!)) j++
      const next = json[j]
      if (next === undefined || ',}]:'.includes(next)) {
        inStr = false
        out += c
      } else {
        out += '\\"'
      }
      continue
    }
    out += c
  }
  return out
}

/**
 * Gateways can report failures (quota exhausted, moderation, upstream errors) inside a
 * 200 SSE stream, in shapes that don't match the provider protocol (e.g. an OpenAI-style
 * `{"error": ...}` event on the Anthropic route). Extract a readable message so these
 * surface as real errors instead of dissolving into an empty "successful" turn.
 */
export function sseErrorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
    try {
      return JSON.stringify(error)
    } catch {
      /* circular or otherwise unserializable — use the fallback */
    }
  }
  return fallback
}

/**
 * Gateways can answer a `stream: true` request with a complete non-SSE JSON body —
 * observed on the Genspark Anthropic route when credits are exhausted (HTTP 200,
 * Content-Type: application/json, the notice text inside a regular message). The SSE
 * parser would find no `data:` lines in such a body and dissolve it into an empty
 * "successful" turn. Returns the body text when that happens, else null.
 */
export async function jsonBodyInsteadOfSse(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.toLowerCase().includes('application/json') ? await response.text() : null
}

/**
 * A non-SSE JSON reply whose text is the gateway's credits-exhausted notice
 * (Genspark: "Your Genspark credits have been exhausted…") surfaces as a typed
 * error so the apps show a localized "top up" message (errorCode 'credits')
 * instead of the English notice as a normal assistant reply.
 */
export class AiCreditsError extends Error {
  constructor(notice: string) {
    super(notice)
    this.name = 'AiCreditsError'
  }
}

function creditsNoticeText(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.toLowerCase()
    const credits =
      t.includes('genspark.ai/pricing') ||
      (t.includes('credit') && (t.includes('exhausted') || t.includes('insufficient')))
    return credits ? value : null
  }
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    for (const v of Object.values(value)) {
      const hit = creditsNoticeText(v)
      if (hit) return hit
    }
  }
  return null
}

export function throwIfCreditsNotice(bodyText: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return // unparseable bodies are the emit helpers' problem
  }
  const notice = creditsNoticeText(parsed)
  if (notice) throw new AiCreditsError(notice)
}

/**
 * Streaming-safe stripper for inline `think` blocks in the chat reply.
 *
 * MiniMax M3 (and a few other reasoning models) emit their reasoning inline in
 * `message.content` rather than in the separate `reasoning_content` field, so a
 * streamed chat reply used to arrive at the renderer as
 * `<think>…private reasoning…</think>answer`. The non-streaming path already
 * filtered this, but a stream cannot run the same regex: the tag may be split
 * across deltas (`<thi` + `nk>`), so a per-delta replace both misses the block
 * and keeps the partial tag. This class buffers across deltas and only emits
 * text it knows is outside a think block.
 *
 * Text is held back only while it could still become a tag: `open` until the
 * opening tag is resolved, `closing` until the closing tag is resolved.
 * Everything else is forwarded immediately so streaming stays incremental.
 */
export class ThinkTagFilter {
  private mode: 'open' | 'body' | 'closing' | 'text' = 'text'
  private pending = ''
  /**
   * Set right after a think block closes. The newline(s) the model writes
   * between its reasoning and its answer are a separator, not content — the
   * non-streaming path trims them, so the stream must too or the two shapes
   * disagree and the reply starts with a blank line.
   */
  private trimLeading = false
  /** chars held back because a fresh `<` might start a tag */
  private static readonly MAX_TAG_LEN = 32

  /** Feed one delta; returns the user-visible text and any reasoning it unlocks. */
  push(chunk: string): { text: string; reasoning: string } {
    if (!chunk) return { text: '', reasoning: '' }
    let out = ''
    let reasoning = ''
    let rest = this.pending + chunk
    this.pending = ''

    while (rest.length > 0) {
      if (this.mode === 'body') {
        // Everything up to `</think>` is the model's private reasoning: route
        // it to the reasoning channel so the UI can still show it collapsed.
        const close = /<\/think\s*>/i.exec(rest)
        if (close) {
          reasoning += rest.slice(0, close.index)
          rest = rest.slice(close.index + close[0].length)
          this.mode = 'text'
          this.trimLeading = true
          continue
        }
        const hold = partialCloseSuffix(rest)
        if (hold > 0) {
          reasoning += rest.slice(0, rest.length - hold)
          this.pending = rest.slice(rest.length - hold)
        } else {
          reasoning += rest
        }
        return { text: out, reasoning }
      }

      if (this.mode === 'open') {
        // Scanning for the `>` that ends an opening tag.
        const gt = rest.indexOf('>')
        if (gt < 0) {
          this.pending = rest.slice(-ThinkTagFilter.MAX_TAG_LEN)
          return { text: out, reasoning }
        }
        const tag = rest.slice(0, gt + 1)
        rest = rest.slice(gt + 1)
        this.mode = /^<think\b/i.test(tag) ? 'body' : 'text'
        if (this.mode === 'text') out += tag
        continue
      }

      // `text` mode: forward everything except a possible tag opener.
      if (this.trimLeading) {
        const stripped = rest.replace(/^\s+/, '')
        if (stripped.length === 0) {
          // all separator whitespace so far; wait for real content
          this.pending = ''
          return { text: out, reasoning }
        }
        this.trimLeading = false
        rest = stripped
      }
      const lt = rest.indexOf('<')
      if (lt < 0) {
        out += rest
        return { text: out, reasoning }
      }
      out += rest.slice(0, lt)
      const tail = rest.slice(lt)
      const prefix = '<think'.slice(0, tail.length)
      if (tail.length < 6 && prefix.toLowerCase() === tail.toLowerCase()) {
        // Could still become `<think…`; wait for the next delta.
        this.pending = tail
        return { text: out, reasoning }
      }
      if (/^<think\b/i.test(tail)) {
        this.mode = 'open'
        rest = tail
        continue
      }
      out += '<'
      rest = tail.slice(1)
    }
    return { text: out, reasoning }
  }

  /**
   * Flush at end-of-stream. A truncated think block stays hidden (the model was
   * still reasoning when it stopped); a partial plain tag is returned as-is.
   */
  flush(): { text: string; reasoning: string } {
    const held = this.pending
    this.pending = ''
    if (this.mode === 'body' || this.mode === 'open') {
      this.mode = 'text'
      return { text: '', reasoning: held }
    }
    const out = this.mode === 'text' ? held : ''
    this.mode = 'text'
    return { text: out, reasoning: '' }
  }
}

/** Length of the trailing substring that could be a prefix of `</think>`. */
function partialCloseSuffix(text: string): number {
  const marker = '</think>'
  const max = Math.min(marker.length - 1, text.length)
  for (let len = max; len > 0; len--) {
    if (text.slice(-len).toLowerCase() === marker.slice(0, len)) return len
  }
  return 0
}

/** Whole-string variant for non-streaming bodies; keeps `reasoning` separate. */
export function stripThinkTags(raw: string): string {
  if (!raw) return ''
  return raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim()
}
/** Don't throw on parse failure (it would kill the whole stream); return error so the loop feeds it back for retry */
export function parseToolInput(json: string): { input: Record<string, unknown>; error?: string } {
  if (!json.trim()) return { input: {} }
  try {
    return { input: JSON.parse(json) as Record<string, unknown> }
  } catch (e) {
    try {
      return { input: JSON.parse(repairUnescapedQuotes(json)) as Record<string, unknown> }
    } catch {
      const msg = e instanceof Error ? e.message : String(e)
      return { input: {}, error: `${msg}; raw: ${json.slice(0, 500)}` }
    }
  }
}

/**
 * Real end-to-end proof of the SDK 2.0 Kestrel host→editor command
 * round-trip (sdk1.md §11.36.5):
 *
 *   host SDK ──makeCommand──► postMessage ──bridge.onHost────►
 *     installTextBufferSink ──buffer────► reply
 *
 * The two halves (embed bridge + renderer sink adapter) were
 * originally built in separate commits (7c7f878 + a2cbcfc + 043051e).
 * This test wires them together with real envelopes from
 * `@genoffice/sdk/envelope` to prove the wire contract fits — and
 * specifically that the text-buffer adapter's setContent /
 * getContent / insertText commands round-trip through the bridge.
 *
 * Same harness pattern as `embed-bridge-renderer-sink-e2e.test.ts`:
 * bridge IIFE evaluated in a controlled scope + the genuine
 * package implementations.
 */
import { describe, expect, it } from 'vitest'
import { EMBED_BRIDGE_SOURCE } from '../src/embed/bridge'
import {
  installTextBufferSink,
  updateTextBuffer,
  onBufferChange,
} from '@genoffice/ipc-bridge/text-buffer-adapter'
// Inlined envelope helpers (mirroring @genoffice/sdk/envelope) so this
// suite stays self-contained — apps/web-server doesn't depend on
// @genoffice/sdk and pulling the wire format in directly keeps the
// test honest about what is on the wire.
const ENVELOPE_VERSION = '1.0' as const

interface CommandEnvelopePayload {
  name: string
  args?: unknown
}

interface Envelope<T = unknown> {
  v: typeof ENVELOPE_VERSION
  dir: 'host→editor' | 'editor→host'
  kind: 'event' | 'command' | 'command-result'
  correlationId?: string
  payload: T
}

function makeCommand(name: string, args: unknown, correlationId: string): Envelope<CommandEnvelopePayload> {
  return {
    v: ENVELOPE_VERSION,
    dir: 'host→editor',
    kind: 'command',
    correlationId,
    payload: { name, args },
  }
}

interface Harness {
  parentPosts: Array<{ data: unknown }>
  messageHandlers: Array<(event: { data: unknown }) => void>
  window: Record<string, unknown>
}

function evalBridgeWithSink(opts?: {
  bufferText?: string
  onChange?: (s: { text: string; bytes: number }) => void
  cursor?: number
}): Harness {
  // Optional call sites (tests 4–5) pass no opts at all; coalesce to {}
  // before touching `opts.bufferText` so we never throw at `undefined.x`.
  const o = opts ?? {}
  const parentPosts: Array<{ data: unknown }> = []
  const messageHandlers: Array<(event: { data: unknown }) => void> = []

  // ONE settable object backs both the bridge's `window` view and the
  // sink's `target` arg. Earlier getter-only harnesses threw
  // "which has only a getter" when installSdkCommandSink assigned to
  // __GENOFFICE_COMMAND_SINK__.
  const fakeWindow: Record<string, unknown> = Object.assign({}, {
    __GENOFFICE_EMBED__: { app: 'docs', sessionId: 'session-rt', docId: 'rt.docx' },
    parent: { postMessage: (data: unknown) => parentPosts.push({ data }) },
    addEventListener: (evt: string, handler: (event: { data: unknown }) => void) => {
      if (evt === 'message') messageHandlers.push(handler)
    },
    dispatchEvent: () => undefined,
  })
  const fakeDocument = {
    readyState: 'complete',
    querySelector: () => null,
  }
  const fn = new Function(
    'window',
    'document',
    'EventSource',
    'setTimeout',
    'CustomEvent',
    'fetch',
    EMBED_BRIDGE_SOURCE,
  )
  fn(fakeWindow, fakeDocument, class { close() {} }, setTimeout, class {}, async () => ({ ok: true }))

  // Install the sink AFTER the bridge is on the window. The bridge
  // reads `window.__GENOFFICE_COMMAND_SINK__` lazily on each command,
  // so order does not matter — but installing after evals makes the
  // test read more naturally ("the editor mounts the sink").
  installTextBufferSink({ target: fakeWindow as never })
  if (o.bufferText !== undefined) {
    updateTextBuffer({
      text: o.bufferText,
      bytes: new TextEncoder().encode(o.bufferText).length,
      ...(typeof o.cursor === 'number' ? { cursor: o.cursor } : {}),
    }, fakeWindow as never)
  }
  if (o.onChange) {
    onBufferChange(o.onChange, fakeWindow as never)
  }
  return { parentPosts, messageHandlers, window: fakeWindow }
}

function deliver(harness: Harness, env: Envelope): void {
  // The bridge onHostMessage reads .data on the event arg.
  const event = { data: env }
  for (const handler of harness.messageHandlers) handler(event)
}

async function flush(): Promise<void> {
  // The bridge wraps sink replies in `Promise.resolve(...).then(...)`, so
  // `parent.postMessage` happens on a microtask, not synchronously inside
  // `deliver()`. Drain a few ticks before asserting on the wire.
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function lastReply(harness: Harness, correlationId: string): {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
} | null {
  for (const post of harness.parentPosts) {
    const env = post.data as Envelope | null
    if (!env || env.kind !== 'command-result') continue
    if (env.correlationId !== correlationId) continue
    return env.payload as { ok: boolean; result?: unknown; error?: { code: string; message: string } }
  }
  return null
}

describe('SDK host → bridge → text-buffer sink round-trip (sdk1.md §11.36.5)', () => {
  it('getContent returns the current buffer state', async () => {
    const h = evalBridgeWithSink({ bufferText: 'before save' })
    const env = makeCommand('getContent', {}, 'corr-get-1')
    deliver(h, env)
    await flush()
    const reply = lastReply(h, 'corr-get-1')
    expect(reply).not.toBeNull()
    expect(reply!.ok).toBe(true)
    const result = reply!.result as { text?: string; bytes?: number }
    expect(result.text).toBe('before save')
    expect(result.bytes).toBe('before save'.length)
  })

  it('setContent replaces the buffer and fires change listeners', async () => {
    const seen: string[] = []
    const h = evalBridgeWithSink({
      bufferText: 'old',
      onChange: (s) => seen.push(s.text),
    })
    deliver(h, makeCommand('setContent', { text: 'host-replaced' }, 'corr-set-1'))
    await flush()
    const reply = lastReply(h, 'corr-set-1')
    expect(reply?.ok).toBe(true)
    expect(seen).toEqual(['host-replaced'])
  })

  it('insertText appends and advances the cursor', async () => {
    // Buffer starts with cursor=0 by default; seed cursor to text length so
    // `insertAt(cursor, text)` lands at the end (the SDK `insertText`
    // contract is "insert at the current cursor", not "always prepend").
    const h = evalBridgeWithSink({ bufferText: 'foo', cursor: 'foo'.length })
    deliver(h, makeCommand('insertText', { text: 'bar' }, 'corr-ins-1'))
    await flush()
    const reply = lastReply(h, 'corr-ins-1')
    expect(reply?.ok).toBe(true)
    deliver(h, makeCommand('getContent', {}, 'corr-get-2'))
    await flush()
    const reply2 = lastReply(h, 'corr-get-2')
    const v = reply2!.result as { text?: string }
    expect(v.text).toBe('foobar')
  })

  it('an unsupported command (e.g. setLang with no adapter) replies with UNSUPPORTED', async () => {
    // installTextBufferSink registers setText / insertText / getText /
    // getBytes only — setLang is absent, so the bridge forwards the
    // command to the sink which throws UnsupportedCommandError.
    const h = evalBridgeWithSink()
    deliver(h, makeCommand('setLang', { lang: 'zh-CN' }, 'corr-lang-1'))
    await flush()
    const reply = lastReply(h, 'corr-lang-1')
    expect(reply).not.toBeNull()
    expect(reply!.ok).toBe(false)
    expect(reply!.error?.code).toBe('UNSUPPORTED')
  })

  it('envelope version mismatch is dropped at the bridge — no reply fires', async () => {
    const h = evalBridgeWithSink()
    const stale: Envelope<CommandEnvelopePayload> = {
      v: '0.9' as typeof ENVELOPE_VERSION,
      dir: 'host→editor',
      kind: 'command',
      correlationId: 'corr-stale',
      payload: { name: 'getContent', args: {} },
    }
    deliver(h, stale)
    await flush()
    const reply = lastReply(h, 'corr-stale')
    expect(reply).toBeNull()
  })
})

/**
 * Integration proof: the real renderer sink
 * (`@genoffice/ipc-bridge/sdk-command-sink`) drives the real embed
 * bridge (§11.36).
 *
 * The two sides were built in separate commits (7c7f878 added the
 * bridge's `window.__GENOFFICE_COMMAND_SINK__` lookup; a2cbcfc added the
 * renderer installer). Each has its own unit suite with a MOCKED
 * counterpart, so neither proves the two actually fit together. This
 * test wires the real installer into the real bridge IIFE and drives a
 * full `editor.command()` round-trip.
 *
 * It is the closest thing to a browser without a browser: bridge IIFE
 * evaluated in a controlled scope (same harness technique as
 * embed-bridge.test.ts) + the genuine package implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBED_BRIDGE_SOURCE } from '../src/embed/bridge'
import {
  UnsupportedCommandError,
  defaultSdkCommandHandlers,
  installSdkCommandSink,
  makeOpenFileDialogHandler,
  type SdkCommandSinkTarget,
} from '@genoffice/ipc-bridge/sdk-command-sink'

interface Harness {
  parentPosts: Array<{ data: unknown }>
  messageHandlers: Array<(event: { data: unknown }) => void>
  fetchCalls: Array<{ url: string; init: RequestInit }>
  window: SdkCommandSinkTarget & Record<string, unknown>
}

function evalBridge(target: SdkCommandSinkTarget & Record<string, unknown>): Harness {
  const harness: Harness = { parentPosts: [], messageHandlers: [], fetchCalls: [], window: target }
  // ONE object serves as both the fake `window` the bridge reads and the
  // `target` the real sink installer writes to. A plain settable property
  // (not a getter) is required — installSdkCommandSink assigns to it, and
  // a getter-only shape throws "which has only a getter".
  const fakeWindow = Object.assign(target, {
    __GENOFFICE_EMBED__: { app: 'docs', sessionId: 'embed-integration', docId: 'fixture.docx' },
    parent: { postMessage: (data: unknown) => { harness.parentPosts.push({ data }) } },
    addEventListener: (evt: string, handler: (event: { data: unknown }) => void) => {
      if (evt === 'message') harness.messageHandlers.push(handler)
    },
    dispatchEvent: () => undefined,
  })
  const fakeDocument = {
    readyState: 'complete',
    querySelector: () => null,
  }
  class FakeEventSource {
    onmessage: unknown = null
    onerror: unknown = null
    constructor(public url: string) {}
    close() {}
  }
  const fakeFetch = async (url: string, init: RequestInit) => {
    harness.fetchCalls.push({ url, init })
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: null }) }
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
  fn(fakeWindow, fakeDocument, FakeEventSource, setTimeout, class {}, fakeFetch)
  harness.window = fakeWindow as unknown as Harness['window']
  return harness
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function resultFor(h: Harness, correlationId: string) {
  const post = h.parentPosts.find((p) => {
    const d = p.data as { kind?: string; correlationId?: string }
    return d.kind === 'command-result' && d.correlationId === correlationId
  })
  return post?.data as
    | { kind: string; correlationId: string; payload: { ok: boolean; result?: unknown; error?: { code: string; message: string } } }
    | undefined
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('renderer sink ↔ embed bridge integration (§11.36)', () => {
  it('routes a renderer-handled command through the real sink (no IPC POST)', async () => {
    const target: SdkCommandSinkTarget & Record<string, unknown> = {}
    const h = evalBridge(target)
    // Install the REAL package sink, exactly as every renderer does at boot.
    installSdkCommandSink({
      target: h.window,
      handlers: {
        ...defaultSdkCommandHandlers(),
        setTheme: (args) => `theme:${(args as { theme: string }).theme}`,
      },
    })
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'int-1',
        payload: { name: 'setTheme', args: { theme: 'dark' } },
      },
    })
    await flush()
    const result = resultFor(h, 'int-1')
    expect(result).toBeDefined()
    expect(result!.payload.ok).toBe(true)
    expect(result!.payload.result).toBe('theme:dark')
    // The sink handled it — the server channel must NOT have been hit.
    expect(h.fetchCalls).toHaveLength(0)
  })

  it('surfaces the package UnsupportedCommandError code verbatim to the host', async () => {
    const target: SdkCommandSinkTarget & Record<string, unknown> = {}
    const h = evalBridge(target)
    installSdkCommandSink({ target: h.window, handlers: defaultSdkCommandHandlers() })
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'int-2',
        payload: { name: 'setContent', args: { content: 'x' } },
      },
    })
    await flush()
    const result = resultFor(h, 'int-2')
    expect(result!.payload.ok).toBe(false)
    expect(result!.payload.error!.code).toBe('UNSUPPORTED')
    expect(result!.payload.error!.message).toContain('setContent')
    expect(h.fetchCalls).toHaveLength(0)
  })

  it('falls back to the server channel when no sink is installed', async () => {
    const target: SdkCommandSinkTarget & Record<string, unknown> = {}
    const h = evalBridge(target)
    // Deliberately do NOT install a sink.
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'int-3',
        payload: { name: 'listComments', args: {} },
      },
    })
    await flush()
    expect(h.fetchCalls).toHaveLength(1)
    expect(h.fetchCalls[0]!.url).toBe('/api/ipc/sdk%3Acommand')
  })

  it('openFileDialog dismissal round-trips as {canceled:true} through the bridge', async () => {
    const target: SdkCommandSinkTarget & Record<string, unknown> = {}
    const h = evalBridge(target)
    // Stub the DOM the handler touches so the picker resolves as dismissed.
    const savedDoc = (globalThis as { document?: unknown }).document
    ;(globalThis as { document?: unknown }).document = {
      body: { appendChild: () => undefined },
      createElement: () => {
        const listeners: Record<string, () => void> = {}
        return {
          style: {},
          files: [],
          addEventListener: (e: string, cb: () => void) => { listeners[e] = cb },
          remove: () => undefined,
          click: () => { listeners['change']?.() },
        }
      },
    }
    try {
      installSdkCommandSink({
        target: h.window,
        handlers: { openFileDialog: makeOpenFileDialogHandler() },
      })
      h.messageHandlers[0]!({
        data: {
          v: '1.0',
          dir: 'host→editor',
          kind: 'command',
          correlationId: 'int-4',
          payload: { name: 'openFileDialog', args: { accept: '.docx' } },
        },
      })
      await flush()
      const result = resultFor(h, 'int-4')
      expect(result!.payload.ok).toBe(true)
      expect(result!.payload.result).toEqual({ canceled: true })
    } finally {
      ;(globalThis as { document?: unknown }).document = savedDoc
    }
  })

  it('uninstall() makes the bridge fall back to the server channel again', async () => {
    const target: SdkCommandSinkTarget & Record<string, unknown> = {}
    const h = evalBridge(target)
    const handle = installSdkCommandSink({ target: h.window, handlers: { print: () => 'x' } })
    handle.uninstall()
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'int-5',
        payload: { name: 'print', args: {} },
      },
    })
    await flush()
    const result = resultFor(h, 'int-5')
    // Server channel returned {ok:true, result:null} from the stub fetch.
    expect(h.fetchCalls).toHaveLength(1)
    expect(result!.payload.ok).toBe(true)
  })

  it('UnsupportedCommandError is the shared class from the package', () => {
    // Guards against a future refactor introducing a second, private error
    // type that the bridge would forward with a different code.
    const err = new UnsupportedCommandError('x')
    expect(err.code).toBe('UNSUPPORTED')
    expect(err.name).toBe('UnsupportedCommandError')
  })
})

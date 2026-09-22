/**
 * Tests for the iframe Embed bridge (sdk1.md §11.31).
 *
 * The bridge is the JS that runs inside the iframe after the server
 * serves the embed HTML. It has two responsibilities:
 *   1. Read `<meta name="genoffice-nonce">` and post a `ready` event
 *      to `window.parent` with the nonce (sdk1.md §11.20).
 *   2. Subscribe to `/api/ipc/events?session=<sessionId>` and forward
 *      server-side lifecycle events to `window.parent`.
 *
 * Earlier versions also relayed inbound host commands onto `window` as
 * `host.command` CustomEvents, but no shipped code consumed that path
 * (sdk1.md §11.34). The relay has been removed; inbound command
 * consumption is now the editor's own postMessage listener's job.
 *
 * Before this commit, the bridge source was inlined inside
 * `embed/index.ts` and only smoke-tested live in the browser. Splitting
 * it out + evaluating it in a controlled scope lets us pin:
 *   - the postMessage payload shape (envelope version, kind, name)
 *   - the nonce source (the meta tag, not the URL hash or a global var)
 *   - the app field source (window.__GENOFFICE_EMBED__.app)
 *   - the version field source (server SOT constant)
 *   - the SSE subscription URL and message forwarding
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBED_BRIDGE_SOURCE, EMBED_BRIDGE_VERSION } from '../src/embed/bridge'
import { WEB_SERVER_VERSION } from '../src/common/version'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

interface BridgeHarness {
  /** Capture window.parent.postMessage calls. */
  parentPosts: Array<{ data: unknown; targetOrigin: string }>
  /** Capture window.addEventListener('message', ...) handlers. */
  messageHandlers: Array<(event: { data: unknown }) => void>
  /** Capture window.addEventListener('DOMContentLoaded' / 'load', ...) handlers. */
  domLoadedHandlers: Array<() => void>
  /** Capture window.dispatchEvent(CustomEvent) calls. */
  dispatchedEvents: Array<{ type: string; detail: unknown }>
  /** Capture EventSource construction args + handlers. */
  eventSources: Array<{
    url: string
    onmessage: (ev: { data: string }) => void
    onerror: () => void
    closed: boolean
  }>
  /** The fake meta tag for `<meta name="genoffice-nonce">`. */
  nonce: string | null
  /** The fake __GENOFFICE_EMBED__ config. */
  embedConfig: { app: string; sessionId?: string } | null
  /** document.readyState stub. */
  readyState: 'loading' | 'interactive' | 'complete'
}

/**
 * Build a fake `window` / `document` / `EventSource` scope and evaluate
 * the bridge source inside it. Returns a harness with capture handles so
 * tests can assert what the bridge did.
 */
function evalBridgeWith(opts: { nonce: string | null; embedConfig: BridgeHarness['embedConfig']; readyState?: BridgeHarness['readyState'] }): BridgeHarness {
  const harness: BridgeHarness = {
    parentPosts: [],
    messageHandlers: [],
    domLoadedHandlers: [],
    dispatchedEvents: [],
    eventSources: [],
    nonce: opts.nonce,
    embedConfig: opts.embedConfig,
    readyState: opts.readyState ?? 'complete',
  }

  // Build a fake `window` object
  const fakeWindow = {
    __GENOFFICE_EMBED__: opts.embedConfig,
    parent: {
      postMessage(data: unknown, targetOrigin: string) {
        harness.parentPosts.push({ data, targetOrigin })
      },
    },
    addEventListener(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'message') harness.messageHandlers.push(handler as never)
      else if (event === 'DOMContentLoaded' || event === 'load') {
        harness.domLoadedHandlers.push(handler as never)
      }
    },
    dispatchEvent(event: { type: string; detail?: unknown }) {
      harness.dispatchedEvents.push({ type: event.type, detail: event.detail })
    },
  }

  // Fake document
  const fakeDocument = {
    readyState: harness.readyState,
    querySelector(selector: string): { getAttribute(name: string): string | null } | null {
      if (selector === 'meta[name="genoffice-nonce"]' && harness.nonce !== null) {
        return { getAttribute(name: string) { return name === 'content' ? harness.nonce : null } }
      }
      return null
    },
  }

  // Fake EventSource — push a reference to self into the harness so
  // the test can read .onmessage directly after eval.
  class FakeEventSource {
    url: string
    onmessage: ((ev: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    closed = false
    constructor(url: string) {
      this.url = url
      harness.eventSources.push(this)
    }
    close() {
      this.closed = true
    }
  }

  // The bridge source is wrapped in `(function(){...})();` — IIFE.
  // We need to expose `window`, `document`, `EventSource`, `setTimeout`,
  // `CustomEvent` to its scope. Use `new Function(...)` for a clean eval.
  const fn = new Function('window', 'document', 'EventSource', 'setTimeout', 'CustomEvent', EMBED_BRIDGE_SOURCE)
  fn(fakeWindow, fakeDocument, FakeEventSource, setTimeout, class FakeCustomEvent {
    type: string
    detail: unknown
    constructor(type: string, init: { detail?: unknown } = {}) {
      this.type = type
      this.detail = init.detail
    }
  })

  // Bridge schedules sendReady + subscribePush via setTimeout(_, 0).
  // Flush them synchronously so tests can assert side effects immediately.
  vi.runAllTimers()

  return harness
}

describe('EMBED_BRIDGE_SOURCE (sdk1.md §11.31)', () => {
  it('exports a non-empty source string with the IIFE wrapper', () => {
    expect(typeof EMBED_BRIDGE_SOURCE).toBe('string')
    expect(EMBED_BRIDGE_SOURCE.length).toBeGreaterThan(200)
    expect(EMBED_BRIDGE_SOURCE.trim().startsWith('(function')).toBe(true)
    expect(EMBED_BRIDGE_SOURCE.trim().endsWith(')();')).toBe(true)
  })

  it('embeds the WEB_SERVER_VERSION constant', () => {
    expect(EMBED_BRIDGE_SOURCE).toContain(`version: '${WEB_SERVER_VERSION}'`)
    expect(EMBED_BRIDGE_VERSION).toBe('1.0')
  })

  it('posts ready event with envelope version 1.0', () => {
    const h = evalBridgeWith({ nonce: 'n-abc', embedConfig: { app: 'docs' } })
    expect(h.parentPosts.length).toBeGreaterThan(0)
    const first = h.parentPosts[0]!.data as { v: string; dir: string; kind: string; payload: { name: string; payload: { type: string; nonce: string; app: string; version: string } } }
    expect(first.v).toBe('1.0')
    expect(first.dir).toBe('editor→host')
    expect(first.kind).toBe('event')
    expect(first.payload.name).toBe('ready')
    expect(first.payload.payload.type).toBe('ready')
  })

  it('echoes the nonce from <meta name="genoffice-nonce"> in the ready event', () => {
    const h = evalBridgeWith({ nonce: 'forged-nonce-attempt', embedConfig: { app: 'docs' } })
    const ready = h.parentPosts.find((p) => {
      const d = p.data as { payload?: { name?: string } }
      return d.payload?.name === 'ready'
    })!
    const data = ready.data as { payload: { payload: { nonce: string } } }
    expect(data.payload.payload.nonce).toBe('forged-nonce-attempt')
  })

  it('omits nonce field in ready event when meta tag is absent', () => {
    const h = evalBridgeWith({ nonce: null, embedConfig: { app: 'docs' } })
    const ready = h.parentPosts.find((p) => {
      const d = p.data as { payload?: { name?: string } }
      return d.payload?.name === 'ready'
    })!
    const data = ready.data as { payload: { payload: { nonce?: string } } }
    expect(data.payload.payload.nonce).toBeUndefined()
  })

  it('reads app from window.__GENOFFICE_EMBED__', () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'sheets' } })
    const ready = h.parentPosts.find((p) => {
      const d = p.data as { payload?: { name?: string } }
      return d.payload?.name === 'ready'
    })!
    const data = ready.data as { payload: { payload: { app: string } } }
    expect(data.payload.payload.app).toBe('sheets')
  })

  it('reads app as undefined when __GENOFFICE_EMBED__ is null', () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: null })
    const ready = h.parentPosts.find((p) => {
      const d = p.data as { payload?: { name?: string } }
      return d.payload?.name === 'ready'
    })!
    const data = ready.data as { payload: { payload: { app: string } } }
    // null && null.app -> null; the bridge does `__GENOFFICE_EMBED__ && __GENOFFICE_EMBED__.app`
    // so the result is `null` (not undefined) when the config is missing.
    expect(data.payload.payload.app == null).toBe(true)
  })

  it('uses WEB_SERVER_VERSION as the version field', () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    const ready = h.parentPosts.find((p) => {
      const d = p.data as { payload?: { name?: string } }
      return d.payload?.name === 'ready'
    })!
    const data = ready.data as { payload: { payload: { version: string } } }
    expect(data.payload.payload.version).toBe(WEB_SERVER_VERSION)
  })

  it('opens EventSource to /api/ipc/events when sessionId is present', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-abc-123' },
    })
    expect(h.eventSources.length).toBe(1)
    expect(h.eventSources[0]!.url).toBe('/api/ipc/events?session=embed-abc-123')
  })

  it('does NOT open EventSource when sessionId is absent', () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    expect(h.eventSources.length).toBe(0)
  })

  it('forwards SSE events to window.parent as postMessage', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-xyz' },
    })
    // Capture the SSE onmessage handler from the fake EventSource
    const es = h.eventSources[0]!
    expect(typeof es.onmessage).toBe('function')
    // Simulate a server-side push event
    const initialPosts = h.parentPosts.length
    es.onmessage({ data: JSON.stringify({ channel: 'saved', args: [{ dirty: false, version: 42 }] }) })
    const newPosts = h.parentPosts.slice(initialPosts)
    expect(newPosts.length).toBe(1)
    const payload = (newPosts[0]!.data as { payload: { name: string; payload: unknown } }).payload
    expect(payload.name).toBe('saved')
    expect((payload.payload as { dirty: boolean }).dirty).toBe(false)
  })

  it('unwraps single-arg SSE events to plain payload object', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-y' },
    })
    const es = h.eventSources[0]!
    const initialPosts = h.parentPosts.length
    es.onmessage({ data: JSON.stringify({ channel: 'dirtyChanged', args: [{ dirty: true }] }) })
    const newPost = h.parentPosts[initialPosts]!
    const payload = (newPost.data as { payload: { payload: unknown } }).payload
    // args: [{dirty:true}] -> single-arg unwrap -> {dirty:true}
    expect(payload.payload).toEqual({ dirty: true })
  })

  it('forwards multi-arg SSE events as args array', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-z' },
    })
    const es = h.eventSources[0]!
    const initialPosts = h.parentPosts.length
    es.onmessage({ data: JSON.stringify({ channel: 'selectionChange', args: [{ start: 0, end: 10 }, { focus: true }] }) })
    const newPost = h.parentPosts[initialPosts]!
    const payload = (newPost.data as { payload: { payload: unknown } }).payload
    expect(payload.payload).toEqual([{ start: 0, end: 10 }, { focus: true }])
  })

  it('ignores SSE events missing channel or args', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-q' },
    })
    const es = h.eventSources[0]!
    const initialPosts = h.parentPosts.length
    es.onmessage({ data: JSON.stringify({ channel: 'saved' }) }) // no args
    es.onmessage({ data: JSON.stringify({ args: [] }) }) // no channel
    es.onmessage({ data: 'not-json' }) // invalid JSON
    expect(h.parentPosts.length).toBe(initialPosts)
  })

  it('does NOT dispatch host.command CustomEvent for inbound commands (sdk1.md §11.34)', () => {
    // Prior to §11.34 the bridge relayed inbound host commands onto
    // `window` as `host.command` CustomEvents for a renderer-side
    // listener. No shipped code consumed that path, so the relay was
    // removed. This test pins the negative contract: an inbound
    // command postMessage MUST NOT produce a host.command CustomEvent
    // regardless of whether the bridge still installs a postMessage
    // listener (it currently does not — we check both shapes).
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    // If a listener is registered, invoke it; if not, the assertion
    // below still holds (no host.command was ever dispatched).
    if (h.messageHandlers.length > 0) {
      const initialEvents = h.dispatchedEvents.length
      h.messageHandlers[0]!({ data: { v: '1.0', kind: 'command', payload: { name: 'setTheme', args: { theme: 'dark' } } } })
      expect(h.dispatchedEvents.length).toBe(initialEvents)
    }
    expect(h.dispatchedEvents.filter((e) => e.type === 'host.command')).toHaveLength(0)
  })

  it('does NOT install a postMessage listener after §11.34', () => {
    // The bridge prior to §11.34 listened for inbound postMessages to
    // either validate envelope version or re-dispatch `host.command`
    // CustomEvents. Both uses are gone: the editor registers its own
    // postMessage listener post-bridge, and no consumer of the relay
    // ever shipped. Pin the absence so a future refactor can't
    // accidentally re-introduce the listener.
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    expect(h.messageHandlers).toHaveLength(0)
  })

  it('waits for DOMContentLoaded when document.readyState is loading', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs' },
      readyState: 'loading',
    })
    // ready event not yet posted
    const initialPosts = h.parentPosts.length
    expect(initialPosts).toBe(0)
    // Trigger DOMContentLoaded
    h.domLoadedHandlers.forEach((fn) => fn())
    // Flush the setTimeout(_, 0) inside the DOMContentLoaded handler
    vi.runAllTimers()
    expect(h.parentPosts.length).toBeGreaterThan(0)
  })

  it('every outbound postMessage uses the U+2192 arrow dir, never ASCII hyphen', () => {
    // SDK isEnvelope (apps/sdk/src/envelope.ts:76) strictly compares
    // `dir === 'editor→host' || dir === 'host→editor'`. The bridge
    // previously emitted `'editor->host'` (ASCII hyphen, U+002D) which
    // isEnvelope rejected silently — every SSE-relayed lifecycle event
    // (`saved`, `dirtyChanged`, `selectionChange`) was dropped at the
    // SDK side. This test guards the wire format by scanning the bridge
    // source for any ASCII-hyphen occurrences.
    const asciiHits = (EMBED_BRIDGE_SOURCE.match(/'editor->host'/g) || []).length
    const arrowHits = (EMBED_BRIDGE_SOURCE.match(/'editor→host'/g) || []).length
    expect(asciiHits).toBe(0)
    expect(arrowHits).toBeGreaterThan(0)
  })

  it('emits dir as U+2192 arrow in all live postMessages, not ASCII hyphen', () => {
    // Live-runtime equivalent of the source-grep guard above: exercise
    // the bridge under the standard fake-iframe environment and verify
    // every postMessage uses the exact arrow character that SDK
    // isEnvelope accepts.
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    expect(h.parentPosts.length).toBeGreaterThan(0)
    for (const post of h.parentPosts) {
      const d = post.data as { dir?: string }
      expect(d.dir).toBe('editor→host')
    }
  })
})

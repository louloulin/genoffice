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
 *   - the app field source (`<meta name="genoffice-embed-config">`, with a
 *     host-set `window.__GENOFFICE_EMBED__` as the override)
 *   - the version field source (server SOT constant)
 *   - the SSE subscription URL and message forwarding
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBED_BRIDGE_SOURCE, EMBED_BRIDGE_VERSION } from '../src/embed/bridge'
import { WEB_SERVER_VERSION } from '../src/common/version'

/**
 * Drain queued microtasks so a fetch → .then(text) → .then(reply)
 * chain under fake timers completes before the next assertion. Real
 * timers would let the runtime schedule these naturally; under
 * vi.useFakeTimers() we have to drain manually. 10 cycles is enough
 * for any nested promise chain the bridge produces.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

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
  /** Capture fetch(url, init) calls when fetchMock is null. */
  fetchCalls: Array<{ url: string; init: RequestInit }>
  /** Test-supplied fetch implementation (replaces real fetch in bridge scope). */
  fetchMock:
    | ((url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>)
    | null
  /** The fake meta tag for `<meta name="genoffice-nonce">`. */
  nonce: string | null
  /** The fake __GENOFFICE_EMBED__ config. */
  embedConfig: { app: string; sessionId?: string; docId?: string } | null
  /** Test-supplied renderer command sink (window.__GENOFFICE_COMMAND_SINK__). */
  commandSink: ((name: string, args: unknown) => unknown) | null
  /** document.readyState stub. */
  readyState: 'loading' | 'interactive' | 'complete'
}

/**
 * Build a fake `window` / `document` / `EventSource` scope and evaluate
 * the bridge source inside it. Returns a harness with capture handles so
 * tests can assert what the bridge did.
 */
function evalBridgeWith(opts: {
  nonce: string | null
  embedConfig: BridgeHarness['embedConfig']
  readyState?: BridgeHarness['readyState']
  /**
   * Absolute URL the bridge script itself is served from, i.e. what
   * `document.currentScript.src` reports. Defaults to the production shape: a
   * host reverse-proxy mount under `/office-engine`. Tests that care about the
   * root-mounted case pass `'http://host/embed/static/bridge.js'`.
   */
  bridgeSrc?: string
  /**
   * Contents of `<meta name="genoffice-embed-config">` — the production source
   * of the bridge's app / docId / sessionId. This is what the server actually
   * injects; `embedConfig` above models only the optional host override.
   */
  configMeta?: Record<string, unknown> | null
  /** Contents of `<meta name="genoffice-session">`. */
  sessionMeta?: string | null
}): BridgeHarness {
  const harness: BridgeHarness = {
    parentPosts: [],
    messageHandlers: [],
    domLoadedHandlers: [],
    dispatchedEvents: [],
    eventSources: [],
    fetchCalls: [],
    fetchMock: null,
    commandSink: null,
    nonce: opts.nonce,
    embedConfig: opts.embedConfig,
    readyState: opts.readyState ?? 'complete',
  }

  // Build a fake `window` object
  const fakeWindow = {
    __GENOFFICE_EMBED__: opts.embedConfig,
    // The sink is read lazily inside dispatchCommand (window.__GENOFFICE_
    // COMMAND_SINK__), so a getter keeps the harness value live for tests
    // that install a sink AFTER eval.
    get __GENOFFICE_COMMAND_SINK__() {
      return harness.commandSink ?? undefined
    },
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

  // Fake document. `currentScript` / `baseURI` are what the bridge anchors its
  // API URLs on, so the fake models the real prefixed mount by default rather
  // than the degenerate no-DOM case (which would silently fall back to a
  // root-relative URL and hide a prefix regression).
  const bridgeSrc = opts.bridgeSrc ?? 'http://host/office-engine/embed/static/bridge.js'
  const fakeDocument = {
    readyState: harness.readyState,
    currentScript: { src: bridgeSrc },
    baseURI: bridgeSrc.replace(/static\/bridge\.js$/, ''),
    getElementsByTagName(): Array<{ src: string }> {
      return [{ src: bridgeSrc }]
    },
    querySelector(selector: string): { getAttribute(name: string): string | null } | null {
      // The real document returns the *unescaped* attribute value, so the
      // JSON meta is served as plain JSON here (the server's `&quot;` escaping
      // is undone by the HTML parser before `getAttribute` ever sees it).
      let value: string | null = null
      if (selector === 'meta[name="genoffice-nonce"]') value = harness.nonce
      else if (selector === 'meta[name="genoffice-embed-config"]') {
        value = opts.configMeta ? JSON.stringify(opts.configMeta) : null
      } else if (selector === 'meta[name="genoffice-session"]') {
        value = opts.sessionMeta ?? null
      }
      if (value === null) return null
      return { getAttribute(name: string) { return name === 'content' ? value : null } }
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

  // Fake fetch — when fetchMock is set, delegate; otherwise capture and
  // return a synthetic 200/ok envelope so the bridge's .then() chain
  // resolves without hanging the test (tests that need precise control
  // set fetchMock before triggering the message handler).
  const fakeFetch = async (url: string, init: RequestInit) => {
    harness.fetchCalls.push({ url, init })
    if (harness.fetchMock) return harness.fetchMock(url, init)
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: null }) }
  }

  // The bridge source is wrapped in `(function(){...})();` — IIFE.
  // We need to expose `window`, `document`, `EventSource`, `setTimeout`,
  // `CustomEvent`, `fetch` to its scope. Use `new Function(...)` for a
  // clean eval.
  const fn = new Function('window', 'document', 'EventSource', 'setTimeout', 'CustomEvent', 'fetch', EMBED_BRIDGE_SOURCE)
  fn(
    fakeWindow,
    fakeDocument,
    FakeEventSource,
    setTimeout,
    class FakeCustomEvent {
      type: string
      detail: unknown
      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type
        this.detail = init.detail
      }
    },
    fakeFetch,
  )

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

  it('reads app / sessionId / docId from the injected embed-config meta', () => {
    // The production path. The server injects <meta name="genoffice-embed-config">
    // and <meta name="genoffice-session">; nothing in any shipped artifact ever
    // assigns a `window.__GENOFFICE_EMBED__` global. Asserting only the global
    // (as this file used to) left the whole push relay dead in every deployment
    // while the suite stayed green.
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: null,
      configMeta: { app: 'docs', sessionId: 'embed-meta-1', docId: 'meta.docx' },
    })
    const ready = h.parentPosts.find((p) => (p.data as { payload?: { name?: string } }).payload?.name === 'ready')!
    const data = ready.data as { payload: { payload: { app: string } } }
    expect(data.payload.payload.app).toBe('docs')
    // Full URL, so this also pins the mount-relative resolution that the meta
    // fix depends on: the meta can supply a sessionId, but a root-relative
    // EventSource would still ask the *host* for it.
    expect(h.eventSources.length).toBe(1)
    expect(h.eventSources[0]!.url).toBe('http://host/office-engine/api/ipc/events?session=embed-meta-1')
  })

  it('falls back to the genoffice-session meta for the session id', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: null,
      configMeta: { app: 'docs' },
      sessionMeta: 'embed-session-meta',
    })
    expect(h.eventSources.length).toBe(1)
    expect(h.eventSources[0]!.url).toBe('http://host/office-engine/api/ipc/events?session=embed-session-meta')
  })

  it('lets an explicit host override win over the injected meta', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'sheets', sessionId: 'host-override' },
      configMeta: { app: 'docs', sessionId: 'embed-meta-1' },
    })
    const ready = h.parentPosts.find((p) => (p.data as { payload?: { name?: string } }).payload?.name === 'ready')!
    const data = ready.data as { payload: { payload: { app: string } } }
    expect(data.payload.payload.app).toBe('sheets')
    expect(h.eventSources[0]!.url).toBe('http://host/office-engine/api/ipc/events?session=host-override')
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

  it('opens EventSource to the mount-relative /api/ipc/events when sessionId is present', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-abc-123' },
    })
    expect(h.eventSources.length).toBe(1)
    // Resolved against the bridge's own <script src>, which sits at
    // <mount>/embed/static/bridge.js — so the API root is two levels up. A
    // root-relative '/api/ipc/events' would be asked of the *host*, which
    // forwards only its own mount path, and the push channel would die
    // silently under a prefixed deployment.
    expect(h.eventSources[0]!.url).toBe('http://host/office-engine/api/ipc/events?session=embed-abc-123')
    expect(h.eventSources[0]!.url).not.toMatch(/^\/api\//)
  })

  it('opens the same SSE channel when mounted at the origin root', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-abc-123' },
      bridgeSrc: 'http://host/embed/static/bridge.js',
    })
    expect(h.eventSources.length).toBe(1)
    expect(h.eventSources[0]!.url).toBe('http://host/api/ipc/events?session=embed-abc-123')
  })

  it('resolves the command round-trip against the mount, not the origin root', () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-abc-123', docId: 'doc_1' },
    })
    h.messageHandlers.forEach((fn) =>
      fn({
        data: {
          v: '1.0',
          dir: 'host→editor',
          kind: 'command',
          correlationId: 'cmd-mount',
          payload: { name: 'setTheme', args: { theme: 'dark' } },
        },
      }),
    )
    expect(h.fetchCalls.length).toBeGreaterThan(0)
    expect(h.fetchCalls[0]!.url).toBe('http://host/office-engine/api/ipc/sdk%3Acommand')
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

  it('does NOT dispatch host.command CustomEvent for inbound commands (sdk1.md §11.34 invariant)', () => {
    // The §11.34 cleanup removed the host.command CustomEvent relay
    // (no renderer-side consumer ever shipped). The §11.36 inbound
    // dispatch re-installs a postMessage listener but ONLY to convert
    // envelope 'command' messages into IPC POSTs — it MUST NOT re-add
    // the CustomEvent path. Pin the invariant across both eras.
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    if (h.messageHandlers.length > 0) {
      h.messageHandlers[0]!({
        data: {
          v: '1.0',
          dir: 'host→editor',
          kind: 'command',
          correlationId: 'cmd-test',
          payload: { name: 'setTheme', args: { theme: 'dark' } },
        },
      })
    }
    expect(h.dispatchedEvents.filter((e) => e.type === 'host.command')).toHaveLength(0)
  })

  it('installs a postMessage listener for inbound command dispatch (sdk1.md §11.36)', () => {
    // The bridge now actively dispatches inbound envelope commands to
    // /api/ipc/<channel> via fetch. Confirm a postMessage listener is
    // installed so SDK editor.command() round-trips work in the
    // iframe without renderer-side changes.
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    expect(h.messageHandlers.length).toBe(1)
  })

  it('ignores inbound events (kind === event) at the bridge level', () => {
    // Inbound events from the host are handled by the editor's own
    // postMessage listener (apps/sdk/src/editor.ts) loaded into the
    // same iframe post-bridge. The bridge MUST NOT reply to events,
    // only commands. Pin: a simulated inbound 'event' envelope should
    // produce zero outbound postMessages.
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    const before = h.parentPosts.length
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'event',
        payload: { name: 'hostEvent', payload: { foo: 1 } },
      },
    })
    expect(h.parentPosts.length).toBe(before)
  })

  it('ignores malformed envelopes (wrong version / wrong dir / wrong shape)', () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    const before = h.parentPosts.length
    const malformed = [
      { data: null },
      { data: { v: '2.0', dir: 'host→editor', kind: 'command', correlationId: 'c', payload: { name: 'x' } } },
      { data: { v: '1.0', dir: 'editor→host', kind: 'command', correlationId: 'c', payload: { name: 'x' } } },
      { data: { v: '1.0', dir: 'host→editor', kind: 'command' /* missing payload */ } },
      { data: { v: '1.0', dir: 'host→editor', kind: 'command', correlationId: '', payload: { name: 'x' } } },
    ]
    for (const m of malformed) h.messageHandlers[0]!(m)
    expect(h.parentPosts.length).toBe(before)
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

  it('opens exactly one SSE stream when both DOMContentLoaded and load fire', () => {
    // The bridge installs sendReady + subscribePush from BOTH listeners (the
    // external script can still be running while the parser is going), and
    // both events dispatch on every page load. subscribePush holds an *open
    // connection*, unlike sendReady's one-shot message, so without a guard
    // each embed page kept two EventSource streams — and two server-side
    // session registrations — alive for its whole lifetime. The live prefix
    // probe observed three streams where two are correct (bridge + renderer).
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: null,
      configMeta: { app: 'docs', sessionId: 'embed-dup-1' },
      readyState: 'loading',
    })
    expect(h.eventSources.length).toBe(0)
    // Fire DOMContentLoaded, then load — the real page sequence.
    h.domLoadedHandlers.forEach((fn) => fn())
    vi.runAllTimers()
    expect(h.eventSources.length).toBe(1)
    // `load` is the second handler in the same captured list; firing it must
    // not add a stream (this is the assertion that fails without the guard).
    h.domLoadedHandlers.forEach((fn) => fn())
    vi.runAllTimers()
    expect(h.eventSources.length).toBe(1)
    expect(h.eventSources[0]!.url).toBe('http://host/office-engine/api/ipc/events?session=embed-dup-1')
    // Same guard shape for the ready envelope: exactly one per page.
    expect(h.parentPosts.filter((p) => (p.data as { payload?: { name?: string } }).payload?.name === 'ready')).toHaveLength(1)
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

  // ---------------------------------------------------------------
  // sdk1.md §11.36: bridge inbound command dispatch via fetch IPC.
  // The fake harness exposes fetch via h.fetchCalls; we register a
  // mock before invoking the message handler so dispatchCommand's
  // Promise chain resolves synchronously under vi.useFakeTimers().
  // ---------------------------------------------------------------
  function withFetchMock<T>(h: ReturnType<typeof evalBridgeWith>, body: T | { error: object }, status = 200, fn: () => void): void {
    const payload = typeof body === 'object' && body !== null && 'error' in body ? body : { ok: true, result: body }
    h.fetchMock = async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    })
    try { fn() } finally { h.fetchMock = null }
  }

  it('dispatches inbound command envelope as POST /api/ipc/sdk:command', async () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs', sessionId: 'embed-xyz' } })
    let captured: { url: string; init: RequestInit } | null = null
    h.fetchMock = async (url: string, init: RequestInit) => {
      captured = { url, init }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { echoed: true } }) }
    }
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-1',
        payload: { name: 'addComment', args: { text: 'hi', anchor: { cell: 'A1' } } },
      },
    })
    await flushMicrotasks()
    expect(captured).not.toBeNull()
    expect(captured!.url).toBe('http://host/office-engine/api/ipc/sdk%3Acommand')
    const init = captured!.init as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-ipc-session']).toBe('embed-xyz')
    expect(JSON.parse(init.body as string)).toEqual({
      args: [{ name: 'addComment', args: { text: 'hi', anchor: { cell: 'A1' } } }],
    })
  })

  it('includes embedConfig.docId in the IPC envelope', async () => {
    const h = evalBridgeWith({
      nonce: 'n',
      embedConfig: { app: 'docs', sessionId: 'embed-xyz', docId: 'projects/q3.docx' },
    })
    let captured: { url: string; init: RequestInit } | null = null
    h.fetchMock = async (url: string, init: RequestInit) => {
      captured = { url, init }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: {} }) }
    }
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-docid',
        payload: { name: 'listVersions', args: {} },
      },
    })
    await flushMicrotasks()
    const body = JSON.parse((captured!.init as RequestInit).body as string) as {
      args: Array<{ name: string; docId?: string }>
    }
    expect(body.args[0]!.docId).toBe('projects/q3.docx')
  })

  it('prefers window.__GENOFFICE_COMMAND_SINK__ over the IPC POST when installed', async () => {
    // Renderer-owned commands (setContent / mountSidebar / …) are serviced
    // by the renderer bundle via a sink function. When the sink is present
    // the bridge MUST NOT also POST to the server (double-reply would race).
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs', sessionId: 'embed-xyz' } })
    const calls: Array<{ name: string; args: unknown }> = []
    h.commandSink = async (name: string, args: unknown) => {
      calls.push({ name, args })
      return { applied: true }
    }
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-sink',
        payload: { name: 'setContent', args: { content: '<p>hi</p>' } },
      },
    })
    await flushMicrotasks()
    expect(calls).toEqual([{ name: 'setContent', args: { content: '<p>hi</p>' } }])
    expect(h.fetchCalls).toHaveLength(0)
    const reply = h.parentPosts.find((p) => {
      const d = p.data as { kind?: string; correlationId?: string }
      return d.kind === 'command-result' && d.correlationId === 'cmd-sink'
    })
    const data = reply!.data as { payload: { ok: boolean; result: { applied: boolean } } }
    expect(data.payload.ok).toBe(true)
    expect(data.payload.result).toEqual({ applied: true })
  })

  it('rejects with RENDERER_ERROR when the sink throws', async () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs', sessionId: 'embed-xyz' } })
    h.commandSink = async () => {
      const err = new Error('renderer says no') as Error & { code?: string }
      err.code = 'UNSUPPORTED'
      throw err
    }
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-sink-fail',
        payload: { name: 'openFileDialog', args: {} },
      },
    })
    await flushMicrotasks()
    const reply = h.parentPosts.find((p) => {
      const d = p.data as { kind?: string; correlationId?: string }
      return d.kind === 'command-result' && d.correlationId === 'cmd-sink-fail'
    })
    const data = reply!.data as { payload: { ok: boolean; error: { code: string; message: string } } }
    expect(data.payload.ok).toBe(false)
    expect(data.payload.error.code).toBe('UNSUPPORTED')
    expect(data.payload.error.message).toBe('renderer says no')
    expect(h.fetchCalls).toHaveLength(0)
  })

  it('replies command-result with ok:true when IPC returns ok envelope', async () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs', sessionId: 'embed-xyz' } })
    h.fetchMock = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, result: { value: 42 } }),
    })
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-2',
        payload: { name: 'docs:read', args: { path: '/x.docx' } },
      },
    })
    await flushMicrotasks()
    const reply = h.parentPosts.find((p) => {
      const d = p.data as { kind?: string; correlationId?: string }
      return d.kind === 'command-result' && d.correlationId === 'cmd-2'
    })
    expect(reply).toBeDefined()
    const data = reply!.data as { kind: string; correlationId: string; payload: { ok: boolean; result: { value: number } } }
    expect(data.kind).toBe('command-result')
    expect(data.correlationId).toBe('cmd-2')
    expect(data.payload.ok).toBe(true)
    expect(data.payload.result).toEqual({ value: 42 })
  })

  it('replies command-result with ok:false when IPC returns error envelope', async () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs', sessionId: 'embed-xyz' } })
    h.fetchMock = async () => ({
      ok: false, status: 400,
      text: async () => JSON.stringify({
        error: { message: 'path outside storage', code: 'PATH_OUTSIDE_STORAGE' },
      }),
    })
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-3',
        payload: { name: 'docs:save', args: { path: '/etc/passwd' } },
      },
    })
    await flushMicrotasks()
    const reply = h.parentPosts.find((p) => {
      const d = p.data as { kind?: string; correlationId?: string }
      return d.kind === 'command-result' && d.correlationId === 'cmd-3'
    })
    expect(reply).toBeDefined()
    const data = reply!.data as { payload: { ok: boolean; error: { code: string; message: string } } }
    expect(data.payload.ok).toBe(false)
    expect(data.payload.error.code).toBe('PATH_OUTSIDE_STORAGE')
    expect(data.payload.error.message).toBe('path outside storage')
  })

  it('replies command-result with IPC_ERROR when IPC returns non-JSON', async () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs', sessionId: 'embed-xyz' } })
    h.fetchMock = async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' })
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-4',
        payload: { name: 'docs:save', args: {} },
      },
    })
    await flushMicrotasks()
    const reply = h.parentPosts.find((p) => {
      const d = p.data as { kind?: string; correlationId?: string }
      return d.kind === 'command-result' && d.correlationId === 'cmd-4'
    })
    const data = reply!.data as { payload: { ok: boolean; error: { code: string } } }
    expect(data.payload.ok).toBe(false)
    expect(data.payload.error.code).toBe('IPC_ERROR')
  })

  it('replies command-result with IPC_FETCH_FAILED when fetch itself rejects', async () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs', sessionId: 'embed-xyz' } })
    h.fetchMock = async () => { throw new Error('network down') }
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-5',
        payload: { name: 'docs:save', args: {} },
      },
    })
    await flushMicrotasks()
    const reply = h.parentPosts.find((p) => {
      const d = p.data as { kind?: string; correlationId?: string }
      return d.kind === 'command-result' && d.correlationId === 'cmd-5'
    })
    const data = reply!.data as { payload: { ok: boolean; error: { code: string; message: string } } }
    expect(data.payload.ok).toBe(false)
    expect(data.payload.error.code).toBe('IPC_FETCH_FAILED')
    expect(data.payload.error.message).toBe('network down')
  })

  it('omits x-ipc-session header when embedConfig.sessionId is missing', async () => {
    const h = evalBridgeWith({ nonce: 'n', embedConfig: { app: 'docs' } })
    let captured: { url: string; init: RequestInit } | null = null
    h.fetchMock = async (url: string, init: RequestInit) => {
      captured = { url, init }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: {} }) }
    }
    h.messageHandlers[0]!({
      data: {
        v: '1.0',
        dir: 'host→editor',
        kind: 'command',
        correlationId: 'cmd-6',
        payload: { name: 'docs:read', args: {} },
      },
    })
    await Promise.resolve(); await Promise.resolve()
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['x-ipc-session']).toBeUndefined()
  })
})

/**
 * Bridge E2E: two paired fake windows + a fake DOM driving the real
 * `installDataflareHostBridge` / `installDataflareEmbedBridge` through a
 * full `genoffice-dataflare/v1` session.
 *
 * Pure-Node environment (no jsdom) — we hand-roll the minimal DOM the SDK
 * touches: `window`, `window.parent`, `document.referrer`,
 * `addEventListener('message')`, `postMessage`, `MessageEvent`,
 * `setTimeout`/`clearTimeout`, `URL`, `TextEncoder`.
 *
 * Cross-wired windows: when `host.postMessage(envelope)` fires, the paired
 * `guest` receives a `MessageEvent` whose `source` is `host` and `origin`
 * is `hostOrigin`. Symmetrically for `guest.postMessage` → `host`.
 *
 * `vi.resetModules()` between tests clears the module-local `activeSessionId`
 * in `guest.ts` so each test starts clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: MessageEvent<unknown>) => void

interface FakeWindow {
  readonly origin: string
  parent: FakeWindow | null
  contentWindow: FakeWindow | null
  referrer?: string
  postMessage: (envelope: unknown, origin: string, transfer?: Transferable[]) => void
  listeners: Listener[]
  addEventListener: (type: 'message', fn: Listener) => void
  removeEventListener: (type: 'message', fn: Listener) => void
  toString(): string
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

/**
 * Build a single shared listener list — both host and guest `addEventListener`
 * calls (which the SDK does through the global `window`) land in this list.
 * Either side's `postMessage` fans out to every listener; each side's
 * `onMessage` handler then rejects messages from the wrong `source`.
 *
 * This mirrors the in-browser reality: there is no parent.child listener
 * isolation at the global level — every `window.addEventListener('message')`
 * sees every `MessageEvent` dispatched to that realm, and source/origin
 * guards do the filtering. Sharing the list keeps the test deterministic.
 */
function createSharedListenerRegistry(): { listeners: Listener[]; add: Listener; remove: Listener } {
  const listeners: Listener[] = []
  return {
    listeners,
    add: (fn) => {
      listeners.push(fn)
    },
    remove: (fn) => {
      const idx = listeners.indexOf(fn)
      if (idx >= 0) listeners.splice(idx, 1)
    },
  }
}

function createFakeWindow(origin: string): FakeWindow {
  const win: FakeWindow = {
    origin,
    parent: null,
    contentWindow: null,
    listeners: [],
    postMessage: (_envelope: unknown, _origin: string, _transfer?: Transferable[]) => {
      throw new Error('pairWindows must replace postMessage')
    },
    addEventListener(_type, fn) {
      this.listeners.push(fn)
    },
    removeEventListener(_type, fn) {
      const idx = this.listeners.indexOf(fn)
      if (idx >= 0) this.listeners.splice(idx, 1)
    },
    toString() {
      return origin
    },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  return win
}

/**
 * Wire two windows so the SDK's `window.postMessage(env, origin)` /
 * `window.parent.postMessage(env, origin)` semantics work end-to-end.
 *
 * Per spec:
 *   - `MessageEvent.source` is the window that SENT the message.
 *   - `MessageEvent.origin` is the origin of the window that sent it.
 *   - `target.postMessage(env, origin)` delivers to TARGET's listeners.
 *
 * So the host's postMessage is called when the GUEST sends a message
 * (guest code does `window.parent.postMessage(env, HOST_ORIGIN)`); the
 * message lands in the shared listener list with `source = guest` and
 * `origin = GUEST_ORIGIN` — and the host-side `onMessage` filter
 * (`event.source !== guestWindow`) checks against `guestWindow`, which
 * is the host's reference to the iframe. Symmetrically for host → guest.
 */
function pairWindows(
  host: FakeWindow,
  guest: FakeWindow,
  sharedListeners: Listener[],
  hostOrigin: string,
  guestOrigin: string,
): void {
  host.parent = host
  host.contentWindow = guest
  guest.parent = host
  guest.contentWindow = guest
  guest.referrer = `${hostOrigin}/parent`
  host.postMessage = (envelope, origin, transfer) => {
    void transfer
    if (origin !== hostOrigin) throw new Error(`bad origin ${origin} (guest posts to host as ${hostOrigin})`)
    for (const fn of sharedListeners) {
      fn({ source: guest, origin: guestOrigin, data: envelope } as MessageEvent<unknown>)
    }
  }
  guest.postMessage = (envelope, origin, transfer) => {
    void transfer
    if (origin !== guestOrigin) throw new Error(`bad origin ${origin} (host posts to guest as ${guestOrigin})`)
    for (const fn of sharedListeners) {
      fn({ source: host, origin: hostOrigin, data: envelope } as MessageEvent<unknown>)
    }
  }
}

/**
 * Install the fake DOM the SDK reads at module-init time:
 *   - `globalThis.window` is set to the guest window directly. In a real
 *     browser each realm (host tab + iframe) has its own globals; in Node
 *     we share one `window`. Both sides of the SDK end up calling
 *     `window.addEventListener('message', …)` against the same listener
 *     list — which is also where we made `host.listeners` and
 *     `guest.listeners` point (`setupRig` rewires them to the shared list).
 *     Source/origin checks in each handler do the actual filtering.
 *   - `document.referrer` carries the host's URL so `parentOrigin()` can
 *     derive the expected origin from it.
 *   - `window.location.ancestorOrigins` is set as a fallback for the
 *     rare case where `document.referrer` is empty.
 *
 * Node 22 already provides `URL`, `URLSearchParams`, `setTimeout`,
 * `clearTimeout`, `TextEncoder`, `AbortController`, and `MessageEvent`-
 * shaped objects as globals, so we don't need to re-install them. The SDK
 * only references these lazily inside functions, never at module top level.
 */
function installDom(guestWindow: FakeWindow): void {
  const g = globalThis as Record<string, unknown>
  // Expose `location.ancestorOrigins` as the first fallback path in
  // `parentOrigin()` — keeps the test honest even if `document.referrer`
  // is empty.
  ;(guestWindow as unknown as { location: { ancestorOrigins: string[] } }).location = {
    ancestorOrigins: [guestWindow.parent?.origin ?? ''],
  }
  g.window = guestWindow
  g.document = { referrer: guestWindow.referrer ?? '' }
}

function resetDom(): void {
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.document
}

const HOST_ORIGIN = 'https://shell.test'
const GUEST_ORIGIN = 'https://engine.test'
const SESSION_ID = 'sess-1'

interface TestRig {
  host: FakeWindow
  guest: FakeWindow
  hostModule: typeof import('../../src/dataflare/host')
  guestModule: typeof import('../../src/dataflare/guest')
}

async function setupRig(): Promise<TestRig> {
  const registry = createSharedListenerRegistry()
  const host = createFakeWindow(HOST_ORIGIN)
  const guest = createFakeWindow(GUEST_ORIGIN)
  // Both windows share the same listener list — the SDK's `window.addEventListener`
  // is global, so host.onMessage and guest.onMessage both register here.
  host.listeners = registry.listeners
  guest.listeners = registry.listeners
  pairWindows(host, guest, registry.listeners, HOST_ORIGIN, GUEST_ORIGIN)
  installDom(guest)
  vi.resetModules()
  const [hostModule, guestModule] = await Promise.all([
    import('../../src/dataflare/host'),
    import('../../src/dataflare/guest'),
  ])
  return { host, guest, hostModule, guestModule }
}

describe('iframe ↔ host bridge E2E', () => {
  let rig: TestRig | null = null

  beforeEach(async () => {
    rig = await setupRig()
  })

  afterEach(() => {
    resetDom()
    rig = null
    vi.resetModules()
  })

  it('completes the bootstrap dance: guest posts ready + global-state-request, host sends init, guest switches session', async () => {
    if (!rig) throw new Error('rig not set')
    const events: string[] = []
    const initReceived: unknown[] = []
    const uninstallHost = rig.hostModule.installDataflareHostBridge(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      {
        onEvent: (e) => events.push(`event:${e.type}`),
        onCommand: (c) => initReceived.push(c),
      },
    )
    const uninstallGuest = rig.guestModule.installDataflareEmbedBridge({
      onCommand: (c) => initReceived.push(c),
    })
    // Guest's bootstrap posts go out before any sessionId is set, so the
    // host (which strictly enforces sessionId) drops them. The host then
    // sends an `init` command to anchor the session; from then on the guest
    // tags every envelope with the same id.
    await Promise.resolve()
    rig.hostModule.postCommandToGuest(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      {
        type: 'init',
        context: { tenantId: 't1', userId: 'u1' },
        sessionId: SESSION_ID,
      },
    )
    await Promise.resolve()
    expect(initReceived.some((c) => (c as { type: string }).type === 'init')).toBe(true)
    expect(rig.guestModule.getDataflareEmbedSessionId()).toBe(SESSION_ID)
    // Now guest → host events with sessionId attached should land.
    rig.guestModule.postToEmbedParent({ type: 'document-dirty', documentId: 'doc-1' })
    await Promise.resolve()
    expect(events).toContain('event:document-dirty')
    uninstallHost()
    uninstallGuest()
  })

  it('routes host → guest commands once the session is initialized', async () => {
    if (!rig) throw new Error('rig not set')
    const commands: string[] = []
    rig.hostModule.installDataflareHostBridge(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      {},
    )
    rig.guestModule.installDataflareEmbedBridge({
      onCommand: (c) => commands.push(c.type),
    })
    await Promise.resolve()
    // Anchor the session so the guest's inbound command filter is open.
    rig.hostModule.postCommandToGuest(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      { type: 'init', context: {}, sessionId: SESSION_ID },
    )
    await Promise.resolve()
    rig.hostModule.postCommandToGuest(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      { type: 'set-readonly', readonly: true },
    )
    rig.hostModule.postCommandToGuest(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      { type: 'focus-ai', prompt: 'summarize' },
    )
    await Promise.resolve()
    expect(commands).toEqual(['init', 'set-readonly', 'focus-ai'])
    expect(rig.guestModule.getDataflareEmbedSessionId()).toBe(SESSION_ID)
  })

  it('drops commands with the wrong sessionId from the guest side', async () => {
    if (!rig) throw new Error('rig not set')
    const commands: string[] = []
    rig.hostModule.installDataflareHostBridge(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      {},
    )
    rig.guestModule.installDataflareEmbedBridge({
      onCommand: (c) => commands.push(c.type),
    })
    await Promise.resolve()
    // Hand-spoofed envelope with mismatched sessionId — guest must drop it.
    const forged = {
      protocol: 'genoffice-dataflare/v1',
      kind: 'command',
      sessionId: 'attacker-session',
      payload: { type: 'save' },
    }
    for (const fn of rig.guest.listeners) {
      fn({ source: rig.host, origin: HOST_ORIGIN, data: forged } as MessageEvent<unknown>)
    }
    expect(commands).toEqual([])
  })

  it('round-trips a one-shot request through requestDataflareParent', async () => {
    if (!rig) throw new Error('rig not set')
    rig.hostModule.installDataflareHostBridge(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      {
        onRequest: async (req) => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ echo: req.path })).buffer,
        }),
      },
    )
    rig.guestModule.installDataflareEmbedBridge({ onCommand: () => undefined })
    await Promise.resolve()
    // Anchor the session so the guest's outbound requests carry sessionId.
    rig.hostModule.postCommandToGuest(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      { type: 'init', context: {}, sessionId: SESSION_ID },
    )
    await Promise.resolve()
    const promise = rig.guestModule.requestDataflareParent({
      type: 'http-request',
      requestId: 'req-1',
      sessionId: SESSION_ID,
      method: 'POST',
      path: '/api/v1/echo',
      jsonBody: '{"hello":"world"}',
    })
    const response = await promise
    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(response.body)).toBe('{"echo":"/api/v1/echo"}')
  })

  it('round-trips an SSE stream via requestDataflareStreamParent', async () => {
    if (!rig) throw new Error('rig not set')
    rig.hostModule.installDataflareHostBridge(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      {
        onStreamRequest: (_req, emit, close, signal) => {
          expect(signal.aborted).toBe(false)
          emit({ eventName: 'progress', data: '25%' })
          emit({ eventName: 'progress', data: '75%' })
          queueMicrotask(() => close(200))
        },
      },
    )
    rig.guestModule.installDataflareEmbedBridge({ onCommand: () => undefined })
    await Promise.resolve()
    rig.hostModule.postCommandToGuest(
      rig.host.contentWindow as unknown as Window,
      GUEST_ORIGIN,
      SESSION_ID,
      { type: 'init', context: {}, sessionId: SESSION_ID },
    )
    await Promise.resolve()
    const seen: Array<{ kind: 'event' | 'close'; data: string; status?: number }> = []
    const closePromise = new Promise<number>((resolveClose) => {
      rig!.guestModule.requestDataflareStreamParent(
        {
          type: 'http-stream-request',
          requestId: 'stream-1',
          sessionId: SESSION_ID,
          method: 'POST',
          path: '/api/v1/translate',
          jsonBody: '{}',
        },
        (ev) => seen.push({ kind: 'event', data: ev.data }),
        (status) => {
          seen.push({ kind: 'close', data: '', status })
          resolveClose(status)
        },
        (err) => {
          throw err
        },
      )
    })
    const status = await closePromise
    expect(status).toBe(200)
    expect(seen).toEqual([
      { kind: 'event', data: '25%' },
      { kind: 'event', data: '75%' },
      { kind: 'close', data: '', status: 200 },
    ])
  })

  it('buildDataflareEmbedUrl produces a valid URL with all required params', () => {
    if (!rig) throw new Error('rig not set')
    const url = rig.hostModule.buildDataflareEmbedUrl({
      baseUrl: HOST_ORIGIN,
      app: 'docs',
      documentId: 'doc-42',
      jwt: 'tok-1',
      sessionId: SESSION_ID,
      nonce: 'nonce-1',
      readonly: true,
      locale: 'zh-CN',
      theme: 'dark',
    })
    const u = new globalThis.URL(url)
    expect(u.pathname).toBe('/apps/docs/embedded')
    expect(u.searchParams.get('embed')).toBe('1')
    expect(u.searchParams.get('app')).toBe('docs')
    expect(u.searchParams.get('doc')).toBe('doc-42')
    expect(u.searchParams.get('jwt')).toBe('tok-1')
    expect(u.searchParams.get('sessionId')).toBe(SESSION_ID)
    expect(u.searchParams.get('nonce')).toBe('nonce-1')
    expect(u.searchParams.get('readonly')).toBe('true')
    expect(u.searchParams.get('lang')).toBe('zh-CN')
    expect(u.searchParams.get('theme')).toBe('dark')
  })

  it('isDataflareEnvelope rejects payloads with the wrong protocol', async () => {
    const { isDataflareEnvelope } = await import('../../src/dataflare/protocol')
    expect(isDataflareEnvelope({ protocol: 'other/v1', kind: 'event', payload: {} })).toBe(false)
    expect(isDataflareEnvelope(null)).toBe(false)
    expect(isDataflareEnvelope({})).toBe(false)
    expect(isDataflareEnvelope({ protocol: 'genoffice-dataflare/v1', kind: 'event', payload: {} })).toBe(true)
  })
})
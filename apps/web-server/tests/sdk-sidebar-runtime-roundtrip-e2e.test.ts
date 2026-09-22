/**
 * Real end-to-end proof of the SDK 2.0 Kestrel M3.5 Plugin Runtime
 * (sdk1.md §11.36.5 follow-up + §B.5.1 #8):
 *
 *   host SDK ──makeCommand──▶ postMessage ──bridge.onHost───▶
 *     installLiveModelSink({adapter: {mountSidebar, ...}}) ──createSidebarRuntime──▶ reply
 *
 * The text-buffer e2e (`sdk-command-text-buffer-roundtrip-e2e.test.ts`)
 * proved the wire fits for setContent / getContent / insertText. This
 * suite is the same shape but for the three sidebar commands — and
 * proves the SidebarRuntime actually mounts an iframe, returns a
 * stable panelId, writes the right envelope on postToSidebar, and
 * tears down on unmountSidebar.
 */
import { describe, expect, it } from 'vitest'
import { EMBED_BRIDGE_SOURCE } from '../src/embed/bridge'
import {
  createSidebarRuntime,
  SidebarIframeUnavailableError,
  type SidebarHostLike,
  type SidebarIframeLike,
} from '@genoffice/ipc-bridge/sidebar-runtime'
import {
  installLiveModelSink,
  SidebarPanelNotMountedError,
} from '@genoffice/ipc-bridge/sdk-command-sink'

const ENVELOPE_VERSION = '1.0' as const

interface CommandEnvelopePayload { name: string; args?: unknown }
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

interface FakeIframe {
  src?: string
  style: Record<string, string>
  posted: Array<{ data: unknown; origin: string }>
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  contentWindow: { postMessage: (data: unknown, origin: string) => void }
}

interface Harness {
  parentPosts: Array<{ data: unknown }>
  messageHandlers: Array<(event: { data: unknown }) => void>
  iframes: FakeIframe[]
}

function evalBridge(opts: { sidebar: ReturnType<typeof createSidebarRuntime> }): Harness {
  const parentPosts: Array<{ data: unknown }> = []
  const messageHandlers: Array<(event: { data: unknown }) => void> = []
  const iframes: FakeIframe[] = []

  const fakeWindow: Record<string, unknown> = Object.assign({}, {
    __GENOFFICE_EMBED__: { app: 'docs', sessionId: 'session-sidebar', docId: 'rt.docx' },
    parent: { postMessage: (data: unknown) => { parentPosts.push({ data }) } },
    addEventListener: (evt: string, handler: (event: { data: unknown }) => void) => {
      if (evt === 'message') messageHandlers.push(handler)
    },
    dispatchEvent: () => undefined,
  })
  const fakeDocument = { readyState: 'complete', querySelector: () => null }
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

  // Wire the sink AFTER the bridge boot (the bridge reads the sink lazily).
  installLiveModelSink({
    target: fakeWindow as never,
    adapter: {
      mountSidebar: (i) => opts.sidebar.mount(i),
      unmountSidebar: (i) => { opts.sidebar.unmount(i.panelId); return undefined },
      postToSidebar: (i) => { opts.sidebar.post(i.panelId, i.message); return undefined },
    },
  })

  // Wrap the runtime's host so each mounted iframe ends up in our `iframes` list.
  const realHost = (opts.sidebar as unknown as { host: SidebarHostLike }).host
  ;(opts.sidebar as unknown as { host: SidebarHostLike }).host = {
    appendChild(child) {
      iframes.push(child as unknown as FakeIframe)
      if (realHost.appendChild) realHost.appendChild(child)
    },
    removeChild(child) {
      const i = iframes.indexOf(child as unknown as FakeIframe)
      if (i >= 0) iframes.splice(i, 1)
      if (realHost.removeChild) realHost.removeChild(child)
    },
  }

  return { parentPosts, messageHandlers, iframes }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function deliver(harness: Harness, env: Envelope): void {
  for (const h of harness.messageHandlers) h({ data: env })
}

function lastReply(harness: Harness, correlationId: string) {
  for (const post of harness.parentPosts) {
    const env = post.data as Envelope | null
    if (!env || env.kind !== 'command-result') continue
    if (env.correlationId !== correlationId) continue
    return env.payload as { ok: boolean; result?: unknown; error?: { code: string; message: string } }
  }
  return null
}

function makeSidebar() {
  const iframes: FakeIframe[] = []
  const host: SidebarHostLike = {
    appendChild(child) { iframes.push(child as unknown as FakeIframe) },
    removeChild(child) {
      const i = iframes.indexOf(child as unknown as FakeIframe)
      if (i >= 0) iframes.splice(i, 1)
    },
  }
  const createIframe: () => SidebarIframeLike = () => {
    const fake: FakeIframe = {
      style: {},
      posted: [],
      setAttribute(name: string, value: string) {
        if (name === 'src') fake.src = value
      },
      getAttribute(name: string) { return fake.src ?? null },
      contentWindow: {
        postMessage(data: unknown, origin: string) {
          fake.posted.push({ data, origin })
        },
      },
    }
    return fake as unknown as SidebarIframeLike
  }
  const sidebar = createSidebarRuntime({
    host,
    createIframe,
    bindWindow: false, // we drive handleInboundMessage manually
    postOrigin: 'https://plugins.example',
    inboundOrigin: 'https://plugins.example', // opt into origin filter so the
                                             // 'wrong origin' assertion holds
  })
  return { sidebar, iframes }
}

describe('SDK host → bridge → SidebarRuntime round-trip (sdk1.md §B.5.1 M3.5)', () => {
  it('mountSidebar returns {panelId}, appends iframe, writes postToSidebar envelope, unmount removes it', async () => {
    const { sidebar, iframes } = makeSidebar()
    const h = evalBridge({ sidebar })

    deliver(h, makeCommand('mountSidebar', {
      panelUrl: 'https://plugins.example/spell',
      width: 320,
      title: 'Spell',
    }, 'corr-m1'))
    await flush()
    const r = lastReply(h, 'corr-m1') as { ok: boolean; result?: { panelId: string } } | null
    expect(r).not.toBeNull()
    expect(r!.ok).toBe(true)
    const { panelId } = r!.result!
    expect(panelId).toMatch(/^sidebar-/)
    expect(iframes).toHaveLength(1)
    expect(iframes[0]!.src).toBe('https://plugins.example/spell')

    deliver(h, makeCommand('postToSidebar', { panelId, message: { type: 'progress', pct: 5 } }, 'corr-p1'))
    await flush()
    const r2 = lastReply(h, 'corr-p1') as { ok: boolean } | null
    expect(r2?.ok).toBe(true)
    expect(iframes[0]!.posted).toEqual([{
      data: { v: 'sidebar.v1', panelId, message: { type: 'progress', pct: 5 } },
      origin: 'https://plugins.example',
    }])

    deliver(h, makeCommand('unmountSidebar', { panelId }, 'corr-u1'))
    await flush()
    const r3 = lastReply(h, 'corr-u1') as { ok: boolean } | null
    expect(r3?.ok).toBe(true)
    expect(iframes).toHaveLength(0)
    expect(sidebar.has(panelId)).toBe(false)
  })

  it('postToSidebar on unknown panelId surfaces SIDEBAR_PANEL_NOT_MOUNTED across the wire', async () => {
    const { sidebar } = makeSidebar()
    const h = evalBridge({ sidebar })
    deliver(h, makeCommand('postToSidebar', { panelId: 'ghost', message: { type: 'x' } }, 'corr-bad'))
    await flush()
    const r = lastReply(h, 'corr-bad') as { ok: boolean; error?: { code: string; message: string } } | null
    expect(r).not.toBeNull()
    expect(r!.ok).toBe(false)
    expect(r!.error?.code).toBe('SIDEBAR_PANEL_NOT_MOUNTED')
  })

  it('panel → editor inbound postMessage fans out to onMessage handlers (with origin filtering)', async () => {
    const { sidebar } = makeSidebar()
    const h = evalBridge({ sidebar })
    // Mount so the runtime knows the panelId.
    deliver(h, makeCommand('mountSidebar', { panelUrl: 'https://plugins.example/panel' }, 'corr-m2'))
    await flush()
    const r = lastReply(h, 'corr-m2') as { ok: boolean; result?: { panelId: string } } | null
    const { panelId } = r!.result!

    const seen: Array<unknown> = []
    const off = sidebar.onMessage((_p, m) => seen.push(m))
    // Wrong origin -> dropped
    sidebar.handleInboundMessage({
      data: { v: 'sidebar.v1', panelId, message: { ok: 1 } },
      origin: 'https://evil.example',
    })
    // Right origin -> fires
    sidebar.handleInboundMessage({
      data: { v: 'sidebar.v1', panelId, message: { ok: 2 } },
      origin: 'https://plugins.example',
    })
    // Stale envelope version -> dropped
    sidebar.handleInboundMessage({
      data: { v: 'sidebar.v0', panelId, message: { ok: 3 } },
      origin: 'https://plugins.example',
    })
    expect(seen).toEqual([{ ok: 2 }])
    off()
  })

  it('a renderer-side SidebarIframeUnavailableError surfaces as RENDERER_ERROR (preserving err.code when set)', async () => {
    // Force IFRAME_UNAVAILABLE by passing a host with no real DOM factory AND
    // no `globalThis.document` (vitest bare node). mountSidebar will throw
    // SidebarIframeUnavailableError which the bridge mirrors verbatim.
    const sidebar = createSidebarRuntime({ host: {} })
    const h = evalBridge({ sidebar })
    deliver(h, makeCommand('mountSidebar', { panelUrl: '/x' }, 'corr-dom'))
    await flush()
    const r = lastReply(h, 'corr-dom') as { ok: boolean; error?: { code: string; message: string } } | null
    expect(r).not.toBeNull()
    expect(r!.ok).toBe(false)
    expect(r!.error?.code).toBe('SIDEBAR_IFRAME_UNAVAILABLE')
    expect(r!.error?.message).toMatch(/sidebar runtime/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  createSidebarRuntime,
  SidebarIframeUnavailableError,
  type SidebarHostLike,
  type SidebarIframeLike,
} from '../src/sidebar-runtime'
import {
  installLiveModelSink,
  SidebarPanelNotMountedError,
  UnsupportedCommandError,
} from '../src/sdk-command-sink'

/**
 * Sidebar / taskpane runtime for the SDK 2.0 Kestrel M3.5 Plugin Runtime
 * (sdk1.md §11.36.5 follow-up + §B.5.1 #8). The runtime backs
 * `mountSidebar / unmountSidebar / postToSidebar` in the
 * `@genoffice/ipc-bridge` live-model adapter surface; apps (docs/sheets/
 * slides/pdf/markdown/html) plug it in once at boot.
 *
 * Tests inject a fake DOM via the `host` interface + `createIframe`
 * factory so we don't need jsdom. The `bindWindow:false` path lets us
 * also test the runtime without touching `globalThis.window`.
 */

interface FakeIframe {
  src?: string
  style: Record<string, string>
  posted: Array<{ data: unknown; origin: string }>
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  contentWindow: { postMessage: (data: unknown, origin: string) => void }
}

function makeHost(): { host: SidebarHostLike; children: FakeIframe[] } {
  const children: FakeIframe[] = []
  const host: SidebarHostLike = {
    appendChild(child) {
      children.push(child as unknown as FakeIframe)
    },
    removeChild(child) {
      const i = children.indexOf(child as unknown as FakeIframe)
      if (i >= 0) children.splice(i, 1)
    },
  }
  return { host, children }
}

function makeIframeFactory(postedRef: { list: FakeIframe[] }): () => SidebarIframeLike {
  return () => {
    const iframe: FakeIframe = {
      style: {},
      posted: [],
      setAttribute(name: string, value: string) {
        if (name === 'src') iframe.src = value
      },
      getAttribute(name: string) {
        return iframe.src ?? null
      },
      contentWindow: {
        postMessage(data: unknown, origin: string) {
          iframe.posted.push({ data, origin })
        },
      },
    }
    postedRef.list.push(iframe)
    return iframe as unknown as SidebarIframeLike
  }
}

describe('createSidebarRuntime (mountSidebar / unmountSidebar / postToSidebar)', () => {
  it('mounts a panel: returns {panelId, panelUrl, ...} and appends iframe', () => {
    const posted: FakeIframe[] = []
    const { host, children } = makeHost()
    const rt = createSidebarRuntime({ host, createIframe: makeIframeFactory({ list: posted }) })
    const meta = rt.mount({ panelUrl: '/plugins/spell.html', width: 320, title: 'Spell' })
    expect(meta.panelId).toMatch(/^sidebar-[a-z0-9]+-1$/)
    expect(meta.panelUrl).toBe('/plugins/spell.html')
    expect(meta.width).toBe(320)
    expect(meta.title).toBe('Spell')
    expect(meta.iframe).toBeDefined()
    expect(children).toHaveLength(1)
    expect(children[0] as unknown).toBe(meta.iframe as unknown)
    expect(rt.list()).toEqual([meta])
    expect(rt.has(meta.panelId)).toBe(true)
  })

  it('generates a unique panelId per mount and stays monotonic', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const rt = createSidebarRuntime({ host, createIframe: makeIframeFactory({ list: posted }) })
    const a = rt.mount({ panelUrl: '/a' })
    const b = rt.mount({ panelUrl: '/b' })
    const c = rt.mount({ panelUrl: '/c' })
    expect(new Set([a.panelId, b.panelId, c.panelId]).size).toBe(3)
    expect([a.panelId, b.panelId, c.panelId].map((p) => p.split('-').pop())).toEqual(['1', '2', '3'])
  })

  it('unmount is idempotent: unknown panelId returns false, known panelId returns true', () => {
    const posted: FakeIframe[] = []
    const { host, children } = makeHost()
    const rt = createSidebarRuntime({ host, createIframe: makeIframeFactory({ list: posted }) })
    const meta = rt.mount({ panelUrl: '/x' })
    expect(rt.unmount('does-not-exist')).toBe(false)
    expect(children).toHaveLength(1)
    expect(rt.unmount(meta.panelId)).toBe(true)
    expect(children).toHaveLength(0)
    expect(rt.has(meta.panelId)).toBe(false)
    expect(rt.unmount(meta.panelId)).toBe(false)
  })

  it('post(panelId, message) writes a {v,panelId,message} envelope to the iframe.contentWindow', () => {
    const posted: FakeIframe[] = []
    const { host, children } = makeHost()
    const rt = createSidebarRuntime({
      host,
      createIframe: makeIframeFactory({ list: posted }),
      postOrigin: 'https://plugins.example',
    })
    const meta = rt.mount({ panelUrl: 'https://plugins.example/spell' })
    rt.post(meta.panelId, { type: 'progress', pct: 5 })
    const fake = children[0]!
    expect(fake.posted).toHaveLength(1)
    expect(fake.posted[0]).toEqual({
      data: { v: 'sidebar.v1', panelId: meta.panelId, message: { type: 'progress', pct: 5 } },
      origin: 'https://plugins.example',
    })
  })

  it('post on unknown panelId throws SidebarPanelNotMountedError (SIDEBAR_PANEL_NOT_MOUNTED)', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const rt = createSidebarRuntime({ host, createIframe: makeIframeFactory({ list: posted }) })
    expect(() => rt.post('ghost', { hi: 1 })).toThrow(SidebarPanelNotMountedError)
    try {
      rt.post('ghost', { hi: 1 })
    } catch (e) {
      expect((e as { code?: string }).code).toBe('SIDEBAR_PANEL_NOT_MOUNTED')
    }
  })

  it('handleInboundMessage fires registered handlers for valid envelopes; drops invalid ones', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const seen: Array<{ panelId: string; message: unknown }> = []
    const rt = createSidebarRuntime({
      host,
      createIframe: makeIframeFactory({ list: posted }),
      bindWindow: false,
    })
    const meta = rt.mount({ panelUrl: '/x' })
    const off = rt.onMessage((panelId, message) => seen.push({ panelId, message }))
    rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: { kind: 'pong' } } })
    expect(seen).toEqual([{ panelId: meta.panelId, message: { kind: 'pong' } }])
    rt.handleInboundMessage({ data: { v: 'sidebar.v0', panelId: meta.panelId, message: {} } })
    expect(seen).toHaveLength(1)
    rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: 'ghost', message: {} } })
    expect(seen).toHaveLength(1)
    rt.handleInboundMessage({ data: 42 })
    expect(seen).toHaveLength(1)
    off()
    rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: { kind: 'after' } } })
    expect(seen).toHaveLength(1)
  })

  it('inboundOrigin filter drops messages from other origins silently', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const seen: Array<unknown> = []
    const rt = createSidebarRuntime({
      host,
      createIframe: makeIframeFactory({ list: posted }),
      bindWindow: false,
      inboundOrigin: 'https://plugins.example',
    })
    const meta = rt.mount({ panelUrl: 'https://plugins.example/x' })
    rt.onMessage((_p, m) => seen.push(m))
    rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: { ok: 1 } }, origin: 'https://evil.example' })
    rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: { ok: 2 } }, origin: 'https://plugins.example' })
    expect(seen).toEqual([{ ok: 2 }])
  })

  it('handler exceptions do not break the fan-out to other handlers', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const rt = createSidebarRuntime({
      host,
      createIframe: makeIframeFactory({ list: posted }),
      bindWindow: false,
    })
    const meta = rt.mount({ panelUrl: '/x' })
    const goodSeen: unknown[] = []
    rt.onMessage(() => { throw new Error('boom') })
    rt.onMessage((_p, m) => goodSeen.push(m))
    rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: 'hello' } })
    expect(goodSeen).toEqual(['hello'])
  })

  it('bindWindow:true wires the runtime to the injected windowLike addEventListener', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const seen: Array<unknown> = []
    const listeners: Array<(e: { data: unknown; origin?: string }) => void> = []
    const windowLike = {
      addEventListener(_evt: 'message', h: (e: { data: unknown; origin?: string }) => void) {
        listeners.push(h)
      },
      removeEventListener(_evt: 'message', h: (e: { data: unknown; origin?: string }) => void) {
        const i = listeners.indexOf(h)
        if (i >= 0) listeners.splice(i, 1)
      },
    }
    const rt = createSidebarRuntime({
      host,
      createIframe: makeIframeFactory({ list: posted }),
      windowLike,
      onInboundMessage: (_p, m) => seen.push(m),
    })
    const meta = rt.mount({ panelUrl: '/x' })
    expect(listeners).toHaveLength(1)
    listeners[0]!({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: { hi: 1 } }, origin: 'https://plugins.example' })
    expect(seen).toEqual([{ hi: 1 }])
    rt.dispose()
    expect(listeners).toHaveLength(0)
  })

  it('throws SidebarIframeUnavailableError at mount-time when no DOM factory and no document', () => {
    const { host } = makeHost()
    const rt = createSidebarRuntime({ host })
    expect(() => rt.mount({ panelUrl: '/x' })).toThrow(SidebarIframeUnavailableError)
    try {
      rt.mount({ panelUrl: '/x' })
    } catch (e) {
      expect((e as { code?: string }).code).toBe('SIDEBAR_IFRAME_UNAVAILABLE')
    }
  })

  it('dispose() detaches all iframes + clears handlers + is idempotent', () => {
    const posted: FakeIframe[] = []
    const { host, children } = makeHost()
    const rt = createSidebarRuntime({ host, createIframe: makeIframeFactory({ list: posted }) })
    rt.mount({ panelUrl: '/a' })
    rt.mount({ panelUrl: '/b' })
    expect(children).toHaveLength(2)
    rt.dispose()
    expect(children).toHaveLength(0)
    expect(rt.list()).toEqual([])
    rt.dispose()
    expect(() => rt.mount({ panelUrl: '/c' })).toThrow(/disposed/)
  })

  it('outboundToHost:true mirrors inbound messages as sidebarMessage EditorEvent envelopes to window.parent', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const parentPosts: Array<{ data: unknown; origin: string }> = []
    const outboundTarget = {
      postMessage(data: unknown, origin: string) {
        parentPosts.push({ data, origin })
      },
    }
    const rt = createSidebarRuntime({
      host,
      createIframe: makeIframeFactory({ list: posted }),
      bindWindow: false,
      outboundToHost: true,
      outboundTarget,
    })
    const meta = rt.mount({ panelUrl: 'https://plugins.example/x' })
    rt.handleInboundMessage({
      data: { v: 'sidebar.v1', panelId: meta.panelId, message: { kind: 'PONG', n: 7 } },
      origin: 'https://plugins.example',
    })
    expect(parentPosts).toEqual([{
      data: {
        v: '1.0',
        dir: 'editor→host',
        kind: 'event',
        payload: {
          name: 'sidebarMessage',
          payload: { panelId: meta.panelId, message: { kind: 'PONG', n: 7 } },
        },
      },
      origin: '*',
    }])
  })

  it('outboundToHost:false (default) does NOT post anything to window.parent', () => {
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    const parentPosts: Array<unknown> = []
    const outboundTarget = {
      postMessage(data: unknown) {
        parentPosts.push(data)
      },
    }
    const rt = createSidebarRuntime({
      host,
      createIframe: makeIframeFactory({ list: posted }),
      bindWindow: false,
      outboundTarget,
    })
    const meta = rt.mount({ panelUrl: '/x' })
    rt.handleInboundMessage({
      data: { v: 'sidebar.v1', panelId: meta.panelId, message: { x: 1 } },
    })
    expect(parentPosts).toEqual([])
  })

  it('outboundToHost:true degrades to no-op when no window.parent is reachable', () => {
    // No outboundTarget supplied and globalThis.window.parent doesn't exist
    // (vitest bare node). The runtime must NOT throw at construction —
    // apps that run outside an iframe have no host to forward to.
    const posted: FakeIframe[] = []
    const { host } = makeHost()
    expect(() =>
      createSidebarRuntime({
        host,
        createIframe: makeIframeFactory({ list: posted }),
        bindWindow: false,
        outboundToHost: true,
      }),
    ).not.toThrow()
  })

  describe('integration: installLiveModelSink + createSidebarRuntime', () => {
    it('mountSidebar -> {panelId}, unmountSidebar -> void, postToSidebar writes the envelope', async () => {
      const posted: FakeIframe[] = []
      const { host, children } = makeHost()
      const rt = createSidebarRuntime({
        host,
        createIframe: makeIframeFactory({ list: posted }),
        postOrigin: 'https://plugins.example',
      })
      const sinkHandle = installLiveModelSink({
        target: {},
        adapter: {
          mountSidebar: (i) => rt.mount(i),
          unmountSidebar: (i) => { rt.unmount(i.panelId); return undefined },
          postToSidebar: (i) => { rt.post(i.panelId, i.message); return undefined },
        },
      })
      const r1 = await sinkHandle.dispatch('mountSidebar', {
        panelUrl: 'https://plugins.example/spell',
        width: 320,
        title: 'Spell',
      }) as { panelId: string }
      expect(r1.panelId).toMatch(/^sidebar-/)
      expect(rt.has(r1.panelId)).toBe(true)
      expect(children).toHaveLength(1)
      await sinkHandle.dispatch('postToSidebar', { panelId: r1.panelId, message: { type: 'progress', pct: 1 } })
      const fake = children[0]!
      expect(fake.posted).toEqual([
        { data: { v: 'sidebar.v1', panelId: r1.panelId, message: { type: 'progress', pct: 1 } }, origin: 'https://plugins.example' },
      ])
      await sinkHandle.dispatch('unmountSidebar', { panelId: r1.panelId })
      expect(rt.has(r1.panelId)).toBe(false)
      expect(children).toHaveLength(0)
    })

    it('postToSidebar through the sink on unknown panelId surfaces SIDEBAR_PANEL_NOT_MOUNTED', async () => {
      const posted: FakeIframe[] = []
      const { host } = makeHost()
      const rt = createSidebarRuntime({ host, createIframe: makeIframeFactory({ list: posted }) })
      const sinkHandle = installLiveModelSink({
        target: {},
        adapter: {
          mountSidebar: (i) => rt.mount(i),
          unmountSidebar: (i) => { rt.unmount(i.panelId); return undefined },
          postToSidebar: (i) => { rt.post(i.panelId, i.message); return undefined },
        },
      })
      await expect(
        sinkHandle.dispatch('postToSidebar', { panelId: 'ghost', message: {} }),
      ).rejects.toBeInstanceOf(SidebarPanelNotMountedError)
    })

    it('panel -> editor inbound postMessage fans out to onMessage + the user-provided onInboundMessage', () => {
      const posted: FakeIframe[] = []
      const seen: Array<{ panelId: string; message: unknown; via: string }> = []
      const { host } = makeHost()
      const rt = createSidebarRuntime({
        host,
        createIframe: makeIframeFactory({ list: posted }),
        bindWindow: false,
        onInboundMessage: (panelId, message) => seen.push({ panelId, message, via: 'onInboundMessage' }),
      })
      const meta = rt.mount({ panelUrl: '/x' })
      const off = rt.onMessage((panelId, message) => seen.push({ panelId, message, via: 'onMessage' }))
      rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: { type: 'PONG' } } })
      off()
      rt.handleInboundMessage({ data: { v: 'sidebar.v1', panelId: meta.panelId, message: { type: 'AFTER' } } })
      expect(seen).toEqual([
        { panelId: meta.panelId, message: { type: 'PONG' }, via: 'onInboundMessage' },
        { panelId: meta.panelId, message: { type: 'PONG' }, via: 'onMessage' },
        { panelId: meta.panelId, message: { type: 'AFTER' }, via: 'onInboundMessage' },
      ])
    })

    it('dispatching a command the runtime does NOT implement rejects with UnsupportedCommandError', async () => {
      const posted: FakeIframe[] = []
      const { host } = makeHost()
      const rt = createSidebarRuntime({ host, createIframe: makeIframeFactory({ list: posted }) })
      const sinkHandle = installLiveModelSink({
        target: {},
        adapter: {
          mountSidebar: (i) => rt.mount(i),
        },
      })
      await expect(sinkHandle.dispatch('unmountSidebar', { panelId: 'p' })).rejects.toBeInstanceOf(UnsupportedCommandError)
      await expect(sinkHandle.dispatch('postToSidebar', { panelId: 'p', message: {} })).rejects.toBeInstanceOf(UnsupportedCommandError)
    })
  })
})

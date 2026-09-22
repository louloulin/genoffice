/// Sidebar / taskpane runtime for the GenOffice embed bridge (sdk1.md §11.36.5
/// follow-up + M3.5 Plugin Runtime).
///
/// Apps (docs / sheets / slides / pdf / markdown / html) plug this in by
/// wiring the return value into `installLiveModelSink({adapter: {...}})`:
///
/// ```ts
/// const sidebar = createSidebarRuntime({ host: document.getElementById('sidebar')! })
/// installLiveModelSink({
///   adapter: {
///     mountSidebar: (i) => sidebar.mount(i),
///     unmountSidebar: (i) => { sidebar.unmount(i.panelId) },
///     postToSidebar: (i) => sidebar.post(i.panelId, i.message),
///   },
///   onInboundMessage: (panelId, message) => editor.fireSidebarMessage(panelId, message),
/// })
/// ```
///
/// Wire contract (matches the SDK's EditorCommands.mountSidebar):
///
///   host \u2192 editor: {name:'mountSidebar', args:{panelUrl, width?, title?}}
///   editor \u2192 host: {name:'mountSidebar', args:{panelUrl, width?, title?}, result:{panelId}}
///   host \u2192 editor: {name:'unmountSidebar', args:{panelId}}
///   editor \u2192 host: {name:'unmountSidebar', args:{panelId}, result:void}
///   host \u2192 editor: {name:'postToSidebar', args:{panelId, message}}
///   editor \u2192 host: {name:'postToSidebar', args:{panelId, message}, result:void}
///   panel \u2192 editor: window.postMessage({v:'sidebar.v1', panelId, message})
///   editor \u2192 host: sidebarMessage event ({panelId, message})
///
/// The runtime is DOM-agnostic by accepting an HTMLElement-like host and
/// an optional element factory \u2014 tests inject a fake DOM and apps get the
/// real one.
import { SidebarPanelNotMountedError } from './sdk-command-sink'

export interface SidebarPanelMeta {
  /** Stable id the host uses for unmount / postToSidebar calls. */
  panelId: string
  /** The original panelUrl from mountSidebar. */
  panelUrl: string
  /** Optional width (CSS px) \u2014 apps may use this to size the iframe. */
  width?: number
  /** Optional title \u2014 apps may use this for an aria-label / tooltip. */
  title?: string
  /** The created iframe-like element (real HTMLIFrameElement in browsers). */
  iframe: SidebarIframeLike
  /** epoch ms when the panel was mounted. */
  mountedAt: number
}

/** Minimal interface so the runtime works with a fake DOM in tests. */
export interface SidebarIframeLike {
  src?: string
  /** Inline-style assignments (`element.style.width = '320px'`). */
  style: Record<string, string>
  setAttribute(name: string, value: string): void
  /** Post a message into the iframe. Optional \u2014 absent during mount before the iframe attaches. */
  contentWindow?: { postMessage: (data: unknown, origin: string) => void } | null
}

/** Minimal interface so the runtime works with a fake DOM in tests. */
export interface SidebarHostLike {
  appendChild?(child: SidebarIframeLike): void
  removeChild?(child: SidebarIframeLike): void
}

export interface SidebarRuntimeOptions {
  /** Container the sidebar mounts into. Required. */
  host: SidebarHostLike
  /**
   * Element factory for creating an iframe. Defaults to the standard
   * `document.createElement('iframe')` when available. Injectable for
   * tests under bare Node (no DOM lib).
   */
  createIframe?: () => SidebarIframeLike
  /**
   * Origin to attach to outbound `iframe.contentWindow.postMessage`.
   * Default `'*'` for cross-origin plugin panels (matches SDK examples).
   * Apps running same-origin panels may narrow this to `window.location.origin`.
   */
  postOrigin?: string
  /**
   * Origin filter for inbound panel postMessages. Messages whose
   * `event.origin` doesn't match are dropped silently (do not throw \u2014
   * the SDK contract is "loud failures only for known conditions";
   * unknown origins are expected to be ignored).
   */
  inboundOrigin?: string
  /**
   * If true, the runtime listens to `window.addEventListener('message')`
   * itself and dispatches inbound panel posts to `onInboundMessage`.
   * Default true. Set false if the host app already maintains a global
   * `message` listener and forwards panel messages to the runtime via
   * `runtime.handleInboundMessage(event)`.
   */
  bindWindow?: boolean
  /**
   * Inbound message handler. Fires on the shape
   * `(panelId, message)` after origin + envelope-shape validation.
   */
  onInboundMessage?: (panelId: string, message: unknown) => void
  /**
   * `window` target for the optional `message` listener. Defaults to
   * `globalThis.window`. Injectable for tests.
   */
  windowLike?: {
    addEventListener?(evt: 'message', handler: (e: { data: unknown; origin?: string }) => void): void
    removeEventListener?(evt: 'message', handler: (e: { data: unknown; origin?: string }) => void): void
  }
}

export interface SidebarRuntime {
  /** Mount a panel, return its metadata (incl. assigned panelId). */
  mount(input: { panelUrl: string; width?: number; title?: string }): SidebarPanelMeta
  /** Tear down a panel. Returns true if it was mounted, false if unknown (idempotent). */
  unmount(panelId: string): boolean
  /** Post a JSON-serialisable message into a panel's iframe. Throws SidebarPanelNotMountedError if panelId is unknown. */
  post(panelId: string, message: unknown): void
  /** Snapshot of currently mounted panels. */
  list(): SidebarPanelMeta[]
  /** True when the given panelId is mounted. */
  has(panelId: string): boolean
  /** Subscribe to inbound messages from any mounted panel. Returns an unsubscribe fn. */
  onMessage(handler: (panelId: string, message: unknown) => void): () => void
  /**
   * Manually forward an inbound postMessage event to the runtime. Use
   * when the host app already owns a global `message` listener (i.e.
   * `bindWindow:false` was set) and we want to keep the runtime's
   * handler chain as the single dispatch point.
   */
  handleInboundMessage(event: { data: unknown; origin?: string }): void
  /** Tear down all panels + remove window listener. Idempotent. */
  dispose(): void
}

const SIDEBAR_ENVELOPE_VERSION = 'sidebar.v1' as const

interface SidebarInboundEnvelope {
  v: typeof SIDEBAR_ENVELOPE_VERSION
  panelId: string
  message: unknown
}

function isSidebarInboundEnvelope(data: unknown): data is SidebarInboundEnvelope {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return (
    d.v === SIDEBAR_ENVELOPE_VERSION &&
    typeof d.panelId === 'string' &&
    Object.prototype.hasOwnProperty.call(d, 'message')
  )
}

function defaultCreateIframe(): SidebarIframeLike {
  // Lazy-load so this module stays test-friendly under bare Node. The
  // factory call site asserts the document is available; if it isn't,
  // we throw a structured `SidebarIframeUnavailableError` instead of a
  // generic ReferenceError so the host SDK sees the missing surface.
  type WithDoc = { document?: { createElement: (tag: string) => unknown } }
  const g = globalThis as unknown as WithDoc
  if (!g.document || typeof g.document.createElement !== 'function') {
    throw new SidebarIframeUnavailableError()
  }
  const iframe = g.document.createElement('iframe') as SidebarIframeLike
  return iframe
}

/** Thrown by createSidebarRuntime when no DOM factory is provided and `document` is not available. */
export class SidebarIframeUnavailableError extends Error {
  readonly code = 'SIDEBAR_IFRAME_UNAVAILABLE' as const
  constructor() {
    super('sidebar runtime needs a DOM (pass `createIframe` or run inside a browser)')
    this.name = 'SidebarIframeUnavailableError'
  }
}

function genPanelId(seq: number): string {
  return `sidebar-${Date.now().toString(36)}-${seq.toString(36)}`
}

/**
 * Create a SidebarRuntime instance. Idempotent — call once per app.
 */
export function createSidebarRuntime(options: SidebarRuntimeOptions): SidebarRuntime {
  const create = options.createIframe ?? defaultCreateIframe
  const postOrigin = options.postOrigin ?? '*'
  const inboundOrigin = options.inboundOrigin
  const panels = new Map<string, SidebarPanelMeta>()
  const handlers = new Set<(panelId: string, message: unknown) => void>()
  let nextSeq = 0
  let disposed = false
  let boundHandler: ((e: { data: unknown; origin?: string }) => void) | null = null

  function dispatch(panelId: string, message: unknown): void {
    if (disposed) return
    for (const h of handlers) {
      try {
        h(panelId, message)
      } catch {
        /* handler errors are best-effort; one bad subscriber must not
           break the runtime's message fan-out */
      }
    }
  }

  if (options.bindWindow !== false) {
    const w = options.windowLike ?? ((globalThis as unknown as { window?: SidebarRuntimeOptions['windowLike'] }).window ?? null)
    if (w && typeof w.addEventListener === 'function') {
      boundHandler = (event) => rt.handleInboundMessage(event)
      w.addEventListener('message', boundHandler)
    }
  }

  const rt: SidebarRuntime = {
    mount(input) {
      if (disposed) throw new Error('sidebar runtime disposed')
      if (typeof input.panelUrl !== 'string' || !input.panelUrl) {
        throw new Error('mount: panelUrl is required')
      }
      const panelId = genPanelId(++nextSeq)
      const iframe = create()
      iframe.setAttribute('src', input.panelUrl)
      // width/title are hints \u2014 apps overlay their own sidebar chrome, so
      // we set them as data-* attrs rather than style.width directly,
      // leaving CSS free to size the panel container.
      iframe.setAttribute('data-panel-id', panelId)
      if (typeof input.width === 'number') iframe.setAttribute('data-panel-width', String(input.width))
      if (typeof input.title === 'string') iframe.setAttribute('data-panel-title', input.title)
      if (options.host.appendChild) options.host.appendChild(iframe)
      const meta: SidebarPanelMeta = {
        panelId,
        panelUrl: input.panelUrl,
        width: typeof input.width === 'number' ? input.width : undefined,
        title: typeof input.title === 'string' ? input.title : undefined,
        iframe,
        mountedAt: Date.now(),
      }
      panels.set(panelId, meta)
      return meta
    },
    unmount(panelId) {
      const meta = panels.get(panelId)
      if (!meta) return false
      panels.delete(panelId)
      if (options.host.removeChild) {
        try {
          options.host.removeChild(meta.iframe)
        } catch {
          /* already detached \u2014 ignore */
        }
      }
      return true
    },
    post(panelId, message) {
      const meta = panels.get(panelId)
      if (!meta) throw new SidebarPanelNotMountedError(panelId)
      if (!meta.iframe.contentWindow || typeof meta.iframe.contentWindow.postMessage !== 'function') {
        // The iframe is still mounting (or was detached). Re-throw as
        // a structured error so the host SDK gets a loud cause.
        throw new Error(`post: sidebar panel "${panelId}" has no contentWindow yet`)
      }
      meta.iframe.contentWindow.postMessage(
        { v: SIDEBAR_ENVELOPE_VERSION, panelId, message },
        postOrigin,
      )
    },
    list() {
      return Array.from(panels.values()).map((m) => ({ ...m }))
    },
    has(panelId) {
      return panels.has(panelId)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    handleInboundMessage(event) {
      if (inboundOrigin && event.origin && event.origin !== inboundOrigin) return
      if (!isSidebarInboundEnvelope(event.data)) return
      if (!panels.has(event.data.panelId)) return
      dispatch(event.data.panelId, event.data.message)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const panelId of Array.from(panels.keys())) {
        rt.unmount(panelId)
      }
      if (boundHandler) {
        const w = options.windowLike ?? ((globalThis as unknown as { window?: SidebarRuntimeOptions['windowLike'] }).window ?? null)
        if (w && typeof w.removeEventListener === 'function') {
          try {
            w.removeEventListener('message', boundHandler)
          } catch {
            /* ignore */
          }
        }
        boundHandler = null
      }
      handlers.clear()
    },
  }

  if (options.onInboundMessage) {
    rt.onMessage(options.onInboundMessage)
  }

  return rt
}

/**
 * `mountEditor` — the browser half of the office-ai embed story.
 *
 * office-ai's HTTP face (`/embed/:docId`, `POST /api/ipc/:channel`,
 * `GET /api/ipc/events`) lives in Node and is started by the consuming process
 * with `startUiHost()` or mounted onto an existing server with `attachUi()`.
 * This module is what a *page* loads to put that UI on screen: it creates the
 * iframe, builds the `/embed/` URL, and speaks the postMessage envelope to the
 * server-side bridge (`src/ui/embed/bridge.ts`).
 *
 * The returned handle is deliberately shaped like `@genoffice/web-sdk`'s
 * `EditorHandle`, minus the JWT. office-ai has no auth model to speak of — the
 * host is isolated by binding and loopback — so `jwt`/`host` collapse into a
 * single `baseUrl` and there is nothing to mint.
 */
import {
  ENVELOPE_VERSION,
  isEnvelope,
  makeCommand,
  makeEvent,
  type CommandResultPayload,
  type Envelope,
} from './envelope'
import { setOpenParam } from '../open-param'

export type { Envelope }

export type MountApp = 'docs' | 'sheets' | 'slides' | 'pdf'
export type MountMode = 'edit' | 'view' | 'comment'
export type MountTheme = 'light' | 'dark' | 'auto'
export type MountLang = 'zh-CN' | 'en-US' | 'ja-JP'
export type MountToolbar = 'full' | 'minimal' | 'none'

export interface MountEditorOptions {
  /** Which editor to load. */
  app: MountApp
  /**
   * Origin of a running office-ai UI host (`startUiHost().url`), optionally with
   * a mount prefix (`attachUi(server, {basePath:'/office'})` → `…/office`).
   */
  baseUrl: string
  /** `:docId` — identifies the document for comments/versions. Not the bytes. */
  docId: string
  /** Workspace path the renderer opens (query `open`, or hash `open` for pdf). */
  open?: string
  /** CSS selector or element to mount the iframe into. */
  container: string | HTMLElement

  mode?: MountMode
  theme?: MountTheme
  lang?: MountLang
  toolbar?: MountToolbar
  title?: string
  /** Echoed back on `ready`; use it to tie the frame to this mount. */
  nonce?: string
  /** Only when the host was started with `startUiHost({token})`. */
  token?: string

  instanceId?: string
  /**
   * postMessage origin allowlist. When omitted, only the frame's identity
   * (`event.source === iframe.contentWindow`) is checked — sufficient while the
   * host page is trusted, which is the common in-process case.
   */
  allowedOrigins?: readonly string[]
  /** Reject `whenReady()` after this long. Default 30s. */
  readyTimeoutMs?: number
  /** Reject a `command()` that gets no reply after this long. Default 15s. */
  commandTimeoutMs?: number
}

export interface MountedEditor {
  readonly instanceId: string
  readonly iframe: HTMLIFrameElement
  /** Resolved `/embed/` URL the iframe was pointed at. */
  readonly url: string
  /** Resolves on the bridge's `ready` event; rejects on timeout or boot error. */
  whenReady(): Promise<{ app: MountApp; version: string; nonce?: string }>
  on(name: string, handler: (payload: any) => void): () => void
  once(name: string, handler: (payload: any) => void): () => void
  /** Push a host→editor event (e.g. `sidebarMessage`). */
  post(name: string, payload: unknown): void
  /** Send a command; rejects with the iframe's error or on destroy. */
  command(name: string, args?: unknown, timeoutMs?: number): Promise<any>
  /** Idempotent. Rejects every in-flight command so no await hangs. */
  destroy(): void
}

class CommandError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000

export function mountEditor(options: MountEditorOptions): MountedEditor {
  const container = resolveContainer(options.container)
  const iframe = document.createElement('iframe')
  iframe.src = buildEmbedUrl(options)
  iframe.title = options.title ?? `GenOffice ${options.app} editor`
  // The frame loads a full editor UI; without both of these it renders inside
  // a 300×150 default box and the canvas collapses to nothing.
  iframe.style.width = '100%'
  iframe.style.height = '100%'
  iframe.style.border = '0'
  iframe.style.display = 'block'
  iframe.setAttribute('allowfullscreen', 'true')

  const instanceId = options.instanceId ?? `office-ai-${Math.random().toString(36).slice(2, 10)}`
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const pending = new Map<string, Pending>()
  const allowedOrigins = options.allowedOrigins ? new Set(options.allowedOrigins) : null
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  let destroyed = false
  let counter = 0

  let resolveReady!: (value: { app: MountApp; version: string; nonce?: string }) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<{ app: MountApp; version: string; nonce?: string }>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  // A boot failure must not surface as an unhandled rejection for callers that
  // only ever `command()` — swallow until someone actually awaits it.
  ready.catch(() => {})
  const readyTimer = setTimeout(() => {
    rejectReady(
      new CommandError(
        'EMBED_READY_TIMEOUT',
        `the ${options.app} editor did not report ready within ${readyTimeoutMs}ms — ` +
          'check that baseUrl points at a running office-ai UI host with this app built',
      ),
    )
  }, readyTimeoutMs)

  function emit(name: string, payload: unknown): void {
    const set = listeners.get(name)
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch {
        // A throwing listener must not stop the others or kill the message pump.
      }
    }
  }

  function onMessage(event: MessageEvent): void {
    if (destroyed) return
    // Identity first: any page holding a window reference can post at us, and a
    // forged `command-result` for a guessed correlationId would resolve a
    // command with an attacker-chosen value.
    if (iframe.contentWindow && event.source !== iframe.contentWindow) return
    if (allowedOrigins && !allowedOrigins.has(event.origin)) return
    const data = event.data
    if (!isEnvelope(data) || data.dir !== 'editor→host') return

    if (data.kind === 'command-result') {
      const correlationId = data.correlationId
      if (!correlationId) return
      const entry = pending.get(correlationId)
      if (!entry) return
      pending.delete(correlationId)
      clearTimeout(entry.timer)
      const body = (data.payload ?? {}) as CommandResultPayload
      if (body.ok) entry.resolve(body.result)
      else entry.reject(new CommandError(body.error?.code ?? 'EMBED_ERROR', body.error?.message ?? 'command failed'))
      return
    }

    // The bridge only ever emits `event` inbound; `kind:'command'` would be a
    // frame driving us, which the protocol has no use for.
    if (data.kind !== 'event') return
    const body = data.payload as { name?: unknown; payload?: unknown } | null
    const name = body?.name
    if (typeof name !== 'string' || !name) return
    const detail = body?.payload as { code?: string; message?: string } | undefined
    if (name === 'ready') {
      resolveReady(detail as never)
    } else if (name === 'error') {
      // A boot error ends the ready handshake, so a later `whenReady()` rejects
      // instead of sitting out the full timeout.
      rejectReady(
        new CommandError(detail?.code ?? 'EMBED_ERROR', detail?.message ?? 'the editor reported an error during boot'),
      )
    }
    emit(name, body?.payload)
  }

  window.addEventListener('message', onMessage)

  function post(envelope: Envelope): void {
    if (destroyed) throw new CommandError('EDITOR_DESTROYED', 'this editor was destroyed')
    const target = iframe.contentWindow
    if (!target) throw new CommandError('EDITOR_NOT_MOUNTED', 'the editor iframe is not attached to a document')
    target.postMessage(envelope, '*')
  }

  const handle: MountedEditor = {
    instanceId,
    iframe,
    get url() {
      return iframe.src
    },
    whenReady: () => ready,
    on(name, handler) {
      let set = listeners.get(name)
      if (!set) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(handler)
      return () => {
        set!.delete(handler)
      }
    },
    once(name, handler) {
      const off = handle.on(name, (payload) => {
        off()
        handler(payload)
      })
      return off
    },
    post(name, payload) {
      post(makeEvent(name, payload))
    },
    async command(name, args, timeoutMs = commandTimeoutMs) {
      if (destroyed) throw new CommandError('EDITOR_DESTROYED', 'this editor was destroyed')
      // Posting before the bridge has run silently drops the message — the frame
      // has no listener yet and the promise would never settle.
      await ready.catch((error: Error) => {
        throw error
      })
      counter += 1
      const correlationId = `${instanceId}#${counter}`
      return new Promise((resolveCommand, rejectCommand) => {
        const timer = setTimeout(() => {
          pending.delete(correlationId)
          rejectCommand(new CommandError('EMBED_COMMAND_TIMEOUT', `"${name}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(correlationId, { resolve: resolveCommand, reject: rejectCommand, timer })
        try {
          post(makeCommand(name, args, correlationId))
        } catch (error) {
          pending.delete(correlationId)
          clearTimeout(timer)
          rejectCommand(error as Error)
        }
      })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      clearTimeout(readyTimer)
      window.removeEventListener('message', onMessage)
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new CommandError('EDITOR_DESTROYED', 'the editor was destroyed before the command completed'))
      }
      pending.clear()
      listeners.clear()
      rejectReady(new CommandError('EDITOR_DESTROYED', 'the editor was destroyed during boot'))
      iframe.remove()
    },
  }

  container.appendChild(iframe)
  return handle
}

// ----- helpers ---------------------------------------------------------------

/**
 * Build the `/embed/<docId>` URL.
 *
 * `docId` is the identity SDK commands key comments and versions on; `open` is
 * the actual file. Keeping them separate lets one document id carry several
 * revisions without the comment thread forking.
 */
export function buildEmbedUrl(options: Pick<MountEditorOptions, 'baseUrl' | 'app' | 'docId'> &
  Partial<Omit<MountEditorOptions, 'baseUrl' | 'app' | 'docId'>>): string {
  const base = options.baseUrl.replace(/\/+$/, '')
  const relative = `${base}/embed/${encodeURIComponent(options.docId)}`
  // A same-origin host (`attachUi(server,{basePath:'/office'})`) is naturally
  // addressed as `baseUrl:'/office'`. `new URL()` with no base throws on that,
  // so resolve against the page the way the bridge resolves its own API root —
  // an absolute baseUrl is unaffected (URL() ignores the base for those).
  const pageBase = typeof document !== 'undefined' ? document.baseURI : undefined
  const url = pageBase ? new URL(relative, pageBase) : new URL(relative)
  url.searchParams.set('app', options.app)
  if (options.open) setOpenParam(url, options.app, options.open)
  if (options.mode) url.searchParams.set('mode', options.mode)
  if (options.theme) url.searchParams.set('theme', options.theme)
  if (options.lang) url.searchParams.set('lang', options.lang)
  if (options.toolbar) url.searchParams.set('toolbar', options.toolbar)
  if (options.title) url.searchParams.set('title', options.title)
  if (options.nonce) url.searchParams.set('nonce', options.nonce)
  if (options.token) url.searchParams.set('token', options.token)
  return url.toString()
}

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container !== 'string') return container
  const found = document.querySelector<HTMLElement>(container)
  if (!found) throw new CommandError('CONTAINER_NOT_FOUND', `no element matches "${container}"`)
  return found
}

export { ENVELOPE_VERSION }

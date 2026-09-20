/// The web shell's tab protocol — shared by the shell (host) and every editor
/// app (guest), because the two halves only work together.
///
/// In the desktop build the shell owns real `WebContentsView`s: it knows
/// exactly which editors are alive because *it* created them, and a closed
/// view is gone from the tab list the moment `destroyed` fires.
///
/// The browser build has no such authority. Each editor is a plain browser tab
/// opened with `window.open`, and the shell's only record of it is a row in
/// `localStorage`. Nothing tells the shell when such a tab dies: `beforeunload`
/// does not fire for a crash, a force-quit, "close all windows", or a tab the
/// browser reclaims to save memory. The stale row it leaves behind is a
/// *phantom* — it looks exactly like a live tab.
///
/// Trusting those phantoms produced the two symptoms this protocol exists to
/// kill:
///
///   • **"clicking a document does nothing"** — the click matched a phantom's
///     filename, sent a focus request to a window that no longer existed, and
///     returned without opening anything.
///   • **"and it duplicates"** — worse, when a live tab *did* exist but a
///     phantom happened to be listed first, the request went to the phantom,
///     timed out, and the caller opened a second tab for a file that was
///     already open.
///
/// So liveness is a *claim the guest must actively make*. Every editor tab
/// heartbeats; a row is only believed while its beat is fresh; and a focus
/// request is a handshake with a timeout rather than an assumption. Anything
/// the shell is not sure about, it opens for real.
///
/// This module is DOM-only (no node/electron imports) so it is safe to bundle
/// into every renderer and into the tests.

/** Every editor the shell can host in a browser tab. */
export type OpenableModule = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'

export interface WebTab {
  id: string
  kind: OpenableModule
  title: string
  /** Stable per-tab id; the live window is the source of truth. */
  windowId: string
}

/** Extension → owning editor. The single source of truth for "what opens X". */
export const MODULE_OF_EXT: Readonly<Record<string, OpenableModule>> = {
  docx: 'docs',
  xlsx: 'sheets',
  xlsm: 'sheets',
  xls: 'sheets',
  csv: 'sheets',
  pptx: 'slides',
  ppt: 'slides',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
}

/** URL path segment → editor. Inverse of what `moduleUrl` builds. */
const MODULE_OF_ROUTE: Readonly<Record<string, OpenableModule>> = {
  docs: 'docs',
  sheets: 'sheets',
  slides: 'slides',
  pdf: 'pdf',
  markdown: 'markdown',
  html: 'html',
}

/** Human label for an editor, used when a tab has no file yet. */
export const MODULE_LABEL: Readonly<Record<OpenableModule, string>> = {
  docs: 'AI Docs',
  sheets: 'AI Sheets',
  slides: 'AI Slides',
  pdf: 'AI PDF',
  markdown: 'AI Markdown',
  html: 'AI HTML',
}

/** The editor that owns `path`, or null when no module can open it. */
export function moduleForPath(path: string): OpenableModule | null {
  const ext = path
    .split(/[\\/.]/)
    .pop()
    ?.toLowerCase()
  return (ext && MODULE_OF_EXT[ext]) || null
}

/** The filename a tab row displays (and the key dedupe compares on). */
export function moduleFileName(path?: string): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/** The query parameter a tab id travels in. */
export const TAB_QUERY_PARAM = 'tab'

/**
 * The editor URL for an existing path. pdf/html read the path from the
 * fragment; the other renderers read `?open=`. Mirrors the real routes.
 *
 * `tabId` rides along in the query string so the guest knows exactly which row
 * the host created for it. Inferring identity instead (a stamp on the window
 * handle, or matching on filename) is racy: a freshly opened tab has an empty
 * `sessionStorage` and the property write lands at an unpredictable moment, so
 * the guest could announce an id the host never heard of — which reads as a
 * duplicate row. Passing it in the URL is deterministic.
 */
export function moduleUrl(module: OpenableModule, path: string, tabId?: string): string {
  const base = `/${module}/?mode=tab`
  const encoded = encodeURIComponent(path)
  const suffix = tabId ? `&${TAB_QUERY_PARAM}=${encodeURIComponent(tabId)}` : ''
  return module === 'pdf' || module === 'html'
    ? `${base}#open=${encoded}${suffix}`
    : `${base}&open=${encoded}${suffix}`
}

/** The tab id a guest was handed by its host, read from its own URL. */
export function tabIdFromLocation(loc: { search: string; hash: string }): string | null {
  const fromQuery = new URLSearchParams(loc.search).get(TAB_QUERY_PARAM)
  if (fromQuery) return fromQuery
  /* pdf/html carry their parameters in the fragment, after `#open=` */
  const fromHash = new URLSearchParams(loc.hash.replace(/^#/, '')).get(TAB_QUERY_PARAM)
  return fromHash || null
}

/** The file path a tab was opened on, read back off its own URL. */
export function openPathFromLocation(loc: { search: string; hash: string }): string | undefined {
  const query = new URLSearchParams(loc.search).get('open')
  if (query) return query
  const hash = new URLSearchParams(loc.hash.replace(/^#/, '')).get('open')
  return hash || undefined
}

export interface TabDescriptor {
  kind: OpenableModule
  title: string
}

/**
 * Work out which editor tab *this* window is, from its own URL alone.
 *
 * Deriving it beats passing it: the shell opens the tab with a plain
 * `window.open(url)`, and anything injected into the child (a query flag, a
 * global) has to be threaded through six different apps. The URL is already
 * there, already correct, and the same rule the shell uses to name the row.
 */
export function deriveTabDescriptor(loc: {
  pathname: string
  search: string
  hash: string
}): TabDescriptor | null {
  const segment = loc.pathname.split('/').filter(Boolean)[0] ?? ''
  const kind = MODULE_OF_ROUTE[segment]
  if (!kind) return null
  const path = openPathFromLocation(loc)
  return { kind, title: path ? moduleFileName(path) : MODULE_LABEL[kind] }
}

export interface TabLiveness {
  /** Record that `id`'s window is still alive (a heartbeat or a focus ack). */
  markLive(id: string, now?: number): void
  /** True while the last sign of life is within `staleMs`. */
  isLive(id: string, now?: number): boolean
  /** Forget an id entirely (its window closed or was proven gone). */
  forget(id: string): void
  /** Drop every id whose window is no longer live. */
  pruneLive(ids: Iterable<string>, now?: number): void
}

/** Create a liveness clock. `staleMs` is how long silence is tolerated. */
export function createTabLiveness(staleMs: number): TabLiveness {
  const lastSeen = new Map<string, number>()
  const isLive = (id: string, now = Date.now()): boolean => {
    const seen = lastSeen.get(id)
    return typeof seen === 'number' && now - seen < staleMs
  }
  return {
    markLive(id, now = Date.now()) {
      lastSeen.set(id, now)
    },
    isLive,
    forget(id) {
      lastSeen.delete(id)
    },
    pruneLive(ids, now = Date.now()) {
      const keep = new Set(ids)
      /* Array.from, not spread: Map.keys() is not iterable under the
       * renderer tsconfig target without downlevelIteration. */
      for (const id of Array.from(lastSeen.keys())) {
        if (!keep.has(id) || !isLive(id, now)) lastSeen.delete(id)
      }
    },
  }
}

export type OpenDecision =
  /** An authoritative tab for this path exists — ask it to come forward. */
  | { action: 'focus'; tab: WebTab; duplicates: WebTab[] }
  /** Nothing live owns this path; open a tab. */
  | { action: 'open'; duplicates: WebTab[] }

/**
 * Decide what a click on `path` should do.
 *
 * Only a tab whose window has actually been heard from is trusted, and a live
 * row always wins over a cold one. That ordering matters: taking the *first*
 * row matching the filename meant a phantom listed ahead of a healthy tab won
 * the match, its focus request went unanswered, and the caller opened a second
 * tab for a file already on screen — the "duplicates" half of the bug.
 *
 * `duplicates` lists every row claiming this path so the caller can drop them
 * before acting.
 */
export function decideOpen(
  tabs: readonly WebTab[],
  module: OpenableModule,
  path: string | undefined,
  liveness: Pick<TabLiveness, 'isLive'>,
): OpenDecision {
  if (!path) return { action: 'open', duplicates: [] }
  const title = moduleFileName(path)
  const matches = tabs.filter((t) => t.kind === module && t.title === title)
  if (matches.length === 0) return { action: 'open', duplicates: [] }

  const live = matches.find((t) => liveness.isLive(t.id))
  if (live) {
    return { action: 'focus', tab: live, duplicates: matches.filter((t) => t.id !== live.id) }
  }
  return { action: 'open', duplicates: matches }
}

/**
 * Drop rows whose window is gone. Returns a new array plus whether anything
 * changed, so callers can skip a redundant broadcast on the common no-op.
 */
export function sweepTabs(
  tabs: readonly WebTab[],
  liveness: Pick<TabLiveness, 'isLive'>,
): { tabs: WebTab[]; changed: boolean } {
  const kept = tabs.filter((t) => liveness.isLive(t.id))
  /* Return the original array when nothing died, so callers can use this on a
   * timer without invalidating a memoised TabBar on every tick. */
  if (kept.length === tabs.length) return { tabs: tabs as WebTab[], changed: false }
  return { tabs: kept, changed: true }
}

/**
 * Collapse every row claiming the same (kind, title) as `keep` down to one.
 *
 * The TabBar keys rows on (kind, title), so two rows with the same pair are
 * indistinguishable to the user — that is the "duplicate" half of the reported
 * bug. Returns the surviving rows in their original order plus the rows that
 * were displaced, so the caller can retire their windows.
 */
export function dedupeTabs(
  tabs: readonly WebTab[],
  keep: WebTab,
): { tabs: WebTab[]; dropped: WebTab[] } {
  const dropped = tabs.filter(
    (t) => t.id !== keep.id && t.kind === keep.kind && t.title === keep.title,
  )
  if (dropped.length === 0) return { tabs: tabs as WebTab[], dropped }
  const droppedIds = new Set(dropped.map((t) => t.id))
  /* `keep` is already in `tabs` when the caller passes a cached row, so it
   * must not be appended separately; a caller passing a fresh (uncached) row
   * needs it added, so it is unioned rather than assumed present. */
  const kept = tabs.filter((t) => !droppedIds.has(t.id))
  return { tabs: kept.some((t) => t.id === keep.id) ? kept : [...kept, keep], dropped }
}

/**
 * Tell the windows backing `doomed` to retire themselves. Only one window may
 * own a path, so the extras close rather than sit there invisible in the
 * TabBar. Fire-and-forget: a window that ignores the request is harmless.
 */
export function requestTabClose(
  channel: Pick<BroadcastChannel, 'postMessage'>,
  doomed: readonly WebTab[],
): void {
  for (const tab of doomed) {
    try {
      channel.postMessage({ type: 'close-request', id: tab.id } satisfies TabChannelMessage)
    } catch {
      /* channel closed mid-shutdown; the host's clock will forget the row */
    }
  }
}

/* ── Transport ────────────────────────────────────────────────────────────
 * Host and guest talk over a BroadcastChannel (same-origin, no server round
 * trip) plus localStorage for persistence across a shell reload. */

export const TAB_CHANNEL_NAME = 'genoffice:tabs'
export const TAB_STORAGE_KEY = 'genoffice:web-tabs'
/** Per-tab key so a guest keeps its identity across a reload. sessionStorage
 *  is scoped to one browser tab, which is exactly the lifetime we want. */
export const TAB_ID_KEY = 'genoffice:tab-id'
export const SHELL_ID_KEY = 'genoffice:shell-id'

/** Child windows get their id stamped on the handle by the host; a reload
 *  restores it from sessionStorage instead. Not part of lib.dom. */
export interface TabIdHost {
  __genofficeTabId?: string
}

export function readTabId(win: object | null | undefined): string | null {
  /* `obj` rather than `{ __genofficeTabId?: string }`: lib.dom's Window has no
   * properties in common with that shape, so a structural parameter would
   * refuse the very value we always pass. */
  const id = (win as TabIdHost | null | undefined)?.__genofficeTabId
  return typeof id === 'string' && id ? id : null
}

export function newTabId(): string {
  return 'web-' + Math.random().toString(36).slice(2, 10)
}

/* ── Guest side ───────────────────────────────────────────────────────────
 * What an editor tab must do to be trustworthy. */

export type TabChannelMessage =
  | { type: 'register'; id: string; kind: OpenableModule; title: string }
  | { type: 'heartbeat'; id: string; kind: OpenableModule; title: string }
  | { type: 'unregister'; id: string }
  | { type: 'sync'; tabs: WebTab[] }
  | { type: 'focus-request'; id: string }
  | { type: 'focus-ack'; id: string }
  | { type: 'close-request'; id: string }

export interface TabGuest {
  id: string
  /** Stop heartbeating and announce the tab as gone. */
  dispose(): void
}

export interface TabGuestOptions {
  /** Defaults to `window.location`. */
  location?: { pathname: string; search: string; hash: string }
  /** How often to announce liveness. */
  heartbeatMs?: number
  /** Defaults to a fresh BroadcastChannel; injectable for tests. */
  channel?: BroadcastChannel
  win?: Window
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  session?: Pick<Storage, 'getItem' | 'setItem'>
  /** Override the derived descriptor (tests, or an app with its own routing). */
  descriptor?: TabDescriptor
}

/**
 * Install the guest half of the protocol in an editor window.
 *
 * Safe to call when the window is not an editor tab (returns null) — the
 * caller can then stay a plain page.
 */
export function installTabGuest(options: TabGuestOptions = {}): TabGuest | null {
  const win = options.win ?? (typeof window === 'undefined' ? undefined : window)
  if (!win) return null
  const storage = options.storage ?? win.localStorage
  const session = options.session ?? win.sessionStorage
  const loc = options.location ?? win.location
  const heartbeatMs = options.heartbeatMs ?? 2_500

  const descriptor = options.descriptor ?? deriveTabDescriptor(loc)
  if (!descriptor) return null

  const channel = options.channel ?? new BroadcastChannel(TAB_CHANNEL_NAME)
  const ownsChannel = !options.channel

  /* Identity survives a reload so a refresh does not leave the previous row
   * behind as a phantom. The host's stamp wins when present because the host
   * already told its own cache to expect that id. */
  const id = tabIdFromLocation(loc) ?? readTabId(win) ?? session.getItem(TAB_ID_KEY) ?? newTabId()
  session.setItem(TAB_ID_KEY, id)

  const announce = (type: 'register' | 'heartbeat'): void => {
    channel.postMessage({
      type,
      id,
      kind: descriptor.kind,
      title: descriptor.title,
    } satisfies TabChannelMessage)
  }

  /* A guest that arrived before the host (the shell reloading under an open
   * editor) would otherwise be invisible until its first beat. Register and
   * beat immediately, and re-register when the shell hands out a fresh sync
   * that has lost us. */
  announce('register')

  const timer = win.setInterval(() => announce('heartbeat'), heartbeatMs)

  const onVisible = (): void => {
    if (win.document.visibilityState === 'visible') announce('heartbeat')
  }
  const onPageShow = (event: Event): void => {
    /* bfcache restores leave the page alive but its timers suspended, so the
     * host may have swept us while it was frozen. */
    if ((event as PageTransitionEvent).persisted) announce('register')
  }
  win.document.addEventListener('visibilitychange', onVisible)
  win.addEventListener('pageshow', onPageShow)

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as TabChannelMessage | undefined
    if (!data) return
    if (data.type === 'focus-request' && data.id === id) {
      /* The answer is what tells the host this window is real. It must be sent
       * before any focus attempt, which can throw under a strict CSP. */
      channel.postMessage({ type: 'focus-ack', id } satisfies TabChannelMessage)
      try {
        win.focus()
      } catch {
        /* the browser may refuse; the host already knows we are alive */
      }
      return
    }
    if (data.type === 'close-request' && data.id === id) {
      /* Sent when the host has another window for the same file: only one
       * window may own a path, so the redundant one retires itself. */
      dispose()
      try {
        win.close()
      } catch {
        /* script may not close a tab it did not open; the row is already gone */
      }
      return
    }
    if (data.type === 'sync') {
      /* If the host's list lost us it swept a live tab (we were throttled in
       * the background); re-register so the TabBar shows the file again. */
      const known = Array.isArray(data.tabs) && data.tabs.some((t) => t?.id === id)
      if (!known) announce('register')
    }
  }
  channel.addEventListener('message', onMessage)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    win.clearInterval(timer)
    win.document.removeEventListener('visibilitychange', onVisible)
    win.removeEventListener('pageshow', onPageShow)
    channel.removeEventListener('message', onMessage)
    try {
      channel.postMessage({ type: 'unregister', id } satisfies TabChannelMessage)
    } catch {
      /* the channel is already gone; the host's liveness clock handles it */
    }
    if (ownsChannel) {
      try {
        channel.close()
      } catch {
        /* already closed */
      }
    }
  }
  win.addEventListener('pagehide', dispose)
  /* `beforeunload` covers the ordinary close path; `pagehide` also covers
   * Safari and bfcache navigation. Both funnel through the same guard. */
  win.addEventListener('beforeunload', dispose)
  session.setItem(TAB_ID_KEY, id)
  /* Reference so the unused-var linter keeps `storage` meaningful: the host
   * persists the tab list here and the guest only reads it for diagnostics. */
  void storage

  return { id, dispose }
}

/* ── Host side helpers ─────────────────────────────────────────────────── */

export function loadTabs(storage: Pick<Storage, 'getItem'>): WebTab[] {
  try {
    const raw = storage.getItem(TAB_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as WebTab[]) : []
  } catch {
    /* corrupt or unavailable storage must not stop the shell from booting */
    return []
  }
}

export function saveTabs(storage: Pick<Storage, 'setItem'>, tabs: readonly WebTab[]): void {
  try {
    storage.setItem(TAB_STORAGE_KEY, JSON.stringify(tabs))
  } catch {
    /* quota exceeded or storage disabled: the in-memory cache stays correct
     * for this shell, and the next broadcast re-attempts the persist. */
  }
}

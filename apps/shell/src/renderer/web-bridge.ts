/// Web-version bootstrap for the shell renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.aiOffice` / `window.aiOfficeProject` / `window.aiOfficeTabs` objects
/// the preload exposes in the desktop app, but backed by the HTTP/SSE transport
/// against the running Electron main process. Native-only channels (browse,
/// save-dir picker, reveal, trash, tab management) get browser equivalents so
/// the web version keeps the full feature surface. Inside Electron the preload
/// has already exposed the IPC-backed APIs and this module leaves them
/// untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  pickFileBytes,
  uploadFileToServer,
} from '@genoffice/ipc-bridge/web-native'
import {
  createShellHomeApi,
  createShellProjectApi,
  createShellTabsApi,
} from '../shared/shell-api-factory'
import {
  createTabLiveness,
  decideOpen,
  dedupeTabs,
  loadTabs,
  MODULE_LABEL,
  moduleFileName,
  moduleForPath,
  moduleUrl,
  newTabId,
  requestTabClose,
  saveTabs,
  sweepTabs,
  TAB_CHANNEL_NAME,
  windowName,
  type OpenableModule,
  type TabChannelMessage,
  type WebTab,
} from '@genoffice/ipc-bridge/web-tabs'

if (!isElectronRuntime()) {
  const transport = createHttpIpcTransport()
  const files = createWebFileBridge(transport)
  // SAFETY: lib.dom's Window declares no aiOffice / aiOfficeProject /
  // aiOfficeTabs fields. This module is the sole writer of those three keys
  // (they are assigned at the bottom of this file) and the renderer reads them
  // back through window.aiOffice*, so modelling Window as a bag holding exactly
  // the values we install is correct at runtime even though TypeScript cannot
  // prove it from the lib.dom types alone.
  const bridgedWindow = window as unknown as Record<string, unknown>

  /* ── Web-native tab tracking ─────────────────────────────────────────
   * The Electron shell tracks tabs as WebContentsViews owned by the main
   * process, so it always knows which editors are alive. The web version opens
   * each module with `window.open`, where nothing reports a tab's death: a row
   * in localStorage outlives a window that crashed or was force-quit.
   *
   * `@genoffice/ipc-bridge` owns that protocol (both the rules and the guest
   * half); this block is only the host side — the TabBar's state, the windows
   * it opens, and the decisions it asks the protocol for. */
  const TAB_HEARTBEAT_MS = 2_500
  /** How long silence is tolerated before a row stops being believed.
   *  Deliberately generous: Chrome throttles a hidden tab's timers to about
   *  once a minute, so a short window would evict windows that are very much
   *  alive as soon as the user switches away. This only tidies the TabBar —
   *  a click is settled by the focus handshake, never by this guess. */
  const TAB_STALE_MS = 150_000
  /* (removed) The old focus handshake + 400 ms timeout was the source of
   * the "重复" symptom: a slow-to-answer guest (or one whose tab was still
   * loading a 2.6 MB bundle) was declared phantom and a second window was
   * opened for the same file. Named-window focus replaces it. */
  /** Grace given to restored rows on boot, long enough for the beat each live
   *  tab fires on load — far shorter than TAB_STALE_MS, so phantom rows from a
   *  previous session disappear seconds after a reload instead of lingering. */
  const BOOT_GRACE_MS = 8_000

  const liveness = createTabLiveness(TAB_STALE_MS)
  const markTabLive = (id: string, at?: number): void => liveness.markLive(id, at)

  /* Which tab the shell believes is currently in front. The web build runs
   * editors in separate browser tabs (one per `window.open`), so there is no
   * "focused WebContentsView" event to subscribe to — but the shell *does*
   * know what the user clicked on last, and that is enough for the TabBar to
   * light up the right row. */
  let activeTabId: string = 'home'

  /* Live `Window` handles keyed by tab id. The shell opens every editor with
   * `window.open(url, windowName(id))`, so a click on a TabBar row can focus
   * the child window directly — Chrome honors `handle.focus()` for a window
   * the calling page opened, which is what makes "click the tab and enter
   * the document" actually work in the web build. The previous design let
   * the child call `win.focus()` on itself in a BroadcastChannel handler;
   * Chrome ignores that for backgrounded tabs, which is the root cause of
   * the user's "点击没法进入" symptom.
   *
   * The named-window reuse is also what prevents duplicates: a second click
   * on the same row asks Chrome to focus the existing named window — no
   * second window is created. */
  const tabHandles = new Map<string, Window>()
  /** Path/kind per tab id, so `tabsActivate(id)` can rebuild the editor URL
   *  even after a shell reload (when the handle cache is cold). */
  const tabMeta = new Map<string, { kind: OpenableModule; path?: string }>()

  const rememberHandle = (id: string, win: Window | null): Window | null => {
    if (!win) return null
    if (win.closed) {
      tabHandles.delete(id)
      return null
    }
    tabHandles.set(id, win)
    return win
  }
  const forgetHandle = (id: string): void => {
    const handle = tabHandles.get(id)
    tabHandles.delete(id)
    if (handle && !handle.closed) {
      try {
        handle.close()
      } catch {
        /* cross-origin or already-gone: the row's gone too, nothing to do */
      }
    }
  }
  /** Focus (and re-navigate when the URL drifted) the named window for `id`.
   *  Called from click handlers, so the user-activation token is live and
   *  `window.open(url, name)` is free to either focus the existing window
   *  or open a new one. */
  const focusNamedTab = (id: string, url: string): Window | null => {
    const cached = tabHandles.get(id)
    /* Compare against the absolute URL — `cached.location.href` is always
     * absolute, but `moduleUrl` returns a relative path. Without this
     * normalisation, a re-click on the same recents row looked "different"
     * and triggered an unnecessary `location.href = …` write, which
     * navigated the editor and fired `pagehide` → `unregister`, the chain
     * that closed the window on a re-click. */
    const absUrl = url ? new URL(url, window.location.href).href : ''
    if (cached && !cached.closed) {
      try {
        cached.focus()
        if (absUrl && cached.location.href !== absUrl) cached.location.href = absUrl
        return cached
      } catch {
        tabHandles.delete(id)
        /* fall through to a fresh open */
      }
    }
    return rememberHandle(id, window.open(url, windowName(id)))
  }
  /** Close the editor window for `id`. Cache is preferred (instant); falls
   *  back to a BroadcastChannel close-request when the handle is lost. */
  const closeNamedTab = (id: string): void => {
    const cached = tabHandles.get(id)
    if (cached && !cached.closed) {
      try {
        cached.close()
      } catch {
        /* ignore */
      }
      tabHandles.delete(id)
      return
    }
    const row = tabsCache.find((t) => t.id === id)
    if (row) requestTabClose(tabChannel, [row])
  }

  const tabChannel = new BroadcastChannel(TAB_CHANNEL_NAME)
  let tabsCache = loadTabs(localStorage)
  const restoredIds = tabsCache.map((t) => t.id)
  for (const id of restoredIds) markTabLive(id, Date.now() - (TAB_STALE_MS - BOOT_GRACE_MS))

  const broadcast = (): void => {
    saveTabs(localStorage, tabsCache)
    tabChannel.postMessage({ type: 'sync', tabs: tabsCache } satisfies TabChannelMessage)
    /* The TabBar subscribes to this event rather than the IPC push channel:
     * the SSE bridge would be a longer path for a same-window update. */
    window.dispatchEvent(new CustomEvent('genoffice:web-tabs-changed', { detail: tabsCache }))
  }

  /** Set the active tab id and broadcast a refresh. The TabBar reads
   *  `active` from `tabsList`, so any state change that should repaint the
   *  strip — opening a new editor, focusing a row, closing the active one —
   *  funnels through here. */
  const setActiveTab = (id: string): void => {
    if (activeTabId === id) return
    activeTabId = id
    window.dispatchEvent(new CustomEvent('genoffice:web-tabs-changed', { detail: tabsCache }))
  }

  /** Replace the cache and tell everyone. `retire` also closes their windows. */
  const setTabs = (next: WebTab[], retire: readonly WebTab[] = []): void => {
    tabsCache = next
    for (const gone of retire) {
      liveness.forget(gone.id)
      forgetHandle(gone.id)
    }
    broadcast()
    if (retire.length > 0) requestTabClose(tabChannel, retire)
  }

  const registerTab = (
    kind: OpenableModule,
    path: string | undefined,
    win: Window | null,
    id: string = newTabId(),
    /* Optional display title. Recents rows carry the human-friendly
     * name (e.g. 'upload-me.docx') which is what the user expects the
     * TabBar to show; the on-disk basename includes the upload id
     * prefix (e.g. '7-1789927383352-15m3na-upload-me.docx') and is
     * only useful as a fallback when no recents row is in scope. */
    displayTitle?: string,
  ): WebTab => {
    const title = displayTitle || (path ? moduleFileName(path) : MODULE_LABEL[kind])
    const tab: WebTab = { id, kind, title, windowId: id }
    markTabLive(id)
    tabMeta.set(id, { kind, ...(path !== undefined && { path }) })
    if (win) {
      rememberHandle(id, win)
      /* Stamp the handle too, so the guest can recognise itself even if it
       * loaded before the URL carried the id (older cached bundle). */
      try {
        ;(win as unknown as { __genofficeTabId?: string }).__genofficeTabId = id
      } catch {
        /* cross-origin window: not one of ours, so nothing to stamp */
      }
    }
    /* One row per (kind, title) — the same key clicks dedupe on and the user
     * sees. Two rows for one file are indistinguishable, which is exactly the
     * "it duplicates" report; the displaced window is asked to close so it
     * cannot silently keep editing the same file. */
    const { tabs, dropped } = dedupeTabs([...tabsCache, tab], tab)
    setTabs(tabs, dropped)
    return tab
  }

  const unregisterTabById = (id: string): void => {
    liveness.forget(id)
    forgetHandle(id)
    tabMeta.delete(id)
    setTabs(tabsCache.filter((t) => t.id !== id))
  }

  /** Drop rows whose window has stopped beating. Returns true if the cache
   *  changed, so callers can avoid a redundant broadcast. */
  const sweepStaleTabs = (): boolean => {
    const { tabs, changed } = sweepTabs(tabsCache, liveness)
    if (!changed) return false
    liveness.pruneLive(tabs.map((t) => t.id))
    setTabs(tabs)
    /* If the row that was active just died, fall back to home so the TabBar
     * keeps showing a sensible selection. */
    if (activeTabId !== 'home' && !tabs.some((t) => t.id === activeTabId)) {
      setActiveTab('home')
    }
    return true
  }

  const upsertFromBeat = (info: { id: string; kind: string; title: string }): void => {
    markTabLive(info.id)
    /* Re-adopt a tab whose row was swept while it was throttled in the
     * background: the beat carries enough to rebuild the descriptor. */
    if (tabsCache.some((t) => t.id === info.id)) return
    if (!(info.kind in MODULE_LABEL)) return
    const kind = info.kind as OpenableModule
    /* A guest that reloaded gets a fresh id (sessionStorage is per-tab but the
     * URL it was opened with may name an older row), so the beat must still go
     * through the same one-row-per-(kind, title) rule as registerTab. Adding it
     * blindly reinstated the duplicate TabBar entry the user reported. */
    const tab: WebTab = { id: info.id, kind, title: info.title, windowId: info.id }
    const { tabs, dropped } = dedupeTabs([...tabsCache, tab], tab)
    setTabs(tabs, dropped)
  }

  tabChannel.onmessage = (event: MessageEvent) => {
    const data = event.data as TabChannelMessage | undefined
    if (!data || typeof data !== 'object') return
    switch (data.type) {
      case 'register':
      case 'heartbeat':
        upsertFromBeat(data)
        return
      case 'unregister':
        if (tabsCache.some((t) => t.id === data.id)) unregisterTabById(data.id)
        return
      case 'sync':
        /* Another shell owns the cache too; adopt its list but keep our own
         * liveness clock (its timestamps are not ours to trust). */
        if (Array.isArray(data.tabs)) {
          for (const tab of data.tabs) if (typeof tab?.id === 'string') markTabLive(tab.id)
          tabsCache = data.tabs
          saveTabs(localStorage, tabsCache)
          window.dispatchEvent(new CustomEvent('genoffice:web-tabs-changed', { detail: tabsCache }))
        }
        return
      case 'focus-ack':
        /* legacy: a guest that loaded an older bundle may still answer our
         * (no-longer-sent) focus-request. The ack is now just a heartbeat —
         * mark the tab live so the row survives the periodic sweep. */
        markTabLive(data.id)
        return
      default:
        return
    }
  }

  /* Periodic sweep: keeps the TabBar free of entries whose window is gone
   * without waiting for the user to click something. Cheap (a filter over a
   * handful of items) and a no-op unless something actually died. */
  setInterval(() => {
    sweepStaleTabs()
  }, TAB_HEARTBEAT_MS * 2)
  /* ...and one sweep as soon as the boot grace expires, so rows whose window
   * is gone vanish within seconds of a reload rather than waiting for the
   * periodic tick (the TabBar must not advertise files that are not open). */
  setTimeout(() => {
    sweepStaleTabs()
  }, BOOT_GRACE_MS + 500)

  /* Reserve a tab for an upload *inside the caller's click handler*.
   *
   * The file picker is modal: by the time the user has chosen a file and we
   * have uploaded it, the user-activation window that authorises
   * `window.open` has expired, and the browser silently refuses to open the
   * editor. That is why "打开本地文件" appeared to do nothing.
   *
   * So the tab is created synchronously here (while the gesture is still
   * live) and parked on a tiny placeholder page; `commit` then points it at
   * the real editor URL once the bytes are on disk. The placeholder is the
   * empty string the browser already put in the window — we never navigate
   * to a same-origin URL before we know it, so nothing is fetched twice. */
  const reserveTab = (): {
    win: Window
    open: (path: string) => void
    cancel: () => void
  } | null => {
    /* The id is minted synchronously so the blank window opens *named*. The
     * eventual `win.location.href = moduleUrl(...)` lands back on the same
     * window because the URL carries the matching `name`, instead of
     * spawning a second popup (which is exactly how "打开本地文件" used to
     * look like nothing happened). */
    const id = newTabId()
    const win = window.open('about:blank', windowName(id))
    if (!win) return null
    rememberHandle(id, win)
    return {
      win,
      open: (path: string, displayTitle?: string) => {
        const module = moduleForPath(path)
        if (!module) {
          win.close()
          tabHandles.delete(id)
          return
        }
        registerTab(module, path, win, id, displayTitle)
        win.location.href = moduleUrl(module, path, id)
        setActiveTab(id)
      },
      cancel: () => {
        try {
          win.close()
        } catch {
          /* the browser may refuse to close a tab it thinks the script did
           * not open; the blank tab is harmless if so */
        }
        tabHandles.delete(id)
      },
    }
  }

  /** Open `module` (optionally on `path`) without consulting the cache. */
  const openFreshTab = (module: OpenableModule, path?: string, displayTitle?: string): Window | null => {
    /* The id is minted before the URL is built and travels *inside* it, so
     * the guest announces exactly the row the host just created. The window
     * is opened with the same id as its `name`, so a second click on the
     * same row focuses this tab instead of creating a sibling window — that
     * is the fix for the user's "重复" symptom. */
    const id = newTabId()
    const url = path ? moduleUrl(module, path, id) : `/${module}/?mode=tab&tab=${id}`
    const tab = window.open(url, windowName(id))
    if (!tab) return null
    registerTab(module, path, tab, id, displayTitle)
    setActiveTab(id)
    return tab
  }

  const openModule = (module: OpenableModule, path?: string, displayTitle?: string): Window | null => {
    /* Dedupe: a tab already open for this exact path should be focused, not
     * duplicated. Recents clicks fire often and a new window.open per click
     * would leave the user with N tabs of the same file. The decision itself
     * lives in @genoffice/ipc-bridge (decideOpen) because it carries the fix
     * for the "clicking a recent file does nothing" bug: a cached row is a
     * claim, not proof — only a heartbeat makes it real. */
    const decision = decideOpen(tabsCache, module, path, liveness)

    if (decision.action === 'open') {
      /* Rows claiming this path that nobody is backing are dropped first —
       * otherwise the next click hits the same dead entry and appears to do
       * nothing again, and the TabBar keeps advertising files that are shut.
       * No close is requested: a cold row's window is gone by definition. */
      if (decision.duplicates.length > 0) {
        const deadIds = new Set(decision.duplicates.map((t) => t.id))
        for (const id of deadIds) liveness.forget(id)
        setTabs(tabsCache.filter((t) => !deadIds.has(t.id)))
      }
      return openFreshTab(module, path, displayTitle)
    }

    /* An authoritative tab exists. Named-window focus replaces the old
     * 400 ms focus handshake: a click on the recents row hands the URL
     * back to `window.open` with the same `name` as the existing window,
     * which Chrome focuses (and returns the handle back to us, repopulating
     * the cache). No timeout, no chance of opening a duplicate when the
     * target is slow to answer — that race was the source of the user's
     * "重复" complaint. */
    const target = decision.tab.id
    if (decision.duplicates.length > 0) {
      const dupIds = new Set(decision.duplicates.map((t) => t.id))
      setTabs(
        tabsCache.filter((t) => !dupIds.has(t.id)),
        decision.duplicates,
      )
    }
    /* moduleUrl requires a path; recents-click callers always pass one. */
    if (path) focusNamedTab(target, moduleUrl(module, path, target))
    /* A focused tab may already carry a basename-style title; if the caller
     * now hands us the recents row's display name, refresh the title so the
     * TabBar updates from '13-1789927471769-...docx' to 'upload-me.docx'. */
    if (displayTitle) {
      const idx = tabsCache.findIndex((t) => t.id === target)
      if (idx >= 0 && tabsCache[idx].title !== displayTitle) {
        const next = tabsCache.slice()
        next[idx] = { ...next[idx], title: displayTitle }
        setTabs(next)
      }
    }
    markTabLive(target)
    return null
  }

  const openPathInModule = (path: string, displayTitle?: string): void => {
    const module = moduleForPath(path)
    if (module) openModule(module, path, displayTitle)
  }

  /* ── Web-native upload ─────────────────────────────────────────────────
   * Both the "打开本地文件" card and drag-and-drop must put the bytes in
   * FILES_DIR rather than TMPDIR. The old browse() wrote a temp file: the
   * file opened, but it was gone after the next server restart and never
   * joined the recents list the user was looking at, which is exactly what
   * reads as "this build cannot upload". web:save-file is the persistent
   * path (and it mirrors the entry into the recents map server-side), so
   * both entry points funnel through it and fall back to temp only if
   * storage itself rejects the write. */
  const uploadPicked = async (
    name: string,
    bytes: ArrayBuffer,
  ): Promise<{ path: string; displayName: string }> => {
    try {
      const uploaded = await uploadFileToServer(transport, name, bytes)
      window.dispatchEvent(new Event('genoffice:recents-changed'))
      /* The recents row's display name (file.name with the id prefix
       * stripped) is what the TabBar should show. uploaded.name comes from
       * web:save-file's sanitized filename, which preserves the user's
       * basename when it is safe. The fallback path branch returns the
       * raw name because the temp file sits outside FILES_DIR and has no
       * recents row of its own. */
      return { path: uploaded.path, displayName: uploaded.name }
    } catch {
      const path = await files.writeTempFile(name, bytes)
      return { path, displayName: name }
    }
  }
  // The Electron build gets this from installDropOpenBridge in the preload;
  // without it the web home page showed its drop overlay and then did nothing.
  window.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault()
  })
  window.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return
    ev.preventDefault()
    const dropped = Array.from(ev.dataTransfer.files)
    if (dropped.length === 0) return
    /* Reserve inside the drop handler for the same reason as `browse`: the
     * uploads below are awaited, and the gesture is gone by then. */
    const reserved = reserveTab()
    void (async () => {
      let first: string | null = null
      let firstDisplay: string | undefined
      for (const file of dropped) {
        try {
          /* `first ??= await upload()` would short-circuit: once `first` is
           * set, the right-hand side never runs and the remaining files are
           * silently dropped. Always await the upload, then assign. */
          const uploaded = await uploadPicked(file.name, await file.arrayBuffer())
          if (first === null) {
            first = uploaded.path
            firstDisplay = uploaded.displayName
          }
        } catch {
          /* one unreadable file must not abort the rest of the drop */
        }
      }
      if (!first) {
        reserved?.cancel()
        return
      }
      if (reserved) reserved.open(first, firstDisplay)
      else openPathInModule(first, firstDisplay)
    })()
  })

  /* Map a kind to its (channel, prefix, ext, server dir, url-style). The
   * server dir decides whether the file lives under FILES_DIR (binary
   * formats) or DATA_DIR (plain text). pdf/html pass the open path as
   * #fragment because their index.html reads window.location.hash instead
   * of the ?open= query string. */
  const NEW_MODULE_SPECS: Readonly<
    Record<
      'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html',
      {
        channel: string
        prefix: string
        ext: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md' | 'html'
        serverDir: 'FILES_DIR' | 'DATA_DIR'
        urlStyle: 'query' | 'hash'
      }
    >
  > = {
    docs: {
      channel: 'home:new-doc',
      prefix: 'doc',
      ext: 'docx',
      serverDir: 'FILES_DIR',
      urlStyle: 'query',
    },
    sheets: {
      channel: 'home:new-sheet',
      prefix: 'sheet',
      ext: 'xlsx',
      serverDir: 'FILES_DIR',
      urlStyle: 'query',
    },
    slides: {
      channel: 'home:new-slide',
      prefix: 'slide',
      ext: 'pptx',
      serverDir: 'FILES_DIR',
      urlStyle: 'query',
    },
    pdf: {
      channel: 'home:new-pdf',
      prefix: 'pdf',
      ext: 'pdf',
      serverDir: 'FILES_DIR',
      urlStyle: 'hash',
    },
    markdown: {
      channel: 'home:new-markdown',
      prefix: 'md',
      ext: 'md',
      serverDir: 'DATA_DIR',
      urlStyle: 'query',
    },
    html: {
      channel: 'home:new-html',
      prefix: 'html',
      ext: 'html',
      serverDir: 'DATA_DIR',
      urlStyle: 'hash',
    },
  }

  /* The default DATA_DIR the server resolves to when no env var overrides it
   * (see apps/web-server/src/common/state.ts -> resolveDataDir). When the
   * home:get-data-paths round trip hasn't returned yet (it usually hasn't on
   * the very first click), predicting this default keeps the tab opening
   * correctly; the server-side handler then either re-uses the renderer-
   * supplied id verbatim (and writes the same path) or falls back to its
   * own timestamp id. The only failure mode is a stale default pointing at
   * a dir the server has been redirected away from — the editor surfaces a
   * parse error and the user can click the card again once the IPC has
   * resolved. */
  const DEFAULT_DATA_DIR = '/tmp/genoffice-data'
  const DEFAULT_FILES_DIR = DEFAULT_DATA_DIR + '/files'

  let bridgeFilesDir: string | null = null
  let bridgeDataDir: string | null = null
  void transport
    .invoke('home:get-data-paths')
    .then((r: unknown) => {
      if (r && typeof r === 'object') {
        const obj = r as { filesDir?: unknown; dataDir?: unknown }
        if (typeof obj.filesDir === 'string') bridgeFilesDir = obj.filesDir
        if (typeof obj.dataDir === 'string') bridgeDataDir = obj.dataDir
      }
    })
    .catch(() => {
      /* keep the defaults; the editor surfaces a friendly parse error if the
       * guessed path misses the real FILES_DIR */
    })

  const effectiveDir = (serverDir: 'FILES_DIR' | 'DATA_DIR'): string => {
    if (serverDir === 'FILES_DIR') return bridgeFilesDir ?? DEFAULT_FILES_DIR
    return bridgeDataDir ?? DEFAULT_DATA_DIR
  }

  const openNewTab = (
    kind: 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html',
    projectId?: string,
  ): void => {
    const spec = NEW_MODULE_SPECS[kind]
    /* Suffix the id with a short random tag so two clicks fired in the same
     * millisecond don't collide on the same FILES_DIR path. The prefix +
     * suffix together stay inside the safe regex the server validates. */
    const fileId = `${spec.prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const path = `${effectiveDir(spec.serverDir)}/${fileId}.${spec.ext}`
    /* Built via moduleUrl so the tab id travels in the URL exactly as it does
     * for an existing file; `openNewTab` used to hand-assemble this and drift
     * from the shared rule. */
    const tabId = newTabId()
    const url = `${moduleUrl(kind, path, tabId)}`
    /* Named-window reuse: a second "AI Docs" click focuses the existing
     * empty doc instead of opening a third one. */
    const tab = window.open(url, windowName(tabId))
    if (!tab) return
    registerTab(kind, path, tab, tabId)
    setActiveTab(tabId)
    /* Fire-and-forget: the server handler materialises the file and
     * appends it to DOCS_RECENT. If the renderer predicted the wrong
     * FILES_DIR (because home:get-data-paths hadn't returned), the server
     * falls back to its own timestamp id, the user still gets a working
     * empty document, and the recents row will simply point at a slightly
     * different path than the editor opened. */
    void transport.invoke(spec.channel, { id: fileId, projectId }).catch((cause: unknown) => {
      console.warn(`[web-bridge] ${spec.channel} failed:`, cause)
    })
  }

  bridgedWindow.aiOffice = createShellHomeApi(transport, {
    // Browser equivalent of the Electron picker: upload the chosen bytes to the
    // host's temp dir and hand back that path, which is what the translate
    // pipeline (running server-side) can actually read.
    pickTranslationFile: async () => {
      const picked = await pickFileBytes('.pdf,.docx,.pptx,.xlsx,.xlsm,.xls,.csv', false)
      const file = picked?.[0]
      if (!file) return { ok: false, canceled: true }
      const path = await files.writeTempFile(file.name, file.bytes)
      return { ok: true, path }
    },
    browse: async () => {
      /* Order matters: a click grants a single-use user activation that BOTH
       * `input.click()` (to summon the OS picker) and `window.open()` (to
       * reserve the editor tab) need. `window.open()` consumes it, so the
       * picker must go first — otherwise the browser refuses to show the
       * file chooser with "File chooser dialog can only be shown with a user
       * activation". Both calls are synchronous, so they share the tick.
       *
       * `multiple: true` matches the drop handler below and the server, which
       * already accepts a burst of uploads and gives each one its own id. With
       * a single-file picker the only way to add a folder of documents was one
       * card click per file — and the second click reused the first tab, so it
       * looked like the picker did nothing at all. */
      const picked = pickFileBytes(undefined, true)
      const reserved = reserveTab()
      const filesPicked = await picked
      if (!filesPicked || filesPicked.length === 0) {
        reserved?.cancel()
        return
      }
      let first: string | null = null
      let firstDisplay: string | undefined
      for (const file of filesPicked) {
        try {
          /* Always await: `first ??= await …` would short-circuit after the
           * first success and upload none of the remaining files. */
          const uploaded = await uploadPicked(file.name, file.bytes)
          if (first === null) {
            first = uploaded.path
            firstDisplay = uploaded.displayName
          }
        } catch (cause) {
          /* One rejected file must not discard the rest of the selection. */
          console.warn('[web-bridge] upload failed:', cause)
        }
      }
      if (!first) {
        reserved?.cancel()
        window.alert('无法打开所选文件：上传失败')
        return
      }
      /* The reserved tab opens the first file, and the rest land in recents so
       * the user can reach them from the home grid. */
      if (reserved) reserved.open(first, firstDisplay)
      else openPathInModule(first, firstDisplay)
    },
    openPath: async (path, title) => {
      /* The TabBar shows the recents row's display name (e.g.
       * 'upload-me.docx') rather than the on-disk basename that
       * includes the upload-id prefix; passing it through here keeps
       * the row label consistent with what the user clicked. */
      openPathInModule(path, title)
    },
    /* Sync single-shot creator. Pre-builds the path the editor URL needs,
     * calls window.open inside the click handler (the only place the user
     * gesture stack is alive and the popup grant window is open), and then
     * fire-and-forget asks the server to materialise the file + register
     * it in recents. Without this, the previous design opened an about:blank
     * tab and tried to navigate it after awaiting IPC — browsers silently
     * drop that navigate because it leaves the user gesture stack and the
     * popup grant window has already closed, leaving a pile of dead
     * about:blank tabs (the exact "click AI Docs and nothing happens"
     * symptom). */
    newDoc: async (opts?: { projectId?: string }): Promise<void> => {
      openNewTab('docs', opts?.projectId)
    },
    newSheet: async (opts?: { projectId?: string }): Promise<void> => {
      openNewTab('sheets', opts?.projectId)
    },
    newSlide: async (opts?: { projectId?: string }): Promise<void> => {
      openNewTab('slides', opts?.projectId)
    },
    newMarkdown: async (opts?: { projectId?: string }): Promise<void> => {
      openNewTab('markdown', opts?.projectId)
    },
    newPdf: async (opts?: { projectId?: string }): Promise<void> => {
      openNewTab('pdf', opts?.projectId)
    },
    newHtml: async (opts?: { projectId?: string }): Promise<void> => {
      openNewTab('html', opts?.projectId)
    },
    pickDefaultSaveDir: async () => null,
    revealPath: async () => {},
    openTrash: async () => {},
  })
  bridgedWindow.aiOfficeProject = createShellProjectApi(transport)
  bridgedWindow.aiOfficeTabs = createShellTabsApi(transport, {
    tabsList: async () => {
      // always include the home tab at index 0
      const homeActive = activeTabId === 'home'
      const home = {
        id: 'home',
        kind: 'home' as const,
        title: '首页',
        closable: false,
        active: homeActive,
      }
      sweepStaleTabs()
      return [
        home,
        ...tabsCache.map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          closable: true,
          active: t.id === activeTabId,
        })),
      ]
    },
    tabsActivate: async (id: string) => {
      if (id === 'home') {
        setActiveTab('home')
        window.focus()
        return
      }
      /* Click → focus the editor window. With the handle cache, a live tab
       * is just `handle.focus()`; with a cold cache, `window.open(url,
       * windowName(id))` either focuses the existing named window or opens
       * a new one (and we cache its handle for next time). The user-gesture
       * token is live on the click that fires this call. */
      const meta = tabMeta.get(id)
      if (!meta) return
      /* `meta.path` is undefined for tabs that loaded before their file was
       * created (e.g. an AI Docs tab mid-creation). Fall back to the same
       * "no file yet" URL `openFreshTab` uses so the focus call always has
       * a valid URL to pass to `window.open`. */
      const url = meta.path
        ? moduleUrl(meta.kind, meta.path, id)
        : `/${meta.kind}/?mode=tab&tab=${id}`
      setActiveTab(id)
      focusNamedTab(id, url)
      markTabLive(id)
    },
    tabsClose: async (id: string) => {
      /* Close the editor window for this tab. The handle cache makes this
       * instant for windows the shell is still tracking; the broadcast
       * fallback covers windows opened by another shell instance. */
      closeNamedTab(id)
      unregisterTabById(id)
      if (activeTabId === id) setActiveTab('home')
    },
    tabsShowMenu: async () => {},
    tabsShowNewMenu: async () => {
      // delegate to the home page's new-file menu by clicking the AI Docs card
      // (web version: there's no native popup, so we just open the most-recent module)
      openModule('docs')
    },
    tabsReorder: async () => {},
  })
}

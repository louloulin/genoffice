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
  /** How long a focus handshake waits for the target window to answer before
   *  concluding it is gone and opening the file ourselves. */
  const FOCUS_ACK_TIMEOUT_MS = 400
  /** Grace given to restored rows on boot, long enough for the beat each live
   *  tab fires on load — far shorter than TAB_STALE_MS, so phantom rows from a
   *  previous session disappear seconds after a reload instead of lingering. */
  const BOOT_GRACE_MS = 8_000

  const liveness = createTabLiveness(TAB_STALE_MS)
  const markTabLive = (id: string, at?: number): void => liveness.markLive(id, at)

  /** Pending focus handshakes, keyed by the tab we asked to come forward. */
  const pendingFocusAcks = new Map<string, () => void>()

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

  /** Replace the cache and tell everyone. `retire` also closes their windows. */
  const setTabs = (next: WebTab[], retire: readonly WebTab[] = []): void => {
    tabsCache = next
    for (const gone of retire) liveness.forget(gone.id)
    broadcast()
    if (retire.length > 0) requestTabClose(tabChannel, retire)
  }

  const registerTab = (
    kind: OpenableModule,
    path: string | undefined,
    win: Window | null,
    id: string = newTabId(),
  ): WebTab => {
    const title = path ? moduleFileName(path) : MODULE_LABEL[kind]
    const tab: WebTab = { id, kind, title, windowId: id }
    markTabLive(id)
    if (win) {
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
    setTabs(tabsCache.filter((t) => t.id !== id))
  }

  /** Drop rows whose window has stopped beating. Returns true if the cache
   *  changed, so callers can avoid a redundant broadcast. */
  const sweepStaleTabs = (): boolean => {
    const { tabs, changed } = sweepTabs(tabsCache, liveness)
    if (!changed) return false
    liveness.pruneLive(tabs.map((t) => t.id))
    setTabs(tabs)
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
        pendingFocusAcks.get(data.id)?.()
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

  /* Every URL this module opens is a same-origin path it builds itself
   * (`/${module}/...`), never anything a caller supplies. The two async callers
   * (newPdf, newHtml) must still create the window inside the click handler and
   * navigate it only after their IPC round-trip resolves, so they open it blank
   * first; window.open's single-argument form already defaults to a new tab. */
  const openBlankTab = (): Window | null => window.open('')

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
    const win = openBlankTab()
    if (!win) return null
    const id = newTabId()
    return {
      win,
      open: (path: string) => {
        const module = moduleForPath(path)
        if (!module) {
          win.close()
          return
        }
        registerTab(module, path, win, id)
        win.location.href = moduleUrl(module, path, id)
      },
      cancel: () => {
        try {
          win.close()
        } catch {
          /* the browser may refuse to close a tab it thinks the script did
           * not open; the blank tab is harmless if so */
        }
      },
    }
  }

  /** Open `module` (optionally on `path`) without consulting the cache. */
  const openFreshTab = (module: OpenableModule, path?: string): Window | null => {
    /* The id is minted before the URL is built and travels *inside* it, so the
     * guest announces exactly the row the host just created. A blank tab gets
     * no id: the guest will mint its own and announce it. */
    const id = newTabId()
    const tab = openBlankTab()
    if (!tab) return null
    registerTab(module, path, tab, id)
    tab.location.href = path ? moduleUrl(module, path, id) : `/${module}/?mode=tab&tab=${id}`
    return tab
  }

  const openModule = (module: OpenableModule, path?: string): Window | null => {
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
      return openFreshTab(module, path)
    }

    /* An authoritative tab exists, so this is a handshake, not an assumption:
     * the target answers `focus-ack` and we stop. No answer within
     * FOCUS_ACK_TIMEOUT_MS means the entry outlived its window, and we open
     * the file ourselves. The window.open below happens inside that timeout,
     * which still counts as the current task for popup purposes (and this
     * whole path only runs for a click the browser already authorised). */
    const target = decision.tab.id
    /* Other rows claiming this path are duplicates of the tab we are about to
     * focus. They are live windows, so they are told to close — leaving them
     * open would give two windows the same file, and whichever the user edits
     * second wins. */
    if (decision.duplicates.length > 0) {
      const dupIds = new Set(decision.duplicates.map((t) => t.id))
      setTabs(
        tabsCache.filter((t) => !dupIds.has(t.id)),
        decision.duplicates,
      )
    }
    let settled = false
    const openBecauseSilent = (): void => {
      if (settled) return
      settled = true
      pendingFocusAcks.delete(target)
      unregisterTabById(target)
      openFreshTab(module, path)
    }
    pendingFocusAcks.set(target, () => {
      settled = true
      pendingFocusAcks.delete(target)
      markTabLive(target)
    })
    tabChannel.postMessage({ type: 'focus-request', id: target })
    setTimeout(openBecauseSilent, FOCUS_ACK_TIMEOUT_MS)
    return null
  }

  const openPathInModule = (path: string): void => {
    const module = moduleForPath(path)
    if (module) openModule(module, path)
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
  const uploadPicked = async (name: string, bytes: ArrayBuffer): Promise<string> => {
    try {
      const uploaded = await uploadFileToServer(transport, name, bytes)
      window.dispatchEvent(new Event('genoffice:recents-changed'))
      return uploaded.path
    } catch {
      return await files.writeTempFile(name, bytes)
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
      for (const file of dropped) {
        try {
          // one unreadable file must not abort the rest of the drop
          first ??= await uploadPicked(file.name, await file.arrayBuffer())
        } catch {
          /* unreadable or rejected file: skip it and keep uploading the rest */
        }
      }
      if (!first) {
        reserved?.cancel()
        return
      }
      if (reserved) reserved.open(first)
      else openPathInModule(first)
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
    const tab = window.open(url, '_blank')
    if (!tab) return
    registerTab(kind, path, tab, tabId)
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
       * activation". Both calls are synchronous, so they share the tick. */
      const picked = pickFileBytes(undefined, false)
      const reserved = reserveTab()
      const file = (await picked)?.[0]
      if (!file) {
        reserved?.cancel()
        return
      }
      try {
        const path = await uploadPicked(file.name, file.bytes)
        if (reserved) reserved.open(path)
        else openPathInModule(path)
      } catch (cause) {
        reserved?.cancel()
        window.alert(`无法打开该文件：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
    openPath: async (path) => {
      openPathInModule(path)
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
      const home = {
        id: 'home',
        kind: 'home' as const,
        title: '首页',
        closable: false,
        active: true,
      }
      sweepStaleTabs()
      return [
        home,
        ...tabsCache.map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          closable: true,
          active: false,
        })),
      ]
    },
    tabsActivate: async (id: string) => {
      if (id === 'home') {
        window.focus()
        return
      }
      /* The shell never holds the child Window handle, so clicking a tab used
       * to just focus the shell itself — the click looked like a no-op. The
       * tab protocol solves it the same way a recents click does: ask the tab
       * to come forward and let it focus itself. A tab that does not answer is
       * a phantom, and its row is dropped so the TabBar stops offering it. */
      const tab = tabsCache.find((t) => t.id === id)
      if (!tab) return
      let settled = false
      pendingFocusAcks.set(id, () => {
        settled = true
        pendingFocusAcks.delete(id)
        markTabLive(id)
      })
      tabChannel.postMessage({ type: 'focus-request', id } satisfies TabChannelMessage)
      setTimeout(() => {
        if (settled) return
        pendingFocusAcks.delete(id)
        /* Nobody answered: the row outlived its window. */
        unregisterTabById(id)
      }, FOCUS_ACK_TIMEOUT_MS)
    },
    tabsClose: async (id: string) => {
      /* The shell has no handle on the child window, so it asks the tab to
       * close itself; the row is dropped either way. */
      requestTabClose(
        tabChannel,
        tabsCache.filter((t) => t.id === id),
      )
      unregisterTabById(id)
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

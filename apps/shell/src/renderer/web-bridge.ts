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

  /** The per-tab id the shell stamps on a child window; not part of lib.dom. */
  interface TabIdHost {
    __genofficeTabId?: string
  }
  // SAFETY: lib.dom's Window declares no __genofficeTabId. This module is its
  // only writer (registerTab, below) and every reader goes through
  // asTabIdHost, so at runtime the field is either the string we set or absent
  // — never another type — which is exactly what the optional field claims.
  const asTabIdHost = (win: Window): TabIdHost => win as unknown as TabIdHost

  /* ── Web-native tab tracking ─────────────────────────────────────────
   * The Electron shell tracks tabs as WebContentsViews owned by the main
   * process. The web version opens each module in a new browser tab via
   * window.open; we sync those across all shell windows with BroadcastChannel
   * + localStorage so the TabBar shows real entries. */
  interface WebTab {
    id: string
    kind: 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'
    title: string
    /** stable per-tab random id; the window itself is the source of truth */
    windowId: string
  }
  const TAB_STORAGE_KEY = 'genoffice:web-tabs'
  const SHELL_ID_KEY = 'genoffice:shell-id'
  let shellId = localStorage.getItem(SHELL_ID_KEY)
  if (!shellId) {
    shellId = 'shell-' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem(SHELL_ID_KEY, shellId)
  }
  const tabChannel = new BroadcastChannel('genoffice:tabs')
  const loadTabs = (): WebTab[] => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY)
      return raw ? (JSON.parse(raw) as WebTab[]) : []
    } catch {
      return []
    }
  }
  const saveTabs = (tabs: WebTab[]): void => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(tabs))
    } catch {
      /* quota exceeded or storage disabled: the in-memory cache stays correct
         for this shell, and the next broadcast re-attempts the persist. */
    }
  }
  let tabsCache = loadTabs()
  const broadcast = (): void => {
    tabChannel.postMessage({ type: 'sync', tabs: tabsCache })
    saveTabs(tabsCache)
    // notify the TabBar (which subscribes via window event since the IPC
    // push channel would require the SSE bridge and is unnecessary here)
    window.dispatchEvent(new CustomEvent('genoffice:web-tabs-changed', { detail: tabsCache }))
  }
  const moduleLabel = (kind: WebTab['kind']): string => {
    return {
      docs: 'AI Docs',
      sheets: 'AI Sheets',
      slides: 'AI Slides',
      pdf: 'AI PDF',
      markdown: 'AI Markdown',
      html: 'AI HTML',
    }[kind]
  }
  const moduleFileName = (path?: string): string => {
    if (!path) return ''
    const parts = path.split(/[\\/]/)
    return parts[parts.length - 1] || ''
  }
  const registerTab = (
    kind: WebTab['kind'],
    path: string | undefined,
    win: Window | null,
  ): WebTab => {
    const id = 'web-' + Math.random().toString(36).slice(2, 10)
    const title = path ? moduleFileName(path) : moduleLabel(kind)
    const tab: WebTab = { id, kind, title, windowId: id }
    tabsCache = [...tabsCache, tab]
    broadcast()
    if (win) {
      // stash the tab id on the child window so it can self-close
      try {
        asTabIdHost(win).__genofficeTabId = id
      } catch {
        /* cross-origin window: not one of ours, so nothing to stamp */
      }
    }
    return tab
  }
  const unregisterTabById = (id: string): void => {
    tabsCache = tabsCache.filter((t) => t.id !== id)
    broadcast()
  }
  // listen for cross-window sync (other shells' broadcasts)
  tabChannel.onmessage = (e: MessageEvent) => {
    if (e.data?.type === 'sync') {
      tabsCache = e.data.tabs as WebTab[]
      saveTabs(tabsCache)
      window.dispatchEvent(new CustomEvent('genoffice:web-tabs-changed', { detail: tabsCache }))
    }
    if (e.data?.type === 'close-request') {
      // if this is the child window being asked to close, honour it
      const myId = asTabIdHost(window).__genofficeTabId
      if (typeof myId === 'string' && myId === e.data.id) {
        try {
          window.close()
        } catch {
          /* the browser refuses window.close() for a tab the script did not
             open; the entry is already gone from tabsCache either way. */
        }
      }
    }
    if (e.data?.type === 'focus-request') {
      // The shell home tab asked us to take focus because the user clicked
      // on a recent entry for a path this tab already owns. Bring the window
      // forward so the user lands on the file, not the home tab.
      const myId = asTabIdHost(window).__genofficeTabId
      if (typeof myId === 'string' && myId === e.data.id) {
        try {
          window.focus()
        } catch {
          /* focus() can throw under strict CSP in some sandboxes; safe to
             ignore since the user can still click the TabBar entry. */
        }
      }
    }
  }

  // as a child window: announce ourselves on load and clean up on unload
  const myTabId = asTabIdHost(window).__genofficeTabId
  if (myTabId) {
    const cleanup = (): void => {
      unregisterTabById(myTabId)
    }
    window.addEventListener('beforeunload', cleanup)
    // also broadcast periodically so other shells re-discover us after refresh
    setTimeout(broadcast, 100)
  }

  /* Every URL this module opens is a same-origin path it builds itself
   * (`/${module}/...`), never anything a caller supplies. The two async callers
   * (newPdf, newHtml) must still create the window inside the click handler and
   * navigate it only after their IPC round-trip resolves, so they open it blank
   * first; window.open's single-argument form already defaults to a new tab. */
  const openBlankTab = (): Window | null => window.open('')

  const openModule = (
    module: 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html',
    path?: string,
  ) => {
    // Dedupe: if a tab is already open for this exact path, ask it to focus
    // itself rather than opening a duplicate. Recents clicks fire often and a
    // new window.open per click would leave the user with N tabs of the same
    // file and the TabBar unable to keep them in sync.
    if (path) {
      const existing = tabsCache.find((t) => t.kind === module && t.title === moduleFileName(path))
      if (existing) {
        tabChannel.postMessage({ type: 'focus-request', id: existing.id })
        return null
      }
    }
    const tab = openBlankTab()
    if (!tab) return null
    registerTab(module, path, tab)
    const base = `/${module}/?mode=tab`
    tab.location.href = path
      ? module === 'pdf'
        ? `${base}#open=${encodeURIComponent(path)}`
        : `${base}&open=${encodeURIComponent(path)}`
      : base
    return tab
  }

  const openPathInModule = (path: string): void => {
    const ext = path
      .split(/[\\/.]/)
      .pop()
      ?.toLowerCase()
    const module =
      ext === 'docx'
        ? 'docs'
        : ext === 'xlsx' || ext === 'xlsm' || ext === 'xls' || ext === 'csv'
          ? 'sheets'
          : ext === 'pptx' || ext === 'ppt'
            ? 'slides'
            : ext === 'pdf'
              ? 'pdf'
              : ext === 'md' || ext === 'markdown'
                ? 'markdown'
                : ext === 'html' || ext === 'htm'
                  ? 'html'
                  : null
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
      if (first) openPathInModule(first)
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
    docs: { channel: 'home:new-doc', prefix: 'doc', ext: 'docx', serverDir: 'FILES_DIR', urlStyle: 'query' },
    sheets: { channel: 'home:new-sheet', prefix: 'sheet', ext: 'xlsx', serverDir: 'FILES_DIR', urlStyle: 'query' },
    slides: { channel: 'home:new-slide', prefix: 'slide', ext: 'pptx', serverDir: 'FILES_DIR', urlStyle: 'query' },
    pdf: { channel: 'home:new-pdf', prefix: 'pdf', ext: 'pdf', serverDir: 'FILES_DIR', urlStyle: 'hash' },
    markdown: { channel: 'home:new-markdown', prefix: 'md', ext: 'md', serverDir: 'DATA_DIR', urlStyle: 'query' },
    html: { channel: 'home:new-html', prefix: 'html', ext: 'html', serverDir: 'DATA_DIR', urlStyle: 'hash' },
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
    const id = `${spec.prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const path = `${effectiveDir(spec.serverDir)}/${id}.${spec.ext}`
    const encoded = encodeURIComponent(path)
    const base = `/${kind}/?mode=tab`
    const url =
      spec.urlStyle === 'hash'
        ? path
          ? `${base}#open=${encoded}`
          : base
        : path
          ? `${base}&open=${encoded}`
          : base
    const tab = window.open(url, '_blank')
    if (!tab) return
    registerTab(kind, path, tab)
    /* Fire-and-forget: the server handler materialises the file and
     * appends it to DOCS_RECENT. If the renderer predicted the wrong
     * FILES_DIR (because home:get-data-paths hadn't returned), the server
     * falls back to its own timestamp id, the user still gets a working
     * empty document, and the recents row will simply point at a slightly
     * different path than the editor opened. */
    void transport
      .invoke(spec.channel, { id, projectId })
      .catch((cause: unknown) => {
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
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return
      const file = picked[0]
      if (!file) return
      openPathInModule(await uploadPicked(file.name, file.bytes))
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
      // try to focus the matching window if we can find it
      const t = tabsCache.find((tab) => tab.id === id)
      if (!t) return
      // we don't have a direct handle to the child window; the closest UX is
      // to focus our own window — the user can switch tabs via the browser
      window.focus()
    },
    tabsClose: async (id: string) => {
      // we can't find the child window handle from another shell, but we can
      // broadcast a close request that the child listens for and honours by
      // calling window.close() on itself
      tabChannel.postMessage({ type: 'close-request', id })
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

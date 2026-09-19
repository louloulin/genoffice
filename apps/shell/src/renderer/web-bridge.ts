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
    newDoc: async () => {
      openModule('docs')
    },
    newSheet: async () => {
      openModule('sheets')
    },
    newSlide: async () => {
      openModule('slides')
    },
    newMarkdown: async () => {
      openModule('markdown')
    },
    newPdf: async () => {
      const tab = openBlankTab()
      if (!tab) return
      const result = (await transport.invoke('home:new-pdf')) as { path?: unknown }
      const path = typeof result?.path === 'string' ? result.path : ''
      tab.location.href = path
        ? `/pdf/?mode=tab#open=${encodeURIComponent(path)}`
        : '/pdf/?mode=tab'
      registerTab('pdf', path || undefined, tab)
    },
    newHtml: async () => {
      const tab = openBlankTab()
      if (!tab) return
      const result = (await transport.invoke('home:new-html')) as { path?: unknown }
      const path = typeof result?.path === 'string' ? result.path : ''
      tab.location.href = path
        ? `/html/?mode=tab#open=${encodeURIComponent(path)}`
        : '/html/?mode=tab'
      registerTab('html', path || undefined, tab)
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

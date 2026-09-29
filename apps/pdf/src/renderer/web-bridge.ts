/// Web-version bootstrap for the pdf renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.pdfApi` / `window.projectApi` objects the preload exposes in the
/// desktop app, but backed by the HTTP/SSE transport against the running
/// Electron main process. Inside Electron the preload has already exposed the
/// IPC-backed APIs and this module leaves them untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import { defaultSdkCommandHandlers, installSdkCommandSink } from '@genoffice/ipc-bridge/sdk-command-sink'
import { installTextBufferSink } from '@genoffice/ipc-bridge/text-buffer-adapter'
import { createSidebarRuntime } from '@genoffice/ipc-bridge/sidebar-runtime'
import {
  createDataflareEmbedIntegration,
  isHostDocumentSource,
  resolveEmbedPathPrefix,
} from '@genoffice/web-sdk/dataflare/integration'
import { createPdfApi, createPdfProjectApi } from '../shared/pdf-api-factory'
import type { PdfApi, SavePdfRequest, SavePdfResult } from '../shared/ipc'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the pdf renderer.
  installBackToHome({ label: '返回主页' })
  /* Editor tabs are opened by the shell with `window.open`, so the shell has
   * no window handle to watch. This announces the tab (and keeps beating) over
   * the shared tab protocol — without it the shell can only guess whether a
   * row in its TabBar still has a window behind it, and a wrong guess is what
   * made clicking a recent file do nothing (or open a duplicate). */
  installTabGuest()
  /* SDK 2.0 Kestrel command sink (sdk1.md §11.36). The embed bridge
   * dispatches host `editor.command(name, args)` envelopes to this sink
   * when it exists (falling back to the server-backed `sdk:command` IPC
   * channel otherwise). `defaultSdkCommandHandlers()` covers the two
   * commands that are pure browser operations — `openFileDialog` (file
   * input → base64 PickedFile[]) and `print`. App-specific commands that
   * need the live editor model are added here as the renderer wires them. */
  installTextBufferSink({
    sidebar: createSidebarRuntime({
      // Auto-forward inbound panel messages to window.parent as a
      // sidebarMessage EditorEvent (sdk1.md §B.5.1 #8). Closes the
      // panel → host half of the round-trip so the host SDK's
      // `editor.on('sidebarMessage', cb)` fires without an app-side
      // shim. Degrades to a no-op when there's no parent window
      // (apps run standalone in the browser tab fall back silently).
      outboundToHost: true,

      // Lazy body-aside host: zero DOM cost until mountSidebar runs.
      // Each app owns its sidebar chrome via app-specific CSS in
      // apps/{app}/src/renderer/styles.css. The runtime also sets
      // data-* attributes on the inner iframe for app-side hooks.
      get host() {
        let el = document.getElementById('genoffice-sidebar')
        if (!el) {
          el = document.createElement('aside')
          el.id = 'genoffice-sidebar'
          el.setAttribute('aria-label', 'GenOffice plugin panels')
          el.style.position = 'fixed'
          el.style.top = '0'
          el.style.right = '0'
          el.style.bottom = '0'
          el.style.width = '320px'
          el.style.background = 'var(--bg, #fff)'
          el.style.borderLeft = '1px solid var(--border, #e0e0e0)'
          el.style.zIndex = '1000'
          el.style.display = 'none'
          document.body.appendChild(el)
        }
        return el as unknown as Parameters<typeof createSidebarRuntime>[0]['host']
      },
    }),
  })
  // Embedded under the Dataflarework proxy the IPC endpoints live under
  // `/office-engine/api/…`; without the prefix every call 404s on the host origin.
  const transport = createHttpIpcTransport({
    pathPrefix: resolveEmbedPathPrefix(window.location.pathname),
  })
  const files = createWebFileBridge(transport)
  // SAFETY: `window` has no `pdfApi` / `pdfFilesApi` / `pdfProjectApi` in
  // lib.dom. The bridge assigns those keys below and reads them back through
  // module-scoped helpers, so the cast is sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  // `#open=<path>` grants the path to the bridge sender and returns it as the
  // pending open, so the renderer's boot consumePending() opens it (the web
  // equivalent of the shell granting a path to a real PDF view).
  const hashOpen = new URLSearchParams(window.location.hash.slice(1)).get('open')
  bridgedWindow.pdfApi = createPdfApi(transport, {
    consumePending: async () => {
      if (hashOpen) {
        const granted: unknown = await transport.invoke('pdf:open-path', hashOpen)
        return granted ? hashOpen : null
      }
      return null
    },
    uploadFile: async (projectId?: string) => {
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return null
      const file = picked[0]
      if (!file) return null
      try {
        const uploaded = await uploadFileToServer(transport, file.name, file.bytes, projectId)
        window.dispatchEvent(new Event('genoffice:recents-changed'))
        return uploaded
      } catch (err) {
        console.error('pdf uploadFile failed', err)
        return null
      }
    },
  })
  bridgedWindow.projectApi = createPdfProjectApi(transport)

  // ── Dataflare host documents (drive / knowledge PDFs) ──────────────────────
  //
  // The host hands down a document in `init`; the integration downloads it and
  // `openBytes` parks it in WEB_TEMP_ROOT (a managed path, so pdf:open-path /
  // read-file / save accept it). The renderer then edits that temp copy exactly
  // like a local file. Saving is the one place the flows diverge: pdf:save
  // rewrites the temp copy, and only after that succeeds are the resulting
  // bytes pushed to the host as a new revision (optimistic lock, 409 → conflict).
  let hostDocumentPath: string | null = null
  const dataflare = createDataflareEmbedIntegration({
    app: 'pdf',
    transport,
    openBytes: async (bytes, name) => {
      const path = await files.writeTempFile(name, bytes)
      const granted: unknown = await transport.invoke('pdf:open-path', path)
      if (!granted) throw new Error('pdf: host document could not be opened')
      hostDocumentPath = path
      return path
    },
    // pdf:save already wrote the file; the integration only needs to report ok.
    saveLocal: async () => ({ ok: true }),
    shouldAutoOpen: (context) => context.documentType === 'pdf',
    onDocumentOpened: (result) => {
      // Same hand-off as docs: only the App component can apply an open to the
      // viewer. The path is also parked on window for an App that mounts after
      // the event fired.
      if (typeof result !== 'string') return
      bridgedWindow.dataflarePdfPendingOpen = result
      window.dispatchEvent(new CustomEvent('dataflare:open-document', { detail: result }))
    },
  })
  const pdfApi = bridgedWindow.pdfApi as PdfApi
  const saveToDisk = pdfApi.save
  pdfApi.save = async (request: SavePdfRequest): Promise<SavePdfResult> => {
    const result = await saveToDisk(request)
    const context = dataflare.getContext()
    const isHostSave =
      result.ok &&
      !request.targetPath &&
      request.path === hostDocumentPath &&
      isHostDocumentSource(context?.documentSource)
    if (!isHostSave) return result
    try {
      const bytes = await pdfApi.readFile(request.path)
      const saved = await dataflare.saveDocument(request.path, bytes, false)
      return saved.ok ? result : { ok: false, error: saved.error }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  dataflare.install({})
}

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
  type DataflareEmbedCommand,
} from '@genoffice/web-sdk/dataflare/integration'
import {
  buildEmbedTranslateBody,
  createEmbedTranslateBatchAccumulator,
  parseEmbedTranslateStreamEvent,
} from '@genoffice/translation-core/embed-body'
import type {
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateBatchUnitResult,
} from '@genoffice/translation-core/document'
import { isEmbeddedInHost } from '@genoffice/web-sdk/dataflare/guest'
import { emitTranslateProgress } from './translate-progress'
import { createDataflareTranslationStorage } from '@genoffice/translation-core/storage'
import type { IpcTransport } from '@genoffice/ipc-bridge/client'
import { createPdfApi, createPdfProjectApi } from '../shared/pdf-api-factory'
import type { PdfApi, SavePdfRequest, SavePdfResult } from '../shared/ipc'
import { createEditableDocx, DOCX_CONTENT_TYPE } from './ai/editable-docx'


/**
 * Batch translate for the pdf app, embedded or standalone.
 *
 * Standalone (Electron / plain web tab) there is no drive to enrich from and
 * no SSE channel, so this falls through to the shared `ai:translate-batch`
 * handler and replays the finished batch. Embedded, it streams through the
 * Dataflare host so per-paragraph progress reaches the parent page *and* the
 * space-scoped glossary / memory the host injects are actually used.
 *
 * `dataflare` is passed in rather than captured: the api factory is built
 * before the integration exists, so the caller hands over a late-bound
 * reference (see `dataflareRef`).
 */
async function translatePdfThroughHost(
  dataflare: ReturnType<typeof createDataflareEmbedIntegration> | null,
  transport: IpcTransport,
  request: TranslateBatchRequest,
  options?: { onUnit?: (unit: TranslateBatchUnitResult) => void; signal?: AbortSignal },
): Promise<TranslateBatchResponse> {
  if (!dataflare || !dataflare.isEmbedded()) {
    const response = (await transport.invoke(
      'ai:translate-batch',
      request,
    )) as unknown as TranslateBatchResponse
    for (const unit of response.units ?? []) {
      if (unit?.unitId) options?.onUnit?.(unit)
    }
    return response
  }

  const accumulator = createEmbedTranslateBatchAccumulator()
  const batchId = `pdf-stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const context = dataflare.getContext()
  const body = JSON.stringify(
    buildEmbedTranslateBody(
      {
        requestId: batchId,
        documentId: context?.documentId,
        documentType: 'pdf',
        scene: request.scene || 'pdf-document',
        sourceLanguage: request.sourceLang,
        targetLanguage: request.targetLang,
        preserveFormatting: request.preserveFormat,
        memoryEnabled: request.memoryEnabled,
        qualityCheck: request.qualityCheck,
        glossaryCategory: request.glossaryCategory,
        ...(request.customerName !== undefined ? { customerName: request.customerName } : {}),
      },
      request.units,
    ),
  )

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      options?.signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      resolve()
    }
    function onAbort(): void {
      finish()
    }
    const unsubscribe = dataflare.stream('/office-engine/api/ai/translate/stream', body, {
      onEvent: (event) => {
        const payload = parseEmbedTranslateStreamEvent(event.data)
        if (!payload) return
        const settledUnit = accumulator.push(payload)
        if (settledUnit) {
          options?.onUnit?.(settledUnit)
          // The host renders its own progress from the same run; without this
          // the parent page shows nothing until the last paragraph lands.
          emitTranslateProgress({
            type: 'ai-progress',
            status: 'running',
            progress: accumulator.result().units.length / Math.max(request.units.length, 1),
            completedUnits: accumulator.result().units.length,
            totalUnits: request.units.length,
          })
        }
        if (accumulator.settled) finish()
      },
      onClose: finish,
      onError: (error) => {
        accumulator.push({ type: 'error', message: error.message })
        finish()
      },
    })
    if (settled) return
    options?.signal?.addEventListener('abort', onAbort)
    if (options?.signal?.aborted) finish()
  })

  return accumulator.result()
}

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
  // Late-bound on purpose: `createPdfApi` runs *before* the Dataflare
  // integration exists a few lines down, but the override is only ever invoked
  // from a user action (translating a document), long after `dataflareRef` is
  // assigned. Capturing the integration eagerly here instead would be the
  // same mistake as reading `getContext()` before `install()` — the value
  // would be `null` on every load and the panel would report the embedded
  // translation path as unavailable for every drive PDF.
  let dataflareRef: ReturnType<typeof createDataflareEmbedIntegration> | null = null
  bridgedWindow.pdfApi = createPdfApi(transport, {
    aiTranslateBatchStream: (request, options) =>
      translatePdfThroughHost(dataflareRef, transport, request, options),
    /**
     * Space-scoped glossary / translation memory.
     *
     * The embedded test is `isEmbeddedInHost()` and **not** `dataflare.getContext()`:
     * this object literal is built before `dataflare.install()` runs, so asking
     * for the context here answers `null` on every load and pins the client to
     * `null` forever — which the panel then renders as "unavailable" for every
     * drive document. The space id is still read per call, so the panel follows
     * the user across spaces.
     */
    // SAFETY: the bridge is only reachable after `dataflareRef` is assigned
    // below, and the client reads it per call; the local alias keeps the
    // null-check out of the hot path.
    translationStorage: isEmbeddedInHost()
      ? createDataflareTranslationStorage({
          request: (path, init) => {
            const integration = dataflareRef
            if (!integration) return Promise.reject(new Error('Dataflare host bridge is not ready'))
            return integration.request(path, init)
          },
          getSpaceId: () => dataflareRef?.getContext()?.spaceId ?? null,
        })
      : null,
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
  // The host's own file name, captured from the download. The managed temp copy
  // the viewer edits is named after the document id, so it is useless for
  // naming anything the user will see in the drive.
  let hostDocumentName: string | null = null
  const dataflare = createDataflareEmbedIntegration({
    app: 'pdf',
    transport,
    openBytes: async (bytes, name) => {
      const path = await files.writeTempFile(name, bytes)
      const granted: unknown = await transport.invoke('pdf:open-path', path)
      if (!granted) throw new Error('pdf: host document could not be opened')
      hostDocumentPath = path
      hostDocumentName = name
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
  // Safe now: the integration object exists, and `install()` below is what
  // lets the host's `init` command arrive. The override closure only reads
  // this reference when a translation is actually requested.
  dataflareRef = dataflare
  const pdfApi = bridgedWindow.pdfApi as PdfApi
  const saveToDisk = pdfApi.save
  pdfApi.save = async (request: SavePdfRequest): Promise<SavePdfResult> => {
    let result: SavePdfResult
    try {
      result = await saveToDisk(request)
    } catch (err) {
      // `SavePdfResult` is the whole contract every caller understands: App
      // renders `!result.ok` as a toast. A transport/server throw instead
      // rejects the promise, which no caller catches — the save fails
      // silently and the host never learns the revision did not move.
      // Fold it back into the contract shape.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const context = dataflare.getContext()
    const isHostSave =
      result?.ok === true &&
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

  // ── PDF → editable DOCX (the fallback for layouts in-place rewriting can't carry) ──
  //
  // Both members are gated on the session being a **drive** document, and both
  // read `getContext()` at call time: the host's `init` arrives after this
  // bridge is installed, so anything decided here would decide "no" forever.
  //
  // `supportsEditableDocx` exists so the panel can render no action at all in
  // the desktop build and in knowledge-base documents, rather than offering one
  // that can only fail. A knowledge document has no drive space to put a
  // sibling file in — the same reason the copy-save target is not offered there.
  pdfApi.supportsEditableDocx = () => {
    const context = dataflare.getContext()
    return context?.documentSource === 'drive' && Boolean(context?.documentId)
  }
  pdfApi.createEditableDocx = async ({ path }) => {
    // No host name means no `init` download completed, so there is no host
    // document to sit beside. Deriving a name anyway would file the result as
    // `untitled.editable.docx` — a real file in the user's drive under a name
    // they never chose, which is worse than refusing.
    if (!hostDocumentName) return { ok: false, reason: 'no-source' as const }
    return await createEditableDocx({
      sourceName: hostDocumentName,
      // Read through the same managed temp copy the viewer is editing, so the
      // conversion sees exactly the bytes on screen — including any text edits
      // the user has already made here.
      readSource: async () => await pdfApi.readFile(path),
      convert: async (pdf) => await pdfApi.pdfToDocx(pdf),
      saveAsDocx: async (docx, fileName) => {
        const saved = await dataflare.saveDocument(path, docx, false, {
          saveAsFileName: fileName,
          // The open document is a PDF; without this the host would file an
          // editable Word document as application/pdf.
          contentType: DOCX_CONTENT_TYPE,
        })
        if (!saved.ok) return { ok: false, error: saved.error }
        return saved.savedAs?.itemId
          ? { ok: true, itemId: saved.savedAs.itemId }
          : { ok: true }
      },
    })
  }

  // 转发宿主命令。`install({})` —— 此前是空字面量，于是 `init` 之后的每一条
  // 宿主命令都在这一层被丢弃：Dataflare 头部的「翻译全文」点下去**什么都不会发生**
  // （对话框不出现、不报错、连一条 console error 都没有），而 `App.tsx` 里那份
  // 完整处理 `translate` / `cancel-translation` 的 `onHostCommand` 从来收不到事件。
  //
  // 文档本身能打开容易让人误判为「接线通了」：`init` 是 integration 自己消费的
  // （记账 context + 自动拉字节），不经过 `handlers.onCommand`；只有宿主**主动下发**
  // 的命令走这条路。docs / sheets / slides 三家都转发，只有 pdf 漏了。
  dataflare.install({
    onCommand: (command: DataflareEmbedCommand) => {
      window.dispatchEvent(new CustomEvent('dataflare:office-command', { detail: command }))
    },
  })
}

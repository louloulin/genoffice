/// Web-version bootstrap for the sheets renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.desktopApi` / `window.projectApi` objects the preload exposes in
/// the desktop app, but backed by the HTTP/SSE transport against the running
/// Electron main process. Native-only channels (workbook open dialogs, CSV
/// save confirm, attachment picker, screen capture) get browser equivalents so
/// the web version keeps the full feature surface. Inside Electron the preload
/// has already exposed the IPC-backed APIs and this module leaves them
/// untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import { installTextBufferSink } from '@genoffice/ipc-bridge/text-buffer-adapter'
import { createSidebarRuntime } from '@genoffice/ipc-bridge/sidebar-runtime'
import {
  createDataflareEmbedIntegration,
  isHostDocumentSource,
  resolveEmbedPathPrefix,
} from '@genoffice/web-sdk/dataflare/integration'
import {
  buildEmbedTranslateBody,
  createEmbedTranslateBatchAccumulator,
  parseEmbedTranslateStreamEvent,
} from '@genoffice/translation-core/embed-body'
import { createDataflareTranslationStorage } from '@genoffice/translation-core/storage'
import { isEmbeddedInHost } from '@genoffice/web-sdk/dataflare/guest'
import { emitTranslateProgress } from './translate-progress'
import { createSheetsApi, createSheetsProjectApi, type SheetsApiOverrides } from '../shared/sheets-api-factory'
import type { WorkbookExportCsvResult } from '../shared/desktop-api'
import { createHostDocumentSync } from './dataflare-host-sync'
import { saveWorkbookOverHttp } from './web-save'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill — works even when the user landed on a deep
  // link like `/sheets/...` without ever visiting the home tab.
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

  // ── Dataflare host documents (drive / knowledge xlsx) ──────────────────────
  //
  // The host hands down a workbook in `init`; the integration downloads it and
  // `openBytes` parks it in WEB_TEMP_ROOT (a managed path, so open-path / save /
  // read-file-bytes accept it). The renderer opens that temp copy through its
  // normal selectWorkbook flow and edits it like a local file; save-actions
  // then pushes the saved bytes back via `syncHostDocument`.
  let pendingHostOpen: string | null = null
  const dataflare = createDataflareEmbedIntegration({
    app: 'sheets',
    transport,
    openBytes: async (bytes, name) => {
      const path = await files.writeTempFile(name, bytes)
      hostSync.setHostDocumentPath(path)
      return path
    },
    // workbook:save already wrote the file; the integration only needs to report ok.
    saveLocal: async () => ({ ok: true }),
    shouldAutoOpen: (context) => context.documentType === 'xlsx',
    onDocumentOpened: (result) => {
      // Only the App component can install a workbook into Univer. The path is
      // parked for selectWorkbook; an App that mounts after the event finds it
      // through hasQueuedWorkbook.
      if (typeof result !== 'string') return
      pendingHostOpen = result
      window.dispatchEvent(new CustomEvent('dataflare:open-document', { detail: result }))
    },
  })
  const hostSync = createHostDocumentSync({
    readFileBytes: async (path) => (await files.readFileBytes(path)).bytes,
    saveToHost: async (path, bytes) => {
      const saved = await dataflare.saveDocument(path, bytes, false)
      return saved.ok ? { ok: true } : { ok: false, reason: saved.reason, error: saved.error }
    },
    isHostDocument: () => isHostDocumentSource(dataflare.getContext()?.documentSource),
  })
  // SAFETY: lib.dom's `window` type has no `desktopApi` / `sheetsApi` /
  // `projectApi` properties. The bridge assigns those keys below and reads
  // them back through the same module-scoped helper closures, so the
  // double-cast is sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  bridgedWindow.desktopApi = createSheetsApi(transport, {
    hasQueuedWorkbook: async () =>
      pendingHostOpen !== null || new URLSearchParams(window.location.search).has('open'),
    selectWorkbook: async () => {
      if (pendingHostOpen) {
        const hostPath = pendingHostOpen
        pendingHostOpen = null
        return await transport.invoke('workbook:open-path', hostPath)
      }
      const pending = new URLSearchParams(window.location.search).get('open')
      if (pending) return await transport.invoke('workbook:open-path', pending)
      const picked = await pickFileBytes('.xlsx,.xlsm,.xls,.csv')
      if (!picked) return null
      const file = picked[0]
      if (!file) return null
      const { name, bytes } = file
      const path = await files.writeTempFile(name, bytes)
      return await transport.invoke('workbook:open-path', path)
    },
    selectWorkbooksForMerge: async () => {
      const picked = await pickFileBytes('.xlsx,.xlsm,.xls,.csv', true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        paths.push(await files.writeTempFile(file.name, file.bytes))
      }
      return await transport.invoke('workbook:open-for-merge', paths)
    },
    saveWorkbook: (request) => saveWorkbookOverHttp(transport, request),
    // Embedded (Dataflare-hosted) whole-workbook translation rides the host's
    // SSE feed so the run reports per-cell progress while it is still going;
    // standalone falls back to the plain batch IPC call. Parsing and
    // accumulation are shared with docs / slides / pdf via translation-core.
    aiTranslateBatchStream: (request, options) =>
      translateBatchThroughHost(dataflare, transport, request, options),
    /**
     * Space-scoped glossary / translation memory.
     *
     * The embedded test is `isEmbeddedInHost()` and **not** `dataflare.getContext()`:
     * this object literal is built while the bridge is being assembled, but
     * `dataflare.install()` only runs further down and the host's `init` command
     * cannot arrive until after that — asking for the context here answers
     * `null` on every load and pins the client to `null` forever, which the
     * panel then renders as "unavailable" for every drive document. The space id
     * is still read per call, so the panel follows the user across spaces.
     */
    translationStorage: isEmbeddedInHost()
      ? createDataflareTranslationStorage({
          request: dataflare.request,
          getSpaceId: () => dataflare.getContext()?.spaceId ?? null,
        })
      : null,
    syncHostDocument: (path) => hostSync.sync(path),
    hasPendingHostSync: () => hostSync.hasPending(),
    confirmCsvSave: async () => 'csv',
    /* Forwards the desktop exportCsv contract to the web-server handler.
     * The renderer keeps the desktop-shaped `WorkbookExportCsvResult`
     * (canceled / canceled+saveAsXlsxInstead / canceled+path) verbatim;
     * only the actual save dialog is the host's responsibility, since the
     * web build has no native dialog (this method requires `targetPath`
     * to be set — a missing targetPath surfaces as `{ canceled: true }`,
     * which the renderer falls back to its own UX for). */
    exportCsv: async (request): Promise<WorkbookExportCsvResult> => {
      return (await transport.invoke('workbook:export-csv', request)) as WorkbookExportCsvResult
    },
    pickAttachments: async () => {
      const picked = await pickFileBytes(undefined, true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        paths.push(await files.writeTempFile(file.name, file.bytes))
      }
      return await transport.invoke('sheets:files-add', paths)
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
        console.error('sheets uploadFile failed', err)
        return null
      }
    },
    captureScreenSources: async () => {
      return {
        status: 'ok',
        sources: [{ id: 'display', name: 'Screen', kind: 'screen', thumbnail: '' }],
      }
    },
    captureScreenSource: async () => {
      return await captureDisplayFrame()
    },
  })
  bridgedWindow.projectApi = createSheetsProjectApi(transport)
  // Host commands are broadcast as window events, exactly like docs. Without
  // `onCommand` the integration silently drops every `translate` /
  // `cancel-translation` command, so the Dataflare header's translate buttons
  // look wired up and do nothing.
  dataflare.install({
    onCommand: (command) => {
      window.dispatchEvent(new CustomEvent('dataflare:office-command', { detail: command }))
    },
  })
}

async function captureDisplayFrame(): Promise<{
  mediaType: 'image/png'
  base64: string
  width: number
  height: number
} | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    const video = document.createElement('video')
    video.srcObject = stream
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve()
      video.play()
    })
    const width = video.videoWidth
    const height = video.videoHeight
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      stream.getTracks().forEach((track) => track.stop())
      return null
    }
    context.drawImage(video, 0, 0, width, height)
    stream.getTracks().forEach((track) => track.stop())
    return {
      mediaType: 'image/png',
      base64: canvas.toDataURL('image/png').split(',')[1] ?? '',
      width,
      height,
    }
  } catch {
    return null
  }
}


/**
 * Whole-workbook translation transport for the sheets renderer.
 *
 * Two paths, one contract:
 *   · embedded in a Dataflare host → the host proxies
 *     `/office-engine/api/ai/translate/stream`, which pushes one SSE event per
 *     settled cell, so the progress list fills in live;
 *   · standalone → the plain `ai:translate-batch` IPC, which returns the whole
 *     batch at once (progress then only moves at batch boundaries — slower,
 *     not broken).
 *
 * A cancel must actually stop the work: unsubscribing from the SSE feed is
 * what ends the upstream request, and resolving the promise here is what lets
 * the pipeline report `cancelled` instead of waiting for a feed the user has
 * already walked away from.
 */
async function translateBatchThroughHost(
  dataflare: ReturnType<typeof createDataflareEmbedIntegration>,
  transport: Parameters<typeof createSheetsApi>[0],
  request: Parameters<NonNullable<SheetsApiOverrides['aiTranslateBatchStream']>>[0],
  options?: Parameters<NonNullable<SheetsApiOverrides['aiTranslateBatchStream']>>[1],
): Promise<Awaited<ReturnType<NonNullable<SheetsApiOverrides['aiTranslateBatchStream']>>>> {
  if (!dataflare.isEmbedded()) {
    const response = (await transport.invoke(
      'ai:translate-batch',
      request,
    )) as Awaited<ReturnType<NonNullable<SheetsApiOverrides['aiTranslateBatchStream']>>>
    for (const unit of response.units ?? []) {
      if (unit?.unitId) options?.onUnit?.(unit)
    }
    return response
  }

  const accumulator = createEmbedTranslateBatchAccumulator()
  const batchId = `sheets-stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const context = dataflare.getContext()
  const body = JSON.stringify(
    buildEmbedTranslateBody(
      {
        requestId: batchId,
        documentId: context?.documentId,
        documentType: 'xlsx',
        scene: request.scene || 'sheet-document',
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
          // the parent page shows nothing until the last cell lands.
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

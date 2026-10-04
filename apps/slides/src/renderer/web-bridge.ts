/// Web-version bootstrap for the slides renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.slidesApi` / `window.desktop` / `window.projectApi` objects the
/// preload exposes in the desktop app, but backed by the HTTP/SSE transport
/// against the running Electron main process. Native-only channels (open,
/// insert pickers, export dirs, print, clipboard, fullscreen, font install)
/// get browser equivalents so the web version keeps the full feature surface.
/// Inside Electron the preload has already exposed the IPC-backed APIs and this
/// module leaves them untouched.
import {
  createHttpIpcTransport,
  isElectronRuntime,
  type IpcTransport,
} from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  downloadBytes,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
  webFullscreen,
  webPrint,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import {
  defaultSdkCommandHandlers,
  installSdkCommandSink,
} from '@genoffice/ipc-bridge/sdk-command-sink'
import { installTextBufferSink } from '@genoffice/ipc-bridge/text-buffer-adapter'
import { createSidebarRuntime } from '@genoffice/ipc-bridge/sidebar-runtime'
import {
  createSlidesApi,
  createSlidesFilesApi,
  createSlidesProjectApi,
} from '../shared/slides-api-factory'
import {
  buildEmbedTranslateBody,
  createEmbedTranslateBatchAccumulator,
  narrowUnitStatus,
  parseEmbedTranslateStreamEvent,
} from '@genoffice/translation-core/embed-body'
import type {
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateBatchUnitResult,
} from '@genoffice/translation-core'
import { createDataflareTranslationStorage } from '@genoffice/translation-core/storage'
import { isEmbeddedInHost } from '@genoffice/web-sdk/dataflare/guest'
import { emitTranslateProgress } from './ai/translate-progress'
import {
  isHostDocumentSource,
  resolveEmbedPathPrefix,
} from '@genoffice/web-sdk/dataflare/integration'
import { createDataflareEmbedIntegration } from '@genoffice/web-sdk/dataflare/integration'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the slides renderer.
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
  // 嵌入 Dataflare 时整个 SPA 挂在 /office-engine/ 下，IPC 通道也必须带同样的前缀：
  // 不带的话 `POST /api/ipc/:channel` 会打到宿主根路径（Dataflare 根路径是 WeKnora 的
  // /api/），实测表现为**满屏 404**（app:get-language / slides:new-blank / …）而编辑器
  // 永远停在「正在打开…」。docs / sheets / pdf 三家都传了 pathPrefix，只有 slides 漏了
  // —— 与 transports.ts 的 getWebServerUrl 同一个成因，同一处漏一个应用。
  const transport = createHttpIpcTransport({
    pathPrefix: resolveEmbedPathPrefix(window.location.pathname),
  })
  const files = createWebFileBridge(transport)
  // SAFETY: lib.dom's `window` has no `slidesApi` / `slidesFilesApi` /
  // `slidesProjectApi`. The bridge assigns those keys on the next lines and
  // reads them back through the same module-scoped helpers, so the cast is
  // safe within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  // ── Dataflare 宿主集成 ───────────────────────────────────────────────────
  //
  // slides 此前**完全没有**装这个集成：宿主的 `init` / `translate` /
  // `cancel-translation` 命令被静默丢弃，云盘里的 pptx 在编辑器里连"翻译"
  // 入口都没有。抽取/回写纯逻辑已在 `ai/document-translate.ts` 就位，这里补
  // 上让它真正可达的那一段。
  let pendingHostOpen: string | null = null
  // The managed temp copy the renderer edits. The cloud-drive file is a
  // *different* copy, so a save has to hand the bytes to the host explicitly —
  // see the `save` override below.
  let hostDocumentPath: string | null = null
  const dataflare = createDataflareEmbedIntegration({
    app: 'slides',
    transport,
    openBytes: async (bytes, name) => {
      const path = await files.writeTempFile(name, bytes)
      pendingHostOpen = path
      hostDocumentPath = path
      window.dispatchEvent(new CustomEvent('dataflare:open-document', { detail: path }))
      return path
    },
    // `slides:save` already wrote the file; the integration only reports ok.
    saveLocal: async () => ({ ok: true }),
    shouldAutoOpen: (context) => context.documentType === 'pptx',
  })

  bridgedWindow.slidesApi = createSlidesApi(transport, {
    aiTranslateBatchStream: (request, options) =>
      translateDeckThroughHost(dataflare, transport, request, options),
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
    // ── Save: write the temp copy, then push the bytes to the host ──────────
    //
    // `slides:save` rewrites the temp pptx on the web-server's disk and returns
    // `{ ok, path }`. That is the *whole* of what it did before: the deck never
    // reached the cloud drive, so an embedded save reported success, cleared the
    // dirty flag, and left the drive file byte-identical to the original. A
    // whole-deck translation hit exactly that — the editor showed the translated
    // text, the user pressed ⌘S, and the drive kept the source language with no
    // error anywhere.
    //
    // docs / sheets / pdf all push their bytes; slides was the only one missing.
    // The gate is the same three-part test pdf uses: the local write must have
    // succeeded, it must be the host document we opened (not a Save-As target),
    // and the session must actually be a host document.
    save: async () => {
      const result = (await transport.invoke('slides:save')) as {
        ok: boolean
        path?: string
        error?: string
      }
      const context = dataflare.getContext()
      // `result.path === hostDocumentPath` already covers the untitled case: a
      // draft has no host path, so it can never equal the one we opened.
      const savedPath = result.path
      const isHostSave =
        result.ok &&
        savedPath !== undefined &&
        savedPath === hostDocumentPath &&
        isHostDocumentSource(context?.documentSource)
      if (!isHostSave || savedPath === undefined) return result
      try {
        const bytes = (await files.readFileBytes(savedPath)).bytes
        const saved = await dataflare.saveDocument(savedPath, bytes, false)
        return saved.ok ? result : { ...result, ok: false, error: saved.error }
      } catch (err) {
        return { ...result, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    consumePendingOpen: async (fitWidthPx) => {
      // 宿主下发的文档优先于 URL 上的 `?open=`：前者是用户刚点的文件，
      // 后者可能还挂着上一次会话留下的旧路径。
      const queued = pendingHostOpen
      pendingHostOpen = null
      const path = queued ?? new URLSearchParams(window.location.search).get('open')
      if (!path) return null
      return await transport.invoke('slides:open-path', path, fitWidthPx)
    },
    setShowFullScreen: async () => {
      await webFullscreen()
      return null
    },
    openPptx: async (fitWidthPx) => {
      const picked = await pickFileBytes(
        '.pptx,.ppt,application/vnd.openxmlformats-officedocument.presentationml.presentation',
      )
      if (!picked) return null
      const { name, bytes } = picked[0]
      const path = await files.writeTempFile(name, bytes)
      return await transport.invoke('slides:open-path', path, fitWidthPx)
    },
    insertImage: async (slideIndex, fitWidthPx) => {
      const picked = await pickFileBytes('image/*')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (!['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'].includes(ext)) {
        return { error: 'unsupported', ext }
      }
      const natural = await imageNaturalSize(bytes)
      const deckSize = await deckSizePx()
      if (!deckSize) return null
      const maxW = deckSize.cx / 2
      const maxH = deckSize.cy / 2
      const scale = Math.min(maxW / natural.width, maxH / natural.height)
      const cx = Math.round(natural.width * scale)
      const cy = Math.round(natural.height * scale)
      return await transport.invoke('slides:add-image-bytes', {
        slideIndex,
        base64: bytesToBase64(bytes),
        ext,
        xPx: Math.round((deckSize.cx - cx) / 2),
        yPx: Math.round((deckSize.cy - cy) / 2),
        wPx: cx,
        hPx: cy,
        fitWidthPx,
        name,
      })
    },
    insertMedia: async (slideIndex, kind, fitWidthPx) => {
      const picked = await pickFileBytes(kind === 'video' ? 'video/*' : 'audio/*')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      return await transport.invoke('slides:add-media-bytes', {
        slideIndex,
        kind,
        base64: bytesToBase64(bytes),
        ext,
        fitWidthPx,
        name,
      })
    },
    // `fitWidthPx` is deliberately not honoured for 3D models: the desktop
    // handler sizes an embedded model as a square half the deck height
    // (`apps/slides/src/main/slides-main.ts:3627` — `cy = deckSize.cy * 0.5`,
    // `cx = cy`) and ignores the argument identically. Keeping the web bridge in
    // step with that behaviour matters more than honouring FIT_WIDTH here, so
    // the mismatch is documented rather than fixed on one side only.
    insertModel3d: async (slideIndex, _fitWidthPx) => {
      const picked = await pickFileBytes('.glb,.gltf')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      const deckSize = await deckSizePx()
      if (!deckSize) return null
      const cy = Math.round(deckSize.cy * 0.5)
      const cx = cy
      return await transport.invoke('slides:apply-txn', {
        ops: [
          {
            op: 'addModel3d',
            target: { slide: slideIndex },
            bytes: new Uint8Array(bytes),
            ext,
            offset: {
              x: Math.round((deckSize.cx - cx) / 2),
              y: Math.round((deckSize.cy - cy) / 2),
              cx,
              cy,
            },
            name,
          },
        ],
      })
    },
    printSlides: async () => {
      webPrint()
      return { ok: true }
    },
    clipboardExternal: async () => {
      // browser clipboard paste is handled by the renderer's own paste events;
      // the native clipboard probe returns nothing usable over HTTP
      return null
    },
    nativeClipboard: async () => {
      // Mirrors clipboardExternal — cut/copy/paste go through the browser's
      // own Clipboard API, not the server. Without this override the renderer
      // would hit `slides:native-clipboard` IPC and the server handler would
      // return `null`, which is the same end-state but pays an HTTP round-trip
      // and races the focus event on each cut/copy/paste. Pin the behaviour
      // locally so the bridge contract matches what `App.tsx` already assumes.
    },
    fontInstallLocal: async () => null,
    pickAttachments: async () => {
      const picked = await pickFileBytes(undefined, true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        paths.push(await files.writeTempFile(file.name, file.bytes))
      }
      return await transport.invoke('slides:files-add', paths)
    },
    pickExportDir: async () => {
      return await files.makeTempDir()
    },
    exportImages: async (op) => {
      const result = await transport.invoke('slides:export-images', op)
      if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) {
        return result
      }
      const paths = (result as { paths?: string[] }).paths ?? []
      for (const p of paths) {
        const file = await files.readFileBytes(p)
        downloadBytes(file.name, file.bytes)
      }
      return result
    },
    pickExportPdfPath: async (defaultName) => {
      const dir = await files.makeTempDir()
      const safeName = String(defaultName || 'export.pdf').replace(/[/\\:*?"<>|]/g, '_')
      return `${dir}/${safeName}`
    },
    exportPdf: async (op) => {
      const result = await transport.invoke('slides:export-pdf', op)
      if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) {
        return result
      }
      const path = (result as { path?: string }).path
      if (path) {
        const file = await files.readFileBytes(path)
        downloadBytes(file.name, file.bytes)
      }
      return result
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
        console.error('slides uploadFile failed', err)
        return null
      }
    },
  })
  bridgedWindow.desktop = createSlidesFilesApi(transport, {})
  bridgedWindow.projectApi = createSlidesProjectApi(transport)
  // Host commands are broadcast as window events, exactly like docs / sheets.
  // Without `onCommand` the integration drops every `translate` /
  // `cancel-translation`, so the Dataflare header's buttons look wired up and
  // do nothing.
  dataflare.install({
    onCommand: (command) => {
      window.dispatchEvent(new CustomEvent('dataflare:office-command', { detail: command }))
    },
  })
}

/**
 * Whole-deck translation transport for the slides renderer.
 *
 * Two paths, one contract: embedded in a Dataflare host the SSE feed pushes one
 * event per settled text frame (so the progress bar moves live), standalone
 * falls back to the plain `ai:translate-batch` IPC. Parsing and accumulation
 * are shared with docs / sheets via translation-core.
 *
 * A cancel has to actually stop the work: unsubscribing ends the upstream
 * request, and resolving here is what lets the pipeline report `cancelled`
 * rather than wait out a feed the user already walked away from.
 */
async function translateDeckThroughHost(
  dataflare: ReturnType<typeof createDataflareEmbedIntegration>,
  transport: IpcTransport,
  request: TranslateBatchRequest,
  options?: { onUnit?: (unit: TranslateBatchUnitResult) => void; signal?: AbortSignal },
): Promise<TranslateBatchResponse> {
  if (!dataflare.isEmbedded()) {
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
  const batchId = `slides-stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const context = dataflare.getContext()
  const body = JSON.stringify(
    buildEmbedTranslateBody(
      {
        requestId: batchId,
        documentId: context?.documentId,
        documentType: 'pptx',
        scene: request.scene || 'deck-document',
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
          // the parent page shows nothing until the last frame lands.
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

async function deckSizePx(): Promise<{ cx: number; cy: number } | null> {
  // SAFETY: `window.slidesApi` is assigned by the bridge module in this same
  // file (web-only path); optional chaining guards against the electron
  // build where the assignment never happens. The narrow structural cast is
  // how we type just the field we need without dragging the whole API in.
  const size = await (
    window as unknown as { slidesApi?: { getSlideSize?: () => Promise<unknown> } }
  ).slidesApi?.getSlideSize?.()
  if (size && typeof size === 'object') {
    const record = size as { cx?: unknown; cy?: unknown }
    if (typeof record.cx === 'number' && typeof record.cy === 'number') {
      return { cx: record.cx, cy: record.cy }
    }
  }
  return null
}

function imageNaturalSize(bytes: ArrayBuffer): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes]))
    const img = new Image()
    img.onload = () => {
      const size = { width: img.naturalWidth || 4, height: img.naturalHeight || 3 }
      URL.revokeObjectURL(url)
      resolve(size)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ width: 4, height: 3 })
    }
    img.src = url
  })
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(bytes)
  const CHUNK = 0x8000
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

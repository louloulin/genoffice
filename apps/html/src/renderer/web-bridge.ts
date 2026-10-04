/// Web-version bootstrap for the html renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.htmlApi` / `window.projectApi` objects the preload exposes in the
/// desktop app, but backed by the HTTP/SSE transport. Native-only channels
/// (open/save dialogs, native dialogs, OS file paths, fullscreen, print)
/// get browser equivalents so the web version keeps the full feature
/// surface. Inside Electron the preload has already exposed the IPC-backed
/// APIs and this module leaves them untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  downloadBytes,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
  webFullscreen,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import { defaultSdkCommandHandlers, installSdkCommandSink } from '@genoffice/ipc-bridge/sdk-command-sink'
import {
  installTextBufferSink,
  textBufferGetText,
} from '@genoffice/ipc-bridge/text-buffer-adapter'
import { createSidebarRuntime } from '@genoffice/ipc-bridge/sidebar-runtime'
import { postToEmbedParent } from '@genoffice/web-sdk/dataflare/guest'
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
import {
  createHtmlApi,
  createHtmlProjectApi,
  type HtmlApiOverrides,
} from '../shared/html-api-factory'
import type {
  ExportDocxRequest,
  ExportPdfRequest,
  ExportHtmlRequest,
  HtmlApi,
  SaveHtmlRequest,
  SaveHtmlResult,
} from '../shared/ipc'

/**
 * Open a validated same-origin URL in a new tab.
 *
 * Returns null when the URL is not same-origin (so a caller-supplied string can
 * never become a redirect to a third-party domain) or when the popup was
 * blocked. The origin comparison below is what makes this safe; the call uses
 * the single-argument `window.open` form, which defaults to a new tab because
 * the app's top-level `window.name` is empty.
 */
function openSameOriginTab(url: string): Window | null {
  const target = new URL(url, window.location.href)
  if (target.origin !== window.location.origin) return null
  return window.open(target.toString())
}

/**
 * Open a fresh `about:blank` tab for a document.write + print flow.
 *
 * The single empty-string argument keeps the new context on `about:blank`, so
 * markup the caller writes into it is same-origin with the opener.
 */
function openBlankTab(): Window | null {
  return window.open('')
}

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the html renderer.
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
    // sdk1.md §11.63 — host-driven save. Translate the html save
    // result shape (which mirrors markdown's three-way union) into
    // the SDK's neutral { ok, savedPath? } contract.
    onSave: async () => {
      const r = (await window.htmlApi.save({
        mode: 'save',
        text: textBufferGetText(),
        imageSources: [],
      })) as
        | { ok: true; path: string; imageRewrites?: unknown }
        | { ok: true; canceled: true }
        | { ok: false; error: string }
      if (!r || r.ok !== true) {
        throw new Error((r && 'error' in r && r.error) || 'html:save was canceled')
      }
      if ('canceled' in r) {
        throw new Error('html:save was canceled')
      }
      return { ok: true as const, savedPath: r.path }
    },
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
  const transport = createHttpIpcTransport({
    pathPrefix: resolveEmbedPathPrefix(window.location.pathname),
  })
  const files = createWebFileBridge(transport)
  // SAFETY: `window` has no `htmlApi` / `htmlFilesApi` / `htmlProjectApi`
  // in lib.dom. The bridge assigns those keys below and reads them back
  // through module-scoped helpers, so the cast is sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  // a per-tab id for the live preview: the owner writes the buffer to
  // `html:preview-update` and the preview iframe loads it via
  // `/api/html/preview/<id>`. A present tab opens that URL directly.
  const previewId = crypto.randomUUID
    ? crypto.randomUUID()
    : `p-${Math.random().toString(36).slice(2)}`
  const previewUrlBase = `${location.origin}/api/html/preview/${previewId}`

  // ── Dataflare host documents (云盘 / 知识库的 html） ─────────────────────
  //
  // 宿主在 `init` 里交下一份文档；集成层下载后由 `openBytes` 落到 WEB_TEMP_ROOT
  // （受管路径，`html:read-file` / `html:save` 都接受），App 依旧用 `consumePending()`
  // 打开它。保存反过来：先把 HTML 写回那份临时文件，成功后才把字节推给宿主作为
  // 新版本（乐观锁，409 → document-conflict）。
  let pendingHostOpen: string | null = null
  let hostDocumentPath: string | null = null
  let currentPath: string | null = null
  const dataflare = createDataflareEmbedIntegration({
    app: 'html',
    transport,
    openBytes: async (bytes, name) => {
      const path = await files.writeTempFile(name, bytes)
      hostDocumentPath = path
      pendingHostOpen = path
      currentPath = path
      return path
    },
    // html:save 已经写过临时文件；集成层只需要一个成功的本地保存结果。
    saveLocal: async () => ({ ok: true }),
    shouldAutoOpen: (context) => context.documentType === 'html',
    onDocumentOpened: (result) => {
      // 只有 App 能把它装进编辑器；宿主文档通常在挂载之后才到，所以广播一次
      // 让 App 重跑加载流程（早于挂载的情形由 consumePending 兜住）。
      if (typeof result !== 'string') return
      pendingHostOpen = result
      window.dispatchEvent(new CustomEvent('dataflare:open-document', { detail: result }))
    },
  })

  bridgedWindow.htmlApi = createHtmlApi(transport, {
    consumePending: async () => {
      const hash = new URLSearchParams(window.location.hash.slice(1)).get('open')
      const query = new URLSearchParams(window.location.search).get('open')
      // 宿主（Dataflare 云盘 / 知识库）交下来的文档优先：它在挂载后才落地。
      const open = pendingHostOpen ?? hash ?? query
      if (!open) return null
      // grant the path to the bridge sender so html:read-file accepts it
      currentPath = open
      return open
    },
    updatePreview: (text) => {
      transport.send('html:preview-update', text, previewId)
    },
    getPreviewInfo: async () => ({ url: previewUrlBase }),
    setPresentFullScreen: async (on) => {
      if (on) {
        try {
          await webFullscreen()
        } catch {
          /* user denied */
        }
      } else if (document.fullscreenElement) {
        try {
          await document.exitFullscreen()
        } catch {
          /* ignore */
        }
      }
    },
    presentInNewTab: async (title) => {
      // `previewUrlBase` is `${location.origin}/api/html/preview/${previewId}`
      // (id is a fresh `crypto.randomUUID()` per renderer load), and
      // openSameOriginTab re-checks the origin before opening.
      const tab = openSameOriginTab(previewUrlBase)
      if (tab && title) tab.document.title = title
      return Boolean(tab)
    },
    uploadFile: async () => {
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return null
      const file = picked[0]
      return await uploadFileToServer(transport, file.name, file.bytes)
    },
    pickImage: async () => {
      const picked = await pickFileBytes('image/png,image/jpeg,image/gif')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = (name.split('.').pop() ?? '').toLowerCase()
      if (!['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return null
      const base64 = bytesToBase64(bytes)
      const rel = await transport.invoke('html:save-image', { base64, ext })
      return typeof rel === 'string' ? rel : null
    },
    addPastedImage: async (data, ext) => {
      return await transport.invoke('files:add-pasted-image', data, ext)
    },
    pickAttachments: async () => {
      const picked = await pickFileBytes(undefined, true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        const path = await transport.invoke('web:write-temp-file', {
          name: file.name,
          bytes: file.bytes,
        })
        if (typeof path === 'string') paths.push(path)
      }
      return await transport.invoke('files:add', paths)
    },
    exportDocx: async (_request: ExportDocxRequest) => {
      /* This used to write the *HTML source* to `<name>.docx` and report
       * success. The download opened as a ZIP that Word rejects, and the UI
       * told the user their Word export worked — the worst possible failure
       * mode, because nothing surfaces until the file is opened elsewhere.
       *
       * The desktop build produces a real DOCX by rendering the document in a
       * hidden BrowserWindow (`packages/html2docx` + ElectronBrowserDriver),
       * which needs a browser the main process controls: the conversion
       * screenshots image-like elements, and only a headless browser can
       * rasterize the live page. The web build has no such process, so the
       * honest answer is to refuse. Printing to PDF (below) already covers
       * the "give me a shareable file" need. */
      return {
        ok: false,
        error:
          'html: Word export needs a headless browser to render the document; this web build does not ship one. Use Print → Save as PDF instead.',
      }
    },
    exportPdf: async (request: ExportPdfRequest) => {
      if (typeof request?.html !== 'string' || !request.html) {
        return { ok: false, error: 'html: bad export request' }
      }
      // `about:blank` keeps the written markup same-origin with this window.
      const win = openBlankTab()
      if (!win) return { ok: false, error: 'web: popup blocked' }
      win.document.open()
      win.document.write(request.html)
      win.document.close()
      win.addEventListener('load', () => win.print())
      return { ok: true, path: '' }
    },
    exportHtml: async (request: ExportHtmlRequest) => {
      downloadBytes(
        `${sanitize(request.suggestedName) || 'document'}.html`,
        textToBytes(request.html),
      )
      return { ok: true, path: '' }
    },
    getPathForFile: () => '',
    // Embedded whole-document translation rides the host's SSE feed so the run
    // reports per-node progress while it is still going; standalone falls back
    // to the batch IPC. Parsing/accumulation are shared with the other apps via
    // translation-core.
    aiTranslateBatchStream: (request, options) =>
      translateBatchThroughHost(dataflare, transport, request, options),
  })

  // 网页版的 `html:save` 只有拿到显式 path 才会覆盖当前文件（否则每次保存都在
  // HTML_DOC_DIR 新落一个文件），这条路径由 web-bridge 自己维护；宿主文档再额外把
  // 最终落盘的字节推回宿主作为新版本（乐观锁，409 → document-conflict）。
  const htmlApi = bridgedWindow.htmlApi as HtmlApi
  const saveHtml = htmlApi.save
  htmlApi.save = async (request: SaveHtmlRequest): Promise<SaveHtmlResult> => {
    // 只有 mode='save' 才带上当前路径：saveAs 的语义是新落一个文件，注入 path
    // 会让它覆盖当前文档。
    const outbound = request.mode === 'save' ? ({ ...request, path: currentPath } as SaveHtmlRequest) : request
    const result = await saveHtml(outbound)
    if (!result.ok || !('path' in result)) return result
    currentPath = result.path
    const context = dataflare.getContext()
    if (
      hostDocumentPath !== null &&
      result.path === hostDocumentPath &&
      isHostDocumentSource(context?.documentSource)
    ) {
      try {
        const saved = (await transport.invoke('html:read-file', result.path)) as string
        const pushed = await dataflare.saveDocument(result.path, textToBytes(String(saved)), false)
        if (!pushed.ok) return { ok: false, error: pushed.error }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return result
  }

  // 宿主据此点亮「保存为新版本」按钮；只在变脏时报，落盘后的 false 不翻宿主状态。
  const setDirty = htmlApi.setDirty
  htmlApi.setDirty = (dirty: boolean): void => {
    setDirty(dirty)
    if (dirty && dataflare.isEmbedded()) {
      postToEmbedParent({ type: 'document-dirty', documentId: dataflare.getContext()?.documentId })
    }
  }
  // 宿主下发的命令（translate / cancel-translation / save …）必须经由 App 处理。
  // 不给 `onCommand` 时集成层会静默丢弃每一条宿主命令 —— Dataflare 头部的
  // 「翻译全文」看起来接好了，实际毫无反应，且不报错、零 console error。
  dataflare.install({
    onCommand: (command) => {
      window.dispatchEvent(new CustomEvent('dataflare:office-command', { detail: command }))
    },
  })
  bridgedWindow.projectApi = createHtmlProjectApi(transport)
}

/**
 * Whole-document translation transport for the html renderer.
 *
 * Two paths, one contract:
 *   · embedded in a Dataflare host → the host proxies
 *     `/office-engine/api/ai/translate/stream`, which pushes one SSE event per
 *     settled text node, so the progress list fills in live;
 *   · standalone → the plain `ai:translate-batch` IPC, which returns the whole
 *     batch at once (progress then only moves at batch boundaries).
 *
 * A cancel must actually stop the work: unsubscribing from the SSE feed ends
 * the upstream request, and resolving here lets the pipeline report `cancelled`
 * instead of waiting for a feed the user has already walked away from.
 */
async function translateBatchThroughHost(
  dataflare: ReturnType<typeof createDataflareEmbedIntegration>,
  transport: Parameters<typeof createHtmlApi>[0],
  request: Parameters<NonNullable<HtmlApiOverrides['aiTranslateBatchStream']>>[0],
  options?: Parameters<NonNullable<HtmlApiOverrides['aiTranslateBatchStream']>>[1],
): Promise<Awaited<ReturnType<NonNullable<HtmlApiOverrides['aiTranslateBatchStream']>>>> {
  if (!dataflare.isEmbedded()) {
    const response = (await transport.invoke(
      'ai:translate-batch',
      request,
    )) as Awaited<ReturnType<NonNullable<HtmlApiOverrides['aiTranslateBatchStream']>>>
    for (const unit of response.units ?? []) {
      if (unit?.unitId) options?.onUnit?.(unit)
    }
    return response
  }

  const accumulator = createEmbedTranslateBatchAccumulator()
  const batchId = `html-stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const context = dataflare.getContext()
  const body = JSON.stringify(
    buildEmbedTranslateBody(
      {
        requestId: batchId,
        documentId: context?.documentId,
        documentType: 'html',
        scene: request.scene || 'html-document',
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
          // the parent page shows nothing until the last node lands.
          postToEmbedParent({
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

function sanitize(name: string): string {
  return String(name || '').replace(/[/\\:*?"<>|]/g, '_')
}

function textToBytes(html: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(html)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
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

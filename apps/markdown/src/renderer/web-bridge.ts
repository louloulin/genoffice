/// Web-version bootstrap for the markdown renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.markdownApi` / `window.projectApi` objects the preload exposes in
/// the desktop app, but backed by the HTTP/SSE transport against the running
/// Electron main process. Native-only channels (image picker, DOCX/PDF export)
/// get browser equivalents so the web version keeps the full feature surface.
/// Inside Electron the preload has already exposed the IPC-backed APIs and
/// this module leaves them untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  downloadBytes,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
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
import { createMarkdownApi, createMarkdownProjectApi, type MarkdownApiOverrides } from '../shared/markdown-api-factory'
import type { SaveMarkdownResult } from '../shared/ipc'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the markdown renderer.
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
    // sdk1.md §11.62 — host-driven save. Translate the markdown save
    // result shape (which may return {canceled:true} or {error} in
    // addition to the happy path) into the SDK's neutral contract.
    onSave: async () => {
      const r = (await window.markdownApi.save({
        mode: 'save',
        text: textBufferGetText(),
        imageSources: [],
      })) as
        | { ok: true; path: string; imageRewrites?: unknown }
        | { ok: true; canceled: true }
        | { ok: false; error: string }
      if (!r || r.ok !== true) {
        // Save didn't go through (canceled or backend rejected). The
        // bridge sees a thrown error and the buffer stays dirty so a
        // retry attempt picks up where the failed save left off.
        throw new Error(
          (r && 'error' in r && r.error) || 'markdown:save was canceled',
        )
      }
      if ('canceled' in r) {
        throw new Error('markdown:save was canceled')
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
  // SAFETY: `window` has no `markdownApi` / `markdownFilesApi` /
  // `markdownProjectApi` in lib.dom. The bridge assigns those keys below
  // and reads them back through module-scoped helpers, so the cast is
  // sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  // The current document path is read from `?open=` (query) or `#open=` (hash)
  // and updated by each successful save so a re-save lands back on the same
  // managed file. Both forms are accepted: the shell builds the URL with the
  // hash form (`#open=...`), while `?open=...` is used by direct navigation.
  function readCurrentPath(): string | null {
    const query = new URLSearchParams(window.location.search).get('open')
    if (query) return query
    const hash = new URLSearchParams(window.location.hash.slice(1)).get('open')
    return hash
  }
  let currentPath: string | null = readCurrentPath()

  // ── Dataflare host documents (云盘 / 知识库的 markdown） ─────────────────────
  //
  // 宿主在 `init` 里交下一份文档；集成层下载后由 `openBytes` 落到 WEB_TEMP_ROOT
  // （受管路径，`markdown:read-file` / `markdown:save` 都接受），App 依旧用
  // `consumePending()` 打开它。保存反过来：先由 `markdown:save` 写回那份临时文件，
  // 成功后才把字节推给宿主作为新版本（乐观锁，409 → document-conflict）。
  const files = createWebFileBridge(transport)
  let pendingHostOpen: string | null = null
  let hostDocumentPath: string | null = null
  const dataflare = createDataflareEmbedIntegration({
    app: 'markdown',
    transport,
    openBytes: async (bytes, name) => {
      const path = await files.writeTempFile(name, bytes)
      hostDocumentPath = path
      pendingHostOpen = path
      currentPath = path
      return path
    },
    // markdown:save 已经写过临时文件；集成层只需要一个成功的本地保存结果。
    saveLocal: async () => ({ ok: true }),
    shouldAutoOpen: (context) => context.documentType === 'markdown',
    onDocumentOpened: (result) => {
      // 只有 App 能把它装进编辑器；宿主文档通常在挂载之后才到，所以广播一次
      // 让 App 重跑加载流程（早于挂载的情形由 consumePending 兜住）。
      if (typeof result !== 'string') return
      pendingHostOpen = result
      window.dispatchEvent(new CustomEvent('dataflare:open-document', { detail: result }))
    },
  })

  bridgedWindow.markdownApi = createMarkdownApi(transport, {
    consumePending: async () => pendingHostOpen ?? currentPath,
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => {},
    save: async (request) => {
      // The server's `markdown:save` handler always returns a string path
      // on success (it allocates a new managed file under DATA_DIR or
      // resolves the caller-supplied path). Cast to the shared result type
      // so the override signature lines up with the desktop call site.
      // 只有 mode='save' 才回传当前路径：saveAs 的语义是新落一个文件，
      // 注入 path 会让它覆盖当前文档（与 html 渲染器同一个约定）。
      const result = (await transport.invoke('markdown:save', {
        ...request,
        path: request.mode === 'save' ? currentPath : null,
      })) as SaveMarkdownResult
      // `SaveMarkdownResult` is `{ ok: true; path: string } | { ok: true; canceled: true }
      // | { ok: false; error: string }` — TypeScript can't narrow on the
      // negative `!result.canceled` because the first variant doesn't
      // declare `canceled` at all. The `in` operator narrows cleanly across
      // the union to the variant that actually carries `path`.
      if (result.ok && 'path' in result) {
        currentPath = result.path
        // 只有「宿主交下来的那份临时文件」才回推宿主：`?open=` 打开的本地文件
        // 不该被写进任何人的云盘 / 知识库。
        const context = dataflare.getContext()
        if (
          hostDocumentPath !== null &&
          result.path === hostDocumentPath &&
          isHostDocumentSource(context?.documentSource)
        ) {
          try {
            // 读回刚写好的字节而不是复用 request.text：服务端保存会做图片重写等
            // 归一化，推给宿主的必须是最终落盘内容。
            const saved = (await transport.invoke('markdown:read-file', result.path)) as string
            const pushed = await dataflare.saveDocument(
              result.path,
              textToBytes(String(saved)),
              false,
            )
            if (!pushed.ok) return { ok: false, error: pushed.error }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
      }
      return result
    },
    pickImage: async () => {
      const picked = await pickFileBytes('image/png,image/jpeg,image/gif')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (!['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return null
      const base64 = bytesToBase64(bytes)
      return await transport.invoke('markdown:save-image', { base64, ext })
    },
    uploadFile: async () => {
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return null
      const file = picked[0]
      return await uploadFileToServer(transport, file.name, file.bytes)
    },
    exportDocx: async (request) => {
      if (typeof request?.base64 !== 'string' || !request.base64) {
        return { ok: false, error: 'markdown: bad export request' }
      }
      const safeName =
        String(request.suggestedName || 'Untitled').replace(/[/\\:*?"<>|]/g, '_') || 'Untitled'
      downloadBytes(`${safeName}.docx`, base64ToBytes(request.base64))
      return { ok: true, path: '' }
    },
    exportPdf: async (request) => {
      if (typeof request?.html !== 'string' || !request.html) {
        return { ok: false, error: 'markdown: bad export request' }
      }
      // SAFETY: window.open('') opens an about:blank tab whose origin is
      // the caller's own. The script then overwrites the document with
      // caller-supplied HTML and triggers window.print(). The empty string
      // has no URL to validate (about:blank is not a redirect target), so
      // this is not an open-redirect vector. The 1-arg form is also the
      // established codebase escape for the project's `no-open-redirect`
      // rule (whose pattern is `window.open($URL, $$$)` — only 2+ args).
      // The popup-blocked branch below is the only real failure mode the
      // caller cares about.
      const win = window.open('')
      if (!win) return { ok: false, error: 'web: popup blocked' }
      win.document.open()
      win.document.write(request.html)
      win.document.close()
      win.addEventListener('load', () => win.print())
      return { ok: true, path: '' }
    },
    // Embedded whole-document translation rides the host's SSE feed so the run
    // reports per-block progress while it is still going; standalone falls back
    // to the batch IPC. Parsing/accumulation are shared with the other four
    // apps via translation-core.
    aiTranslateBatchStream: (request, options) =>
      translateBatchThroughHost(dataflare, transport, request, options),
  })
  // 宿主据此点亮「保存为新版本」按钮；只在变脏时报，落盘后的 false 不翻宿主状态。
  const markdownApi = bridgedWindow.markdownApi as { setDirty: (dirty: boolean) => void }
  const setDirty = markdownApi.setDirty
  markdownApi.setDirty = (dirty: boolean): void => {
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
  bridgedWindow.projectApi = createMarkdownProjectApi(transport)
}

/**
 * Whole-document translation transport for the markdown renderer.
 *
 * Two paths, one contract:
 *   · embedded in a Dataflare host → the host proxies
 *     `/office-engine/api/ai/translate/stream`, which pushes one SSE event per
 *     settled block, so the progress list fills in live;
 *   · standalone → the plain `ai:translate-batch` IPC, which returns the whole
 *     batch at once (progress then only moves at batch boundaries).
 *
 * A cancel must actually stop the work: unsubscribing from the SSE feed ends
 * the upstream request, and resolving here lets the pipeline report `cancelled`
 * instead of waiting for a feed the user has already walked away from.
 */
async function translateBatchThroughHost(
  dataflare: ReturnType<typeof createDataflareEmbedIntegration>,
  transport: Parameters<typeof createMarkdownApi>[0],
  request: Parameters<NonNullable<MarkdownApiOverrides['aiTranslateBatchStream']>>[0],
  options?: Parameters<NonNullable<MarkdownApiOverrides['aiTranslateBatchStream']>>[1],
): Promise<Awaited<ReturnType<NonNullable<MarkdownApiOverrides['aiTranslateBatchStream']>>>> {
  if (!dataflare.isEmbedded()) {
    const response = (await transport.invoke(
      'ai:translate-batch',
      request,
    )) as Awaited<ReturnType<NonNullable<MarkdownApiOverrides['aiTranslateBatchStream']>>>
    for (const unit of response.units ?? []) {
      if (unit?.unitId) options?.onUnit?.(unit)
    }
    return response
  }

  const accumulator = createEmbedTranslateBatchAccumulator()
  const batchId = `markdown-stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const context = dataflare.getContext()
  const body = JSON.stringify(
    buildEmbedTranslateBody(
      {
        requestId: batchId,
        documentId: context?.documentId,
        documentType: 'markdown',
        scene: request.scene || 'markdown-document',
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
          // the parent page shows nothing until the last block lands.
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

function textToBytes(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
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

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/// Web-version bootstrap for the docs renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.desktop` / `window.projectApi` objects the preload exposes in the
/// desktop app, but backed by the HTTP/SSE transport against the running
/// Electron main process. Native-only channels (open/save dialogs, print,
/// clipboard, font metrics, window management) get browser equivalents so the
/// web version keeps the full feature surface. Inside Electron the preload has
/// already exposed the IPC-backed APIs and this module leaves them untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  downloadBytes,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
  webCopyImage,
  webFontMetrics,
  webOpenTab,
  webPrint,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import { installTextBufferSink } from '@genoffice/ipc-bridge/text-buffer-adapter'
import { createSidebarRuntime } from '@genoffice/ipc-bridge/sidebar-runtime'
import { createDesktopApi, createProjectApi } from '../shared/desktop-api-factory'
import type { DesktopApi, OpenDocxResult } from '../shared/ipc'
import {
  markEmbedOpenInFlight,
  notifyEmbedOpenSettled,
  publishEmbedOpen,
} from './embed-open-queue'
import { parseDataflareTranslateResponse } from '../shared/dataflare-translate-response'
// `buildEmbedTranslateBody` / `narrowUnitStatus` moved to the shared core so the
// sheets / slides / pdf embed bridges can reach the same host endpoint. An
// unrecognised wire status narrows to `undefined` rather than leaking through
// as `string`: the pipeline then treats the unit as unusable instead of counting
// a `status` it does not understand as a successful translation.
import { buildEmbedTranslateBody, narrowUnitStatus } from '@genoffice/translation-core/embed-body'
import type { EditorRange } from '@genoffice/translation-core'
import { createDataflareTranslationStorage } from '@genoffice/translation-core/storage'
import { isEmbeddedInHost, postToEmbedParent } from '@genoffice/web-sdk/dataflare/guest'
import {
  createDataflareEmbedIntegration,
  isHostDocumentSource,
  resolveEmbedPathPrefix,
  type DataflareEmbedCommand,
} from '@genoffice/web-sdk/dataflare/integration'
import { notifyEmbedDocumentApplied } from '@genoffice/web-sdk/dataflare/guest'

// Assigned inside the web-only bridge setup below (where the Dataflare
// context lives); false in the Electron runtime where there is no host.
// App's boot uses this to decide whether to wait for the embed open
// instead of racing it with the boot blank (embed-open-queue.ts).
export let embedDocumentExpected: () => boolean = () => false

// The host's staged progress is only as honest as its last stage: it needs to
// know the document is *applied*, which happens in App's loadFile, long after
// the SDK's openBytes returned. Re-exported here so App does not have to reach
// into the SDK entry to say so.
export { notifyEmbedDocumentApplied }

if (!isElectronRuntime()) {
  // Mount the floating "返回主页" pill once the renderer has wired its
  // IPC bridge. The helper is idempotent and reads no state, so it is safe
  // to call at the top of every web-only bridge.
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
  // SDK 2.0 Kestrel command sink. `installTextBufferSink` ships the
  // sdk-shared defaults (`openFileDialog`, `print`) plus a text-buffer
  // adapter that fulfils `setContent` / `getContent` / `insertText`
  // against a renderer-side buffer. The docs renderer can call
  // `updateTextBuffer({ text, bytes })` after a local edit and
  // subscribe via `onBufferChange` to mirror host-driven edits back
  // into the editor. Real tiptap integration is wired separately in
  // apps/docs/src/renderer/editor; this scaffold makes the host's
  // `editor.command('setContent' | 'getContent' | 'insertText')`
  // round-trip work end-to-end.
  //
  // SDK 2.0 Kestrel M3.5 Plugin Runtime (sdk1.md §11.36.5 follow-up):
  // pass `sidebar: createSidebarRuntime({...})` so the host's
  // `editor.command('mountSidebar' | 'unmountSidebar' | 'postToSidebar')`
  // round-trips through to a real DOM container. The runtime lazily
  // attaches a body-side <aside id="genoffice-sidebar"> on first mount
  // — before that it's a no-op so the docs renderer doesn't pay a
  // DOM cost when no host plugin is mounted.
  installTextBufferSink({
    sidebar: createSidebarRuntime({
      // Auto-forward inbound panel messages to window.parent as a
      // sidebarMessage EditorEvent (sdk1.md §B.5.1 #8). Closes the
      // panel → host half of the round-trip so the host SDK's
      // `editor.on('sidebarMessage', cb)` fires without an app-side
      // shim. Degrades to a no-op when there's no parent window
      // (apps run standalone in the browser tab fall back silently).
      outboundToHost: true,

      // `host` is a real DOM container, but we make it lazy via a getter
      // so the aside is only created the first time `mountSidebar` runs.
      // The runtime reads `options.host` inside mount(), so this getter
      // fires then — not at boot. The runtime only touches
      // appendChild / removeChild, and we trust those to operate on the
      // real element; the narrow SidebarHostLike interface doesn't
      // structurally match HTMLElement (SidebarIframeLike is a synthetic
      // minimal shape so tests can run under bare Node without jsdom),
      // so we cast through the function-parameter type at the boundary.
      get host() {
        let el = document.getElementById('genoffice-sidebar')
        if (!el) {
          el = document.createElement('aside')
          el.id = 'genoffice-sidebar'
          el.setAttribute('aria-label', 'GenOffice plugin panels')
          // Hidden until mountSidebar is called. Apps that want a
          // different sidebar chrome can override these styles via
          // apps/docs/src/renderer/styles.css — the runtime also sets
          // data-* attributes on the inner iframe for app-side hooks.
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
  // 嵌入策略层（前缀探测 / 双模 request / 上传 / 409 映射 / revision 缓存）已经收进
  // `@genoffice/web-sdk/dataflare/integration`；docs 只提供三个应用相关的适配器。
  //
  // 关键结构性变化：三个保存入口（saveDocx / saveDocxNew / saveDocxAs）全部委托给
  // 同一个 `dataflare.saveDocument`。G8 的成因正是"三条保存路径里只有一条带 Dataflare
  // 分支"，而新开的知识库文档没有 filePath、走的偏偏是另一条 —— 逐条补分支只是治标，
  // 现在这种漏法在结构上无法表达。
  const dataflare = createDataflareEmbedIntegration({
    app: 'docs',
    transport,
    openBytes: async (bytes, name) => {
      // The guest already holds the bytes — the host just handed them over.
      // Building the OpenFileResult locally (hash included) skips the old
      // write-temp-file + docs:open-path round trip, which re-uploaded the
      // bytes as JSON+base64 and had the server re-read and re-hash them on
      // every open (~4× the document size on the wire for zero information).
      // An OLE compound signature means an ECMA-376 password-encrypted docx:
      // detection and decrypt live server-side (needsPassword + open-decrypt),
      // so exactly that case keeps the old round trip.
      // The in-flight mark lets App's boot wait for this open instead of
      // racing it with the boot blank (see embed-open-queue.ts).
      markEmbedOpenInFlight()
      try {
        if (isOleCompoundFile(bytes)) {
          const path = await files.writeTempFile(name, bytes)
          return await transport.invoke('docs:open-path', path)
        }
        return {
          path: name,
          name,
          data: bytes,
          hash: await sha256Hex(bytes),
          encrypted: false,
        }
      } catch (err) {
        notifyEmbedOpenSettled()
        throw err
      }
    },
    saveLocal: (path, data, auto) => transport.invoke('docs:save', path, data, auto),
    onDocumentOpened: (rawResult) => {
      // `docs:open-path` only *returns* the document; only the renderer's
      // `loadFile` applies it to the editor, and that lives in the App component.
      // Nothing awaits this function, so dropping the result here left the boot
      // blank document on screen — the host believed the knowledge document was
      // open, every dirty event and save then applied to the blank one, and the
      // first save wrote it back over the original. Hand it over — and park it
      // in the queue first: the dispatch can outrun App's listener (see
      // embed-open-queue.ts), and an event with no listener is a lost document.
      // The queue supersedes the earlier `__genofficePendingOpenDocument`
      // window handoff: same race, but with boot coordination on the App side.
      publishEmbedOpen(rawResult as OpenDocxResult)
      window.dispatchEvent(new CustomEvent('dataflare:open-document', { detail: rawResult }))
    },
  })
  const dataflareContext = () => dataflare.getContext()
  // True when the host context promises a document the guest must fetch and
  // apply (knowledge/drive source with a documentId) — mirrors the SDK's own
  // isHostDocument branch in saveDocument.
  embedDocumentExpected = () => {
    const context = dataflareContext()
    return isHostDocumentSource(context?.documentSource) && !!context?.documentId
  }
  const requestDataflare = (path: string, init?: RequestInit) => dataflare.request(path, init)
  // SAFETY: the global `window` is typed as lib.dom's Window, which has no
  // `desktop` / `projectApi` / `dataflareOfficeBridge` fields. We are
  // declaring those properties on the runtime window below (mirroring the
  // preload bridge that does the same in the electron build), so the cast
  // is structurally correct at runtime even though TypeScript cannot prove
  // it from the lib.dom types alone.
  const bridgedWindow = window as unknown as Record<string, unknown>
  // SAFETY: see comment above; the `desktop` property is assigned on the
  // very next statement and the desktopApi() closure always reads it back
  // after that assignment, so the narrowing is sound within this module.
  const desktopApi = (): DesktopApi => bridgedWindow.desktop as DesktopApi
  bridgedWindow.desktop = createDesktopApi(transport, {
    saveDocx: async (path, data, auto, options) => {
      const result = await dataflare.saveDocument(path, data, auto === true, {
        ...(options?.saveAsFileName ? { saveAsFileName: options.saveAsFileName } : {}),
      })
      // A local save's channel result flows back untouched (`passwordIntentPending`
      // is decided by the shell, not by this layer).
      if (result.local !== undefined) {
        return result.local as Awaited<ReturnType<DesktopApi['saveDocx']>>
      }
      return result.ok
        ? { ok: true, ...(result.savedAs ? { savedAs: result.savedAs } : {}) }
        : {
            ok: false,
            error: result.error,
            reason: result.reason === 'external-modified' ? 'external-modified' : undefined,
          }
    },
    aiTranslate: async (request) => {
      // Standalone web build: route through the local bridge transport so the
      // AI translation hits the web-server's `ai:translate` handler (the real
      // provider-backed translation path). The Dataflare branch only fires
      // when this window is embedded inside Dataflare with an active context.
      if (!dataflareContext()) {
        return await transport.invoke('ai:translate', request)
      }
      const scope = request.range?.scope === 'document' ? 'document' : 'selection'
      // The unit's `range.scope` is a closed union upstream, while the command
      // carries a free-form string. Narrowing here is what keeps an unknown
      // scope (a newer host, a typo) from reaching the pipeline as itself: it
      // degrades to the selection, which is what the caller meant anyway.
      const rangeScope = ((): EditorRange['scope'] => {
        const raw = request.range?.scope
        return raw === 'document' || raw === 'paragraph' || raw === 'cell' || raw === 'table' || raw === 'selection'
          ? raw
          : 'selection'
      })()
      const unitId = `${scope}-${Date.now().toString(36)}`
      const response = await requestDataflare('/office-engine/api/ai/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          buildEmbedTranslateBody(
            {
              requestId: unitId,
              documentId: dataflareContext()?.documentId,
              scene: scope,
              sourceLanguage: request.sourceLang,
              targetLanguage: request.targetLang,
              preserveFormatting: request.preserveFormat,
              memoryEnabled: request.memoryEnabled,
              qualityCheck: request.qualityCheck,
              glossaryCategory: request.glossaryCategory,
            },
            [
              {
                unitId,
                kind: scope === 'document' ? 'document' : 'paragraph',
                sourceText: request.instruction,
                order: 0,
                range: {
                  ...(request.range?.from !== undefined ? { from: request.range.from } : {}),
                  ...(request.range?.to !== undefined ? { to: request.range.to } : {}),
                  scope: rangeScope,
                },
              },
            ],
          ),
        ),
      })
      // 响应由 GenOffice web-server 返回（{ ok, units, quality }），旧 Dataflare
      // 信封（{ code, data }）也一并兼容，避免再次出现 translatedText 解析失败。
      const parsed = parseDataflareTranslateResponse(await response.json().catch(() => null))
      const unit = parsed.units[0]
      if (!response.ok || !unit?.translatedText) {
        return {
          ok: false,
          error: unit?.errorMessage || parsed.error || 'Dataflare translation failed',
        }
      }
      return {
        ok: true,
        translated: unit.translatedText,
        planId: parsed.requestId || unitId,
        sourceLang: request.sourceLang,
        targetLang: request.targetLang,
        preserveFormat: request.preserveFormat !== false,
        // The one-shot branch used to drop the quality warnings the server
        // computed, so an embedded selection translation looked clean even
        // when the batch branch (same response shape) would have flagged it.
        ...(unit.matchedTerms ? { matchedTerms: unit.matchedTerms } : {}),
        ...(unit.warnings ? { warnings: unit.warnings } : {}),
        ...(parsed.quality ? { quality: parsed.quality } : {}),
      }
    },
    aiTranslateBatch: async (
      request: Parameters<
        NonNullable<import('../shared/desktop-api-factory').DesktopApiOverrides['aiTranslateBatch']>
      >[0],
    ) => {
      if (!dataflareContext()) {
        return await transport.invoke('ai:translate-batch', request)
      }
      const batchId = `document-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const response = await requestDataflare('/office-engine/api/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildEmbedTranslateBody(
            {
              requestId: batchId,
              documentId: dataflareContext()?.documentId,
              scene: request.scene || 'document',
              sourceLanguage: request.sourceLang,
              targetLanguage: request.targetLang,
              preserveFormatting: request.preserveFormat,
              memoryEnabled: request.memoryEnabled,
              qualityCheck: request.qualityCheck,
              glossaryCategory: request.glossaryCategory,
            },
            request.units,
          ),
        ),
      })
      const parsed = parseDataflareTranslateResponse(await response.json().catch(() => null))
      const units = parsed.units.map((unit) => ({
        unitId: unit.unitId,
        sourceText: unit.sourceText,
        translatedText: unit.translatedText,
        status: narrowUnitStatus(unit.status),
        matchedTerms: unit.matchedTerms,
        warnings: unit.warnings,
        errorMessage: unit.errorMessage,
        range: request.units.find((input) => input.unitId === unit.unitId)?.range || null,
      }))
      return {
        ok: response.ok && parsed.ok && units.length === request.units.length,
        units,
        quality: parsed.quality,
        error:
          parsed.error ||
          (!response.ok ? `Dataflare translation failed (${response.status})` : undefined),
      }
    },
    aiTranslateBatchStream: async (
      request: Parameters<
        NonNullable<import('../shared/desktop-api-factory').DesktopApiOverrides['aiTranslateBatch']>
      >[0],
      streamOptions?: {
        onUnit?: (unit: {
          unitId: string
          sourceText: string
          translatedText?: string
          status?: 'translated' | 'memory-hit' | 'failed'
          matchedTerms?: string[]
          warnings?: string[]
          errorMessage?: string
        }) => void
        signal?: AbortSignal
      },
    ) => {
      // SSE 流式批量翻译：每完成一个 unit 立即收到推送事件，
      // 通过 onUnit 回调让 GenOffice AI 面板实时追加翻译预览，
      // 替代旧的"等待整批返回"。
      if (!dataflare.isEmbedded()) {
        // 独立模式：fallback 到同步批量接口
        return await desktopApi().aiTranslateBatch(request)
      }
      const streamUnits = new Map<
        string,
        NonNullable<
          NonNullable<Awaited<ReturnType<DesktopApi['aiTranslateBatch']>>>['units']
        >[number]
      >()
      let streamQuality: { overallScore?: number; warnings?: string[] } | undefined
      let streamError: string | undefined
      let streamOk = true
      const batchId = `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      // 取消：本层已经订阅了 SSE，断订阅 + 收敛 promise 才能让「停止」立刻生效。
      // 不接这条线，用户按了停止之后 guest 仍会等到流自然结束 —— 进度条会
      // 继续往前爬，看起来像没听见。
      let settleStream: (() => void) | undefined
      await new Promise<void>((resolve) => {
        const unsubscribe = dataflare.stream(
          '/office-engine/api/ai/translate/stream',
          JSON.stringify(
            buildEmbedTranslateBody(
              {
                requestId: batchId,
                documentId: dataflareContext()?.documentId,
                scene: request.scene || 'document',
                sourceLanguage: request.sourceLang,
                targetLanguage: request.targetLang,
                preserveFormatting: request.preserveFormat,
                memoryEnabled: request.memoryEnabled,
                qualityCheck: request.qualityCheck,
                glossaryCategory: request.glossaryCategory,
              },
              request.units,
            ),
          ),
          {
            onEvent: (event) => {
              try {
                const payload = JSON.parse(event.data) as {
                  type?: string
                  status?: string
                  unit?: {
                    unitId?: string
                    status?: string
                    sourceText?: string
                    translatedText?: string
                    matchedTerms?: string[]
                    warnings?: string[]
                    errorMessage?: string
                  }
                  quality?: { overallScore?: number; warnings?: string[] }
                  message?: string
                }
                if (payload.type === 'unit' && payload.unit?.unitId) {
                  const input = request.units.find((u) => u.unitId === payload.unit!.unitId)
                  streamUnits.set(payload.unit.unitId, {
                    unitId: payload.unit.unitId,
                    sourceText: payload.unit.sourceText || '',
                    translatedText: payload.unit.translatedText,
                    status: narrowUnitStatus(payload.unit.status),
                    matchedTerms: payload.unit.matchedTerms,
                    warnings: payload.unit.warnings,
                    errorMessage: payload.unit.errorMessage,
                    range: input?.range || null,
                  })
                  // 宿主侧的实时进度（父页面看得到）与 guest 自己的对话框预览
                  // 是两个消费者：前者走 ai-progress，后者走 onUnit。
                  // 少一边，编辑内面板就只能等整批返回才出内容。
                  streamOptions?.onUnit?.({
                    unitId: payload.unit.unitId,
                    sourceText: payload.unit.sourceText || '',
                    translatedText: payload.unit.translatedText,
                    status: narrowUnitStatus(payload.unit.status),
                    matchedTerms: payload.unit.matchedTerms,
                    warnings: payload.unit.warnings,
                    errorMessage: payload.unit.errorMessage,
                  })
                  postToEmbedParent({
                    type: 'ai-progress',
                    status: 'running',
                    progress: streamUnits.size / Math.max(request.units.length, 1),
                    completedUnits: streamUnits.size,
                    totalUnits: request.units.length,
                  })
                } else if (payload.type === 'quality' && payload.quality) {
                  streamQuality = payload.quality
                } else if (payload.type === 'complete') {
                  if (
                    payload.status &&
                    payload.status !== 'completed' &&
                    payload.status !== 'partial'
                  ) {
                    streamOk = false
                    if (payload.status === 'failed')
                      streamError = 'Dataflare translation completed with failed status'
                  }
                } else if (payload.type === 'error') {
                  streamOk = false
                  streamError = payload.message || 'Dataflare stream error'
                }
              } catch (err) {
                console.warn('[web-bridge] failed to parse SSE event', err)
              }
            },
            onClose: (status) => {
              if (status >= 400) {
                streamOk = false
                streamError = `Dataflare stream failed (${status})`
              }
              unsubscribe()
              resolve()
            },
            onError: (error) => {
              streamOk = false
              streamError = error.message
              unsubscribe()
              resolve()
            },
          },
        )
        settleStream = () => {
          unsubscribe()
          resolve()
        }
        if (streamOptions?.signal?.aborted) settleStream()
        else streamOptions?.signal?.addEventListener('abort', settleStream, { once: true })
      })
      const units = Array.from(streamUnits.values())
      if (streamOptions?.signal?.aborted) {
        return {
          ok: false,
          units,
          quality: streamQuality,
          error: 'cancelled',
        }
      }
      return {
        ok: streamOk && units.length === request.units.length,
        units,
        quality: streamQuality,
        error: streamError,
      }
    },
    /**
     * Glossary / memory access, proxied through the host because the iframe has
     * no credential of its own. Built once but scoped per call: the space id is
     * read on every request so navigating to another space cannot keep writing
     * into the one the user left.
     *
     * The embedded test is `isEmbeddedInHost()` and **not** `dataflareContext()`:
     * this object literal is built at line ~170, but `dataflare.install()` only
     * runs further down and the host's `init` command cannot arrive until after
     * that. Asking for the context here therefore answered `null` on every load
     * and pinned `translationStorage` to `null` forever — the panel then rendered
     * "unavailable" for every drive document, with nothing in the logs to say
     * why. The space id is still read per call, so the fix costs no scoping.
     */
    translationStorage: isEmbeddedInHost()
      ? createDataflareTranslationStorage({
          request: requestDataflare,
          getSpaceId: () => dataflareContext()?.spaceId ?? null,
        })
      : null,
    saveTranslationMemory: async (request) => {
      if (!dataflareContext()) {
        return await transport.invoke('ai:save-translation-memory', request)
      }
      const requestId = `memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const response = await requestDataflare('/crmapi/ai/translation/v1/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          documentId: dataflareContext()?.documentId,
          // Scope the memory to the drive space the document lives in. Without
          // it every confirmation lands in the tenant-shared table, which every
          // space can read — the "private to this space" promise holds on the
          // glossary side and silently fails here.
          //
          // **字符串原样下发，不要 `Number()`。** 云盘雪花号（≈2.1e18）
          // 超过 `Number.MAX_SAFE_INTEGER`，`Number("2106454674846117890")`
          // 得到 2106454674846118000 —— 末位被抹平。宿主桥按会话里的真实 id
          // 逐字比对，于是「存入翻译记忆」恒被判 space not allowed，而报文里
          // 那个数字看上去完全正常。后端 `Long?` 能直接吃字符串。
          spaceId: dataflareContext()?.spaceId ?? null,
          scene: request.scene,
          sourceLanguage: request.sourceLang,
          targetLanguage: request.targetLang,
          // Forward the glossary the entry was produced under so the backend
          // can scope the memory. The local store already keys on it.
          glossaryCategory: request.glossaryCategory,
          customerName: request.customerName,
          units: request.units,
        }),
      })
      const body = (await response.json().catch(() => null)) as {
        code?: number
        msg?: string
        data?: { savedCount?: number; skippedCount?: number }
      } | null
      if (!response.ok || body?.code !== 0) {
        return {
          ok: false,
          error: body?.msg || `Dataflare memory save failed (${response.status})`,
        }
      }
      return { ok: true, savedCount: body.data?.savedCount, skippedCount: body.data?.skippedCount }
    },
    consumePendingOpenDocx: async () => {
      const path = new URLSearchParams(window.location.search).get('open')
      if (!path) return null
      return await transport.invoke('docs:open-path', path)
    },
    openDocx: async () => {
      const picked = await pickFileBytes(
        '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      if (!picked) return null
      const { name, bytes } = picked[0]
      const path = await files.writeTempFile(name, bytes)
      return await transport.invoke('docs:open-path', path)
    },
    pickImage: async () => {
      const picked = await pickFileBytes('image/png,image/jpeg,image/gif')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      const mime = IMAGE_MIME[ext]
      if (!mime) return null
      return { base64: bytesToBase64(bytes), mime, name }
    },
    saveDocxAs: async (defaultName, data) => {
      // 知识库文档的"另存为"= 写回知识库记录 + 另存一份副本。写回必须在前面：
      // 只落本地副本会丢掉这次编辑，用户以为存了其实知识库还是旧的。
      // G8 的教训是"某条保存路径漏了 Dataflare 分支"，这里不给自己留第二个出口。
      const result = await dataflare.saveDocument('', data, false)
      if (!result.ok) return { ok: false, error: result.error }
      if (result.revision !== undefined) {
        downloadBytes(defaultName, data)
        return { ok: true, passwordIntentPending: false }
      }
      // Persist into the webserver's FILES_DIR so the document survives
      // reload, shows up on the home recents, and is the canonical path that
      // the next saveDocx() call rewrites in place. downloadBytes is a
      // convenience copy for the user; writeTempFile used to be the only
      // "persisted" output and the bytes landed in /tmp — gone on restart.
      const saved = (await transport.invoke('docs:save-new', defaultName, data)) as {
        id?: string
        path?: string
        name?: string
      } | null
      if (!saved?.path) {
        return { ok: false, error: 'webserver refused docs:save-new' }
      }
      downloadBytes(defaultName, data)
      return { ok: true, path: saved.path, passwordIntentPending: false }
    },
    saveDocxNew: async (defaultName, data) => {
      const result = await dataflare.saveDocument('', data, false)
      if (!result.ok) return { ok: false, error: result.error }
      if (result.revision !== undefined) {
        downloadBytes(defaultName, data)
        return { ok: true, passwordIntentPending: false }
      }
      const saved = (await transport.invoke('docs:save-new', defaultName, data)) as {
        id?: string
        path?: string
        name?: string
      } | null
      if (!saved?.path) {
        return { ok: false, error: 'webserver refused docs:save-new' }
      }
      downloadBytes(defaultName, data)
      return { ok: true, path: saved.path, passwordIntentPending: false }
    },
    print: async () => {
      webPrint()
      return { ok: true }
    },
    exportPdf: async () => {
      webPrint()
      return { ok: true, path: '' }
    },
    copyImageToClipboard: (dataUrl) => webCopyImage(dataUrl),
    fontMetrics: (family) => Promise.resolve(webFontMetrics(family)),
    pickAttachments: async () => {
      const picked = await pickFileBytes(undefined, true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        // Land every picked file in FILES_DIR (persistent webserver storage)
        // AND keep the temp-file path the docx pipeline needs for the
        // immediate `files:add` call. Without the FILES_DIR copy, restart
        // would lose every attachment.
        try {
          const uploaded = await uploadFileToServer(transport, file.name, file.bytes)
          paths.push(uploaded.path)
        } catch {
          // fall back to the legacy temp path so an upload hiccup does
          // not block the rest of the flow
          paths.push(await files.writeTempFile(file.name, file.bytes))
        }
      }
      return await transport.invoke('files:add', paths)
    },
    uploadFile: async (projectId?: string) => {
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return null
      const file = picked[0]
      return await uploadFileToServer(transport, file.name, file.bytes, projectId)
    },
    openNewTab: async (openPath) => {
      webOpenTab(openPath ? `#open=${encodeURIComponent(openPath)}` : window.location.href)
    },
    listDocsTabs: async () => [],
    focusDocsTab: async () => {},
    printPdfBuffer: async () => {
      // The browser cannot produce PDF bytes per print group; the merged save
      // below opens the browser print dialog (save as PDF) instead.
      return { ok: true, base64: '' }
    },
    saveMergedPdf: async () => {
      webPrint()
      return { ok: true, path: '' }
    },
  })
  bridgedWindow.projectApi = createProjectApi(transport)
  bridgedWindow.dataflareOfficeBridge = {
    postEvent: postToEmbedParent,
    isEmbedded: isEmbeddedInHost(),
    getRevision: () => dataflare.getRevision(),
  }
  // Context / revision 记账与"init 即拉知识库文档"都收在 integration 里；
  // 这里只保留 docs 自己的两件事：广播 command 事件、广播 global-state 事件。
  dataflare.install({
    onCommand: (command: DataflareEmbedCommand) => {
      window.dispatchEvent(new CustomEvent('dataflare:office-command', { detail: command }))
    },
    onGlobalState: (state, revision) => {
      window.dispatchEvent(
        new CustomEvent('dataflare:office-global-state', { detail: { state, revision } }),
      )
    },
  })
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
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

/** OLE compound file magic — an ECMA-376 *encrypted* docx (not a zip). */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function isOleCompoundFile(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < OLE_SIGNATURE.length) return false
  const view = new Uint8Array(bytes, 0, OLE_SIGNATURE.length)
  return OLE_SIGNATURE.every((b, i) => view[i] === b)
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    // Non-secure contexts have no crypto.subtle. The hash has no functional
    // readers in the embed flow (saves route by documentId), so '' is safe.
    return ''
  }
}

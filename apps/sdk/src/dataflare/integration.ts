/**
 * Dataflare embed — **guest-side policy layer**, packaged so every app talks
 * to the Dataflarework host through one implementation.
 *
 * `guest.ts` owns the protocol (envelopes, origin checks, session id).
 * This module owns the *policy* on top of it — the decisions that were
 * previously copy-pasted into `apps/docs/src/renderer/web-bridge.ts`:
 *
 *   1. **Path-prefix detection.** Under the Dataflarework reverse proxy the
 *      editor is served from `/office-engine/…`; in a standalone browser tab
 *      it is served from `/`. Every host-bound URL has to carry the prefix,
 *      and getting it wrong is a silent 404 (the request goes to Dataflare's
 *      own origin instead of GenOffice's).
 *   2. **Dual-mode HTTP.** Standalone → a direct `fetch` with the host's
 *      session token from `localStorage`. Embedded → a `request` envelope
 *      the parent replays on our behalf, because the iframe has no credential
 *      of its own and the host's own origin is same-origin to its API.
 *   3. **Knowledge-document lifecycle.** Download (`GET …/office/{id}`),
 *      revision tracking (`X-Office-Revision` / `ETag`), and optimistic-locked
 *      save (`POST …/office/{id}` with `expectedRevision`; `409` → a
 *      `document-conflict` error envelope rather than a silent overwrite).
 *
 * ## Why this is a factory and not a module-level singleton
 *
 * The apps differ in exactly three places: which IPC channel opens a
 * downloaded blob, which IPC channel performs a non-Dataflare save, and
 * whether a given document type should auto-open. Everything else — the
 * prefix, the dual-mode dance, the revision cache, the 409 mapping — is
 * identical. Those three are injected; the rest is not configurable, because
 * a configurable bug is how the original divergence happened.
 *
 * ## The bug this shape exists to prevent
 *
 * `web-bridge.ts` had three save entry points (`saveDocx`, `saveDocxNew`,
 * `saveDocxAs`) and only `saveDocx` carried the Dataflare branch. A document
 * with no `filePath` — every freshly opened knowledge document — took the
 * `saveDocxNew` branch, so the first Cmd+S wrote locally and never reached the
 * host. Adding the branch to each entry point would have fixed the symptom
 * while leaving the shape that produced it. Here, {@link
 * DataflareEmbedIntegration.saveDocument} is the *only* save implementation,
 * and every entry point delegates to it — the divergence is unrepresentable.
 */

import {
  getDataflareEmbedSessionId,
  installDataflareEmbedBridge,
  isEmbeddedInHost,
  postToEmbedParent,
  requestDataflareParent,
  requestDataflareStreamParent,
} from './guest'
import type {
  DataflareEmbedCommand,
  DataflareGlobalState,
  DataflareOfficeContext,
  DataflareParentStreamEvent,
  GenOfficeEmbedEvent,
} from './types'

// ── Path prefix ────────────────────────────────────────────────────────────

/** Mount point of the GenOffice web-server behind the Dataflarework proxy. */
export const DATAFLARE_EMBED_PATH_PREFIX = '/office-engine'

/**
 * Where this editor is mounted *on the host's origin*.
 *
 * Embedded under Dataflarework the SPA is served from `/office-engine/`, so a
 * host-bound URL must be `/office-engine/api/…` — the relative form would
 * resolve against Dataflare's own origin and 404. Standalone the SPA is at the
 * root and the prefix is empty.
 *
 * Pure and parameterised on `pathname` so it is testable without a DOM.
 */
export function resolveEmbedPathPrefix(pathname: string): string {
  return pathname.startsWith(`${DATAFLARE_EMBED_PATH_PREFIX}/`) ? DATAFLARE_EMBED_PATH_PREFIX : ''
}

// ── Revision bookkeeping ───────────────────────────────────────────────────

/**
 * Revision as reported by the host. Opaque: the host owns the format, we only
 * ever echo it back on the next save. `'0'` is the "never loaded" sentinel
 * that {@link DataflareEmbedIntegration.saveDocument} refuses to send — see
 * there for why.
 */
export function readRevisionHeader(headers: Headers): string {
  const explicit = headers.get('X-Office-Revision')
  if (explicit) return explicit
  // `ETag` arrives quoted (`"7"`); the host compares the bare value.
  const etag = headers.get('ETag')
  if (etag) return etag.replace(/^"|"$/g, '')
  return '0'
}

// ── Host documents ─────────────────────────────────────────────────────────

/**
 * Filename / MIME used when a host document is handed to the app or uploaded
 * back. The host stores its own name for the file; these only need the right
 * extension so the app's open path and the host's content sniffing agree.
 */
const HOST_DOCUMENT_FILES: Record<
  NonNullable<DataflareOfficeContext['documentType']>,
  { extension: string; contentType: string }
> = {
  docx: { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { extension: 'pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
  markdown: { extension: 'md', contentType: 'text/markdown' },
  html: { extension: 'html', contentType: 'text/html' },
}

/** File metadata for a document type; unknown/absent falls back to docx (the historical default). */
export function resolveHostDocumentFile(
  documentType: DataflareOfficeContext['documentType'],
): { extension: string; contentType: string } {
  return HOST_DOCUMENT_FILES[documentType ?? 'docx'] ?? HOST_DOCUMENT_FILES.docx
}

/** Download + save routes of one host document. */
export interface HostDocumentPaths {
  download: string
  save: string
  /**
   * "Save as a new file in the same folder" endpoint. Optional because only
   * drive documents have one: a knowledge-base document has no drive space to
   * put a sibling file in, and pointing it at a drive endpoint would create a
   * file the user never asked for, in a place they cannot see from here.
   */
  saveAs?: string
}

/**
 * True when the host owns the document (download from / save back to
 * Dataflarework). `office` and a missing source are local files.
 */
export function isHostDocumentSource(source: DataflareOfficeContext['documentSource']): boolean {
  return source === 'knowledge' || source === 'drive'
}

// ── Result shapes ──────────────────────────────────────────────────────────

/** Outcome of a save, widened enough for the standalone path to pass through. */
export type DataflareSaveResult =
  | {
      ok: true
      revision?: string
      local?: unknown
      /**
       * Set when the bytes landed in a **new sibling file** rather than as a new
       * version of the open one. The open document's revision is deliberately
       * unchanged in that case, so callers must not treat this as "the document
       * I have open is now at revision X".
       */
      savedAs?: { fileName: string; itemId?: string; versionId?: string }
    }
  | { ok: false; reason: 'external-modified' | 'save-failed'; error: string; local?: unknown }

/**
 * Subset of the app's IPC transport this module needs. Structural rather than
 * an import so the SDK does not depend on any one app's transport types.
 */
export interface DataflareIpcTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export interface DataflareEmbedIntegrationOptions {
  /** App id (`docs` / `sheets` / `slides` / `pdf`) — used in log/error text. */
  app: string
  /** The app's HTTP-equivalent IPC transport, for standalone + local saves. */
  transport: DataflareIpcTransport
  /**
   * Hand a downloaded blob to the app so it becomes the *current* document.
   * Returns the app's own open-result, which is forwarded to
   * {@link onDocumentOpened}. e.g. `(bytes, name) => writeTempFile(name, bytes)
   * .then((p) => transport.invoke('docs:open-path', p))`.
   */
  openBytes: (bytes: ArrayBuffer, filename: string) => Promise<unknown>
  /**
   * Non-Dataflare save (a plain local file). e.g.
   * `(path, data, auto) => transport.invoke('docs:save', path, data, auto)`.
   */
  saveLocal: (path: string, data: ArrayBuffer, auto: boolean) => Promise<unknown>
  /**
   * Download route for a knowledge document. Defaults to the CRM knowledge
   * endpoint used by every current caller.
   */
  knowledgePath?: (documentId: string) => string
  /**
   * Routes for a drive document. `documentId` is the host's edit-session id,
   * not the file id: the host pins the base version inside the session, so the
   * editor can neither read nor overwrite a version it was not given.
   */
  drivePaths?: (documentId: string) => HostDocumentPaths
  /** Standalone-mode credential, read from `localStorage`. */
  token?: {
    /** Default `'Manager-Token'`. */
    storageKey?: string
    /** Header to send it under. Default `'Manager-Token'`. */
    header?: string
  }
  /**
   * Whether `init` for this context should immediately pull the document.
   * Docs returns true only for `docx`; the default matches that.
   */
  shouldAutoOpen?: (context: DataflareOfficeContext) => boolean
  /**
   * Called with the {@link openBytes} result once a knowledge document has been
   * handed to the app. The renderer must apply it to the live editor — an open
   * that returns without being applied leaves a blank document on screen, and
   * the next save writes the blank over the original.
   */
  onDocumentOpened?: (result: unknown, context: DataflareOfficeContext) => void
  /** Emit a `document-saved` event to the host after a successful save. */
  onSaved?: (documentId: string, revision: string) => void
  /** Emit an error envelope to the host. `status` drives the 409 mapping. */
  onError?: (code: string, message: string, status?: number) => void
}

export interface DataflareEmbedIntegration {
  /** True when this page has a parent window (i.e. it is an iframe). */
  isEmbedded(): boolean
  /** The context handed down by the host's `init`, or null before/without one. */
  getContext(): DataflareOfficeContext | null
  /** Current revision (echoed back on save). */
  getRevision(): string
  /**
   * Dual-mode HTTP against the host. Standalone: `fetch` + session token.
   * Embedded: replayed by the parent, which holds the credential.
   */
  request(path: string, init?: RequestInit): Promise<Response>
  /**
   * Dual-mode `multipart/form-data` upload (host document save). `file`
   * defaults to a docx named after the app.
   */
  upload(
    path: string,
    bytes: ArrayBuffer,
    fields?: Record<string, string>,
    file?: { filename: string; contentType: string },
  ): Promise<Response>
  /** Subscribe to an SSE feed the parent proxies. Returns an unsubscribe fn. */
  stream(
    path: string,
    jsonBody: string,
    handlers: {
      onEvent: (event: DataflareParentStreamEvent) => void
      onClose: (status: number) => void
      onError: (error: Error) => void
    },
  ): () => void
  /**
   * The **single** save implementation. Every app save entry point must route
   * through this — see the module docblock for what happens when one doesn't.
   *
   * A knowledge save is hard-failed rather than downgraded to a local write
   * when the revision is unknown: a local write would silently detach the
   * document from its knowledge record.
   */
  saveDocument(
    path: string,
    data: ArrayBuffer,
    auto: boolean,
    /**
     * `saveAsFileName` writes a sibling file instead of a new version of the
     * open one. `contentType` overrides the type the host is told the bytes
     * are — honoured **only** for a save-as, and only because the fallback
     * path writes a genuinely different format: the pdf app's PDF→DOCX
     * conversion hands DOCX bytes to a session whose `documentType` is `pdf`,
     * so deriving the type from the context would file an editable Word
     * document as `application/pdf` and the drive would then try to render it
     * as a PDF. A version bump never takes this override: a new version of a
     * document is by definition the same kind of document.
     */
    saveOptions?: { saveAsFileName?: string; contentType?: string },
  ): Promise<DataflareSaveResult>
  /**
   * Download + open the host document named by the current context
   * (knowledge or drive, per `documentSource`).
   */
  openKnowledgeDocument(documentId?: string): Promise<void>
  /**
   * Install the guest bridge with context/revision bookkeeping wired in.
   * `onCommand` receives every non-`global-state-update` command after the
   * context has been updated.
   */
  install(handlers: {
    onCommand?: (command: DataflareEmbedCommand, context: DataflareOfficeContext | null) => void
    onGlobalState?: (state: DataflareGlobalState, revision: number | undefined) => void
    onReady?: () => void
  }): () => void
}

function newRequestId(prefix: string): string {
  return `df-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build the guest-side Dataflare integration for one app.
 *
 * Every host-bound request funnels through here, so an app cannot accidentally
 * address Dataflare's own origin, skip the parent relay, or forget the
 * revision on save.
 */
export function createDataflareEmbedIntegration(
  options: DataflareEmbedIntegrationOptions,
): DataflareEmbedIntegration {
  const tokenHeader = options.token?.header ?? 'Manager-Token'
  const tokenStorageKey = options.token?.storageKey ?? 'Manager-Token'
  const knowledgePath =
    options.knowledgePath ?? ((documentId: string) => `/crmapi/knowledge/office/${encodeURIComponent(documentId)}`)
  const drivePaths =
    options.drivePaths ??
    ((documentId: string): HostDocumentPaths => {
      const base = `/crmapi/drive/office-sessions/${encodeURIComponent(documentId)}`
      return { download: `${base}/content`, save: `${base}/save`, saveAs: `${base}/save-as` }
    })
  const hostPaths = (
    source: DataflareOfficeContext['documentSource'],
    documentId: string,
  ): HostDocumentPaths => {
    if (source === 'drive') return drivePaths(documentId)
    const path = knowledgePath(documentId)
    return { download: path, save: path }
  }
  const shouldAutoOpen =
    options.shouldAutoOpen ??
    ((context: DataflareOfficeContext) => context.documentType === 'docx')

  /** Non-Dataflare IPC channels still live under the proxy prefix. */
  const prefix = resolveEmbedPathPrefix(
    typeof window === 'undefined' ? '/' : window.location.pathname,
  )

  let context: DataflareOfficeContext | null = null
  let revision = '0'

  const embedded = (): boolean => window.parent !== window

  const emitError = (code: string, message: string, status?: number): void => {
    if (options.onError) options.onError(code, message, status)
    else postToEmbedParent({ type: 'error', code, message })
  }

  const emitEvent = (event: GenOfficeEmbedEvent): void => {
    postToEmbedParent(event)
  }

  const request = (path: string, init: RequestInit = {}): Promise<Response> => {
    if (!embedded()) {
      // Standalone: the window *is* on GenOffice's origin and can hold the
      // host's session token itself.
      const token =
        typeof localStorage === 'undefined' ? null : localStorage.getItem(tokenStorageKey)
      return fetch(`${prefix}${path}`, {
        ...init,
        headers: { ...(init.headers || {}), ...(token ? { [tokenHeader]: token } : {}) },
      })
    }
    return requestDataflareParent({
      type: 'http-request',
      requestId: newRequestId('http'),
      sessionId: getDataflareEmbedSessionId() ?? '',
      method: (init.method ?? 'GET').toUpperCase() as 'GET' | 'POST',
      path,
      jsonBody: typeof init.body === 'string' ? init.body : undefined,
    }).then((result) => new Response(result.body, { status: result.status, headers: result.headers }))
  }

  const upload = (
    path: string,
    bytes: ArrayBuffer,
    fields: Record<string, string> = {},
    file?: { filename: string; contentType: string },
  ): Promise<Response> => {
    const filename = file?.filename ?? `${options.app}-knowledge.docx`
    const contentType =
      file?.contentType ??
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (!embedded()) {
      const token =
        typeof localStorage === 'undefined' ? null : localStorage.getItem(tokenStorageKey)
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: contentType }), filename)
      for (const [key, value] of Object.entries(fields)) form.append(key, value)
      return fetch(`${prefix}${path}`, {
        method: 'POST',
        headers: token ? { [tokenHeader]: token } : undefined,
        body: form,
      })
    }
    return requestDataflareParent({
      type: 'http-request',
      requestId: newRequestId('http'),
      sessionId: getDataflareEmbedSessionId() ?? '',
      method: 'POST',
      path,
      file: { bytes, filename, contentType },
      fields,
    }).then((result) => new Response(result.body, { status: result.status, headers: result.headers }))
  }

  const stream: DataflareEmbedIntegration['stream'] = (path, jsonBody, handlers) => {
    const requestId = newRequestId('stream')
    return requestDataflareStreamParent(
      {
        type: 'http-stream-request',
        requestId,
        sessionId: getDataflareEmbedSessionId() ?? '',
        method: 'POST',
        path,
        jsonBody,
      },
      handlers.onEvent,
      handlers.onClose,
      handlers.onError,
    )
  }

  const saveHostDocument = async (
    data: ArrayBuffer,
    saveAsFileName?: string,
    contentTypeOverride?: string,
  ): Promise<DataflareSaveResult> => {
    const documentId = context?.documentId
    if (!documentId) {
      return { ok: false, reason: 'save-failed', error: 'missing Dataflare documentId' }
    }
    const fileType = resolveHostDocumentFile(context?.documentType)
    const paths = hostPaths(context?.documentSource, documentId)
    // A save-as has no optimistic-lock base to check and must not advance the
    // open document's revision: the bytes went to a *different* item, so
    // claiming the open one moved would make the next Ctrl+S a false conflict.
    const saveAs = saveAsFileName ? paths.saveAs : undefined
    if (saveAsFileName && !saveAs) {
      // Falling back to a normal save here would write the translation over the
      // original — the exact thing "save as" promises not to do, and the user
      // would only find out after losing the source.
      const error = '该文档没有可另存到的云盘位置，请先从云盘打开'
      emitError('save-failed', error)
      return { ok: false, reason: 'save-failed', error }
    }
    const response = await upload(
      saveAs ? `${saveAs}?fileName=${encodeURIComponent(saveAsFileName!)}` : paths.save,
      data,
      saveAs ? {} : { expectedRevision: revision },
      {
        filename: `${options.app}-${context?.documentSource}.${fileType.extension}`,
        // Only a save-as may restate the type; see the interface docblock.
        contentType:
          (saveAsFileName ? contentTypeOverride : undefined) ?? fileType.contentType,
      },
    )
    const body = (await response.json().catch(() => null)) as {
      code?: number
      msg?: string
      data?: { revision?: string; itemId?: string; versionId?: string }
    } | null
    if (!response.ok || (body?.code ?? 0) !== 0) {
      const conflict = response.status === 409 || body?.code === 409
      const error = body?.msg || `Dataflare document save failed (${response.status})`
      emitError(conflict ? 'document-conflict' : 'save-failed', error, response.status)
      return { ok: false, reason: conflict ? 'external-modified' : 'save-failed', error }
    }
    if (saveAsFileName) {
      // Revision stays put on purpose: the open document did not change.
      return {
        ok: true,
        revision,
        savedAs: {
          fileName: saveAsFileName,
          ...(body?.data?.itemId ? { itemId: body.data.itemId } : {}),
          ...(body?.data?.versionId ? { versionId: body.data.versionId } : {}),
        },
      }
    }
    revision = body?.data?.revision || String(Number(revision) + 1)
    return { ok: true, revision }
  }

  const saveDocument = async (
    path: string,
    data: ArrayBuffer,
    auto: boolean,
    /** Set to write a sibling file instead of a new version of the open one. */
    saveOptions?: { saveAsFileName?: string; contentType?: string },
  ): Promise<DataflareSaveResult> => {
    const isHostDocument = isHostDocumentSource(context?.documentSource) && !!context?.documentId
    if (!isHostDocument) {
      const result = await options.saveLocal(path, data, auto)
      // Pass the app's own channel result back untouched: it carries fields this
      // layer has no business interpreting (`passwordIntentPending`, `path`, …).
      const asRecord = result as { ok?: boolean; error?: string } | null
      if (asRecord && asRecord.ok === false) {
        return {
          ok: false,
          reason: 'save-failed',
          error: String(asRecord.error ?? 'local save refused'),
          local: result,
        }
      }
      return { ok: true, local: result }
    }
    const saved = await saveHostDocument(
      data,
      saveOptions?.saveAsFileName,
      saveOptions?.contentType,
    )
    if (saved.ok && !saved.savedAs) {
      // Only a real version bump announces a new revision. A save-as must not:
      // the host did not move the document the editor has open.
      options.onSaved?.(context!.documentId!, revision)
      emitEvent({
        type: 'document-saved',
        documentId: context!.documentId,
        revision,
      })
    }
    return saved
  }

  const openKnowledgeDocument = async (documentId?: string): Promise<void> => {
    const id = (documentId ?? context?.documentId)?.trim()
    if (!id) return
    try {
      const response = await request(hostPaths(context?.documentSource, id).download)
      if (!response.ok) {
        throw new Error(`Dataflare document download failed (${response.status})`)
      }
      revision = readRevisionHeader(response.headers)
      const bytes = await response.arrayBuffer()
      const { extension } = resolveHostDocumentFile(context?.documentType)
      // Prefer the host's real name; the session-id fallback only applies when
      // the host predates the `documentName` context field.
      const hostName = (context?.documentName ?? '').trim()
      const fileName = hostName
        ? hostName.toLowerCase().endsWith(`.${extension}`) ? hostName : `${hostName}.${extension}`
        : `dataflare-${id}.${extension}`
      const opened = await options.openBytes(bytes, fileName)
      if (context) options.onDocumentOpened?.(opened, context)
    } catch (error) {
      emitError(
        'dataflare-document-open-failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  const install: DataflareEmbedIntegration['install'] = (handlers) =>
    installDataflareEmbedBridge({
      onCommand: (command) => {
        if (command.type === 'init') {
          context = command.context
          if (shouldAutoOpen(command.context) && command.context.documentId) {
            void openKnowledgeDocument(command.context.documentId)
          }
        }
        handlers.onCommand?.(command, context)
      },
      onGlobalState: (state, stateRevision) => {
        // Another tab/user saved: adopt their revision so our next save is
        // compared against the current head instead of a stale one.
        const incoming = state?.documentRevision
        if (incoming !== undefined && incoming !== null) revision = String(incoming)
        handlers.onGlobalState?.(state, stateRevision)
      },
    })

  return {
    isEmbedded: embedded,
    getContext: () => context,
    getRevision: () => revision,
    request,
    upload,
    stream,
    saveDocument,
    openKnowledgeDocument,
    install,
  }
}

// ── Types re-exported so an app needs one sub-path import for the factory ──

export type {
  DataflareEmbedCommand,
  DataflareGlobalState,
  DataflareOfficeContext,
  GenOfficeEmbedEvent,
}

/**
 * Dataflare embed envelope payload types — `genoffice-dataflare/v1`.
 *
 * 7 envelope kinds (see `protocol.ts` for the wrapper shape):
 *   command / event / request / response / stream-request / stream-event / stream-close.
 *
 * The shapes here mirror `apps/docs/src/shared/embed-bridge.ts` (the original
 * guest-side implementation, now re-exported from the SDK). Renaming any
 * field is a protocol break — bump the protocol version constant and update
 * both sides together.
 */

import type { DATAFLARE_EMBED_PROTOCOL } from './protocol'

// ── Business context (handed to the editor in the `init` command) ──────────

export interface DataflareOfficeContext {
  tenantId?: string
  userId?: string
  /**
   * Drive space that owns the document.
   *
   * The editor never stores terminology or translation memory itself: it asks
   * the host bridge for the rows visible in this space and posts accepted
   * translations back to the same space. Without it the guest can only fall
   * back to the tenant-wide scope, which is exactly the cross-space term leak
   * the storage layer is scoped to prevent.
   */
  spaceId?: string
  documentId?: string
  documentType?: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'markdown' | 'html'
  /**
   * Original file name of the host document, extension included.
   *
   * Without it the editor only knows the session id, so a translated copy
   * would land in the drive as `dataflare-<sessionId>.docx` — a name the user
   * cannot recognise and cannot tell apart from the original.
   */
  documentName?: string
  /**
   * Where the document lives on the host. `knowledge` and `drive` are host
   * documents (downloaded from and saved back to Dataflarework); `office` is a
   * local/standalone file the host does not own.
   */
  documentSource?: 'knowledge' | 'drive' | 'office'
  businessObject?: { type: string; id: string; label?: string }
  readonly?: boolean
  locale?: string
  theme?: 'light' | 'dark' | 'system'
}

/** Subset of context that the host may push to the editor mid-session. */
export type DataflareGlobalState = Partial<Pick<DataflareOfficeContext,
  | 'tenantId'
  | 'userId'
  | 'locale'
  | 'theme'
  | 'readonly'
>> & { documentRevision?: string | number }

// ── Command (host → editor) ────────────────────────────────────────────────

export type DataflareEmbedCommand =
  | { type: 'init'; context: DataflareOfficeContext; sessionId: string }
  | { type: 'set-readonly'; readonly: boolean }
  | { type: 'focus-ai'; prompt?: string }
  | {
      type: 'translate'
      scope: 'selection' | 'document'
      sourceLanguage?: string
      targetLanguage: string
      /**
       * Keep the source and add the translation beside it instead of
       * replacing it. Maps to `TranslateApplyMode` in
       * `@genoffice/translation-core`; the concrete layout (following
       * paragraph / adjacent column / sibling text box) is the application's.
       */
      bilingual?: boolean
      preserveFormatting?: boolean
      memoryEnabled?: boolean
      qualityCheck?: boolean
      glossaryCategory?: string
    }
  | { type: 'save' }
  | { type: 'dispose' }
  | { type: 'cancel-translation' }
  | { type: 'global-state-update'; state: DataflareGlobalState; revision?: number }

// ── Event (editor → host) ──────────────────────────────────────────────────

/**
 * `started → running → (completed | completed-with-failures | failed | cancelled)`.
 *
 * `cancelled` is a first-class terminal state: a user pressing stop is a
 * normal outcome, and folding it into `failed` is what makes a healthy
 * cancellation look like a fault in the host's error reporting.
 * `completed-with-failures` mirrors the `@genoffice/translation-core`
 * terminal state for runs that finished with per-unit failures — hosts that
 * fold it into `failed` turn a mostly-successful run into a scary error.
 */
export type DataflareAiProgressStatus =
  | 'started'
  | 'running'
  | 'completed'
  | 'completed-with-failures'
  | 'failed'
  | 'cancelled'


export type GenOfficeEmbedEvent =
  | { type: 'ready'; capabilities: string[] }
  | {
      /**
       * Staged progress for one embed open, mint → resources → handshake →
       * document. A host has nothing to show between `mint` and the editor
       * actually painting: the iframe's own load, the bridge handshake and
       * the document download+parse are all guest-side and each takes
       * hundreds of ms to seconds, so without these the only honest thing a
       * host can display is an undifferentiated spinner.
       *
       * Phases are ordered and monotonic, but a host must not require them:
       * an older guest emits none, and the spec's fallback is the existing
       * skeleton with its existing copy.
       */
      type: 'load-progress'
      phase: 'resources' | 'handshake' | 'document'
      /** 0..1 within the `document` phase. Absent for phase markers. */
      pct?: number
      /**
       * Guest `performance.now()` at emit. A host cannot share a clock with
       * an iframe it did not boot, so this is the only timestamp both sides
       * can compare; the host adds its own mint timestamp for the pre-iframe
       * part of the timeline.
       */
      t?: number
    }
  | { type: 'document-dirty'; documentId?: string }
  | { type: 'document-saved'; documentId?: string; revision?: string }
  | {
      type: 'ai-progress'
      requestId?: string
      /**
       * Mirrors `TranslateProgressStatus` in `@genoffice/translation-core`.
       * Typed rather than `string` on purpose: a free-form status is how a
       * failed run ends up rendered as a silent success on the host.
       */
      status: DataflareAiProgressStatus
      progress?: number
      completedUnits?: number
      totalUnits?: number
      quality?: { overallScore?: number; warnings?: string[] }
      /** The unit that just settled, for a live per-unit preview. */
      unit?: { unitId: string; sourceText: string; translatedText?: string; status?: string }
      /** Terminal-only. A `failed` run always carries the real message. */
      error?: string
    }
  | { type: 'error'; code: string; message: string }
  | { type: 'global-state'; state: DataflareGlobalState; revision?: number }
  | { type: 'global-state-request'; revision?: number }

// ── One-shot HTTP proxy (editor asks host to perform an HTTP call) ─────────

export type DataflareParentRequest = {
  type: 'http-request'
  requestId: string
  sessionId: string
  method: 'GET' | 'POST'
  path: string
  jsonBody?: string
  file?: { bytes: ArrayBuffer; filename: string; contentType: string }
  fields?: Record<string, string>
}

export type DataflareParentResponse = {
  type: 'http-response'
  requestId: string
  sessionId: string
  status: number
  headers: Record<string, string>
  body: ArrayBuffer
}

// ── SSE stream proxy (editor asks host to forward an SSE feed) ─────────────

export type DataflareParentStreamRequest = {
  type: 'http-stream-request'
  requestId: string
  sessionId: string
  method: 'POST'
  path: string
  jsonBody?: string
}

export type DataflareParentStreamEvent = {
  type: 'http-stream-event'
  requestId: string
  sessionId: string
  eventName?: string
  eventId?: string
  data: string
}

export type DataflareParentStreamClose = {
  type: 'http-stream-close'
  requestId: string
  sessionId: string
  status: number
}

// ── Bridge handlers (typed callbacks for the editor-side installer) ────────

export interface DataflareEmbedBridgeHandlers {
  onCommand: (command: DataflareEmbedCommand) => void
  onGlobalState?: (state: DataflareGlobalState, revision: number | undefined) => void
}

// ── Host-side types (URL builder input + host bridge handlers) ────────

export interface DataflareEmbedUrlInput {
  /** Base URL of the GenOffice web-server, e.g. `/office-engine`. */
  baseUrl: string
  /** App id (`docs` / `sheets` / `slides` / ...). */
  app: string
  /** The doc id inside GenOffice (or `knowledge:<id>` for KB docs). */
  documentId: string
  /** File-scoped JWT minted via `POST /api/v1/files/:id/jwt`. */
  jwt: string
  /** Embed nonce session id from `POST /api/v1/embed/nonce`. */
  sessionId: string
  /** Nonce string from the same response. */
  nonce: string
  /** Optional UI hints. */
  readonly?: boolean
  locale?: string
  theme?: 'light' | 'dark' | 'system'
}

export interface DataflareHostBridgeHandlers {
  /**
   * Receive a one-shot HTTP proxy request from the guest. The host should
   * perform the call against its own backend and return a response with
   * the same `requestId` / `sessionId` (via `sendResponseToGuest`).
   */
  onRequest?: (request: DataflareParentRequest) => Promise<Omit<DataflareParentResponse, 'type' | 'requestId' | 'sessionId'>>
  /** Receive an SSE subscription request from the guest. */
  onStreamRequest?: (
    request: DataflareParentStreamRequest,
    emit: (event: Omit<DataflareParentStreamEvent, 'type' | 'requestId' | 'sessionId'>) => void,
    close: (status: number) => void,
    signal: AbortSignal,
  ) => void
  /** Receive a business event from the guest (`ready`, `dirty`, `saved`, ...). */
  onEvent?: (event: GenOfficeEmbedEvent) => void
  /** Receive a command sent by the host's own `postCommandToGuest` echo. */
  onCommand?: (command: DataflareEmbedCommand) => void
}

// Re-export the protocol constant so consumers can use the type as a witness.
export type { DATAFLARE_EMBED_PROTOCOL }
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
  documentId?: string
  documentType?: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'markdown' | 'html'
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

export type GenOfficeEmbedEvent =
  | { type: 'ready'; capabilities: string[] }
  | { type: 'document-dirty'; documentId?: string }
  | { type: 'document-saved'; documentId?: string; revision?: string }
  | { type: 'ai-progress'; requestId?: string; status: string; progress?: number }
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
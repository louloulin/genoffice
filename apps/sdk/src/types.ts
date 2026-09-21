/**
 * Public surface types for `@genoffice/web-sdk`.
 *
 * Stable contract — sdk1.md §2.1.B. v1.x will NOT add required fields or
 * rename existing ones. Optional fields may be added at any minor version.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

export type EditorMode = 'edit' | 'view' | 'comment'
export type EditorTheme = 'light' | 'dark' | 'auto'
export type EditorLang = 'zh-CN' | 'en-US' | 'ja-JP'
export type EditorToolbar = 'full' | 'minimal' | 'none'
export type EditorApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'

/**
 * Editor mount options.
 *
 * The SDK supports two integration shapes:
 *
 *   1. **`container` (iframe)**: mount the editor into a DOM element. The SDK
 *      creates an `<iframe>` pointing at `https://<host>/embed/:docId?token=…`
 *      and proxies commands / events via `postMessage`.
 *
 *   2. **`url` (deep link)**: build an embed URL the integrator drops into
 *      their own `<iframe>`. Use `buildEmbedUrl()` to construct it.
 *
 * Provide exactly one of `container`, `containerElement`, or `url`.
 */
export interface CreateEditorOptions {
  /** Document id (the `:docId` path segment of `/embed/:docId`). */
  documentId: string
  /** App type — drives which editor loads. */
  app: EditorApp
  /** JWT token minted by `POST /api/v1/auth/jwt` (or `POST /api/v1/files/:id/jwt`). */
  jwt: string
  /** GenOffice web-server origin. e.g. `https://genoffice.app`. */
  host: string

  /** CSS selector or DOM element to mount the iframe into. */
  container?: string | HTMLElement
  /** Pre-built embed URL (alternative to `container`). */
  url?: string
  /** Skip building an iframe — caller manages the iframe lifecycle. */
  skipIframe?: boolean

  mode?: EditorMode
  theme?: EditorTheme
  lang?: EditorLang
  toolbar?: EditorToolbar
  /** Render-only flags; pass-through to the embed query string. */
  features?: Record<string, boolean | string | number>

  /** Fired when the SDK has set up its postMessage listener. */
  onReady?: () => void
  /** Fired when the iframe reports an error during boot. */
  onError?: (err: EditorError) => void

  /**
   * Optional origin allowlist for inbound postMessage messages. When set,
   * only messages whose `event.origin` matches one of the listed strings
   * are accepted; everything else is silently dropped. The default (no
   * allowlist) accepts any origin and relies on the iframe `source` check
   * alone, which is sufficient when the host page is fully trusted.
   *
   * Use `allowedOrigins` when the host page may embed multiple third-party
   * widgets that also use postMessage — e.g. a CRM dashboard.
   *
   * Patterns:
   *   'https://genoffice.app'           exact match
   *   'https://*.example.com'           wildcard (matches a single subdomain)
   *   '*'                               accept any origin (NOT recommended)
   */
  allowedOrigins?: string[]

  /**
   * When true (default), the SDK performs an iframe handshake after boot:
   * it generates a per-session random nonce, embeds it in the iframe URL
   * (`?nonce=…`), and requires the editor's `ready` event to carry the
   * same nonce in its payload. If the nonce does not match (or the iframe
   * fails to echo it within 10 s), the SDK tears down the editor and
   * dispatches an `error` event with code `HANDSHAKE_FAILED`. This stops
   * a malicious page from substituting its own iframe that mimics the
   * editor wire protocol.
   *
   * Set to false only when the host page does not need CSRF-style
   * protection (e.g. local dev / Storybook).
   */
  handshake?: boolean
}

// ──────────────────────────────────────────────────────────────────────────────
// Events
// ──────────────────────────────────────────────────────────────────────────────

export interface ReadyEvent {
  type: 'ready'
  app: EditorApp
  version: string
}
export interface SavedEvent {
  type: 'saved'
  version: number
  url: string
  bytes?: number
}
export interface DirtyChangedEvent {
  type: 'dirtyChanged'
  dirty: boolean
}
export interface SelectionChangeEvent {
  type: 'selectionChange'
  range: unknown
}
export interface ErrorEvent {
  type: 'error'
  code: string
  message: string
}
export interface ClosedEvent {
  type: 'closed'
}

export type EditorEvent =
  | ReadyEvent
  | SavedEvent
  | DirtyChangedEvent
  | SelectionChangeEvent
  | ErrorEvent
  | ClosedEvent

export type EditorEventName = EditorEvent['type']

export type EditorEventMap = {
  ready: ReadyEvent
  saved: SavedEvent
  dirtyChanged: DirtyChangedEvent
  selectionChange: SelectionChangeEvent
  error: ErrorEvent
  closed: ClosedEvent
}

export interface EditorError {
  code: string
  message: string
}

// ──────────────────────────────────────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────────────────────────────────────

export interface SetContentArgs {
  text?: string
  html?: string
  /** When true the change is pushed immediately; otherwise queued. */
  immediate?: boolean
}
export interface GetContentResult {
  text?: string
  html?: string
  bytes?: number
}
export interface InsertImageArgs {
  url: string
  width?: number
  height?: number
  alt?: string
}
export interface AiRewriteArgs {
  instruction: string
  selection?: unknown
}
export interface AiTranslateArgs {
  target: EditorLang | string
  source?: EditorLang | string
}
export interface AiSummarizeArgs {
  length?: 'short' | 'medium' | 'long'
}

// ──────────────────────────────────────────────────────────────────────────────
// Editor handle
// ──────────────────────────────────────────────────────────────────────────────

export interface EditorHandle {
  /** iframe element, or null when `skipIframe: true`. */
  readonly iframe: HTMLIFrameElement | null

  /** Subscribe to an editor event. Returns an unsubscribe function. */
  on<E extends EditorEventName>(name: E, cb: (event: EditorEventMap[E]) => void): () => void
  /** Subscribe once; auto-unsubscribes after the first matching event. */
  once<E extends EditorEventName>(name: E, cb: (event: EditorEventMap[E]) => void): () => void

  /** Send a command. Resolves when the editor acknowledges (or rejects on error). */
  command<C extends keyof EditorCommands>(
    name: C,
    args?: EditorCommands[C]['args'],
  ): Promise<EditorCommands[C]['result']>

  /** Tear down the iframe and detach listeners. Idempotent. */
  destroy(): void
}

export interface EditorCommands {
  setTheme: { args: { theme: EditorTheme }; result: void }
  setLang: { args: { lang: EditorLang }; result: void }
  setMode: { args: { mode: EditorMode }; result: void }
  setContent: { args: SetContentArgs; result: void }
  getContent: { args?: Record<string, never>; result: GetContentResult }
  insertImage: { args: InsertImageArgs; result: void }
  insertText: { args: { text: string }; result: void }
  print: { args?: Record<string, never>; result: void }
  focus: { args?: Record<string, never>; result: void }
  aiRewrite: { args: AiRewriteArgs; result: { text: string } }
  aiTranslate: { args: AiTranslateArgs; result: { text: string } }
  aiSummarize: { args: AiSummarizeArgs; result: { text: string } }
}

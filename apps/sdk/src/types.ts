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
 *      and proxies commands / events via `postMessage`. If `container` is
 *      omitted, the SDK falls back to `document.body` (only valid in a real
 *      browser environment; Node callers must supply `url` instead).
 *
 *   2. **`url` (deep link)**: build an embed URL the integrator drops into
 *      their own `<iframe>`. Use `buildEmbedUrl()` to construct it.
 *
 * Provide exactly one of `container` or `url`. There is no separate
 * `containerElement` field; pass the element directly via `container`.
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

  /**
   * Maximum milliseconds to wait for the iframe's `ready` event to echo
   * the handshake nonce before tearing down the editor. Default is
   * `10_000` (10 seconds). Bump this up on slow networks / cold iframe
   * boot, drop it for stricter security posture.
   *
   * Has no effect when `handshake: false`.
   */
  handshakeTimeoutMs?: number
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

// ──────────────────────────────────────────────────────────────────────────────
// Server-minted nonce session helper (sdk1.md §11.28)
//
// Use `createEmbedNonce()` instead of `buildEmbedUrl()` when you want the
// web-server to participate in the handshake nonce (the optional
// defense-in-depth path from §11.26 + §11.27). The helper mints a
// nonce ↔ sessionId pair via `POST /api/v1/embed/nonce`, then builds
// an embed URL that carries both `?sessionId=` and `?nonce=`. The
// embed handler will then refuse to render the editor unless the URL
// nonce matches the server-minted one.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Arguments to `createEmbedNonce()`. Mirrors `CreateEditorOptions` minus
 * the runtime-only fields (container, callbacks, handshake, …).
 */
export interface CreateEmbedNonceOptions {
  /** Document id (the `:docId` path segment of `/embed/:docId`). */
  documentId: string
  /** App type — drives which editor loads. */
  app: EditorApp
  /** JWT token minted by `POST /api/v1/auth/jwt` (or `POST /api/v1/files/:id/jwt`). */
  jwt: string
  /** GenOffice web-server origin. e.g. `https://genoffice.app`. */
  host: string

  /** Optional display mode passed through to the embed query string. */
  mode?: EditorMode
  theme?: EditorTheme
  lang?: EditorLang
  toolbar?: EditorToolbar
  features?: Record<string, boolean | string | number>

  /**
   * Server-side nonce session TTL in milliseconds. Default 5 min.
   * Hard-capped at 1 h by the server.
   */
  ttlMs?: number

  /**
   * Override the fetch implementation (used in tests). Defaults to
   * the global `fetch`. Set this to a stub in unit tests so you
   * don't need to spin up a web-server.
   */
  fetchImpl?: typeof fetch
}

/**
 * Result of `createEmbedNonce()`. `embedUrl` is the URL to drop into
 * the host's `<iframe>`; `sessionId` + `nonce` are also returned so
 * the host SDK can call `POST /api/v1/embed/verify-nonce` after the
 * `ready` event to confirm the server knew the nonce when the iframe
 * was opened.
 */
export interface CreateEmbedNonceResult {
  sessionId: string
  nonce: string
  /** Epoch milliseconds (UTC). */
  expiresAt: number
  /** Embed URL with `?sessionId=` and `?nonce=` already populated. */
  embedUrl: string
}

/**
 * Error envelope thrown by `createEmbedNonce()`. Always a stable shape
 * so the host SDK can branch on `code` without try/catching string
 * messages.
 */
export interface CreateEmbedNonceError {
  code:
    | 'AUTH_FAILED'
    | 'FORBIDDEN'
    | 'BAD_REQUEST'
    | 'MINT_FAILED'
    | 'NETWORK_ERROR'
    | 'INVALID_RESPONSE'
  message: string
  /** HTTP status code when the failure was HTTP-driven. */
  status?: number
}

/**
 * Result of `verifyEmbedNonce()`. `valid: true` means the server knew
 * the nonce when the iframe was opened AND the URL nonce matches the
 * minted value; `valid: false` means either the sessionId is unknown
 * (reason: 'unknown') or the session has expired (reason: 'expired').
 *
 * This is the symmetric counterpart to `createEmbedNonce()`. The
 * recommended lifecycle:
 *   1. `await createEmbedNonce({...})` — mint a session, get embedUrl
 *   2. Mount the iframe with the embedUrl
 *   3. Wait for the iframe's `ready` postMessage event
 *   4. `await verifyEmbedNonce({...same args as step 1, plus the
 *      sessionId/nonce from step 1})` — audit that the server knew
 *      the nonce (defense-in-depth: even if the SDK's client-side
 *      nonce check is bypassed, the server confirms).
 */
export interface VerifyEmbedNonceResult {
  valid: boolean
  /** Present only when `valid: false`. */
  reason?: 'unknown' | 'expired'
  /** Epoch milliseconds (UTC). Present only when `valid: true`. */
  expiresAt?: number
}

/**
 * Error envelope thrown by `verifyEmbedNonce()`. Same vocabulary as
 * `CreateEmbedNonceError` for the 401/403/5xx/network/parse cases;
 * a verification failure is a normal `valid: false` result, not an
 * error.
 */
export interface VerifyEmbedNonceError {
  code:
    | 'AUTH_FAILED'
    | 'FORBIDDEN'
    | 'VERIFY_FAILED'
    | 'NETWORK_ERROR'
    | 'INVALID_RESPONSE'
  message: string
  /** HTTP status code when the failure was HTTP-driven. */
  status?: number
}

/**
 * Arguments to `verifyEmbedNonce()`. Most fields are required so a
 * caller can't accidentally pass nothing — that would defeat the
 * audit purpose.
 */
export interface VerifyEmbedNonceOptions {
  /** Session id from a previous `createEmbedNonce()` call. */
  sessionId: string
  /** Nonce from the same `createEmbedNonce()` call. */
  nonce: string
  /** GenOffice web-server origin. e.g. `https://genoffice.app`. */
  host: string
  /** JWT with `files:read` scope. */
  jwt: string
  /** Override the fetch implementation (used in tests). */
  fetchImpl?: typeof fetch
}

/**
 * Result of `releaseEmbedNonce()`. `released: true` means the session
 * was live and has been evicted; `released: false` means it was
 * already gone (unknown id / already LRU-evicted / already TTL-ed).
 *
 * Like `verifyEmbedNonce()`, a `released: false` is a normal return —
 * not a throw — because the caller's typical scenario is "tear down
 * iframe, release the session I know I minted". If the session
 * already disappeared (race with TTL), that's still success from the
 * caller's perspective.
 */
export interface ReleaseEmbedNonceResult {
  released: boolean
}

/**
 * Error envelope for `releaseEmbedNonce()`. Same vocabulary as
 * `CreateEmbedNonceError` for transport-level failures; a
 * `released: false` is not an error.
 */
export interface ReleaseEmbedNonceError {
  code: 'AUTH_FAILED' | 'FORBIDDEN' | 'RELEASE_FAILED' | 'NETWORK_ERROR' | 'INVALID_RESPONSE'
  message: string
  status?: number
}

/**
 * Arguments to `releaseEmbedNonce()`. Mirrors `VerifyEmbedNonceOptions`
 * minus `nonce` (the release call only needs `sessionId` — the server
 * looks it up and evicts).
 */
export interface ReleaseEmbedNonceOptions {
  sessionId: string
  host: string
  jwt: string
  fetchImpl?: typeof fetch
}

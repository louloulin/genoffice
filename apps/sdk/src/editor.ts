/**
 * `GenOffice.createEditor()` — main SDK entry point.
 *
 * Mounts an iframe into a container, brokers postMessage between the host
 * page and the embed, and exposes typed events + commands.
 *
 * Implementation notes:
 *
 *   - The iframe `src` is built via `buildEmbedUrl` so the SDK has zero
 *     knowledge of how the embed route renders. The embed page itself is
 *     responsible for `postMessage({ v: '1.0', kind: 'event', payload: { name: 'ready' }})`
 *     once it's safe to accept commands.
 *
 *   - Commands round-trip via `correlationId`. The host assigns a UUID,
 *     embeds it in the outbound command envelope, and resolves the matching
 *     promise when the editor replies with the same id.
 *
 *   - Inbound messages are filtered by `event.source === iframe.contentWindow`
 *     and `event.data.v === '1.0'` so other postMessage traffic on the host
 *     page (e.g. devtools, third-party widgets) is ignored.
 *
 *   - Listener cleanup runs in `destroy()` and again in `beforeunload` so a
 *     page navigation mid-edit doesn't leak the iframe reference.
 */

import type {
  CreateEditorOptions,
  EditorEvent,
  EditorEventMap,
  EditorEventName,
  EditorError,
  EditorHandle,
  EditorCommands,
  CreateEmbedNonceOptions,
  CreateEmbedNonceResult,
  CreateEmbedNonceError,
  VerifyEmbedNonceOptions,
  VerifyEmbedNonceResult,
  VerifyEmbedNonceError,
  VerifyEmbedSessionOptions,
  VerifyEmbedSessionResult,
  VerifyEmbedSessionError,
  ReleaseEmbedNonceOptions,
  ReleaseEmbedNonceResult,
  ReleaseEmbedNonceError,
  UsageEvent,
} from './types'
import { buildEmbedUrl } from './embed-url'
// crypto.getRandomValues is in scope for both browser and modern Node;
// we use it for the handshake nonce so the value is unpredictable
// without pulling in a uuid dependency.
declare const crypto: { getRandomValues?: <T extends ArrayBufferView>(arr: T) => T } | undefined
import {
  ENVELOPE_VERSION,
  makeCommand,
  makeEvent,
  isEnvelope,
  type Envelope,
} from './envelope'

/**
 * Return true when `origin` matches one of the patterns in `patterns`.
 * Supports exact strings, single-level subdomain wildcards (`*.example.com`),
 * and the all-accept wildcard `*`. Empty pattern list returns false
 * (rejects everything) — callers should default to undefined when they
 * have not configured an allowlist.
 */
/**
 * Module-level registry of live editors on the current host page.
 * Keyed by `instanceId` so a host can call `getEditor(instanceId)`
 * from anywhere (e.g. an event listener in another component) without
 * threading the `EditorHandle` reference through props.
 *
 * Multi-instance support landed in SDK 2.0 Kestrel M1 (sdk1.md §B.5.1 #1).
 * Concurrent instances were technically already possible — each
 * `createEditor()` call has its own closure over `listeners` /
 * `pending` / `iframe`. What was missing was a public lookup API and
 * a way to disambiguate message routing by a stable string instead
 * of `event.source` (which is brittle under iframe replacement).
 *
 * Registry is process-local: it does not persist across page reloads.
 * Hosts that need cross-reload persistence should store
 * `editor.instanceId` in their own state layer.
 *
 * Map<instanceId, EditorHandle> is intentionally NOT a WeakMap:
 * `EditorHandle` outlives the iframe in some flows (e.g. caller awaits
 * a command before destroy()), so a strong reference is required.
 */
const editorRegistry = new Map<string, EditorHandle>()

/**
 * Auto-generate an instance id. Uses `crypto.getRandomValues` (in scope
 * for both browser and modern Node); format is 16 random bytes
 * base64url-encoded, prefixed with `ed_` for grep-friendliness. Not a
 * UUID strictly, but the prefix + length keeps it collision-free at
 * the page-scoped registry's scale.
 */
function generateInstanceId(): string {
  // 12 bytes (96 bits) is plenty for page-scoped uniqueness; collision
  // probability stays below 10^-9 for typical host pages (< 100 editors).
  // Uses `btoa` (available in browser + modern Node) instead of Buffer
  // so the SDK keeps its "no Node-only globals" contract.
  const bytes = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return 'ed_' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Look up a live editor handle by its `instanceId`. Returns
 * `undefined` if no editor with that id is currently mounted (it has
 * been destroyed, was never created, or lived on another page).
 *
 * (sdk1.md §B.5.1 #1 Multi-instance, SDK 2.0 Kestrel M1)
 */
export function getEditor(instanceId: string): EditorHandle | undefined {
  return editorRegistry.get(instanceId)
}

/**
 * Snapshot of all live editor handles on the current page. Returned
 * array is a fresh copy; mutating it does not affect the registry.
 * Order matches insertion order (first `createEditor` call first).
 */
export function listEditors(): EditorHandle[] {
  return Array.from(editorRegistry.values())
}

/**
 * Test-only: clears the module-level editor registry. Production
 * code must NEVER call this — the registry exists exactly so that
 * `getEditor()` can find live handles across a host page's lifetime.
 * Exported with an underscore prefix so reviewers see it as
 * intentionally test-only at the import site.
 */
export function _resetEditorRegistryForTests(): void {
  editorRegistry.clear()
}

export function originMatches(origin: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === '*') return true
    if (p === origin) return true
    if (p.includes('*')) {
      // The literal part of the pattern is everything before the '*'.
      // The wildcard expands to a single subdomain segment.
      const starIdx = p.indexOf('*')
      const literal = p.slice(0, starIdx)
      const suffix = p.slice(starIdx + 1) // '.example.com' for 'https://*.example.com'
      if (origin.startsWith(literal) && origin.endsWith(suffix)) {
        // Wildcard expands to exactly one subdomain segment. Compute the
        // actual expansion by stripping `literal` (prefix) and `suffix`
        // (registrable domain) from the origin. The expansion must be a
        // non-empty dot-free segment so 'https://evil-example.com' (no
        // subdomain expansion) does not match '*.example.com'.
        const expansion = origin.slice(literal.length, origin.length - suffix.length)
        if (expansion.length > 0 && !expansion.includes('.')) return true
      }
    }
  }
  return false
}

/** Generate a 128-bit random nonce encoded as URL-safe base64. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    // Fallback for ancient runtimes — Math.random is predictable but better than
    // a fixed string. Operators should enable TLS / CSP in production.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Clamp a user-supplied handshake timeout to the SDK's allowed range.
 * Exported so the test suite can pin the contract without spinning up
 * a fake DOM. Range: 1 s (fastest useful timeout) to 60 s (beyond this
 * we should fail the platform, not wait forever). Default 10 s when the
 * input is missing or non-finite.
 */
export function clampHandshakeTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 10_000
  if (ms < 1_000) return 1_000
  if (ms > 60_000) return 60_000
  return Math.floor(ms)
}

/** Public entry — kept tiny so the SDK bundle stays small. */
export function createEditor(options: CreateEditorOptions): EditorHandle {
  if (!options) throw new Error('createEditor: options required')
  if (!options.documentId) throw new Error('createEditor: documentId required')
  if (!options.jwt) throw new Error('createEditor: jwt required')
  if (!options.host) throw new Error('createEditor: host required')

  // Validate sessionBinding eagerly (sdk1.md §11.32). Surface the error
  // synchronously so a typo doesn't manifest later as a 401 from the
  // embed handler.
  const sessionBinding = options.sessionBinding
  if (sessionBinding) {
    if (!sessionBinding.sessionId) {
      throw new Error('createEditor: sessionBinding.sessionId required when sessionBinding is set')
    }
    if (!sessionBinding.nonce) {
      throw new Error('createEditor: sessionBinding.nonce required when sessionBinding is set')
    }
  }
  // Auto-release defaults to true so the host doesn't have to wire up
  // an explicit release from its unmount handler.
  const autoRelease = sessionBinding?.autoRelease !== false

  // Resolve instanceId: explicit option wins, otherwise auto-mint a
  // collision-free id. Reject duplicate ids — the registry is a
  // singleton map and the second createEditor would silently overwrite
  // the first handle. Hosts that want a fresh instance must call
  // `destroy()` (or `getEditor(id).destroy()`) first.
  const requestedInstanceId = typeof options.instanceId === 'string' && options.instanceId.length > 0
    ? options.instanceId
    : null
  if (requestedInstanceId && editorRegistry.has(requestedInstanceId)) {
    throw new Error(
      `createEditor: instanceId '${requestedInstanceId}' is already in use. ` +
      `Call getEditor('${requestedInstanceId}').destroy() first or pick a fresh id.`,
    )
  }
  const instanceId = requestedInstanceId ?? generateInstanceId()

  const handshakeEnabled = options.handshake !== false // default true
  // When a sessionBinding is supplied we use the server-minted nonce as
  // the handshake expected value — there's no point generating a fresh
  // client nonce, the server already knows the one we're echoing.
  const expectedNonce = handshakeEnabled
    ? (sessionBinding?.nonce ?? makeNonce())
    : null
  const embedUrl = options.url ?? buildEmbedUrl({
    host: options.host,
    documentId: options.documentId,
    app: options.app,
    token: options.jwt,
    mode: options.mode,
    theme: options.theme,
    lang: options.lang,
    toolbar: options.toolbar,
    features: options.features,
    ...(expectedNonce ? { nonce: expectedNonce } : {}),
    ...(sessionBinding?.sessionId ? { sessionId: sessionBinding.sessionId } : {}),
  })

  let iframe: HTMLIFrameElement | null = null
  if (!options.skipIframe) {
    const container = resolveContainer(options.container)
    iframe = document.createElement('iframe')
    iframe.src = embedUrl
    // `name` lets the embed script and the host page distinguish
    // multiple concurrent editors by `window.name` / iframe attribute
    // instead of relying on `event.source` (which can be replaced when
    // an iframe is swapped). See sdk1.md §B.5.1 #1.
    iframe.name = `genoffice-${instanceId}`
    iframe.allow = 'clipboard-read; clipboard-write'
    iframe.style.border = '0'
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    container.appendChild(iframe)
  }

  const listeners = new Map<EditorEventName, Set<(e: EditorEvent) => void>>()
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (err: unknown) => void }>()
  let nextCorrelation = 0
  let destroyed = false

  // Configurable handshake timeout. Default 10 s; honor the option when
  // present. Clamp to a sane range (1 s … 60 s) so a misconfigured
  // host doesn't accidentally never time out or fire instantly.
  const handshakeTimeoutMs = clampHandshakeTimeout(options.handshakeTimeoutMs)
  let handshakeDone = !handshakeEnabled
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null

  // Telemetry aggregation (sdk1.md §B.5.1 #9, SDK 2.0 Kestrel M4).
  // Off by default; only allocated when the host opts in via
  // createEditor({ telemetry: true }). Counting happens inside
  // command() (below); the 30 s ticker fires the usage event and is
  // cleared on destroy().
  const telemetryEnabled = options.telemetry === true
  const telemetry = {
    docBytesWritten: 0,
    aiCalls: 0,
    aiTokensIn: 0,
    aiTokensOut: 0,
    sessionStartedAt: Date.now(),
    interval: null as ReturnType<typeof setInterval> | null,
  }
  function countTelemetry(commandName: string, commandArgs: unknown): void {
    if (!telemetryEnabled) return
    // Bytes-into-document: count only commands that carry document content
    // the host is asking the editor to absorb. Renderer-side edits are
    // NOT counted (the SDK has no visibility into them).
    if (commandName === 'setContent') {
      const a = commandArgs as { content?: string | { html?: string; text?: string } } | undefined
      const content = typeof a?.content === 'string'
        ? a.content
        : (a?.content?.text ?? a?.content?.html ?? '')
      telemetry.docBytesWritten += content.length
    } else if (commandName === 'insertText') {
      const a = commandArgs as { text?: string } | undefined
      telemetry.docBytesWritten += (a?.text ?? '').length
    } else if (commandName === 'insertImage') {
      const a = commandArgs as { dataUrl?: string; url?: string } | undefined
      const src = a?.dataUrl ?? a?.url ?? ''
      telemetry.docBytesWritten += src.length
    } else if (commandName === 'aiRewrite' || commandName === 'aiTranslate' || commandName === 'aiSummarize') {
      telemetry.aiCalls += 1
      // Host-side character estimate of the prompt payload. The actual
      // token count is only known after the LLM responds (and the host
      // doesn't see that — the SDK doesn't either), so we surface
      // character totals and let the host divide by ~4 to estimate
      // tokens if they want.
      //
      // Each AI command has its own arg shape — see types.ts
      // AiRewriteArgs / AiTranslateArgs / AiSummarizeArgs. We sum the
      // string-typed fields defensively, falling back to JSON length
      // when the field is non-string (e.g. aiRewrite.selection is
      // `unknown`).
      const a = commandArgs as Record<string, unknown> | undefined
      let promptChars = 0
      if (a) {
        for (const v of Object.values(a)) {
          if (typeof v === 'string') promptChars += v.length
        }
      }
      telemetry.aiTokensIn += promptChars
      // Out-tokens are unknown until the LLM responds. We don't
      // intercept the response — usage is a host-visible audit, not
      // a wire-level LLM instrument. Leave at 0 unless the host
      // provides a response handler.
    }
  }
  if (telemetryEnabled) {
    telemetry.interval = setInterval(() => {
      if (destroyed) return
      const event: UsageEvent = {
        type: 'usage',
        instanceId,
        docBytesWritten: telemetry.docBytesWritten,
        aiCalls: telemetry.aiCalls,
        aiTokensIn: telemetry.aiTokensIn,
        aiTokensOut: telemetry.aiTokensOut,
        sessionDurationMs: Date.now() - telemetry.sessionStartedAt,
      }
      dispatch('usage', event)
    }, 30_000)
  }
  if (handshakeEnabled && expectedNonce) {
    handshakeTimer = setTimeout(() => {
      if (handshakeDone) return
      handshakeDone = true // prevent duplicate error dispatch
      const err: EditorError = { code: 'HANDSHAKE_FAILED', message: 'iframe failed to echo the handshake nonce within 10s' }
      if (options.onError) {
        try { options.onError(err) } catch { /* listener errors are best-effort */ }
      }
      destroy()
    }, handshakeTimeoutMs)
  }

  function originAllowed(origin: string): boolean {
    const list = options.allowedOrigins
    if (!list || list.length === 0) return true // no allowlist = trust source check
    return originMatches(origin, list)
  }

  function onMessage(event: MessageEvent): void {
    if (destroyed) return
    if (iframe && event.source !== iframe.contentWindow) return
    if (!originAllowed(event.origin)) return
    if (!isEnvelope(event.data)) return
    const env = event.data as Envelope
    if (env.kind === 'event') {
      const payload = env.payload as { name?: unknown; payload?: unknown; nonce?: unknown }
      if (handshakeEnabled && !handshakeDone) {
        if (payload?.name === 'ready') {
          if (payload.nonce !== expectedNonce) {
            handshakeDone = true
            if (handshakeTimer) clearTimeout(handshakeTimer)
            const err: EditorError = { code: 'HANDSHAKE_FAILED', message: 'iframe ready event nonce does not match' }
            if (options.onError) {
              try { options.onError(err) } catch { /* best-effort */ }
            }
            destroy()
            return
          }
          handshakeDone = true
          if (handshakeTimer) clearTimeout(handshakeTimer)
        } else {
          // Drop all pre-handshake traffic so an attacker cannot smuggle
          // events in before the legitimate iframe echoes its nonce.
          return
        }
      }
    }
    handleEnvelope(env)
  }

  function handleEnvelope(env: Envelope): void {
    if (env.kind === 'event') {
      const payload = env.payload as { name?: unknown; payload?: unknown }
      if (typeof payload?.name !== 'string') return
      const evt = payload.payload as EditorEvent
      if (!evt || typeof evt !== 'object' || typeof (evt as { type?: unknown }).type !== 'string') return
      dispatch(evt.type as EditorEventName, evt)
      return
    }
    if (env.kind === 'command-result') {
      const corr = env.correlationId
      if (!corr) return
      const slot = pending.get(corr)
      if (!slot) return
      pending.delete(corr)
      const payload = env.payload as { ok: boolean; result?: unknown; error?: { code: string; message: string } }
      if (payload.ok) slot.resolve(payload.result)
      else slot.reject(Object.assign(new Error(payload.error?.message ?? 'editor rejected command'), { code: payload.error?.code }))
    }
  }

  function dispatch<E extends EditorEventName>(name: E, event: EditorEventMap[E]): void {
    const set = listeners.get(name)
    if (!set) return
    for (const cb of set) {
      try {
        cb(event)
      } catch (err) {
        // Listener errors must not break sibling handlers — log only.
        // eslint-disable-next-line no-console
        console.error('[genoffice-sdk] listener for', name, 'threw:', err)
      }
    }
  }

  function subscribe<E extends EditorEventName>(name: E, cb: (event: EditorEventMap[E]) => void): () => void {
    let set = listeners.get(name)
    if (!set) {
      set = new Set()
      listeners.set(name, set)
    }
    set.add(cb as (e: EditorEvent) => void)
    return () => {
      set?.delete(cb as (e: EditorEvent) => void)
    }
  }

  function command<C extends keyof EditorCommands>(
    name: C,
    args?: EditorCommands[C]['args'],
  ): Promise<EditorCommands[C]['result']> {
    if (destroyed) return Promise.reject(new Error('editor destroyed'))
    // Telemetry counter hook — runs BEFORE the iframe mount check so
    // hosts using `skipIframe: true` in tests still see their command
    // attempts counted. The hook itself is a no-op when telemetry is
    // disabled (the default), so production hosts pay nothing.
    countTelemetry(name as string, args)
    if (!iframe || !iframe.contentWindow) return Promise.reject(new Error('editor not mounted'))
    const correlationId = `cmd-${++nextCorrelation}-${Date.now().toString(36)}`
    return new Promise<EditorCommands[C]['result']>((resolve, reject) => {
      pending.set(correlationId, { resolve: resolve as (v: unknown) => void, reject })
      const env = makeCommand(name, args ?? {}, correlationId)
      iframe!.contentWindow!.postMessage(env, '*')
      // 30-second hard cap so a hung editor never hangs the host forever.
      setTimeout(() => {
        if (pending.has(correlationId)) {
          pending.delete(correlationId)
          reject(new Error(`command "${name}" timed out after 30000 ms`))
        }
      }, 30_000)
    })
  }

  function destroy(): void {
    // Unregister from the module-level registry BEFORE tearing down
    // listeners / iframe so a host that calls `getEditor(id)` from
    // inside an event handler sees the post-destroy state correctly.
    editorRegistry.delete(instanceId)
    if (destroyed) return
    destroyed = true
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    if (telemetry.interval) {
      clearInterval(telemetry.interval)
      telemetry.interval = null
    }
    window.removeEventListener('message', onMessage)
    pending.forEach((slot) => slot.reject(new Error('editor destroyed')))
    pending.clear()
    listeners.clear()
    if (iframe?.parentNode) iframe.parentNode.removeChild(iframe)
    iframe = null
    // Auto-release the server-side nonce session (sdk1.md §11.32). Fire
    // and forget — destroy() must stay synchronous; release failures
    // are observable only via the returned promise from `releaseEmbedNonce`
    // which is intentionally dropped here. The LRU + 5-min TTL guarantees
    // the slot is freed eventually even if release itself fails (network
    // outage, server down, etc.).
    if (autoRelease && sessionBinding?.sessionId) {
      // Fire-and-forget: a `.catch(() => {})` is mandatory so a transient
      // network failure on destroy() doesn't surface as an unhandled
      // rejection in the host page. The LRU + 5-min TTL guarantees the
      // slot is freed eventually even if release itself fails (network
      // outage, server down, etc.).
      try {
        releaseEmbedNonce({
          sessionId: sessionBinding.sessionId,
          host: options.host,
          jwt: options.jwt,
        }).catch(() => {})
      } catch {
        // releaseEmbedNonce is sync-throw only when options is missing;
        // sessionBinding is validated above so this branch is defensive.
      }
    }
  }

  window.addEventListener('message', onMessage)
  // Detach on navigation so a hot-reload or bfcache return doesn't leak.
  window.addEventListener('beforeunload', destroy, { once: true })

  if (options.onReady) {
    subscribe('ready', options.onReady)
  }
  if (options.onError) {
    subscribe('error', options.onError)
  }

  // Host-side event helpers (push to editor). Useful for theme/lang changes
  // initiated from the host rather than from the editor UI.
  const pushEvent = (name: string, payload: unknown) => {
    if (!iframe?.contentWindow) return
    iframe.contentWindow.postMessage(makeEvent(name, payload), '*')
  }
  pushEvent('host.theme', { theme: options.theme ?? 'auto' })
  pushEvent('host.lang', { lang: options.lang ?? 'en-US' })

  // Compose the public EditorHandle. We use a getter for `iframe`
  // so the iframe reference stays live after iframe reflow / re-render.
  const handle: EditorHandle = {
    instanceId,
    get iframe() {
      return iframe
    },
    on: subscribe,
    once: <E extends EditorEventName>(name: E, cb: (event: EditorEventMap[E]) => void) => {
      const off = subscribe(name, (e) => {
        off()
        cb(e)
      })
      return off
    },
    command,
    destroy,
  }
  // Register the handle in the module-level registry so `getEditor(id)`
  // can find it from anywhere in the host page. `destroy()` removes
  // this entry (see top of destroy() function above).
  editorRegistry.set(instanceId, handle)
  return handle
}

function resolveContainer(target: string | HTMLElement | undefined): HTMLElement {
  if (!target) {
    if (typeof document === 'undefined') throw new Error('createEditor: container required when document is not available')
    return document.body
  }
  if (typeof target === 'string') {
    const el = document.querySelector(target)
    if (!el) throw new Error(`createEditor: container "${target}" not found`)
    return el as HTMLElement
  }
  return target
}

export { ENVELOPE_VERSION }

/**
 * Mint a server-side nonce session and return an embed URL that carries
 * both `?sessionId=` and `?nonce=`. This is the SDK-side companion to
 * `POST /api/v1/embed/nonce` (sdk1.md §11.26) — calling this means the
 * web-server participates in the handshake nonce and the embed handler
 * will refuse to render the editor if the URL nonce doesn't match the
 * server-minted value (§11.27).
 *
 * Why use this over `buildEmbedUrl()`:
 *   - Defense-in-depth against attacker-controlled iframes / proxy
 *     rewrites of the URL: the nonce is stored server-side and never
 *     transmitted except in the URL itself.
 *   - Integrator gets a single call that produces the embed URL, so
 *     no chance of forgetting to plumb the `sessionId` query param.
 *
 * Why NOT use this:
 *   - Requires the host to already have a JWT that includes `files:read`
 *     scope (the endpoint is scope-gated). For anonymous public embeds,
 *     use `buildEmbedUrl()` and rely on the client-side nonce check from
 *     §11.20.
 *
 * Throws a `CreateEmbedNonceError` on any failure. Never throws a raw
 * HTTP error so the caller can branch on `.code`.
 */
export async function createEmbedNonce(
  options: CreateEmbedNonceOptions,
): Promise<CreateEmbedNonceResult> {
  if (!options) throw makeNonceError('INVALID_RESPONSE', 'createEmbedNonce: options required')
  if (!options.documentId) throw makeNonceError('INVALID_RESPONSE', 'createEmbedNonce: documentId required')
  if (!options.jwt) throw makeNonceError('INVALID_RESPONSE', 'createEmbedNonce: jwt required')
  if (!options.host) throw makeNonceError('INVALID_RESPONSE', 'createEmbedNonce: host required')

  const f = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!f) throw makeNonceError('NETWORK_ERROR', 'createEmbedNonce: no fetch implementation available')

  const url = `${options.host.replace(/\/$/, '')}/api/v1/embed/nonce`
  let res: Response
  try {
    res = await f(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId: options.documentId,
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      }),
    })
  } catch (err) {
    throw makeNonceError(
      'NETWORK_ERROR',
      `createEmbedNonce: network error — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (res.status === 401) {
    throw makeNonceError('AUTH_FAILED', 'createEmbedNonce: 401 Unauthorized — JWT invalid or expired', 401)
  }
  if (res.status === 403) {
    throw makeNonceError('FORBIDDEN', 'createEmbedNonce: 403 Forbidden — JWT lacks files:read scope', 403)
  }
  if (res.status === 400) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body.error?.message ? `: ${body.error.message}` : ''
    } catch {
      /* non-JSON body — leave detail empty */
    }
    throw makeNonceError('BAD_REQUEST', `createEmbedNonce: 400 Bad Request${detail}`, 400)
  }
  if (!res.ok) {
    throw makeNonceError('MINT_FAILED', `createEmbedNonce: ${res.status} ${res.statusText}`, res.status)
  }

  let body: { sessionId?: unknown; nonce?: unknown; expiresAt?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch (err) {
    throw makeNonceError(
      'INVALID_RESPONSE',
      `createEmbedNonce: response not JSON — ${err instanceof Error ? err.message : String(err)}`,
      res.status,
    )
  }
  if (
    typeof body.sessionId !== 'string' ||
    typeof body.nonce !== 'string' ||
    typeof body.expiresAt !== 'number'
  ) {
    throw makeNonceError('INVALID_RESPONSE', 'createEmbedNonce: response missing sessionId/nonce/expiresAt', res.status)
  }

  const embedUrl = buildEmbedUrl({
    host: options.host,
    documentId: options.documentId,
    app: options.app,
    token: options.jwt,
    mode: options.mode,
    theme: options.theme,
    lang: options.lang,
    toolbar: options.toolbar,
    features: options.features,
    nonce: body.nonce,
    sessionId: body.sessionId,
  })

  return {
    sessionId: body.sessionId,
    nonce: body.nonce,
    expiresAt: body.expiresAt,
    embedUrl,
  }
}

function makeNonceError(
  code: CreateEmbedNonceError['code'],
  message: string,
  status?: number,
): CreateEmbedNonceError {
  return status !== undefined ? { code, message, status } : { code, message }
}

/**
 * Audit that the web-server knew the (sessionId, nonce) pair when the
 * iframe was opened. The server only retains nonces it issued itself
 * via `createEmbedNonce()` (or directly via `POST /api/v1/embed/nonce`),
 * so a tampered iframe — even one whose bridge successfully echoed the
 * right nonce — will fail this check because its sessionId was never
 * minted by the server.
 *
 * Typical lifecycle:
 *   1. `await createEmbedNonce({...})`  → get `{embedUrl, sessionId, nonce}`
 *   2. Mount `<iframe src={embedUrl}>` and wait for `ready` postMessage
 *   3. `await verifyEmbedNonce({sessionId, nonce, host, jwt})`
 *      → if `valid: true`, the iframe is trustworthy
 *      → if `valid: false`, treat the iframe as suspicious (e.g.
 *        destroy it, dispatch an error event, surface a banner)
 *
 * This helper only returns `true` / `false` from the server's
 * perspective; it does NOT inspect the iframe's postMessage itself —
 * that responsibility still lives in `createEditor()` (the
 * §11.20 client-side nonce check).
 *
 * Throws a `VerifyEmbedNonceError` on HTTP / network / parse failures.
 * A verification failure (`valid: false`) is a normal successful return,
 * NOT a throw.
 */
export async function verifyEmbedNonce(
  options: VerifyEmbedNonceOptions,
): Promise<VerifyEmbedNonceResult> {
  if (!options) throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: options required')
  if (!options.sessionId) throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: sessionId required')
  if (!options.nonce) throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: nonce required')
  if (!options.host) throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: host required')
  if (!options.jwt) throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: jwt required')

  const f = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!f) throw makeVerifyError('NETWORK_ERROR', 'verifyEmbedNonce: no fetch implementation available')

  const url = `${options.host.replace(/\/$/, '')}/api/v1/embed/verify-nonce`
  let res: Response
  try {
    res = await f(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: options.sessionId, nonce: options.nonce }),
    })
  } catch (err) {
    throw makeVerifyError(
      'NETWORK_ERROR',
      `verifyEmbedNonce: network error — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (res.status === 401) {
    throw makeVerifyError('AUTH_FAILED', 'verifyEmbedNonce: 401 Unauthorized', 401)
  }
  if (res.status === 403) {
    throw makeVerifyError('FORBIDDEN', 'verifyEmbedNonce: 403 Forbidden', 403)
  }
  if (!res.ok) {
    throw makeVerifyError('VERIFY_FAILED', `verifyEmbedNonce: ${res.status} ${res.statusText}`, res.status)
  }

  let body: { valid?: unknown; reason?: unknown; expiresAt?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch (err) {
    throw makeVerifyError(
      'INVALID_RESPONSE',
      `verifyEmbedNonce: response not JSON — ${err instanceof Error ? err.message : String(err)}`,
      res.status,
    )
  }
  if (body.valid !== true && body.valid !== false) {
    throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: response missing valid:true|false', res.status)
  }
  if (body.valid === false) {
    if (body.reason !== 'unknown' && body.reason !== 'expired') {
      throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: invalid reason field', res.status)
    }
    return { valid: false, reason: body.reason }
  }
  if (typeof body.expiresAt !== 'number') {
    throw makeVerifyError('INVALID_RESPONSE', 'verifyEmbedNonce: response missing expiresAt', res.status)
  }
  return { valid: true, expiresAt: body.expiresAt }
}

function makeVerifyError(
  code: VerifyEmbedNonceError['code'],
  message: string,
  status?: number,
): VerifyEmbedNonceError {
  return status !== undefined ? { code, message, status } : { code, message }
}

/**
 * Audit that the web-server knows the `(sessionId, nonce)` pair right
 * now (sdk1.md §11.32). Symmetric counterpart to `verifyEmbedNonce()`
 * with a more lifecycle-friendly name: host code calls this right
 * after the iframe's `ready` event to confirm the iframe's session is
 * one the server minted.
 *
 * Wire protocol is identical to `verifyEmbedNonce()`
 * (`POST /api/v1/embed/verify-nonce`); the distinct name exists so
 * the call site reads naturally in the `mint → mount → audit →
 * release` lifecycle. Both helpers accept the same input shape and
 * produce the same output; choose based on which verb reads better in
 * the call site.
 *
 *   const ok = await verifyEmbedSession({ sessionId, nonce, host, jwt })
 *
 * `ok.valid === true` means the server currently knows the session;
 * `ok.valid === false` with `reason` is a normal result (not an
 * error) — the session expired or was evicted. Transport-level
 * failures throw a `VerifyEmbedSessionError`.
 */
export async function verifyEmbedSession(
  options: VerifyEmbedSessionOptions,
): Promise<VerifyEmbedSessionResult> {
  if (!options) throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: options required')
  if (!options.sessionId) throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: sessionId required')
  if (!options.nonce) throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: nonce required')
  if (!options.host) throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: host required')
  if (!options.jwt) throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: jwt required')

  const f = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!f) throw makeVerifySessionError('NETWORK_ERROR', 'verifyEmbedSession: no fetch implementation available')

  const url = `${options.host.replace(/\/$/, '')}/api/v1/embed/verify-nonce`
  let res: Response
  try {
    res = await f(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: options.sessionId, nonce: options.nonce }),
    })
  } catch (err) {
    throw makeVerifySessionError(
      'NETWORK_ERROR',
      `verifyEmbedSession: network error — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (res.status === 401) {
    throw makeVerifySessionError('AUTH_FAILED', 'verifyEmbedSession: 401 Unauthorized', 401)
  }
  if (res.status === 403) {
    throw makeVerifySessionError('FORBIDDEN', 'verifyEmbedSession: 403 Forbidden', 403)
  }
  if (!res.ok) {
    throw makeVerifySessionError('VERIFY_FAILED', `verifyEmbedSession: ${res.status} ${res.statusText}`, res.status)
  }

  let body: { valid?: unknown; reason?: unknown; expiresAt?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch (err) {
    throw makeVerifySessionError(
      'INVALID_RESPONSE',
      `verifyEmbedSession: response not JSON — ${err instanceof Error ? err.message : String(err)}`,
      res.status,
    )
  }
  if (body.valid !== true && body.valid !== false) {
    throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: response missing valid:true|false', res.status)
  }
  if (body.valid === false) {
    if (body.reason !== 'unknown' && body.reason !== 'expired') {
      throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: invalid reason field', res.status)
    }
    return { valid: false, reason: body.reason }
  }
  if (typeof body.expiresAt !== 'number') {
    throw makeVerifySessionError('INVALID_RESPONSE', 'verifyEmbedSession: response missing expiresAt', res.status)
  }
  return { valid: true, expiresAt: body.expiresAt }
}

function makeVerifySessionError(
  code: VerifyEmbedSessionError['code'],
  message: string,
  status?: number,
): VerifyEmbedSessionError {
  return status !== undefined ? { code, message, status } : { code, message }
}

/**
 * Evict a server-side nonce session. Symmetric counterpart to
 * `createEmbedNonce()` (§11.30). Use this from the host's iframe
 * `destroy()` path so the LRU slot is freed immediately instead of
 * waiting for the 5-min TTL.
 *
 * Returns `{released:true}` when the session was live and was
 * removed; `{released:false}` when it was already gone (race with
 * TTL / LRU). Both are normal results — only HTTP / network / parse
 * failures throw.
 *
 * Fire-and-forget friendly — the caller can `void releaseEmbedNonce(...)`
 * from a `destroy()` handler without awaiting; failures are observable
 * via the standard try/catch on the returned promise.
 */
export async function releaseEmbedNonce(
  options: ReleaseEmbedNonceOptions,
): Promise<ReleaseEmbedNonceResult> {
  if (!options) throw makeReleaseError('INVALID_RESPONSE', 'releaseEmbedNonce: options required')
  if (!options.sessionId) throw makeReleaseError('INVALID_RESPONSE', 'releaseEmbedNonce: sessionId required')
  if (!options.host) throw makeReleaseError('INVALID_RESPONSE', 'releaseEmbedNonce: host required')
  if (!options.jwt) throw makeReleaseError('INVALID_RESPONSE', 'releaseEmbedNonce: jwt required')

  const f = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!f) throw makeReleaseError('NETWORK_ERROR', 'releaseEmbedNonce: no fetch implementation available')

  const url = `${options.host.replace(/\/$/, '')}/api/v1/embed/nonce`
  let res: Response
  try {
    res = await f(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${options.jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: options.sessionId }),
    })
  } catch (err) {
    throw makeReleaseError(
      'NETWORK_ERROR',
      `releaseEmbedNonce: network error — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (res.status === 401) {
    throw makeReleaseError('AUTH_FAILED', 'releaseEmbedNonce: 401 Unauthorized', 401)
  }
  if (res.status === 403) {
    throw makeReleaseError('FORBIDDEN', 'releaseEmbedNonce: 403 Forbidden', 403)
  }
  if (!res.ok) {
    throw makeReleaseError('RELEASE_FAILED', `releaseEmbedNonce: ${res.status} ${res.statusText}`, res.status)
  }

  let body: { released?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch (err) {
    throw makeReleaseError(
      'INVALID_RESPONSE',
      `releaseEmbedNonce: response not JSON — ${err instanceof Error ? err.message : String(err)}`,
      res.status,
    )
  }
  if (body.released !== true && body.released !== false) {
    throw makeReleaseError('INVALID_RESPONSE', 'releaseEmbedNonce: response missing released:true|false', res.status)
  }
  return { released: body.released }
}

function makeReleaseError(
  code: ReleaseEmbedNonceError['code'],
  message: string,
  status?: number,
): ReleaseEmbedNonceError {
  return status !== undefined ? { code, message, status } : { code, message }
}

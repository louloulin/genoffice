/**
 * Pure embed URL builder — no DOM access, so usable in Node-side test code
 * and SSR contexts.
 *
 * The embed URL contract is documented in sdk1.md §2.1.C and mirrored in
 * `apps/web-server/src/embed/index.ts`. Any change to the query-string
 * vocabulary must update both files.
 */

import type { EditorApp, EditorLang, EditorMode, EditorTheme, EditorToolbar } from './types'

export interface EmbedUrlInput {
  host: string
  documentId: string
  app: EditorApp
  token: string
  mode?: EditorMode
  theme?: EditorTheme
  lang?: EditorLang
  toolbar?: EditorToolbar
  /**
   * Optional handshake nonce (URL-safe base64, 16 random bytes by
   * convention). When present, `buildEmbedUrl` writes `?nonce=…` so the
   * server-side embed bridge can echo it back in the `ready` postMessage
   * event, letting the host page verify the iframe is actually serving
   * our document (not a malicious imposter). Without this, the
   * `?nonce=` parameter was silently dropped — see sdk1.md §11.20.
   */
  nonce?: string
  /**
   * Optional server-side nonce session id (sdk1.md §11.26 + §11.27).
   * When present alongside `nonce`, the embed handler binds the URL
   * to a server-minted session and rejects mismatched or unknown
   * sessions with 401 / 400 envelopes. This upgrades the handshake
   * nonce from a client-only check to a server-attested one.
   *
   * Pair with `createEmbedNonce()` rather than constructing the URL
   * by hand so the server side stays in sync.
   */
  sessionId?: string
  features?: Record<string, boolean | string | number>
}

export function buildEmbedUrl(input: EmbedUrlInput): string {
  const base = new URL(`/embed/${encodeURIComponent(input.documentId)}`, ensureTrailingSlash(input.host))
  const params = base.searchParams
  params.set('app', input.app)
  params.set('token', input.token)
  if (input.nonce) params.set('nonce', input.nonce)
  if (input.sessionId) params.set('sessionId', input.sessionId)
  if (input.mode) params.set('mode', input.mode)
  if (input.theme) params.set('theme', input.theme)
  if (input.lang) params.set('lang', input.lang)
  if (input.toolbar) params.set('toolbar', input.toolbar)
  if (input.features) {
    for (const [k, v] of Object.entries(input.features)) {
      params.set(`feat.${k}`, String(v))
    }
  }
  return base.toString()
}

function ensureTrailingSlash(host: string): string {
  return host.endsWith('/') ? host : `${host}/`
}

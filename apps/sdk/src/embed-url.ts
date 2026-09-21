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
  features?: Record<string, boolean | string | number>
}

export function buildEmbedUrl(input: EmbedUrlInput): string {
  const base = new URL(`/embed/${encodeURIComponent(input.documentId)}`, ensureTrailingSlash(input.host))
  const params = base.searchParams
  params.set('app', input.app)
  params.set('token', input.token)
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

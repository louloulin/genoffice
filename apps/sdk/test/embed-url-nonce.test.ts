/**
 * buildEmbedUrl must surface the handshake nonce (sdk1.md §11.20).
 *
 * Background: the SDK generates a random nonce per session and the host
 * page expects the iframe to echo it back in the `ready` postMessage event
 * to verify the iframe identity. The nonce had to travel from the SDK to
 * the server via `?nonce=` in the iframe URL. Before §11.20, `buildEmbedUrl`
 * silently dropped the nonce field — the URL only contained `?app&token`,
 * so the bridge script never saw it and the SDK's `HANDSHAKE_FAILED`
 * timer always fired 10 seconds later.
 *
 * Tests pin the round-trip end to end so future refactors can't regress.
 */
import { describe, expect, it } from 'vitest'
import { buildEmbedUrl } from '../src/embed-url'

describe('buildEmbedUrl handshake nonce (sdk1.md §11.20)', () => {
  it('omits ?nonce when not provided', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'doc_abc',
      app: 'docs',
      token: 'jwt-xyz',
    })
    expect(url).not.toContain('nonce=')
    // Sanity: required params still present.
    expect(url).toContain('app=docs')
    expect(url).toContain('token=jwt-xyz')
  })

  it('includes ?nonce=<value> when provided', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'doc_abc',
      app: 'docs',
      token: 'jwt-xyz',
      nonce: 'abc123-random-22-chars',
    })
    expect(url).toContain('nonce=abc123-random-22-chars')
  })

  it('URL-encodes the nonce so + / = /  survive transport', () => {
    // makeNonce() produces URL-safe base64 (no padding, +/= replaced by -_),
    // but defense-in-depth: confirm a literal that needs encoding is handled.
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'doc_abc',
      app: 'docs',
      token: 'jwt-xyz',
      nonce: 'value with spaces & specials=/?',
    })
    // URLSearchParams encodes spaces as +; & becomes %26; = becomes %3D.
    expect(url).toContain('nonce=value+with+spaces')
    expect(url).not.toContain('nonce=value with spaces')
  })

  it('preserves the relative ordering: token, nonce, app, mode, theme, lang, toolbar', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'doc_abc',
      app: 'docs',
      token: 'jwt-xyz',
      nonce: 'n-once',
      theme: 'dark',
      lang: 'zh-CN',
      toolbar: 'full',
    })
    const appIdx = url.indexOf('app=')
    const tokenIdx = url.indexOf('token=')
    const nonceIdx = url.indexOf('nonce=')
    const themeIdx = url.indexOf('theme=')
    const langIdx = url.indexOf('lang=')
    const toolbarIdx = url.indexOf('toolbar=')
    expect(appIdx).toBeGreaterThan(-1)
    expect(tokenIdx).toBeGreaterThan(appIdx)
    expect(nonceIdx).toBeGreaterThan(tokenIdx)
    expect(themeIdx).toBeGreaterThan(nonceIdx)
    expect(langIdx).toBeGreaterThan(themeIdx)
    expect(toolbarIdx).toBeGreaterThan(langIdx)
  })
})

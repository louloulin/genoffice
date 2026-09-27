import { describe, expect, it } from 'vitest'
import { buildEmbedUrl } from '../src/embed-url'

describe('buildEmbedUrl', () => {
  it('always includes app, documentId, token', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'doc-abc',
      app: 'docs',
      token: 'eyJ.test',
    })
    expect(url).toContain('/embed/doc-abc')
    expect(url).toContain('app=docs')
    expect(url).toContain('token=eyJ.test')
  })

  it('escapes documentId in path', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'foo/bar baz',
      app: 'docs',
      token: 't',
    })
    expect(url).toContain('/embed/foo%2Fbar%20baz')
  })

  it('omits optional fields when not supplied', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'sheets',
      token: 't',
    })
    const params = new URL(url).searchParams
    expect(params.get('mode')).toBeNull()
    expect(params.get('theme')).toBeNull()
    expect(params.get('lang')).toBeNull()
    expect(params.get('toolbar')).toBeNull()
  })

  it('passes optional mode/theme/lang/toolbar when supplied', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'slides',
      token: 't',
      mode: 'view',
      theme: 'dark',
      lang: 'zh-CN',
      toolbar: 'minimal',
    })
    const params = new URL(url).searchParams
    expect(params.get('mode')).toBe('view')
    expect(params.get('theme')).toBe('dark')
    expect(params.get('lang')).toBe('zh-CN')
    expect(params.get('toolbar')).toBe('minimal')
  })

  it('prefixes feature flags with feat.', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
      features: { spellcheck: false, comments: 'rwx' },
    })
    const params = new URL(url).searchParams
    expect(params.get('feat.spellcheck')).toBe('false')
    expect(params.get('feat.comments')).toBe('rwx')
  })

  it('adds trailing slash to host without one', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
    })
    expect(url.startsWith('https://genoffice.app/embed/')).toBe(true)
  })

  it('keeps existing trailing slash on host', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app/',
      documentId: 'd',
      app: 'docs',
      token: 't',
    })
    expect(url.startsWith('https://genoffice.app/embed/')).toBe(true)
  })

  it('preserves a path prefix on host (e.g. /office-engine dev-proxy)', () => {
    // The dev proxy rewrites `/office-engine/...` -> upstream; in production
    // GenOffice may sit behind the same prefix via reverse proxy. A leading
    // slash on the embed path used to make WHATWG URL replace the base path
    // and silently drop the prefix — locking the iframe onto the host's SPA
    // fallback in dev. The fix resolves `embed/...` (relative) so the prefix
    // survives.
    const url = buildEmbedUrl({
      host: 'http://127.0.0.1:8990/office-engine',
      documentId: '2104158614643634177',
      app: 'docs',
      token: 't',
    })
    expect(url).toBe(
      'http://127.0.0.1:8990/office-engine/embed/2104158614643634177?app=docs&token=t',
    )
  })

  it('preserves a deeper prefix and trailing slash on host', () => {
    const url = buildEmbedUrl({
      host: 'https://cdn.example.com/office-engine/',
      documentId: 'doc-9',
      app: 'docs',
      token: 't',
    })
    expect(url).toBe(
      'https://cdn.example.com/office-engine/embed/doc-9?app=docs&token=t',
    )
  })
})

describe('buildEmbedUrl handshake nonce (sdk1.md §11.20)', () => {
  it('omits ?nonce when not provided', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
    })
    expect(url).not.toContain('nonce=')
  })

  it('emits ?nonce=<value> when supplied', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
      nonce: 'abc123-random-22-chars',
    })
    expect(url).toContain('nonce=abc123-random-22-chars')
  })

  it('places nonce immediately after token (sandwiched before mode/theme/lang/toolbar)', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
      nonce: 'n-once',
      theme: 'dark',
      lang: 'zh-CN',
    })
    const tokenIdx = url.indexOf('token=')
    const nonceIdx = url.indexOf('nonce=')
    const themeIdx = url.indexOf('theme=')
    expect(tokenIdx).toBeGreaterThan(-1)
    expect(nonceIdx).toBeGreaterThan(tokenIdx)
    expect(themeIdx).toBeGreaterThan(nonceIdx)
  })

  it('URL-encodes special characters in the nonce value', () => {
    // makeNonce() returns URL-safe base64 (no padding, +/-= → -_), so this
    // is defense-in-depth: a nonce value that happens to contain spaces
    // or HTML-significant chars must be encoded for transport.
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
      nonce: 'a b&c=d',
    })
    expect(url).toContain('nonce=a+b%26c%3Dd')
    expect(url).not.toContain('nonce=a b&c=d')
  })


  it('writes ?sessionId=... when provided (sdk1.md §11.27)', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
      nonce: 'n',
      sessionId: 's',
    })
    expect(url).toContain('sessionId=s')
    expect(url).toContain('nonce=n')
  })

  it('does not write ?sessionId=... when not supplied', () => {
    const url = buildEmbedUrl({
      host: 'https://genoffice.app',
      documentId: 'd',
      app: 'docs',
      token: 't',
      nonce: 'n',
    })
    expect(url).not.toContain('sessionId=')
  })
})
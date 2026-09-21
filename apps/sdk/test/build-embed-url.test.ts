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
})

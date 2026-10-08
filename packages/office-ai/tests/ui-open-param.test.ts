/**
 * The `open` parameter is not one contract but two, and picking the wrong one
 * is silent: a `?open=` URL boots the pdf app into its empty state with no
 * console error, because only `location.hash` is consulted. These tests pin
 * both URL builders to the shape their renderer actually reads.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { startUiHost, type UiHostHandle } from '../src/ui/host'
import { buildEmbedUrl } from '../src/ui-browser/mount'
import { setOpenParam } from '../src/open-param'

let host: UiHostHandle | null = null

afterEach(async () => {
  await host?.close()
  host = null
})

/** The path is irrelevant to the URL shape; only how it is encoded matters. */
const STAGED_PATH = '/tmp/office-ai/test dir/a.pdf'

describe('setOpenParam', () => {
  it('puts pdf paths in the hash and every other app in the query', () => {
    const pdf = new URL('http://127.0.0.1:9000/pdf')
    setOpenParam(pdf, 'pdf', STAGED_PATH)
    expect(pdf.hash).toBe(`#${new URLSearchParams({ open: STAGED_PATH }).toString()}`)
    expect(pdf.searchParams.get('open')).toBeNull()

    for (const app of ['docs', 'sheets', 'slides']) {
      const url = new URL('http://127.0.0.1:9000/' + app)
      setOpenParam(url, app, STAGED_PATH)
      expect(url.searchParams.get('open'), app).toBe(STAGED_PATH)
      expect(url.hash, app).toBe('')
    }
  })

  it('round-trips the path through both decoders the renderers use', () => {
    const pdf = new URL('http://127.0.0.1:9000/pdf')
    setOpenParam(pdf, 'pdf', STAGED_PATH)
    // web-bridge.ts: `new URLSearchParams(window.location.hash.slice(1))`
    expect(new URLSearchParams(pdf.hash.slice(1)).get('open')).toBe(STAGED_PATH)

    const docs = new URL('http://127.0.0.1:9000/docs')
    setOpenParam(docs, 'docs', STAGED_PATH)
    expect(new URL(docs).searchParams.get('open')).toBe(STAGED_PATH)
  })
})

describe('UiHostHandle.open', () => {
  it('emits a hash-addressed URL for pdf and a query-addressed one otherwise', async () => {
    host = await startUiHost()
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

    const pdf = host.open('pdf', bytes, { name: 'a.pdf' })
    const pdfUrl = new URL(pdf.url)
    expect(pdfUrl.pathname).toBe('/pdf')
    expect(new URLSearchParams(pdfUrl.hash.slice(1)).get('open')).toBe(pdf.path)
    expect(pdfUrl.searchParams.get('open')).toBeNull()

    const docs = host.open('docs', bytes, { name: 'a.docx' })
    expect(new URL(docs.url).searchParams.get('open')).toBe(docs.path)
    // Both apps staged distinct files, so the paths must not collide.
    expect(docs.path).not.toBe(pdf.path)
  })
})

describe('buildEmbedUrl', () => {
  const base = { baseUrl: 'http://127.0.0.1:9000', docId: 'doc-1' }

  it('hash-addresses the pdf app', () => {
    const url = new URL(buildEmbedUrl({ ...base, app: 'pdf', open: STAGED_PATH }))
    expect(url.searchParams.get('app')).toBe('pdf')
    expect(new URLSearchParams(url.hash.slice(1)).get('open')).toBe(STAGED_PATH)
    expect(url.searchParams.get('open')).toBeNull()
  })

  it('query-addresses the other apps without losing the embed params', () => {
    const url = new URL(
      buildEmbedUrl({ ...base, app: 'docs', open: STAGED_PATH, mode: 'edit', theme: 'dark' }),
    )
    expect(url.searchParams.get('open')).toBe(STAGED_PATH)
    expect(url.searchParams.get('app')).toBe('docs')
    expect(url.searchParams.get('mode')).toBe('edit')
    expect(url.searchParams.get('theme')).toBe('dark')
    expect(url.hash).toBe('')
  })
})

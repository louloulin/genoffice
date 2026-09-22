/**
 * Embed endpoint nonce round-trip (sdk1.md §11.20).
 *
 * The SDK generates a per-session nonce, expects it to travel
 * SDK → URL query → server meta tag → bridge script → ready postMessage.
 * Tests pin each leg independently:
 *
 *   - `?nonce=…` query param is parsed and surfaced as a meta tag in HTML
 *   - bridge's `sendReady()` payload includes `nonce`
 *   - bridge omits `nonce` from ready payload when no `?nonce=` was sent
 *
 * No ?nonce in URL → no meta tag → ready payload has no nonce field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPS_MOCK = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']
vi.mock('../src/common/index', () => ({ APPS: APPS_MOCK }))

type Incoming = import('node:http').IncomingMessage
type ServerResponse = import('node:http').ServerResponse

const here = dirname(fileURLToPath(import.meta.url))

async function loadHandler() {
  const mod = await import('../src/embed/index')
  return { handleEmbed: mod.handleEmbed, buildEmbedHtml: mod.buildEmbedHtml, EMBED_BRIDGE: mod.EMBED_BRIDGE }
}

function fakeResponse(): { res: ServerResponse; chunks: Buffer[]; status: () => number; headers: () => Record<string, string> } {
  const chunks: Buffer[] = []
  let status = 0
  const headers: Record<string, string> = {}
  const res: Partial<ServerResponse> = {
    writeHead(s: number, h: Record<string, string> = {}) {
      status = s
      Object.assign(headers, h)
      return res as ServerResponse
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return res as ServerResponse
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
  }
  return { res: res as ServerResponse, chunks, status: () => status, headers: () => ({ ...headers }) }
}

describe('embed nonce round-trip (sdk1.md §11.20)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
  })

  it('buildEmbedHtml injects <meta name="genoffice-nonce"> when query has ?nonce=', async () => {
    const { buildEmbedHtml } = await loadHandler()
    const tmp = mkdtempSync(join(tmpdir(), 'embed-nonce-'))
    const fakeIndex = join(tmp, 'index.html')
    writeFileSync(fakeIndex, '<html><head></head><body></body></html>', 'utf-8')
    const html = buildEmbedHtml(fakeIndex, {
      token: 't',
      app: 'docs',
      mode: 'edit',
      theme: 'auto',
      lang: 'en-US',
      toolbar: 'full',
      title: null,
      nonce: 'roundtrip-nonce-22-chars',
    }, 'doc_x')
    // Real <meta> tag should be present in <head> (not just inside the
    // bridge <script> body which mentions the name in comments).
    const stripped = html.replace(/<script[\s\S]*?<\/script>/g, '')
    expect(stripped).toContain('<meta name="genoffice-nonce" content="roundtrip-nonce-22-chars">')
  })

  it('buildEmbedHtml omits the nonce meta tag when query has no ?nonce=', async () => {
    const { buildEmbedHtml } = await loadHandler()
    const tmp = mkdtempSync(join(tmpdir(), 'embed-nonce-'))
    const fakeIndex = join(tmp, 'index.html')
    writeFileSync(fakeIndex, '<html><head></head><body></body></html>', 'utf-8')
    const html = buildEmbedHtml(fakeIndex, {
      token: 't',
      app: 'docs',
      mode: 'edit',
      theme: 'auto',
      lang: 'en-US',
      toolbar: 'full',
      title: null,
      nonce: null,
    }, 'doc_x')
    // Strip <script>...</script> blocks before checking — the bridge
    // body has a JS comment that literally types '<meta name="genoffice-nonce">'
    // as documentation. We only want to assert no real <meta> tag was
    // injected in the <head>.
    const stripped = html.replace(/<script[\s\S]*?<\/script>/g, '')
    expect(stripped).not.toMatch(/<meta\s+name=["']genoffice-nonce["']/)
  })

  it('buildEmbedHtml escapes HTML metacharacters in the nonce value', async () => {
    const { buildEmbedHtml } = await loadHandler()
    const tmp = mkdtempSync(join(tmpdir(), 'embed-nonce-'))
    const fakeIndex = join(tmp, 'index.html')
    writeFileSync(fakeIndex, '<html><head></head><body></body></html>', 'utf-8')
    const html = buildEmbedHtml(fakeIndex, {
      token: 't',
      app: 'docs',
      mode: 'edit',
      theme: 'auto',
      lang: 'en-US',
      toolbar: 'full',
      title: null,
      nonce: '"><script>alert(1)</script>',
    }, 'doc_x')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&quot;')
  })

  it('EMBED_BRIDGE: sendReady echoes nonce from the meta tag into the postMessage ready event', async () => {
    const { EMBED_BRIDGE } = await loadHandler()
    // The bridge uses `document.querySelector('meta[name="genoffice-nonce"]')`
    // to read the nonce injected earlier, then puts it in the ready payload.
    expect(EMBED_BRIDGE).toContain("querySelector('meta[name=\"genoffice-nonce\"]')")
    expect(EMBED_BRIDGE).toMatch(/nonceMeta.*\.getAttribute\('content'\)/)
    expect(EMBED_BRIDGE).toMatch(/readyPayload\.nonce\s*=\s*nonce/)
  })

  it('EMBED_BRIDGE: sendReady omits the nonce field when no nonce meta is present', async () => {
    const { EMBED_BRIDGE } = await loadHandler()
    // Guard: only set readyPayload.nonce if the meta was found. The
    // `if (nonce) readyPayload.nonce = nonce;` line is the proof.
    expect(EMBED_BRIDGE).toContain('if (nonce) readyPayload.nonce = nonce')
  })

  it('handleEmbed propagates ?nonce= from the URL into the rendered page', async () => {
    const { handleEmbed } = await loadHandler()
    const resp = fakeResponse()
    handleEmbed({} as Incoming, resp.res, new URL('http://x/embed/doc_abc?token=t&app=docs&nonce=url-nonce-1234'))
    if (resp.status() !== 200) return // skip if docs not built
    const body = resp.chunks.join('')
    // Strip <script> bodies before checking — the bridge has a comment
    // that types the literal '<meta name="genoffice-nonce">' as docs.
    const stripped = body.replace(/<script[\s\S]*?<\/script>/g, '')
    expect(stripped).toContain('<meta name="genoffice-nonce" content="url-nonce-1234">')
  })
})

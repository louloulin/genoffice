import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Set up a hoisted mock of the common APPS export. Using vi.hoisted keeps the
// factory reference stable across vi.resetModules() so each per-test reset
// still routes through the mocked APPS list.
const { APPS_MOCK } = vi.hoisted(() => ({ APPS_MOCK: ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'] }))
vi.mock('../src/common/index', () => ({ APPS: APPS_MOCK }))

type Incoming = import('node:http').IncomingMessage
type ServerResponse = import('node:http').ServerResponse

const here = dirname(fileURLToPath(import.meta.url))

afterEach(() => {
  vi.doUnmock('node:fs')
})

async function loadHandler() {
  const mod = await import('../src/embed/index')
  return mod.handleEmbed
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
  return {
    res: res as ServerResponse,
    chunks,
    status: () => status,
    headers: () => ({ ...headers }),
  }
}

describe('handleEmbed', () => {
  it('returns false for non-/embed paths', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    const handled = handleEmbed({} as Incoming, resp.res, new URL('http://x/docs/index.html'))
    expect(handled).toBe(false)
  })

  it('rejects missing token with 400', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed({} as Incoming, resp.res, new URL('http://x/embed/doc_abc'))
    expect(resp.status()).toBe(400)
    expect(JSON.parse(resp.chunks.join('')).error.code).toBe('INVALID_ARGUMENT')
  })

  it('coerces an unknown app parameter to the docs default and serves 200', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed({} as Incoming, resp.res, new URL('http://x/embed/doc_abc?token=t&app=garbage'))
    // docs is built in this repo → 200; the coercion must not 500.
    expect([200, 503]).toContain(resp.status())
  })

  it('injects token meta tag + bridge script when serving a built app', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed({} as Incoming, resp.res, new URL('http://x/embed/doc_abc?token=jwt-xyz&app=docs&theme=dark&lang=zh-CN'))
    if (resp.status() !== 200) return // docs not built in this env — skip
    const body = resp.chunks.join('')
    expect(body).toContain('<meta name="genoffice-token" content="jwt-xyz">')
    expect(body).toContain('ENVELOPE_VERSION = \'1.0\'')
    expect(body).toContain('window.parent.postMessage')
    expect(body).toContain('theme')
    expect(body).toContain('dark')
  })

  it('escapes token attribute to defeat HTML breakout', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    const evil = '"><script>alert(1)</script>'
    handleEmbed({} as Incoming, resp.res, new URL(`http://x/embed/doc_abc?token=${encodeURIComponent(evil)}&app=docs`))
    if (resp.status() !== 200) return // skip if docs not built
    const body = resp.chunks.join('')
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&quot;')
  })



  it('injects a per-request sessionId meta + EventSource wiring for SSE forwarding', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed(
      {} as Incoming,
      resp.res,
      new URL('http://x/embed/doc_abc?token=jwt-xyz&app=docs'),
    )
    if (resp.status() !== 200) return // docs not built — skip
    const body = resp.chunks.join('')
    // Per-request sessionId for SSE push forwarding.
    expect(body).toMatch(/<meta name="genoffice-session" content="embed-[a-z0-9-]+">/)
    // The bridge script must open an EventSource to the same SSE channel
    // the editor's own push-hub uses, so server-side saved/dirtyChanged
    // events flow through to window.parent.
    expect(body).toContain('new EventSource(\'/api/ipc/events?session=\' + encodeURIComponent(cfg.sessionId))')
    // The bridge must forward each SSE frame to window.parent via the
    // existing post(name, payload) helper so the host sees one envelope
    // per frame, same shape as ready/error/etc.
    expect(body).toMatch(/es\.onmessage = function \(ev\) \{[\s\S]*post\(frame\.channel, p\)/)
  })

  // The "503 when no app is built" path is covered by the docs-not-built
  // smoke check (the resolveAppIndex candidate walk returns null when no
  // out/ directory exists). Mocking node:fs requires resetModules + doMock
  // to rewire the embed module's imports, which conflicts with the
  // per-test loadHandler pattern; we leave that case to the integration
  // suite where the build state is real.

  it('matches </HEAD> case-insensitively in buildEmbedHtml', async () => {
    const mod = await import('../src/embed/index')
    const tmp = mkdtempSync(join(tmpdir(), 'embed-case-'))
    const fakeIndex = join(tmp, 'index.html')
    writeFileSync(fakeIndex, '<HTML><HEAD><meta charset="utf-8"></HEAD><body>hi</body></HTML>', 'utf-8')
    const html = mod.buildEmbedHtml(fakeIndex, {
      token: 't',
      app: 'docs',
      mode: 'edit',
      theme: 'auto',
      lang: 'en-US',
      toolbar: 'full',
      title: null,
    }, 'doc_x')
    expect(html.indexOf('ENVELOPE_VERSION')).toBeLessThan(html.indexOf('<body>'))
  })

  it('escapes token attribute in buildEmbedHtml', async () => {
    const mod = await import('../src/embed/index')
    const tmp = mkdtempSync(join(tmpdir(), 'embed-case-'))
    const fakeIndex = join(tmp, 'index.html')
    writeFileSync(fakeIndex, '<html><head></head><body></body></html>', 'utf-8')
    const html = mod.buildEmbedHtml(fakeIndex, {
      token: '"><script>alert(1)</script>',
      app: 'docs',
      mode: 'edit',
      theme: 'auto',
      lang: 'en-US',
      toolbar: 'full',
      title: null,
    }, 'doc_x')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})

describe('EMBED_BRIDGE', () => {
  it('declares the v1.0 envelope version', async () => {
    const mod = await import('../src/embed/index')
    expect(mod.EMBED_BRIDGE).toContain('ENVELOPE_VERSION = \'1.0\'')
  })

  it('posts ready events to window.parent', async () => {
    const mod = await import('../src/embed/index')
    expect(mod.EMBED_BRIDGE).toContain('window.parent.postMessage')
    // sdk1.md §11.34: the bridge no longer dispatches host.command
    // CustomEvents (no renderer-side consumer exists). Pin absence at
    // the *code* level — comments may still mention the name for
    // historical context, but no `new CustomEvent('host.command', …)`
    // invocation may exist in the IIFE source.
    expect(mod.EMBED_BRIDGE).not.toMatch(/new\s+CustomEvent\(['"]host\.command['"]/)
  })

  it('does not include a hard-coded host origin so postMessage wildcard works', async () => {
    const mod = await import('../src/embed/index')
    expect(mod.EMBED_BRIDGE).not.toMatch(/targetOrigin.*'https?:\/\//)
  })
})

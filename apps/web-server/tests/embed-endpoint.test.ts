import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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

// The embed endpoint serves the *built* renderer. When that build is missing
// every request answers 503 and the assertions below would quietly reduce to
// nothing — the skip-if-not-200 pattern this file used to carry, which is how
// a blank-iframe regression survived a green suite. Fail loudly instead: a
// missing `out/renderer` means the build chain is broken, not that the
// behaviour is untestable.
const DOCS_RENDERER = resolve(here, '..', '..', '..', 'apps', 'docs', 'out', 'renderer', 'index.html')

beforeAll(() => {
  expect(
    existsSync(DOCS_RENDERER),
    `Missing ${DOCS_RENDERER}. Build the renderer first: npm run build -w @genoffice/docs`,
  ).toBe(true)
})

/** A GET request with the minimal shape `handleEmbed` reads. */
function getRequest(extra: Record<string, unknown> = {}) {
  return { method: 'GET', ...extra } as unknown as Incoming
}

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
    const handled = handleEmbed({ method: "GET" } as unknown as Incoming, resp.res, new URL('http://x/docs/index.html'))
    expect(handled).toBe(false)
  })

  it('rejects missing token with 400', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed({ method: "GET" } as unknown as Incoming, resp.res, new URL('http://x/embed/doc_abc'))
    expect(resp.status()).toBe(400)
    expect(JSON.parse(resp.chunks.join('')).error.code).toBe('INVALID_ARGUMENT')
  })

  it('coerces an unknown app parameter to the docs default and serves 200', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed(getRequest(), resp.res, new URL('http://x/embed/doc_abc?token=t&app=garbage'))
    // docs is built in this repo → 200; the coercion must not 500.
    expect(resp.status()).toBe(200)
  })

  it('injects token meta tag + bridge script when serving a built app', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed(getRequest(), resp.res, new URL('http://x/embed/doc_abc?token=jwt-xyz&app=docs&theme=dark&lang=zh-CN'))
    expect(resp.status()).toBe(200)
    const body = resp.chunks.join('')
    expect(body).toContain('<meta name="genoffice-token" content="jwt-xyz">')
    // W6c: the bridge is now an external script reference — the CSP can
    // stay at `script-src 'self'` instead of needing `'unsafe-inline'`.
    //
    // Both the bridge and the `<base>` are directory-relative on purpose. A
    // root-relative `/embed/...` or `<base href="/">` only works when this
    // server is mounted at the origin root; Dataflarework mounts it behind
    // `/office-engine` with `strip-path-prefix: true`, where the browser asks
    // the *host* for `/assets/…` and `/embed/…`, the host forwards neither,
    // and the embed iframe renders blank. Pin the relative form so a future
    // "fix" cannot quietly reintroduce the prefix dependency.
    expect(body).toContain('<script src="static/bridge.js"></script>')
    expect(body).toContain('<base href="./">')
    expect(body).not.toContain('<base href="/">')
    // Scoped to attribute values on purpose (R-H): a whole-document scan for
    // a leading '/' would trip over `<meta content=…>` and the injected JSON
    // config, and the only way to keep such an over-broad assertion is to
    // weaken it. Every same-origin reference the page issues must be
    // directory-relative so it resolves under the host's mount prefix.
    expect(body).not.toMatch(/(?:src|href)="\//)
    expect(body).toContain('theme')
    expect(body).toContain('dark')
  })

  it('escapes token attribute to defeat HTML breakout', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    const evil = '"><script>alert(1)</script>'
    handleEmbed(getRequest(), resp.res, new URL(`http://x/embed/doc_abc?token=${encodeURIComponent(evil)}&app=docs`))
    expect(resp.status()).toBe(200)
    const body = resp.chunks.join('')
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&quot;')
  })



  it('injects a per-request sessionId meta + a mount-relative bridge reference', async () => {
    const handleEmbed = await loadHandler()
    const resp = fakeResponse()
    handleEmbed(getRequest(), resp.res, new URL('http://x/embed/doc_abc?token=jwt-xyz&app=docs'))
    expect(resp.status()).toBe(200)
    const body = resp.chunks.join('')
    // Per-request sessionId for SSE push forwarding.
    expect(body).toMatch(/<meta name="genoffice-session" content="embed-[a-z0-9-]+">/)
    // The SSE wiring itself lives in the bridge *file* now, not the page. This
    // assertion used to pin the inlined source and so silently stopped testing
    // anything once the bridge moved out of the HTML — and it pinned the
    // root-relative URL that broke push under a prefixed mount. The bridge's
    // behaviour is asserted in embed-bridge.test.ts against a fake DOM; here we
    // only pin that the page hands the bridge the session id it needs.
    const mod = await import('../src/embed/index')
    const { EMBED_BRIDGE_SOURCE } = await import('../src/embed/bridge')
    const sessionMatch = body.match(/<meta name="genoffice-session" content="(embed-[a-z0-9-]+)">/)
    expect(sessionMatch).not.toBeNull()
    const cfgMatch = body.match(/<meta name="genoffice-embed-config" content="([^"]+)">/)
    expect(cfgMatch).not.toBeNull()
    expect(JSON.parse(cfgMatch![1]!.replace(/&quot;/g, '"')).sessionId).toBe(sessionMatch![1])
    // No API call may be baked into the served page as a root-relative URL,
    // and neither may the bridge resolve one at runtime.
    expect(body).not.toContain("'/api/")
    expect(EMBED_BRIDGE_SOURCE).not.toContain("EventSource('/api/")
    // Generic form — catches fetch, fetchFn, or any other call site that
    // bakes a root-relative '/api/ipc/' into the bridge (the prior
    // string match on `fetch('/api/` missed the `fetchFn` alias used at
    // the call site below).
    expect(EMBED_BRIDGE_SOURCE).not.toContain("'/api/ipc/")
    expect(EMBED_BRIDGE_SOURCE).toContain('apiUrl(')
    expect(mod.EMBED_BRIDGE_SCRIPT_PATH).toBe('/embed/static/bridge.js')
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

/**
 * Static transport regression: compression negotiation, cache validators and
 * cache-control. The embed path used to re-download the multi-MB bundle on
 * every open because responses carried no Content-Encoding, no ETag and no
 * useful Cache-Control.
 *
 * Asserts the behaviour committed for the embed-open-performance change:
 *   1. gzip: hashed JS asset served gzipped and ≤30% of raw size (A1),
 *   2. immutable cache-control on content-hashed names, no-cache on HTML (A2),
 *   3. ETag + 304 on conditional re-request (A4),
 *   4. Vary: Accept-Encoding everywhere, encoding-scoped ETags,
 *   5. already-compressed formats (woff2, png) are served uncompressed,
 *   6. SDK route keeps its wildcard CORS and gains the same validators.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'

const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
const docsRenderer = join(__dirname, '..', '..', 'docs', 'out', 'renderer')

async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`web-server did not become healthy within ${timeoutMs}ms`)
}

describe('static transport: compression, validators, cache-control', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let serverStderr = ''

  beforeAll(async () => {
    expect(existsSync(bundle), `Missing ${bundle}. Build it first: npm run bundle -w @genoffice/web-server`).toBe(true)
    expect(existsSync(join(docsRenderer, 'index.html')), `Missing docs renderer build: ${docsRenderer}`).toBe(true)
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-static-cache-e2e-'))
    const port = 20000 + Math.floor(Math.random() * 9000)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GENOFFICE_DATA_DIR: dataDir },
      stdio: 'pipe',
    })
    server.stderr?.on('data', (chunk) => {
      serverStderr += String(chunk)
    })
    server.stdout?.on('data', () => {})
    try {
      await waitForHealth(base)
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- server output ---\n${serverStderr.slice(-4000)}`)
    }
  }, 60_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  /** The docs bundle's own module script (`./assets/index-*.js`). */
  function docsModuleSrc(): string {
    const html = readFileSync(join(docsRenderer, 'index.html'), 'utf8')
    const src = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1]
    if (!src) throw new Error('docs index.html carries no module script')
    return src.replace(/^\.\//, '')
  }

  it('serves the hashed main JS gzipped at ≤30% of raw size', async () => {
    const src = docsModuleSrc()
    const raw = statSync(join(docsRenderer, src)).size
    const res = await fetch(`${base}/docs/${src}`, { headers: { 'Accept-Encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toContain('Accept-Encoding')
    // undici fetch transparently decompresses, so body.byteLength is the raw
    // size — the wire transfer size is Content-Length (set to the gzipped len).
    const wire = Number(res.headers.get('content-length'))
    expect(wire).toBeGreaterThan(0)
    expect(wire).toBeLessThanOrEqual(Math.floor(raw * 0.3))
  })

  it('marks hashed assets immutable and HTML no-cache', async () => {
    const src = docsModuleSrc()
    const asset = await fetch(`${base}/docs/${src}`, { headers: { 'Accept-Encoding': 'identity' } })
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const page = await fetch(`${base}/docs/`)
    expect(page.headers.get('cache-control')).toBe('no-cache')
  })

  it('answers conditional requests with a body-less 304', async () => {
    const src = docsModuleSrc()
    const first = await fetch(`${base}/docs/${src}`, { headers: { 'Accept-Encoding': 'identity' } })
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const second = await fetch(`${base}/docs/${src}`, {
      headers: { 'Accept-Encoding': 'identity', 'If-None-Match': etag! },
    })
    expect(second.status).toBe(304)
    expect((await second.arrayBuffer()).byteLength).toBe(0)
    // revalidate must not be blocked by client caches
    expect(second.headers.get('cache-control')).toContain('max-age')
  })

  it('scopes the ETag per encoding so cached variants cannot cross-validate', async () => {
    const src = docsModuleSrc()
    const raw = await fetch(`${base}/docs/${src}`, { headers: { 'Accept-Encoding': 'identity' } })
    const gz = await fetch(`${base}/docs/${src}`, { headers: { 'Accept-Encoding': 'gzip' } })
    expect(gz.headers.get('etag')).not.toBe(raw.headers.get('etag'))
  })

  it('does not double-compress already-compressed formats', async () => {
    const { readdirSync } = await import('node:fs')
    const woff2 = readdirSync(join(docsRenderer, 'assets')).find((f) => f.endsWith('.woff2'))
    expect(woff2).toBeTruthy()
    const res = await fetch(`${base}/docs/assets/${woff2}`, { headers: { 'Accept-Encoding': 'gzip, br' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  it('keeps the SDK route CORS-open while gaining validators', async () => {
    const manifest = join(__dirname, '..', 'dist', 'static', 'sdk', 'sdk-entries.json')
    expect(existsSync(manifest), `Missing SDK bundle manifest: ${manifest}`).toBe(true)
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { entries?: Array<{ out?: string }> }
    const out = parsed.entries?.find((e) => typeof e.out === 'string' && e.out.length > 0)?.out
    expect(out).toBeTruthy()
    // entries are extension-less ("index"); the route serves the emitted twins
    const res = await fetch(`${base}/static/sdk/${out}.mjs`, { headers: { 'Accept-Encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('etag')).toBeTruthy()
    expect(res.headers.get('vary')).toContain('Accept-Encoding')
  })
})

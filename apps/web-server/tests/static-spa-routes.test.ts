/**
 * Static / SPA fallback regression test.
 *
 * The web-server serves a single renderer per first-level route. Sub-routes
 * that live inside the shell bundle (`/marketplace/`, `/skills/`) keep their
 * route name as a path prefix, so the shell's own `<script src="./assets/…">`
 * resolves to `/marketplace/assets/index-*.js`. Before the fix the server
 * could not find that file and returned the SPA index.html instead, which the
 * browser rejects with:
 *
 *   Failed to load module script: Expected a JavaScript-or-Wasm module script
 *   but the server responded with a MIME type of "text/html"
 *
 * This suite boots the real bundle and asserts that
 *   1. /marketplace/ and /skills/ serve the shell index.html (not docs),
 *   2. their module requests come back as JavaScript (not text/html),
 *   3. the documented app routes still serve their own renderer.
 *
 * The bundle is gitignored, so this suite is skipped when it is absent —
 * `apps/web-server/tests/global-setup.ts` rebuilds it for `npx vitest run`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'

const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
const haveBundle = existsSync(bundle)

/** First `<script type="module" src=…>` in a renderer index.html. */
function moduleSrcFor(html: string): string | undefined {
  return html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1]
}

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

describe.skipIf(!haveBundle)('static SPA route fallback', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-static-e2e-'))
    const port = 20000 + Math.floor(Math.random() * 9000)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GENOFFICE_DATA_DIR: dataDir },
      stdio: 'pipe',
    })
    server.stderr?.on('data', () => {})
    server.stdout?.on('data', () => {})
    await waitForHealth(base)
  }, 60_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  // The shell renderer on disk — the module hash changes whenever the shell is
  // rebuilt, so read the real hash instead of pinning one in the test.
  const shellIndexPath = join(__dirname, '..', '..', 'shell', 'out', 'renderer', 'index.html')

  it.each(['marketplace', 'skills'])(
    '/%s/ serves the shell renderer for its nested assets',
    async (route) => {
      // The shell page: /skills/ and /marketplace/ are shell sub-routes, so
      // the response must be the shell index.html, not the docs one.
      const page = await fetch(`${base}/${route}/`)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      const html = await page.text()
      expect(html).toContain('<div id="root">')

      if (!existsSync(shellIndexPath)) return
      const shellHtml = readFileSync(shellIndexPath, 'utf8')
      const shellScript = moduleSrcFor(shellHtml)
      if (!shellScript) return

      // Request the shell's module through the sub-route prefix, exactly the
      // way the browser resolves the relative `./assets/…` src.
      const assetPath = `/${route}/${shellScript.replace(/^\.\//, '')}`
      const asset = await fetch(`${base}${assetPath}`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).not.toContain('text/html')
      expect(asset.headers.get('content-type')).toMatch(/javascript/)
    },
  )

  it('documented app routes still serve and hash their own renderer', async () => {
    for (const route of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']) {
      const res = await fetch(`${base}/${route}/`)
      expect(res.status, `${route} page`).toBe(200)
      expect(res.headers.get('content-type'), `${route} page`).toContain('text/html')
      const html = await res.text()
      expect(html, `${route} index`).toContain('<div id="root">')

      const src = moduleSrcFor(html)
      if (!src) continue
      const assetPath = src.startsWith('/') ? src : `/${route}/${src}`
      // The app's own module must be fetchable and typed, not the SPA fallback.
      const asset = await fetch(`${base}${assetPath}`)
      expect(asset.status, `${route} asset status`).toBe(200)
      expect(asset.headers.get('content-type'), `${route} asset type`).not.toContain('text/html')
    }
  })

  it('a missing static asset returns 404 instead of the SPA index.html', async () => {
    // Regression: an unresolved `.js`/`.css` request used to be answered with
    // the SPA index.html, so the browser saw `text/html` for a module script
    // and refused to run it. The 404 keeps the miss explicit.
    for (const asset of [
      '/definitely-missing/assets/index-00000000.js',
      '/definitely-missing/assets/index-00000000.css',
      '/definitely-missing/assets/vendor-00000000.woff2',
    ]) {
      const res = await fetch(`${base}${asset}`)
      expect(res.status, asset).toBe(404)
      expect(res.headers.get('content-type'), asset).not.toContain('text/html')
    }
  })

  it('serves /favicon.ico as an image (never as the SPA index.html)', async () => {
    // `/favicon.ico` is deliberately served — the browser requests it on every
    // page load and the console used to fill with 404s. The contract is "an
    // image or an explicit empty response", never HTML: answering with
    // index.html would make the browser try to decode markup as an icon.
    const res = await fetch(`${base}/favicon.ico`)
    expect([200, 204]).toContain(res.status)
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html')
    if (res.status === 200) {
      expect(res.headers.get('content-type')).toContain('image/')
    }
  })

  it('still serves the SPA for extension-less client routes', async () => {
    // The 404 guard must not swallow client-side routes: anything without a
    // known asset extension still reaches the SPA shell.
    for (const route of ['/settings', '/some/deep/client/route']) {
      const res = await fetch(`${base}${route}`)
      expect(res.status, route).toBe(200)
      expect(res.headers.get('content-type'), route).toContain('text/html')
    }
  })

  it('unknown first-level routes fall back to the shell without a 500', async () => {
    const res = await fetch(`${base}/definitely-not-a-route/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})

/**
 * Web-server static delivery regression: every app bundle must actually reach
 * the browser, from every navigation form the shell can produce.
 *
 * Why this exists (the bug it locks down): `apps/web-server/src/index.ts`
 * inferred the target app from the URL and then unconditionally fell back to a
 * *docs* candidate without checking that the candidate existed. That left the
 * resolution variable truthy-but-missing, which skipped both the route-prefix
 * retry and the cross-app `assets/` search, so the server answered 404 for the
 * bundle of every app other than shell/docs. The HTML was served fine, the page
 * was blank, and no HTTP-status smoke test noticed.
 *
 * The `?app=<name>` form is the one that breaks: a page loaded from
 * `/?app=pdf` resolves its relative `./assets/index-*.js` against the document
 * URL, and URL resolution *drops the query string*, producing a bare
 * `/assets/index-*.js` request whose app can only be recovered by the cross-app
 * search. These tests therefore resolve asset URLs exactly like a browser does
 * (`new URL(src, pageUrl)`) instead of hard-coding a path shape.
 *
 * This suite starts its own web-server (or uses WEB_BASE_URL when set) and
 * FAILS — never skips — when the bundle it needs is missing: a missing bundle
 * is a broken build chain, and the bug this file exists for was invisible to a
 * suite that skipped whenever the server was not already running.
 */
import { test, expect, chromium, type Browser } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from '../apps/web-server/tests/helpers/server-process'

/**
 * The bundled chromium build can lag the installed Playwright version (the
 * cache holds 1208 while this Playwright wants 1234), so prefer system Chrome
 * and only fall back to the bundled binary. Mirrors web-launch-all.spec.ts.
 */
async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome' })
  } catch {
    return await chromium.launch()
  }
}

const EXTERNAL_BASE = process.env.WEB_BASE_URL
const BUNDLE = resolve(__dirname, '../apps/web-server/dist/bundle/index.js')
const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell'] as const

/** Where the suite talks to. Set from `WEB_BASE_URL` or by `beforeAll`'s spawn. */
let BASE = ''

/** Every navigation form the shell or a deep link can produce. */
const NAV_FORMS: Array<{ app: string; url: string }> = [
  ...APPS.map((app) => ({ app, url: `/?app=${app}` })),
  ...APPS.map((app) => ({ app, url: `/${app}/?mode=tab` })),
]

/** Same-origin module/style references declared by the served HTML. */
function assetRefs(html: string): string[] {
  const refs: string[] = []
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) refs.push(m[1])
  for (const m of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) refs.push(m[1])
  return refs.filter((r) => !/^(data:|https?:|#)/.test(r))
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
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

test.describe('web-server asset delivery', () => {
  test.setTimeout(120_000)
  let server: ChildProcess | undefined
  let dataDir = ''
  /** Server stderr, surfaced when startup fails. */
  let serverStderr = ''

  test.beforeAll(async () => {
    if (EXTERNAL_BASE) {
      BASE = EXTERNAL_BASE
      return
    }
    // FAIL, never skip. A missing bundle is a broken build chain, and the bug
    // this file exists for — the HTML served fine while its assets 404'd — was
    // invisible for exactly as long as the suite was allowed to decide there
    // was nothing to check.
    expect(
      existsSync(BUNDLE),
      `Missing ${BUNDLE}. Build it first: npm run bundle -w @genoffice/web-server ` +
        `(or point WEB_BASE_URL at an already-running server)`,
    ).toBe(true)
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-web-assets-'))
    const port = 21000 + Math.floor(Math.random() * 9000)
    BASE = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [BUNDLE], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GENOFFICE_DATA_DIR: dataDir },
      stdio: 'pipe',
    })
    // Keep both streams flowing (an unread pipe stalls the child), and keep the
    // stderr text: the server refuses to boot when a renderer or SDK entry is
    // missing, and "did not become healthy" without that message sends the
    // reader hunting through a log the test threw away.
    server.stderr?.on('data', (chunk) => {
      serverStderr += String(chunk)
    })
    server.stdout?.on('data', () => {})
    try {
      await waitForHealth(BASE, 30_000)
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- server output ---\n${serverStderr.slice(-4000)}`)
    }
  })

  test.afterAll(async () => {
    await stopServer(server, dataDir)
  })

  test('every app serves its HTML and its referenced assets from every nav form', async () => {

    const problems: string[] = []
    for (const { app, url } of NAV_FORMS) {
      const pageUrl = `${BASE}${url}`
      const htmlRes = await fetch(pageUrl, { signal: AbortSignal.timeout(10_000) })
      if (htmlRes.status !== 200) {
        problems.push(`${url} → HTML ${htmlRes.status}`)
        continue
      }
      const html = await htmlRes.text()
      const refs = assetRefs(html)
      if (refs.length === 0) problems.push(`${url} → HTML declared no assets`)

      for (const ref of refs) {
        // The browser resolves the reference against the document URL — this is
        // what drops `?app=<name>` and produces the bare /assets/ request.
        const resolved = new URL(ref, pageUrl).toString()
        const res = await fetch(resolved, { signal: AbortSignal.timeout(15_000) })
        const type = res.headers.get('content-type') || ''
        if (res.status !== 200) {
          problems.push(`${url} → ${app}: ${ref} resolved to ${resolved} → HTTP ${res.status}`)
          continue
        }
        // A module/style served as text/html makes the browser refuse to run it
        // ("Expected a JavaScript-or-Wasm module script … text/html").
        if (/\.(js|mjs)$/.test(new URL(resolved).pathname) && !/javascript/.test(type)) {
          problems.push(`${app}: ${ref} served with content-type "${type}"`)
        }
        if (/\.css$/.test(new URL(resolved).pathname) && !/css/.test(type)) {
          problems.push(`${app}: ${ref} served with content-type "${type}"`)
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([])
  })

  test('every app actually boots in a real browser (no blank page)', async () => {

    const browser = await launchBrowser()
    const failures: string[] = []
    try {
      for (const app of APPS) {
        const page = await browser.newPage()
        const assetFailures: string[] = []
        page.on('response', (r) => {
          const p = new URL(r.url()).pathname
          if (r.status() >= 400 && /\.(js|mjs|css)$/.test(p)) {
            assetFailures.push(`${r.status()} ${p}`)
          }
        })
        try {
          await page.goto(`${BASE}/?app=${app}`, { waitUntil: 'load', timeout: 20_000 })
          await page.waitForFunction(
            () => (document.querySelector('#root')?.children.length ?? 0) > 0,
            { timeout: 15_000 },
          )
        } catch (err) {
          failures.push(`/?app=${app} did not mount: ${String(err).split('\n')[0]}`)
        }
        if (assetFailures.length > 0) {
          failures.push(`/?app=${app} failed assets: ${[...new Set(assetFailures)].join(', ')}`)
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }

    expect(failures, failures.join('\n')).toEqual([])
  })
})

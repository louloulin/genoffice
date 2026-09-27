/**
 * Embed under a path prefix — the C27 dimension, which had no gate.
 *
 * Production mounts this server behind a path prefix (Dataflarework uses
 * `/office-engine` with `strip-path-prefix: true`). The server never learns
 * what the prefix was — the host erases it before forwarding — so anything the
 * embed page asks for must be resolvable *relative to where the page was
 * served*, never root-relative. A `/assets/…` or `/api/…` reference resolves
 * against the HOST's origin under the prefix, the host forwards only its own
 * mount path, and the iframe renders blank.
 *
 * That regression shipped once and every unprefixed test stayed green, because
 * `WEB_PATH_PREFIX` had no coverage outside two probes that CI never ran. This
 * suite parses `apps/sdk/scripts/...`-independent, boots the real bundle with
 * the prefix armed, and asks the questions a browser asks: serve the embed,
 * then fetch every reference the served HTML declares — through the prefix.
 *
 * Both halves of the old break are pinned so neither can return quietly:
 *   - the HTML's `<base>` and its asset references must be directory-relative
 *     (a revert to `<base href="/">` fails the `<base>` assertion);
 *   - the bridge must resolve its API root from its own script URL, never from
 *     a root-relative literal (a revert to `new EventSource('/api/...')` fails
 *     the bridge assertion).
 *
 * Scope note: the "no root-relative reference" rule is asserted over `<script
 * src>` / `<link href>` attribute values and the bridge's EventSource call —
 * not over whole documents. The HTML legitimately contains injected JSON and
 * meta content, and the bridge's own comments discuss root-relative paths;
 * scanning for a leading `/` would fail on correct content and invite someone
 * to weaken the assertion instead of fixing the code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'

const PREFIX = 'office-engine'
const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')

/** Same-origin references a browser resolves and fetches for the page. */
function assetRefs(html: string): string[] {
  const refs: string[] = []
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) refs.push(m[1])
  for (const m of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) refs.push(m[1])
  return refs.filter((r) => !/^(data:|https?:|#|\/\/)/.test(r))
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

describe('embed behind WEB_PATH_PREFIX', () => {
  let server: ChildProcess | undefined
  let origin: string
  let dataDir: string
  let serverStderr = ''

  beforeAll(async () => {
    expect(
      existsSync(bundle),
      `Missing ${bundle}. Build it first: npm run bundle -w @genoffice/web-server`,
    ).toBe(true)
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-embed-prefix-'))
    const port = 30000 + Math.floor(Math.random() * 9000)
    origin = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        GENOFFICE_DATA_DIR: dataDir,
        WEB_PATH_PREFIX: `/${PREFIX}`,
      },
      stdio: 'pipe',
    })
    server.stderr?.on('data', (chunk) => {
      serverStderr += String(chunk)
    })
    server.stdout?.on('data', () => {})
    try {
      await waitForHealth(origin)
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- server output ---\n${serverStderr.slice(-4000)}`)
    }
  }, 60_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('serves the embed HTML under the prefix', async () => {
    const res = await fetch(`${origin}/${PREFIX}/embed/doc_abc?token=t&app=docs`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('declares a directory-relative base and bridge, and no root-relative asset', async () => {
    const res = await fetch(`${origin}/${PREFIX}/embed/doc_abc?token=t&app=docs`)
    const html = await res.text()

    // The `<base>` decides how every relative reference resolves. `"/"` sends
    // them to the host's origin, which is the C27 blank-iframe regression.
    expect(html).toContain('<base href="./">')
    expect(html).not.toContain('<base href="/">')

    // The bridge is directory-relative for the same reason.
    expect(html).toContain('<script src="static/bridge.js"></script>')

    const refs = assetRefs(html)
    expect(refs.length, `embed HTML declared no assets:\n${html}`).toBeGreaterThan(0)
    const rootRelative = refs.filter((r) => r.startsWith('/'))
    expect(rootRelative, `root-relative references resolve against the HOST: ${rootRelative.join(', ')}`).toEqual([])
  })

  it('serves every reference the embed declares, through the prefix', async () => {
    const pageUrl = `${origin}/${PREFIX}/embed/doc_abc?token=t&app=docs`
    const html = await (await fetch(pageUrl)).text()

    // Resolve exactly as the browser does: a declared `<base href>` REPLACES
    // the document URL as the resolution base for every relative reference.
    // Resolving against `pageUrl` instead would make this test pass even when
    // `<base href="/">` is present — the assets would resolve to the prefixed
    // paths this server does serve, while a real browser would ask the host.
    const baseHref = html.match(/<base[^>]*\shref="([^"]*)"/)?.[1]
    expect(baseHref, `embed HTML declares no <base>:\n${html}`).toBeDefined()
    const resolutionBase = new URL(baseHref as string, pageUrl).toString()

    for (const ref of assetRefs(html)) {
      const resolved = new URL(ref, resolutionBase).toString()
      expect(resolved.startsWith(`${origin}/${PREFIX}/`), `${ref} escaped the prefix: ${resolved}`).toBe(true)

      const asset = await fetch(resolved)
      expect(asset.status, `${ref} → ${resolved}`).toBe(200)
      // Modules served as text/html are refused by the browser.
      if (/\.(js|mjs)$/.test(new URL(resolved).pathname)) {
        expect(asset.headers.get('content-type'), `${ref} content-type`).toMatch(/javascript/)
      }
    }
  })

  it('serves a bridge whose API root is derived, not root-relative', async () => {
    const res = await fetch(`${origin}/${PREFIX}/embed/static/bridge.js`)
    expect(res.status).toBe(200)
    const src = await res.text()

    // Pinned to the call site, not to a document-wide `/` scan: the bridge's
    // comments mention the root-relative form they replaced, and its own
    // script path is a slash-prefixed constant by design.
    expect(src).toContain("new EventSource(apiUrl('api/ipc/events')")
    expect(src).not.toMatch(/new EventSource\(\s*['"`]\//)
  })
})

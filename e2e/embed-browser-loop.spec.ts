/**
 * G2.8 — the embed iframe closed loop, in a REAL browser, behind the REAL
 * Dataflarework path prefix.
 *
 * `embed-loop-probe.mjs` proves the host↔guest postMessage loop, but it runs
 * against a harness host that proxies `/assets` and `/static` at its own root
 * *in addition to* `/office-engine`. That is not how Dataflarework deploys, and
 * it is precisely what let C27 (root-relative `<base href="/">`, root-relative
 * `new EventSource('/api/ipc/events…')`) pass in the harness and render a blank
 * iframe in production. This file is the gate for the real topology: the host
 * forwards **one** prefix, `/office-engine`, and nothing else, so any
 * root-relative reference in the embed page asks the *host* for a path it does
 * not forward.
 *
 * Four hops, each asserted on real evidence rather than on absence of error:
 *
 *   1. mount   — the editor DOM really appears inside the iframe
 *   2. ready   — a `ready` envelope with the URL nonce reaches the host window
 *   3. push    — the bridge's `EventSource` resolved to the *prefixed*
 *                `/office-engine/api/ipc/events` URL, got 200
 *                `text/event-stream`, and real bytes (`connected`) came back
 *   4. command — a `host→editor` command round-trips to a `command-result`
 *
 * Fail closed: a missing bundle, a missing fixture, a server that never boots
 * and a browser that will not launch are all red. Nothing here skips.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { stopServer } from '../apps/web-server/tests/helpers/server-process'

const ROOT = resolve(__dirname, '..')
const SERVER_BUNDLE = join(ROOT, 'apps', 'web-server', 'dist', 'bundle', 'index.js')
const DOCX_FIXTURE = join(ROOT, 'fixtures', 'generated', 'simple.docx')

/**
 * The single prefix the host forwards. Dataflarework mounts GenOffice at
 * `/office-engine` with `strip-path-prefix: true`
 * (`OfficeEngineProxyController`); nothing else of the engine is reachable
 * through the host. Hardcoded, never an env knob — a gate whose strictness is
 * settable from the environment is not a gate.
 */
const ENGINE_PREFIX = '/office-engine'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Reserve `n` distinct ports. Reserving them one at a time and closing each
 * before the next lets the OS hand out the same ephemeral port twice, so one
 * side silently talks to the other. Keep every socket open until all are taken.
 */
async function reservePorts(n: number): Promise<number[]> {
  const probes: import('node:http').Server[] = []
  try {
    for (let i = 0; i < n; i++) {
      probes.push(
        await new Promise<import('node:http').Server>((res, rej) => {
          const s = createServer()
          s.once('error', rej)
          s.listen(0, '127.0.0.1', () => res(s))
        }),
      )
    }
    return probes.map((s) => (s.address() as import('node:net').AddressInfo).port)
  } finally {
    await Promise.all(probes.map((s) => new Promise((r) => s.close(r))))
  }
}

const b64url = (input: string) => Buffer.from(input).toString('base64url')

function mintJwt(secret: string, sub: string, scope: string[]): string {
  const now = Math.floor(Date.now() / 1000)
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ sub, scope, iat: now, exp: now + 3600, iss: 'genoffice', aud: 'genoffice-web' }),
  )}`
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`
}

/**
 * The host page. Hand-rolled on purpose: it must not pull in the SDK host
 * bridge, or a bridge regression and a spec regression would be
 * indistinguishable. What it does do is observe the wire exactly as a host has
 * to — a raw `message` listener installed *before* the iframe gets a `src` (the
 * guest posts `ready` from its script's top level, so anything later misses
 * it), and a `sendCommand` that speaks the `host→editor` envelope the bridge's
 * `onHostMessage` accepts.
 */
function hostHtml(cfg: { url: string; nonce: string }): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>embed-browser-loop host</title></head>
<body style="margin:0">
<div id="banner" style="font:12px system-ui;padding:4px">host page</div>
<script>
const CFG = ${JSON.stringify(cfg)};
window.__state = { events: [], results: [], errors: [] };
const pending = new Map();
let correlation = 0;

// Raw observer, installed before the iframe exists. The SDK's own bridge drops
// envelopes whose sessionId does not match; this one does not, so "the guest
// never sent it" stays distinguishable from "the host bridge filtered it".
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || d.v !== '1.0' || d.dir !== 'editor→host') return;
  if (d.kind === 'event') {
    window.__state.events.push({ name: d.payload && d.payload.name, payload: d.payload && d.payload.payload });
  } else if (d.kind === 'command-result') {
    window.__state.results.push(d);
    const resolve = pending.get(d.correlationId);
    if (resolve) { pending.delete(d.correlationId); resolve(d); }
  }
});

const iframe = document.createElement('iframe');
iframe.id = 'office';
iframe.style.cssText = 'width:1200px;height:800px;border:0';
document.body.appendChild(iframe);

window.__host = {
  sendCommand(name, args) {
    return new Promise((resolve, reject) => {
      const correlationId = 'cmd-' + (++correlation);
      const timer = setTimeout(() => {
        pending.delete(correlationId);
        reject(new Error('no command-result for ' + name + ' within 20s'));
      }, 20000);
      pending.set(correlationId, (d) => { clearTimeout(timer); resolve(d); });
      iframe.contentWindow.postMessage({
        v: '1.0', dir: 'host→editor', kind: 'command', correlationId,
        payload: { name: name, args: args === undefined ? {} : args },
      }, '*');
    });
  },
  ready: () => CFG,
};

iframe.src = CFG.url;
window.addEventListener('error', (e) => { window.__state.errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => { window.__state.errors.push('rejection: ' + String(e.reason)); });
</script>
</body></html>`
}

test.describe.configure({ mode: 'serial' })

test.describe('embed iframe closed loop behind the /office-engine prefix (G2.8)', () => {
  test.setTimeout(240_000)

  let server: ChildProcess | undefined
  let hostServer: import('node:http').Server | undefined
  let browser: Browser | undefined
  let dataDir = ''
  let engineBase = ''
  let hostBase = ''
  let docId = ''
  let nonce = ''
  let embedUrl = ''
  /** Upstream SSE bytes, keyed by the request URL the host proxy saw. */
  const sseTaps = new Map<string, string>()

  test.beforeAll(async () => {
    // Fail closed. A missing artifact is a broken build chain, never a reason
    // to pass quietly.
    expect(existsSync(SERVER_BUNDLE), `Missing ${SERVER_BUNDLE} — build it: npm run bundle -w @genoffice/web-server`).toBe(true)
    expect(existsSync(DOCX_FIXTURE), `Missing ${DOCX_FIXTURE}`).toBe(true)

    const [enginePort, hostPort] = await reservePorts(2)
    engineBase = `http://127.0.0.1:${enginePort}`
    hostBase = `http://127.0.0.1:${hostPort}`

    // 1. A disposable GenOffice on loopback with an isolated DATA_DIR, carrying a
    //    JWT secret (so the embed token is really verified) and NO WEB_TOKEN —
    //    the Dataflarework deployment posture, where the gateway owns Gate 1
    //    and injects the operator token upstream.
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-embed-loop-spec-'))
    const secret = randomBytes(32).toString('hex')
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(enginePort), DATA_DIR: dataDir, GENOFFICE_JWT_SECRET: secret }
    delete env.WEB_TOKEN
    server = spawn(process.execPath, [SERVER_BUNDLE], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    server.stdout?.on('data', (c) => (log += String(c)))
    server.stderr?.on('data', (c) => (log += String(c)))
    const deadline = Date.now() + 30_000
    for (;;) {
      if (server.exitCode !== null) throw new Error(`web-server exited ${server.exitCode}\n${log}`)
      try {
        if ((await fetch(`${engineBase}/health`)).ok) break
      } catch { /* keep polling */ }
      if (Date.now() > deadline) throw new Error(`web-server never healthy\n${log}`)
      await sleep(250)
    }

    // 2. A real document to point the embed at — the SDK command handlers
    //    resolve `docId` against <DATA_DIR>/files, so a fake id proves nothing.
    //    `POST /api/v1/files` declares the hard `files:write` scope, so it
    //    needs a bearer even though Gate 1 is open.
    const bearer = mintJwt(secret, 'embed-browser-loop', ['files:read', 'files:write'])
    const upload = await fetch(`${engineBase}/api/v1/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ name: 'embed-browser-loop.docx', bytes: readFileSync(DOCX_FIXTURE).toString('base64') }),
    })
    const uploaded = (await upload.json().catch(() => ({}))) as { id?: string }
    expect(upload.status, `file upload failed: ${JSON.stringify(uploaded)}`).toBe(201)
    expect(typeof uploaded.id, 'upload response carried no id').toBe('string')
    docId = uploaded.id!

    // No `sessionId` in the URL: that opt-in would demand a server-minted
    // nonce pairing we do not need here. The embed HTML still bakes a
    // per-request sessionId into its config meta, which is what the SSE
    // channel and the IPC session header ride on.
    nonce = `nonce-${Date.now().toString(36)}`
    embedUrl =
      `${hostBase}${ENGINE_PREFIX}/embed/${encodeURIComponent(docId)}` +
      `?token=${encodeURIComponent(bearer)}` +
      `&app=docs&nonce=${encodeURIComponent(nonce)}`

    // 3. The host: the host page at `/`, and exactly one forwarded prefix.
    const page = hostHtml({ url: embedUrl, nonce })
    hostServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', hostBase)
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(page)
        return
      }
      if (url.pathname !== ENGINE_PREFIX && !url.pathname.startsWith(`${ENGINE_PREFIX}/`)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end(`host proxy: ${url.pathname} is not proxied (only ${ENGINE_PREFIX})`)
        return
      }
      const upstreamPath = url.pathname.slice(ENGINE_PREFIX.length) || '/'
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: new URL(engineBase).port,
          method: req.method,
          path: upstreamPath + url.search,
          headers: { ...req.headers, host: `127.0.0.1:${new URL(engineBase).port}` },
        },
        (up) => {
          // Tee the SSE body as it crosses the prefix. Playwright cannot hand
          // back a streaming response body and CDP's dataReceived carries no
          // payload in current Chromium, so this is where "the bytes really
          // came back" is observable. It also proves the proxy streamed rather
          // than buffered: a buffered proxy would not see a chunk until close.
          if (url.pathname === `${ENGINE_PREFIX}/api/ipc/events`) {
            up.on('data', (chunk: Buffer) => {
              const key = req.url ?? ''
              sseTaps.set(key, ((sseTaps.get(key) ?? '') + chunk.toString('utf8')).slice(0, 4096))
            })
          }
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        },
      )
      upstream.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end(`proxy error: ${err.message}`)
      })
      req.pipe(upstream)
    })
    await new Promise<void>((r) => hostServer!.listen(new URL(hostBase).port, '127.0.0.1', () => r()))

    browser = await launchBrowser()
  })

  test.afterAll(async () => {
    await browser?.close()
    if (hostServer) await new Promise((r) => hostServer!.close(r))
    await stopServer(server)
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  /** Fresh page per test, with the raw `message` observer already in place. */
  async function openHost(): Promise<Page> {
    const page = await browser!.newPage()
    const failures: string[] = []
    page.on('requestfailed', (r) => failures.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`))
    await page.goto(`${hostBase}/`, { waitUntil: 'domcontentloaded' })
    return page
  }

  /** The frame the guest document runs in — the bridge is in there, not here. */
  async function embedFrame(page: Page): Promise<import('@playwright/test').Frame> {
    for (let i = 0; i < 120; i++) {
      const frame = page.frames().find((f) => f.url().includes(`${ENGINE_PREFIX}/embed/`))
      if (frame) return frame
      await sleep(250)
    }
    throw new Error(`no frame ever loaded ${ENGINE_PREFIX}/embed/…`)
  }

  test('the embed document and its bundle resolve through the prefix, and the editor mounts', async () => {
    // Hop 0, over plain HTTP: the document itself, and the reverse assertion
    // that its own references are prefix-resolvable. Scoped to `<base>` and to
    // `src`/`href` attribute values — a whole-page scan for `/` would flag
    // correct content and teach the next reader to weaken the check.
    const doc = await fetch(embedUrl)
    const html = await doc.text()
    expect(doc.status).toBe(200)
    expect(html).toContain('<base href="./">')
    expect(html).not.toMatch(/<script[^>]*\bsrc="\//i)
    expect(html).not.toMatch(/<link[^>]*\bhref="\//i)

    const page = await openHost()
    const frame = page.frameLocator('#office')
    // Hop 1: the editor really rendered. A 200 HTML shell with a blank iframe
    // is exactly the C27 failure mode, and a status check cannot see it.
    await expect(frame.locator('.editor-scroll .ProseMirror')).toBeVisible({ timeout: 60_000 })

    // The bundle came from the engine mount, not the host root: the host
    // answers 404 for anything outside the prefix, so a non-blank editor is
    // itself the proof that every asset URL carried the prefix.
    await expect(page.locator('#banner')).toBeVisible()
    await page.close()
  })

  test('the bridge posts `ready` to the host with the URL nonce echoed back', async () => {
    const page = await openHost()
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __state: { events: Array<{ name: string; payload: { nonce?: string } | null }> } }).__state.events),
        { timeout: 60_000, intervals: [250] },
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ready' })]))

    const ready = await page.evaluate(
      () => (window as unknown as { __state: { events: Array<{ name: string; payload: Record<string, unknown> | null }> } }).__state.events.find((e) => e.name === 'ready'),
    )
    // The nonce is the anti-substitution check (sdk1.md §11.20): the host
    // compares it against the one it put in the URL. A `ready` without it is
    // a mount from somewhere else, so assert the value, not just presence.
    expect(ready!.payload?.nonce).toBe(nonce)
    expect(ready!.payload?.app).toBe('docs')
    await page.close()
  })

  test('the push channel connects to the PREFIXED events URL and delivers real bytes', async () => {
    const page = await openHost()
    // Two independent observations, because either alone is weak: the init
    // script records the URL the bridge actually resolved, and the host proxy
    // tees the bytes that came back. Both have to be armed before the guest
    // boots — the bridge opens its EventSource from a DOMContentLoaded
    // callback, which lands long before a `goto` returns.
    await page.addInitScript(() => {
      const w = window as unknown as { __sse: { urls: string[]; opened: number }; EventSource: typeof EventSource }
      w.__sse = { urls: [], opened: 0 }
      const Real = w.EventSource
      const Wrapped = function (this: unknown, url: string, opts?: EventSourceInit) {
        w.__sse.urls.push(String(url))
        const es = new Real(url, opts)
        es.addEventListener('open', () => { w.__sse.opened++ })
        return es
      } as unknown as typeof EventSource
      Wrapped.prototype = Real.prototype
      w.EventSource = Wrapped
    })
    const responses = new Map<string, { status: number; contentType: string }>()
    page.on('response', (r) => {
      if (r.url().includes('/api/ipc/events')) {
        responses.set(r.url(), { status: r.status(), contentType: r.headers()['content-type'] ?? '' })
      }
    })

    await page.goto(`${hostBase}/`, { waitUntil: 'domcontentloaded' })
    // The bridge runs in the guest frame, so `__sse` lives on that frame's
    // window — reading it off the page would only ever see the empty
    // top-frame object.
    const frame = await embedFrame(page)

    // Two streams are expected and both must be prefixed: the bridge's own
    // `subscribePush`, plus the docs renderer's push hub. The assertion is on
    // the resolved *pathname* rather than on an exact string, because the
    // session id is server-minted per request. The reverse case is the point:
    // a bare `/api/ipc/events` would be asked of the host, which forwards only
    // `/office-engine`, and the channel would die silently (C27).
    await expect
      .poll(
        () =>
          frame
            .evaluate(() => (window as unknown as { __sse: { urls: string[] } }).__sse.urls)
            .then((urls) => urls.filter((u) => u.includes('/api/ipc/events'))),
        { timeout: 60_000, intervals: [250] },
      )
      .not.toHaveLength(0)

    const urls = await frame.evaluate(() => (window as unknown as { __sse: { urls: string[] } }).__sse.urls)
    // The two sides record URLs differently — the init script sees whatever
    // string the constructor got (some callers pass a document-relative one),
    // Playwright always reports the resolved absolute URL. Normalise before
    // matching, or the join silently misses.
    const streams = urls.filter((u) => u.includes('/api/ipc/events')).map((u) => new URL(u, hostBase).toString())
    for (const u of streams) {
      expect(new URL(u).pathname).toBe(`${ENGINE_PREFIX}/api/ipc/events`)
    }

    const opened = await frame.evaluate(() => (window as unknown as { __sse: { opened: number } }).__sse.opened)
    expect(opened).toBeGreaterThan(0)

    for (const u of streams) {
      const response = responses.get(u)
      expect(response, `no response observed for ${u}`).toBeTruthy()
      expect(response!.status).toBe(200)
      expect(response!.contentType).toContain('text/event-stream')
    }

    // A 200 + an `open` event is still "no error" — it does not prove a single
    // byte of stream came back. Assert the real payload: the server's opening
    // `: connected` comment, tapped as it crossed the prefix. Scoped to this
    // page's own sessionId so another test's stream cannot satisfy it.
    const sessionId = await frame.evaluate(
      () => document.querySelector('meta[name="genoffice-session"]')?.getAttribute('content') ?? '',
    )
    expect(sessionId).not.toBe('')
    const tapKey = `${ENGINE_PREFIX}/api/ipc/events?session=${sessionId}`
    await expect
      .poll(() => sseTaps.get(tapKey) ?? '', { timeout: 30_000, intervals: [250] })
      .toContain('connected')
    await page.close()
  })

  test('an SDK command round-trips host → iframe → IPC → command-result', async () => {
    const page = await openHost()
    // The real docs renderer installs window.__GENOFFICE_COMMAND_SINK__ at
    // boot, and its handler map is small (defaultSdkCommandHandlers is just
    // openFileDialog + print). So this test is also the standing proof that
    // the bridge reads an UNSUPPORTED sink rejection as "not mine" and hands
    // off to the server channel rather than short-circuiting on the sink —
    // without that fall-through every command below would come back
    // UNSUPPORTED and the whole server-backed subset would be unreachable
    // from a real embed.
    // Gate on the `ready` handshake, not on `__host` existing: the host page's
    // script runs long before the guest document does, and a command posted
    // into an iframe whose bridge has not yet installed its `message` listener
    // is silently dropped. `ready` is the guest's own signal that it is
    // listening.
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __state: { events: Array<{ name: string }> } }).__state.events.some((e) => e.name === 'ready')),
        { timeout: 60_000, intervals: [250] },
      )
      .toBe(true)

    type Result = { payload: { ok: boolean; result?: { comments?: Array<{ id: string; text: string }> }; error?: { code: string } } }
    const command = async (name: string, args: unknown = {}): Promise<Result> =>
      (await page.evaluate(
        ([n, a]) => (window as unknown as { __host: { sendCommand: (n: string, a: unknown) => Promise<Result> } }).__host.sendCommand(n as string, a),
        [name, args] as const,
      )) as Result

    // Read path. This is the one that proves the whole chain: the bridge read
    // `docId`/`sessionId` out of the injected config meta, POSTed to the
    // PREFIXED /api/ipc/sdk:command, and the dispatcher resolved the docId
    // against managed storage. Before the bridge used readEmbedConfig(), docId
    // was undefined and this came back INVALID_ARGUMENT every time.
    const listed = await command('listComments')
    expect(listed.payload.ok, JSON.stringify(listed.payload)).toBe(true)
    expect(listed.payload.result?.comments).toEqual([])

    // Write path, then read it back over a second round trip — the first
    // assertion could pass against a store that never persists.
    const added = await command('addComment', { text: 'g2.8 round trip', anchor: { cell: 'C3' } })
    expect(added.payload.ok, JSON.stringify(added.payload)).toBe(true)
    const relisted = await command('listComments')
    expect(relisted.payload.result?.comments).toEqual([
      expect.objectContaining({ id: added.payload.result && (added.payload.result as { id: string }).id, text: 'g2.8 round trip' }),
    ])

    // Reverse assertion: a command nobody implements must fail loudly and
    // structurally. A silently-hanging or silently-ok bridge is the failure
    // mode that makes hosts ship broken integrations.
    const unknown = await command('notARealCommand')
    expect(unknown.payload.ok).toBe(false)
    expect(unknown.payload.error?.code).toBe('WEB_UNSUPPORTED')
    await page.close()
  })
})

/**
 * Prefer the system Chrome: the bundled chromium build can lag the installed
 * Playwright version, and a silent fallback turns a launch problem into a
 * confusing protocol failure. Both attempts are reported when neither works.
 */
async function launchBrowser(): Promise<Browser> {
  const errors: string[] = []
  for (const opts of [{ channel: 'chrome' as const }, {}]) {
    try {
      return await chromium.launch(opts)
    } catch (err) {
      errors.push(`  ${JSON.stringify(opts)} → ${String((err as Error)?.message ?? err).split('\n')[0]}`)
    }
  }
  throw new Error(`no launchable browser (run: npx playwright install chromium)\n${errors.join('\n')}`)
}

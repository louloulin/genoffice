/**
 * T1 — real-browser embed-loop probe, Dataflarework topology.
 *
 * Proves the whole embed editing loop against a *disposable* web-server and a
 * real Chromium, in the same shape Dataflarework deploys:
 *
 *   browser ──► host page  http://127.0.0.1:H/            (the "Dataflarework" shell)
 *                 └ iframe  http://127.0.0.1:H/office-engine/embed/<docId>?token=…
 *                            │  proxied, prefix-stripped, to the GenOffice web-server
 *                            └ editor boots, guest bridge posts `ready`
 *
 * The host page is NOT hand-rolled protocol code — it loads the SDK host
 * bundle from the real distribution channel
 * (`/office-engine/static/sdk/dataflare-host.umd.js`) and uses
 * `installDataflareHostBridge` + `postCommandToGuest`. That is the point:
 * if this passes, `#19 W6a` (Dataflarework switching onto the SDK) is proven
 * to be mechanically possible.
 *
 * Run:
 *     node e2e/embed-loop-probe.mjs
 *
 * Env knobs:
 *     PROBE_SKIP_BUILD=1        reuse existing dist/ (SDK + server + app builds)
 *     PROBE_KEEP=1              leave the temp DATA_DIR for inspection
 *     PROBE_DOCUMENT_SOURCE=office
 *                               run the T3/G4 reproduction instead: the host
 *                               sends `documentSource: 'office'` (what a direct
 *                               link to the workspace actually gets), the guest
 *                               neither fetches nor uploads, and the report is
 *                               "G4 REPRODUCED" when that silent local save is
 *                               observed. Default is `knowledge` (the loop).
 *     HEADED=1                  run with a visible browser
 *
 * The set of prefixes the fake host proxy forwards is a constant, not an env
 * knob. It used to be `PROBE_PROXY_PREFIXES`, and the only way to use it was
 * to widen it — adding `/assets` + `/static` asks the host to serve the editor
 * bundle at the origin root, which no real deployment does, and that default
 * masked a genuine break: `<base href="/">` in the embed HTML pointed the
 * bundle at the host's `/assets/…`, so the iframe rendered blank under the real
 * prefix while this harness reported LOOP OK. A gate whose looseness is an
 * environment variable is not a gate.
 */
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, randomBytes } from 'node:crypto'
import { chromium } from '@playwright/test'
import JSZip from 'jszip'
import { openEmbedSession } from '../apps/sdk/dist/file-embed.mjs'
import { buildDataflareEmbedUrl } from '../apps/sdk/dist/dataflare-host.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const serverBundle = join(repoRoot, 'apps', 'web-server', 'dist', 'bundle', 'index.js')
const sdkHostUmd = join(repoRoot, 'apps', 'web-server', 'dist', 'static', 'sdk', 'dataflare-host.umd.js')
const docxFixture = join(repoRoot, 'fixtures', 'generated', 'simple.docx')

const findings = []
const note = (ok, what, detail) => {
  findings.push({ ok, what, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
}

// Filled during the run; printed in the final report (A24/A20 outputs).
let probeTiming = null
let probeTransfer = null
let probeFirstScreen = null

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Reserve `n` distinct ports. Reserving them one at a time and closing each
 * before the next would let the OS hand out the same ephemeral port twice —
 * the second bind then fails, or worse, one side silently talks to the other.
 * Keep every socket open until all ports are collected.
 */
async function reservePorts(n) {
  const probes = []
  try {
    for (let i = 0; i < n; i++) {
      probes.push(
        await new Promise((res, rej) => {
          const s = createServer()
          s.once('error', rej)
          s.listen(0, '127.0.0.1', () => res(s))
        }),
      )
    }
    return probes.map((s) => s.address().port)
  } finally {
    await Promise.all(probes.map((s) => new Promise((r) => s.close(r))))
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}
function mintJwt(secret, sub, scope) {
  const now = Math.floor(Date.now() / 1000)
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ sub, scope, iat: now, exp: now + 3600, iss: 'genoffice', aud: 'genoffice-web' }),
  )}`
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── boot the disposable GenOffice web-server ───────────────────────────────

let serverProc = null
let serverLog = ''
let dataDir = ''
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  if (serverProc && serverProc.exitCode === null) serverProc.kill('SIGTERM')
  if (process.env.PROBE_KEEP === '1') {
    console.log(`\n[probe] temp data dir kept: ${dataDir}`)
    return
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {}
}
process.on('exit', cleanup)

async function startServer(port, secret) {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    GENOFFICE_JWT_SECRET: secret,
  }
  // Match the Dataflarework deployment: GenOffice carries no WEB_TOKEN of its
  // own (auth is the gateway's job) — see docker/docker-compose.yaml there.
  delete env.WEB_TOKEN
  serverProc = spawn(process.execPath, [serverBundle], {
    cwd: dirname(serverBundle),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', (c) => (serverLog += String(c)))
  serverProc.stderr.on('data', (c) => (serverLog += String(c)))
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null) throw new Error(`server exited ${serverProc.exitCode}\n${serverLog}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
      if (r.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error(`server never healthy\n${serverLog}`)
}

// ── the host page (served on its own origin, mirrors Dataflarework) ─────────

function hostHtml(cfg) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>embed-loop-probe host</title>
<script src="/office-engine/static/sdk/dataflare-host.umd.js"></script>
</head>
<body style="margin:0">
<div id="banner" style="font:12px system-ui;padding:4px">host page — embedding GenOffice</div>
<script>
const CFG = ${JSON.stringify(cfg)};
const log = [];
window.__state = { events: [], commands: [], requests: [], savedB64: null, errors: [] };
// A24 five-layer timing: first-occurrence host-clock timestamp per mark tag.
// "mark" stays string-compatible (log.push(tag)) so the existing waitLog
// contract is untouched; __state.t is additive.
window.__state.t = {};
function mark(tag, extra) {
  log.push(tag);
  window.__state.log = log;
  if (window.__state.t[tag] === undefined) window.__state.t[tag] = performance.now();
  if (extra !== undefined) console.log(tag, extra);
}

function decodeB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function encodeJson(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).buffer;
}

const iframe = document.createElement('iframe');
iframe.id = 'office';
iframe.style.cssText = 'width:1200px;height:800px;border:0';
document.body.appendChild(iframe);

// Raw, unguarded observer installed BEFORE the bridge: tells "the guest never
// sent it" apart from "the bridge dropped it on the sessionId check". The
// bootstrap handshake (ready / global-state-request) is posted from the guest's
// module top level, when it has not been told a sessionId yet.
window.__state.raw = [];
// A20 byte accounting (host side): "served" = document bytes handed to the
// guest over postMessage; "savedUpload" = bytes the guest sent back on save.
// The proxied HTTP IPC traffic ("web:write-temp-file" upload, "docs:open-path"
// read-back) is counted node-side where the proxy lives.
window.__state.bytes = { served: 0, savedUpload: 0 };
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.protocol !== 'genoffice-dataflare/v1') return;
  window.__state.raw.push({
    kind: d.kind,
    type: d.payload && d.payload.type,
    sessionId: d.sessionId || null,
  });
});

// Install the host bridge BEFORE the guest boots: the guest posts 'ready' from
// its module top-level, so an onload-time install would miss it entirely.
const SDK = window.GenOfficeDataflareHost;
mark('sdk-global:' + (SDK && SDK.installDataflareHostBridge ? 'present' : 'MISSING'));
const uninstall = SDK.installDataflareHostBridge(iframe.contentWindow, location.origin, CFG.sessionId, {
  onEvent: (e) => { window.__state.events.push(e); mark('guest-event:' + e.type, e); },
  onCommand: (c) => { window.__state.commands.push(c); mark('guest-command:' + c.type); },
  onRequest: async (req) => {
    window.__state.requests.push({ method: req.method, path: req.path, hasFile: !!req.file, fields: req.fields || null });
    mark('guest-request:' + req.method + ' ' + req.path, { hasFile: !!req.file });
    if (req.path.indexOf('/crmapi/knowledge/office/') !== -1) {
      if (req.method === 'GET') {
        window.__state.bytes.served = CFG.docBytes;
        return {
          status: 200,
          headers: { 'x-office-revision': CFG.revision, 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          body: decodeB64(CFG.docB64),
        };
      }
      // POST — the editor saved. Capture the exact bytes the host received.
      const bytes = new Uint8Array(req.file.bytes);
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      window.__state.savedB64 = btoa(bin);
      window.__state.savedFields = req.fields || null;
      window.__state.bytes.savedUpload = bytes.length;
      mark('host-received-save', { bytes: bytes.length, fields: req.fields });
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: encodeJson({ code: 0, msg: 'ok', data: { revision: String(Number(CFG.revision) + 1) } }),
      };
    }
    return { status: 404, headers: {}, body: new ArrayBuffer(0) };
  },
  onStreamRequest: (req, emit, close) => {
    mark('guest-stream-request:' + req.path);
    close(200);
  },
});

// A24 t0: everything below (asset fetch, boot, handshake, document) counts
// from the moment the host points the iframe at the embed URL.
mark('iframe-src');
iframe.src = CFG.url;
iframe.onload = () => {
  mark('iframe-loaded');
  // Host pushes the document context. Note the sessionId: the guest adopts it
  // on init and drops every later command that does not carry it.
  SDK.postCommandToGuest(iframe.contentWindow, location.origin, CFG.sessionId, {
    type: 'init',
    sessionId: CFG.sessionId,
    context: {
      tenantId: 'probe',
      userId: 'probe-user',
      documentId: CFG.documentId,
      documentType: 'docx',
      documentSource: ${JSON.stringify(cfg.documentSource ?? 'knowledge')},
      locale: 'zh-CN',
    },
  });
  mark('init-sent');
};
window.addEventListener('error', (e) => { window.__state.errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => { window.__state.errors.push('rejection: ' + String(e.reason)); });
</script>
</body></html>`
}

// ── main ───────────────────────────────────────────────────────────────────

// The host proxy forwards exactly one path prefix: `/office-engine`, which is
// what Dataflarework's `OfficeEngineProxyController` forwards and what the Vite
// dev proxy forwarded before it. Hardcoded on purpose — see the note at the top
// of this file.
const proxyPrefixes = ['/office-engine']

// T3 / G4: the host's `documentSource` decides whether the guest opens and
// uploads at all, and the two sides disagree on the default. The host's
// `OfficeWorkspaceView.vue` defaults to 'office' while the guest's gates only
// accept 'knowledge' — and the sidebar link
// (`dataflarework .../sidebarNavItems.ts:92`) opens the workspace with no
// `source` query, so that default is what a direct link actually gets. Run the
// same loop with 'office' to reproduce the silent local save on demand:
//     PROBE_DOCUMENT_SOURCE=office node e2e/embed-loop-probe.mjs
const DOCUMENT_SOURCE = process.env.PROBE_DOCUMENT_SOURCE === 'office' ? 'office' : 'knowledge'
const G4_MODE = DOCUMENT_SOURCE !== 'knowledge'

if (!existsSync(serverBundle)) {
  console.error(`missing ${serverBundle} — run: npm run bundle:esbuild -w @genoffice/web-server`)
  process.exit(1)
}
for (const f of [sdkHostUmd, docxFixture]) {
  if (!existsSync(f)) {
    console.error(`missing ${f} — run: npm run build -w @genoffice/web-sdk`)
    process.exit(1)
  }
}

const [serverPort, hostPort] = await reservePorts(2)
dataDir = mkdtempSync(join(tmpdir(), 'genoffice-embed-loop-'))
const secret = randomBytes(32).toString('hex')
const serverBase = `http://127.0.0.1:${serverPort}`
const hostBase = `http://127.0.0.1:${hostPort}`
const docFixtureBytes = readFileSync(docxFixture).byteLength

// A20 byte accounting (node side): every proxied `/api/ipc/<channel>` round
// trip records its wire sizes. The document-carrying channels are
// `web:write-temp-file` (guest → server upload) and `docs:open-path` /
// `docs:open` (server → guest read-back); everything else is small control
// JSON and reported only as a total.
const ipcTraffic = []
let ipcTotalReq = 0
let ipcTotalRes = 0

let hostServer = null
try {
  await startServer(serverPort, secret)
  console.log(`[probe] web-server healthy on ${serverBase}`)

  // 1. A real file to point the embed at (the JWT mint 404s for unknown ids).
  const bearer = mintJwt(secret, 'embed-loop-probe', ['files:read', 'files:write'])
  const upload = await fetch(`${serverBase}/api/v1/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ name: 'embed-loop.docx', bytes: readFileSync(docxFixture).toString('base64') }),
  })
  const uploaded = await upload.json().catch(() => ({}))
  const fileId = uploaded?.id
  if (upload.status !== 201 || typeof fileId !== 'string') {
    throw new Error(`file upload failed (${upload.status}): ${JSON.stringify(uploaded)}`)
  }
  console.log(`[probe] documentId = ${fileId}`)

  // 2. The SDK's own one-call bootstrap, but with a URL builder that matches
  //    the web-server's real route. Log what the SDK ships by default too.
  //    A24 layer 1 (mint): the three-hop credential mint is timed as issued.
  const mintStart = performance.now()
  const session = await openEmbedSession({
    baseUrl: serverBase,
    documentId: fileId,
    app: 'docs',
    bearer,
    buildUrl: (input) =>
      `${hostBase}/office-engine/embed/${encodeURIComponent(input.documentId)}` +
      `?token=${encodeURIComponent(input.jwt)}&app=${input.app}` +
      `&nonce=${encodeURIComponent(input.nonce)}&sessionId=${encodeURIComponent(input.sessionId)}`,
  })
  const mintMs = performance.now() - mintStart
  const sdkDefault = buildDataflareEmbedUrl({
    baseUrl: hostBase,
    app: 'docs',
    documentId: fileId,
    jwt: session.jwt,
    sessionId: session.sessionId,
    nonce: session.nonce,
  })
  console.log(`[probe] embed url      = ${session.url}`)
  console.log(`[probe] SDK default url = ${sdkDefault}`)

  // 3. Host server: serve the host page, proxy the engine prefixes.
  const hostPage = hostHtml({
    url: session.url,
    sessionId: session.sessionId,
    documentId: fileId,
    revision: '7',
    docB64: readFileSync(docxFixture).toString('base64'),
    docBytes: docFixtureBytes,
    documentSource: DOCUMENT_SOURCE,
  })
  hostServer = createServer((req, res) => {
    const url = new URL(req.url, hostBase)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(hostPage)
      return
    }
    const prefix = proxyPrefixes.find((p) => url.pathname === p || url.pathname.startsWith(p + '/'))
    if (!prefix) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end(`host proxy: ${url.pathname} is not proxied (prefixes: ${proxyPrefixes.join(', ')})`)
      return
    }
    const upstreamPath = url.pathname.startsWith('/office-engine')
      ? url.pathname.slice('/office-engine'.length) || '/'
      : url.pathname
    const ipcMatch = /^\/api\/ipc\/(.+)$/.exec(upstreamPath)
    const ipcEntry = ipcMatch
      ? { channel: decodeURIComponent(ipcMatch[1]), method: req.method, reqBytes: 0, resBytes: 0 }
      : null
    if (ipcEntry) {
      const cl = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(cl) && cl > 0) ipcEntry.reqBytes = cl
      else {
        req.on('data', (c) => (ipcEntry.reqBytes += c.length))
        // The pipe below still consumes the stream; the data listener only observes.
        req.resume()
      }
    }
    const upstream = httpRequest(
      { host: '127.0.0.1', port: serverPort, method: req.method, path: upstreamPath + url.search, headers: { ...req.headers, host: `127.0.0.1:${serverPort}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        if (ipcEntry) up.on('data', (c) => (ipcEntry.resBytes += c.length))
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`proxy error: ${err.message}`)
    })
    upstream.on('close', () => {
      if (ipcEntry) {
        ipcTraffic.push(ipcEntry)
        ipcTotalReq += ipcEntry.reqBytes
        ipcTotalRes += ipcEntry.resBytes
      }
    })
    req.pipe(upstream)
  })
  await new Promise((r) => hostServer.listen(hostPort, '127.0.0.1', r))
  console.log(`[probe] host page on ${hostBase} (proxying: ${proxyPrefixes.join(', ')})`)

  // 4. Real browser. `channel: 'chrome'` uses the system Chrome; the bundled
  //    chromium is often not installed in this repo's cache, so a silent
  //    fallback to it would turn a launch problem into a confusing protocol
  //    failure. Try each explicitly and report what actually failed.
  const browser = await (async () => {
    const headed = process.env.HEADED === '1'
    const errors = []
    for (const opts of [{ channel: 'chrome', headless: !headed }, { headless: !headed }]) {
      try {
        return await chromium.launch(opts)
      } catch (err) {
        errors.push(`  ${JSON.stringify(opts)} → ${String(err?.message ?? err).split('\n')[0]}`)
      }
    }
    throw new Error(`no launchable browser (run: npx playwright install chromium)\n${errors.join('\n')}`)
  })()
  const page = await browser.newPage()
  // Guest-frame debug capture (addInitScript covers every frame, iframe
  // included): uncaught errors/rejections, dataflare:open-document dispatches
  // with byte counts, and a .ProseMirror text-length timeline. Bounded so a
  // chatty page can't flood the report.
  await page.addInitScript(() => {
    window.__guestDbg = []
    const push = (m) => {
      if (window.__guestDbg.length < 80) window.__guestDbg.push(m)
    }
    window.addEventListener('error', (e) =>
      push('err@' + Math.round(performance.now()) + ':' + String(e.message).slice(0, 120)),
    )
    window.addEventListener('unhandledrejection', (e) =>
      push(
        'rej@' + Math.round(performance.now()) + ':' + String(e.reason?.message ?? e.reason).slice(0, 160),
      ),
    )
    const orig = EventTarget.prototype.dispatchEvent
    EventTarget.prototype.dispatchEvent = function (ev) {
      if (ev && ev.type === 'dataflare:open-document') {
        const d = ev.detail
        push(
          'open-dispatch@' +
            Math.round(performance.now()) +
            ' keys=' +
            (d ? Object.keys(d).join(',') : 'null') +
            ' bytes=' +
            (d?.data?.byteLength ?? '?'),
        )
      }
      return orig.call(this, ev)
    }
    setInterval(() => {
      const pm = document.querySelector('.ProseMirror')
      if (pm) push('pm@' + Math.round(performance.now()) + ' textLen=' + pm.textContent.length)
    }, 400)
  })
  // Node-side mark recorder: `mark` lives in the host page script, so marks
  // recorded outside page code (editor-visible, doc-loaded) go through here.
  // Same contract as the page-side mark(): first occurrence wins, tag lands
  // in __state.log for waitLog and __state.t for the A24 layer math.
  const pageMark = (tag) =>
    page
      .evaluate((t) => {
        if (!Array.isArray(window.__state.log)) window.__state.log = []
        window.__state.log.push(t)
        if (window.__state.t[t] === undefined) window.__state.t[t] = performance.now()
      }, tag)
      .catch(() => {})
  // Log every frame's console, tagged: the save path fails *inside* the iframe,
  // so host-page-only logging hides the reason.
  page.on('console', (m) => {
    if (!process.env.PROBE_VERBOSE && m.type() !== 'error') return
    const loc = m.location()
    const where = loc?.url ? `${loc.url.split('/').slice(-1)[0]}:${loc.lineNumber}` : '?'
    console.log(`  [console:${m.type()} @${where}] ${m.text().slice(0, 400)}`)
  })
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))
  page.on('requestfailed', (r) => console.log(`  [requestfailed] ${r.method()} ${r.url()} — ${r.failure()?.errorText}`))
  await page.goto(`${hostBase}/`, { waitUntil: 'domcontentloaded' })

  await page.waitForFunction(() => Array.isArray(window.__state?.log), null, { timeout: 15_000 })
  const waitLog = async (tag, ms = 30_000) => {
    try {
      await page.waitForFunction((t) => window.__state.log.includes(t), tag, { timeout: ms })
      return true
    } catch {
      return false
    }
  }

  console.log('\n[probe] — loop hops —')
  note(await waitLog('init-sent', 10_000), 'host sent `init` on iframe load')
  const gotBytesRequest = await waitLog(
    'guest-request:GET /crmapi/knowledge/office/' + fileId,
    G4_MODE ? 5_000 : 30_000,
  )
  note(
    G4_MODE ? !gotBytesRequest : gotBytesRequest,
    G4_MODE
      ? 'G4: guest does NOT fetch the document when documentSource !== `knowledge`'
      : 'guest asked the host for the document bytes',
  )
  note(
    await page
      .waitForFunction(() => window.__state.events.some((e) => e.code === 'dataflare-document-open-failed' || e.type === 'error'), null, { timeout: 3_000 })
      .then(() => false)
      .catch(() => true),
    'no document-open error event',
  )

  // The editor must actually mount inside the iframe.
  const frame = page.frameLocator('#office')
  const editor = frame.locator('.editor-scroll .ProseMirror')
  let editorVisible = true
  let editorGuestMs = -1
  const editorWaitStart = Date.now()
  try {
    await editor.waitFor({ state: 'visible', timeout: 90_000 })
    await pageMark('editor-visible')
    // When (relative to the iframe's own navigation start) did the editor
    // actually become visible? The guest's performance.timeline origin is the
    // iframe nav, so this is the guest-side 资源层 number.
    editorGuestMs = await editor
      .evaluate(() => Math.round(performance.now()))
      .catch(() => -1)
  } catch (e) {
    editorVisible = false
    console.log(
      `  [editor-wait] rejected after ${Date.now() - editorWaitStart}ms: ${String(e?.message ?? e).slice(0, 200)}`,
    )
  }
  if (!editorVisible) {
    // Diagnose the blank iframe on the spot: "no .ProseMirror at all" (boot
    // never reached the editor) is a different bug from "ProseMirror present
    // but zero-size/hidden" (CSS/layout), and the body HTML tells them apart.
    const dom = await frame
      .locator('body')
      .evaluate((el) => {
        const pm = el.querySelector('.ProseMirror')
        const scroll = el.querySelector('.editor-scroll')
        const box = pm?.getBoundingClientRect()
        const cs = pm ? getComputedStyle(pm) : null
        return {
          hasPm: !!pm,
          pmCount: el.querySelectorAll('.ProseMirror').length,
          scrollLen: (scroll?.innerHTML ?? '').length,
          pmHtml: (pm?.innerHTML ?? '').replace(/\s+/g, ' ').slice(0, 400),
          pmInScroll: !!(pm && scroll && scroll.contains(pm)),
          pmChain: (() => {
            const chain = []
            let n = pm?.parentElement
            for (let i = 0; n && i < 6; i++) {
              chain.push(`${n.tagName.toLowerCase()}.${String(n.className).split(' ').join('.')}`)
              n = n.parentElement
            }
            return chain
          })(),
          pmRect: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
          pmDisplay: cs?.display,
          pmVisibility: cs?.visibility,
          scrollRect: scroll
            ? { w: Math.round(scroll.getBoundingClientRect().width), h: Math.round(scroll.getBoundingClientRect().height) }
            : null,
          bodyText: (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
          skeleton: !!el.querySelector('[class*="skeleton"]'),
        }
      })
      .catch((e) => ({ error: String(e).slice(0, 200) }))
    console.log(`  [diag] iframe DOM: ${JSON.stringify(dom)}`)
  }
  note(editorVisible, 'editor mounted inside the iframe (non-blank)')

  // The bytes the host served must actually land in the editor. Asking for the
  // document and mounting an editor are two different things: `docs:open-path`
  // *returns* the parsed document, and only the renderer's `loadFile` applies
  // it. An embed flow that awaits that invoke and drops the result leaves the
  // boot blank document on screen — indistinguishable from success unless the
  // editor's content is read. Probe by text, not by "the request happened".
  let docProbe = ''
  let docLoaded = false
  if (editorVisible) {
    const deadline = Date.now() + (G4_MODE ? 5_000 : 20_000)
    while (Date.now() < deadline) {
      docProbe = await editor
        .evaluate((el) => (el.textContent ?? '').slice(0, 200))
        .catch((e) => `probe failed: ${String(e).slice(0, 200)}`)
      if (typeof docProbe === 'string' && docProbe.includes('第一段')) {
        await pageMark('doc-loaded')
        docLoaded = true
        break
      }
      await sleep(100)
    }
  }
  note(
    G4_MODE ? !docLoaded : docLoaded,
    G4_MODE
      ? 'G4: the editor keeps the boot blank document (host bytes never applied)'
      : 'the served document loaded into the editor (fixture text present)',
    docProbe,
  )
  if (!docLoaded && !G4_MODE) {
    const dbg = await frame
      .locator('body')
      .evaluate(() => window.__guestDbg ?? [])
      .catch(() => ['dbg-unavailable'])
    console.log(`  [diag] guest dbg head: ${JSON.stringify(dbg.slice(0, 30))}`)
  }

  if (editorVisible) {
    // Bisect the save hop: wrap the guest's save entry point so we can tell
    // "the Cmd+S pipeline never reached the bridge" apart from "it reached the
    // bridge and the bridge failed to post".
    await frame
      .locator('body')
      .evaluate(() => {
        const d = window.desktop
        if (!d) return
        // Wrap every save entry point, not just saveDocx: saveOnce routes a
        // pathless document to saveDocxNew/saveDocxAs, and only saveDocx has the
        // Dataflare upload wired in — so counting saveDocx alone cannot tell
        // "the press did nothing" apart from "the press took the local branch".
        window.__saveCalls = []
        for (const name of ['saveDocx', 'saveDocxNew', 'saveDocxAs']) {
          const orig = d[name]
          if (typeof orig !== 'function') continue
          const bound = orig.bind(d)
          d[name] = async (...args) => {
            window.__saveCalls.push({ fn: name, first: String(args[0]).slice(-40) })
            return bound(...args)
          }
        }
        // Count the Cmd+S keydown as the *guest window* sees it. If the count
        // does not move, the browser never delivered the gesture to the iframe
        // (focus), and the app is not at fault; if it moves but nothing saves,
        // the app's own handler ran and bailed.
        window.__sKeys = 0
        window.addEventListener(
          'keydown',
          (e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) window.__sKeys++
          },
          true,
        )
      })
      .catch((e) => console.log(`  [diag] could not wrap saveDocx: ${String(e).slice(0, 200)}`))

    const TYPED = `embed-loop-${Date.now().toString(36)}`
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' ' + TYPED)

    const waitSaved = () =>
      page
        .waitForFunction(() => window.__state.savedB64 !== null, null, { timeout: 8_000 })
        .then(() => true)
        .catch(() => false)

    // 1. Real keystroke — exactly one. The *first* save of an embedded session
    //    is the interesting one: it must reach the host like any other. Pressing
    //    twice the way an earlier revision of this harness did hid the fact that
    //    the first press takes a local-only branch (see the `save calls` diag
    //    below), so assert the first press on its own.
    const primary = process.platform === 'darwin' ? 'Meta+s' : 'Control+s'
    const readCalls = () =>
      frame
        .locator('body')
        .evaluate(() => ({
          sKeys: window.__sKeys,
          calls: (window.__saveCalls ?? []).map((c) => c.fn),
        }))
        .catch(() => null)

    await page.keyboard.press(primary)
    let saved = await waitSaved()
    const first = await readCalls()
    console.log(
      `  [diag] real key "${primary}" (first press) → ${saved ? 'SAVED' : 'no save'}` +
        (first ? ` (guest: ${first.sKeys} Cmd+S keydown, save calls [${first.calls}])` : ''),
    )
    if (G4_MODE) {
      // T3: prove G4 from the harness instead of from reading code. With
      // `documentSource: 'office'` the guest's save gate never matches, so the
      // press silently falls through to the local-only branch: no upload, no
      // `document-saved`, no revision — and nothing tells the user.
      const g4Calls = first?.calls ?? []
      note(
        (first?.sKeys ?? 0) > 0,
        'G4: the Cmd+S really did reach the guest (so this is not a focus problem)',
        first?.sKeys,
      )
      note(!saved, 'G4: the host received NO saved bytes — the save stayed local', { saved, calls: g4Calls })
      note(
        g4Calls.includes('saveDocxNew') && !g4Calls.includes('saveDocx'),
        'G4: the guest took the local-only save branch (saveDocxNew, never saveDocx)',
        g4Calls,
      )
      const g4Events = await page.evaluate(() => window.__state.events.map((e) => e.type))
      note(
        !g4Events.includes('document-saved'),
        'G4: no `document-saved` reached the host — the failure is silent',
        g4Events,
      )
    } else {
      note(
        saved,
        'the FIRST Cmd+S crossed the whole loop' +
          (saved ? '' : ` — guest routed to [${first?.calls ?? '?'}], no upload reached the host`),
      )

      // 2. Second press: proves the loop *can* close, and pins the workaround the
      //    first-press defect forces on real users.
      if (!saved) {
        await page.keyboard.press(primary)
        saved = await waitSaved()
        const second = await readCalls()
        console.log(
          `  [diag] real key "${primary}" (second press) → ${saved ? 'SAVED' : 'no save'}` +
            (second ? ` (guest: ${second.sKeys} Cmd+S keydown, save calls [${second.calls}])` : ''),
        )
      }

      // 3. Synthetic fallback: reaches the app's `window` keydown listener without
      //    going through any browser accelerator. It proves the app-side pipeline
      //    is sound even when the browser eats the real gesture.
      if (!saved) {
        const fired = await frame
          .locator('body')
          .evaluate(() => {
            const ev = new KeyboardEvent('keydown', {
              key: 's', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true,
            })
            window.dispatchEvent(ev)
            return true
          })
          .catch(() => false)
        if (fired) {
          saved = await waitSaved()
          if (saved) console.log('  [diag] real Cmd+S did not save; a synthetic keydown did')
        }
      }

      note(saved, 'the loop closed (host received saved bytes)')

      if (!saved) {
        // Diagnose *inside* the guest: the host only sees what crossed the bridge.
        const diag = await page.evaluate(() => ({ requests: window.__state.requests }))
        console.log(`  [diag] host-side requests: ${JSON.stringify(diag.requests)}`)
        const guest = frame.locator('body')
        const guestDiag = await guest
          .evaluate(() => {
            const w = window
            const bridge = w.dataflareOfficeBridge
            const pm = document.querySelector('.editor-scroll .ProseMirror')
            return {
              isEmbedded: bridge?.isEmbedded,
              revision: bridge?.getRevision?.(),
              pmText: (pm?.textContent ?? '').slice(-120),
              hasDesktop: typeof w.desktop === 'object',
              hasSaveDocx: typeof w.desktop?.saveDocx === 'function',
              saveCalls: w.__saveCalls ?? null,
            }
          })
          .catch((e) => ({ error: String(e).slice(0, 300) }))
        console.log(`  [diag] guest: ${JSON.stringify(guestDiag)}`)
      }
    }

    if (saved) {
      const state = await page.evaluate(() => ({
        savedB64: window.__state.savedB64,
        savedFields: window.__state.savedFields,
        events: window.__state.events,
      }))
      const zip = await JSZip.loadAsync(Buffer.from(state.savedB64, 'base64'))
      const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
      note(xml.includes(TYPED), 'saved docx contains the typed text', { typed: TYPED, xmlBytes: xml.length })
      note(
        state.savedFields?.expectedRevision === '7',
        'save carried expectedRevision (optimistic lock)',
        state.savedFields,
      )
      const savedEvent = state.events.find((e) => e.type === 'document-saved')
      note(!!savedEvent, 'guest emitted `document-saved` to the host', savedEvent)
    }
  }

  // 5. The `ready` handshake — a known suspect. The guest posts `ready` before
  //    any `init` arrives, so its `activeSessionId` is still null and
  //    `makeEnvelope` omits the sessionId; the host bridge drops envelopes
  //    whose sessionId doesn't match. The raw observer tells the two apart:
  //    "never sent" vs "sent, then dropped on the sessionId check".
  const { events, raw, marks, bytes } = await page.evaluate(() => ({
    events: window.__state.events.map((e) => e.type),
    raw: window.__state.raw,
    marks: window.__state.t,
    bytes: window.__state.bytes,
  }))
  const gotReady = events.includes('ready')
  console.log(`\n[probe] guest events received by host: ${JSON.stringify(events)}`)
  console.log(`[probe] raw envelopes at the host window: ${JSON.stringify(raw)}`)
  findings.push({
    ok: gotReady,
    what: 'host received the guest `ready` handshake',
    detail: gotReady ? undefined : 'READY DROPPED — see report',
  })

  // ── A24 five-layer timing + A20 transfer accounting ───────────────────────
  // All host-clock layers are first-occurrence marks inside the page; the mint
  // layer is node-clock around the SDK bootstrap. `load-progress` carries the
  // guest's own monotonic clock (`t` = performance.now() inside the iframe) —
  // reported alongside so the resource layer can be attributed precisely once
  // the guest emits it.
  const loadProgressEvents = await page.evaluate(() =>
    window.__state.events
      .filter((e) => e.type === 'load-progress')
      .map((e) => ({ phase: e.phase, pct: e.pct, guestT: e.t, arrival: null })),
  )
  const tDocLoaded = marks['doc-loaded']
  const tEditable = Math.max(marks['editor-visible'] ?? 0, tDocLoaded ?? 0)
  const t0 = marks['iframe-src']
  const tReady = marks['guest-event:ready']
  const tDocStart = marks[`guest-request:GET /crmapi/knowledge/office/${fileId}`]
  const layer = (name, from, to) => {
    if (from === undefined || to === undefined) return { name, ms: null }
    return { name, ms: Math.round(to - from) }
  }
  probeTiming = {
    g4Mode: G4_MODE,
    mintMs: Math.round(mintMs),
    layers: [
      layer('资源(iframe→编辑器可见)', t0, marks['editor-visible']),
      layer('握手(init→ready)', marks['init-sent'], tReady),
      layer('文档(请求→内容应用)', tDocStart, tDocLoaded),
      layer('可编辑(iframe→可编辑)', t0, tEditable || undefined),
    ],
    e2eMs: tEditable ? Math.round(tEditable - t0) : null,
    editorVisibleGuestMs: editorGuestMs,
    loadProgressEvents,
  }
  // ── A16/A49 first-screen network panel ────────────────────────────────────
  // A49 asks for the on-demand claim to be *network-panel provable*. Read the
  // guest's own resource timing and diff it against the chunks that actually
  // exist in the shipped build: a chunk the first screen never requested is a
  // chunk the browser did not load, and a named on-demand chunk appearing in
  // the requested set is exactly the failure A49 forbids.
  const guestFrame = page.frames().find((f) => f !== page.mainFrame())
  if (guestFrame) {
    const net = await guestFrame.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => ({
        name: e.name.split('/').pop() ?? e.name,
        enc: e.encodedBodySize,
        raw: e.decodedBodySize,
        start: Math.round(e.startTime),
      })),
    )
    const assetsDir = join(repoRoot, 'apps', 'docs', 'out', 'renderer', 'assets')
    const shipped = existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : []
    const requested = new Set(net.map((e) => e.name))
    const js = net.filter((e) => e.name.endsWith('.js'))
    const css = net.filter((e) => e.name.endsWith('.css'))
    const sum = (list, key) => list.reduce((s, e) => s + e[key], 0)
    // A49 names the on-demand feature areas: AiPanel, the agent runtime, the
    // translation chain, the export chains. The parse worker is deliberately
    // NOT in this set — parsing the document is what makes it editable, so its
    // chunk is part of the first screen by definition; flagging it would turn
    // a correct build into a false red.
    const ON_DEMAND = /aipanel|agent|translat|export/i
    probeFirstScreen = {
      shippedJsChunks: shipped.length,
      requestedJsChunks: js.length,
      jsRaw: sum(js, 'raw'),
      jsEncoded: sum(js, 'enc'),
      cssRaw: sum(css, 'raw'),
      cssEncoded: sum(css, 'enc'),
      onDemandLoadedOnFirstScreen: js.map((e) => e.name).filter((n) => ON_DEMAND.test(n)),
      notLoaded: shipped.filter((f) => !requested.has(f)),
      requested: js.map((e) => `${e.name} ${e.raw}/${e.enc}@${e.start}`),
    }
    note(
      probeFirstScreen.onDemandLoadedOnFirstScreen.length === 0,
      'A49 首屏未加载按需 chunk(AiPanel/agent/翻译/导出)',
      probeFirstScreen.onDemandLoadedOnFirstScreen,
    )
  }
  const docCarryChannels = ['web:write-temp-file', 'docs:open-path', 'docs:open', 'docs:read-path']
  const docCarryIpc = ipcTraffic.filter((e) => docCarryChannels.includes(e.channel))
  const docCarryWire =
    docCarryIpc.reduce((s, e) => s + e.reqBytes + e.resBytes, 0)
  const servedBytes = G4_MODE ? 0 : bytes.served
  const transferTotal = servedBytes + docCarryWire
  probeTransfer = {
    docBytes: docFixtureBytes,
    servedBytes,
    docCarryIpc: docCarryIpc.map((e) => ({ channel: e.channel, req: e.reqBytes, res: e.resBytes })),
    docCarryWire,
    transferTotal,
    ratio: docFixtureBytes > 0 ? Number((transferTotal / docFixtureBytes).toFixed(2)) : null,
    ipcTotalReq,
    ipcTotalRes,
  }

  const errors = await page.evaluate(() => window.__state.errors)
  if (errors.length) console.log(`[probe] page errors: ${JSON.stringify(errors)}`)

  await browser.close()
} catch (err) {
  console.error(`\n[probe] ERROR: ${err?.stack ?? err}`)
  findings.push({ ok: false, what: 'probe completed without throwing', detail: String(err?.message ?? err) })
} finally {
  if (hostServer) await new Promise((r) => hostServer.close(r))
  cleanup()
}

const failed = findings.filter((f) => !f.ok)
const label = G4_MODE ? 'G4 REPRODUCED' : 'LOOP OK'
console.log(`\n═══ report ═══`)
for (const f of findings) console.log(`${f.ok ? ' ✓' : ' ✗'} ${f.what}${f.detail === undefined ? '' : `  → ${JSON.stringify(f.detail)}`}`)
if (probeTiming) {
  console.log(`\n── A24 分层计时 (host clock, ms) ──`)
  console.log(`  mint(凭据三跳, node clock): ${probeTiming.mintMs}`)
  for (const l of probeTiming.layers) console.log(`  ${l.name}: ${l.ms ?? 'n/a'}`)
  console.log(`  端到端(iframe→可编辑): ${probeTiming.e2eMs ?? 'n/a'}`)
  if (probeTiming.editorVisibleGuestMs >= 0) {
    console.log(`  guest 时钟的编辑器可见时刻: ${probeTiming.editorVisibleGuestMs} ms (iframe nav 起)`)
  }
  if (probeTiming.loadProgressEvents.length) {
    console.log(`  guest load-progress 事件: ${JSON.stringify(probeTiming.loadProgressEvents)}`)
  }
}
if (probeTransfer) {
  console.log(`\n── A20 文档传输计量 ──`)
  console.log(`  文件体积: ${probeTransfer.docBytes} B`)
  console.log(`  postMessage 交付: ${probeTransfer.servedBytes} B`)
  console.log(`  IPC 文档承载通道: ${JSON.stringify(probeTransfer.docCarryIpc)} (wire 合计 ${probeTransfer.docCarryWire} B)`)
  console.log(`  传输总量/体积 = ${probeTransfer.transferTotal}/${probeTransfer.docBytes} = ${probeTransfer.ratio}×`)
  console.log(`  IPC 其他流量合计: req ${probeTransfer.ipcTotalReq} B / res ${probeTransfer.ipcTotalRes} B`)
}
if (probeFirstScreen) {
  const f = probeFirstScreen
  console.log(`\n── A16/A49 首屏网络面板 (guest resource timing) ──`)
  console.log(`  构建产物 JS chunk: ${f.shippedJsChunks} 个,首屏请求 ${f.requestedJsChunks} 个`)
  console.log(`  首屏 JS: raw ${f.jsRaw} B / 线上传输 ${f.jsEncoded} B`)
  console.log(`  首屏 CSS: raw ${f.cssRaw} B / 线上传输 ${f.cssEncoded} B`)
  console.log(`  首屏请求明细: ${JSON.stringify(f.requested)}`)
  console.log(`  首屏未请求 chunk (${f.notLoaded.length}): ${JSON.stringify(f.notLoaded)}`)
  console.log(`  按需 chunk 混入首屏: ${JSON.stringify(f.onDemandLoadedOnFirstScreen)}`)
}
console.log(`\n${failed.length === 0 ? label : `${failed.length} FAILURE(S)`}`)
process.exit(failed.length === 0 ? 0 : 1)

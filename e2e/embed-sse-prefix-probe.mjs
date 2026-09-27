/**
 * Does the embed's SSE push channel actually connect and deliver a frame when
 * the page is served through the REAL Dataflarework prefix (/office-engine/**)?
 *
 * e2e/embed-loop-probe.mjs proxies /assets + /static at the host root in
 * addition to /office-engine, which is how a root-relative EventSource URL
 * survived. This probe uses the real prefix and nothing else, and instruments
 * window.EventSource before any page script runs so it observes the URL the
 * bridge actually resolved — not one the probe guessed.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8991'
const DOC = process.env.DOC || 'prefix-probe.docx'
const url = `${BASE}/office-engine/embed/${DOC}?token=bogus&app=docs`

// Only the system Chrome channel is cached in this environment; the bundled
// chromium headless shell is not installed.
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()

// Install before page scripts: record every EventSource the iframe constructs,
// plus every frame it receives.
await page.addInitScript(() => {
  const w = window
  w.__sseProbe = { urls: [], frames: [] }
  const Real = w.EventSource
  w.EventSource = function (u, o) {
    w.__sseProbe.urls.push(String(u))
    const es = new Real(u, o)
    es.addEventListener('message', (ev) => w.__sseProbe.frames.push(String(ev.data).slice(0, 200)))
    es.addEventListener('open', () => w.__sseProbe.frames.push('[open]'))
    es.addEventListener('error', () => w.__sseProbe.frames.push('[error]'))
    return es
  }
  w.EventSource.prototype = Real.prototype

  // The bridge first resolves <script src> then builds the API URL. Record the
  // bridge's own resolved anchor too, so a failure names which half broke.
  w.__bridgeSrc = null
  document.addEventListener('DOMContentLoaded', () => {
    for (const s of document.getElementsByTagName('script')) {
      if (s.src && s.src.indexOf('/embed/static/bridge.js') !== -1) w.__bridgeSrc = s.src
    }
  })
})

const sseResponses = []
page.on('response', (r) => {
  const u = new URL(r.url())
  if (u.pathname.endsWith('/api/ipc/events')) {
    sseResponses.push({
      path: u.pathname,
      status: r.status(),
      contentType: r.headers()['content-type'] || '',
    })
  }
})

// Every IPC call the page makes, with the session it claims. The server's push
// channel is request-scoped — a frame is only ever written back to the session
// named on the request that produced it — so "no frame" has two very different
// causes: no IPC call happened at all, or it happened under a different session
// than the one(s) the page is subscribed to.
const ipcCalls = []
page.on('request', (r) => {
  const u = new URL(r.url())
  if (u.pathname.includes('/api/ipc/') && !u.pathname.endsWith('/api/ipc/events')) {
    ipcCalls.push({
      method: r.method(),
      path: u.pathname,
      session: r.headers()['x-ipc-session'] || null,
    })
  }
})

const consoleErrors = []
const failed = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
page.on('requestfailed', (r) => failed.push(`${r.url()} — ${r.failure()?.errorText}`))

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)

// Deterministic push stimulus.
//
// Ctrl+S is not a reliable stimulus: the docs renderer only issues docs:save
// when it believes the document is dirty, and on a freshly-booted embed page
// it does not — the earlier run captured 14 IPC calls and every one was a
// read-only boot call. "No frame arrived" then means nothing at all.
//
// html:dirty-changed is registered unconditionally (src/index.ts:205-210) and
// is a pure push: the handler's entire body is
// `sendIpcEvent(event, 'dirtyChanged', …)` with no filesystem work. Sending it
// under the page's OWN injected session is exactly the round trip the bridge
// depends on — same session on the request and on the subscription — and it
// measures the frame through the real /office-engine prefix rather than
// asserting "no errors".
const stimulus = await page.evaluate(async () => {
  const meta = (n) => {
    const el = document.querySelector(`meta[name="${n}"]`)
    return el ? el.getAttribute('content') : null
  }
  const session = meta('genoffice-session')
  if (!session) return { ok: false, why: 'no genoffice-session meta in this document' }
  // Resolve against the bridge's own <script src>, the same structural anchor
  // the bridge uses, so this measures the prefixed URL rather than a guess.
  const src = window.__bridgeSrc
  if (!src) return { ok: false, why: 'bridge <script src> not found', session }
  const endpoint = new URL('../../api/ipc/html:dirty-changed', src).toString()
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ipc-session': session },
    body: JSON.stringify({ args: [true] }),
  })
  return { ok: res.ok, status: res.status, session, endpoint, body: (await res.text()).slice(0, 200) }
})
await page.waitForTimeout(1500)

// Nudge the editor too — kept as a realistic secondary stimulus; the probe
// records whether it produced a docs:save call at all.
await page.keyboard.press('Control+S')
await page.waitForTimeout(2500)

const out = await page.evaluate(() => {
  const describe = (w) => {
    try {
      const d = w.document
      const meta = (n) => {
        const el = d.querySelector ? d.querySelector(`meta[name="${n}"]`) : null
        return el ? el.getAttribute('content') : null
      }
      return {
        href: String(w.location.href).slice(0, 120),
        sse: w.__sseProbe || null,
        embedGlobal: typeof w.__GENOFFICE_EMBED__ === 'undefined' ? 'undefined' : JSON.stringify(w.__GENOFFICE_EMBED__).slice(0, 300),
        configMeta: (meta('genoffice-embed-config') || '').slice(0, 300),
        sessionMeta: meta('genoffice-session'),
        metaNames: d.querySelectorAll ? [...d.querySelectorAll('meta[name]')].map((m) => m.getAttribute('name')).slice(0, 20) : [],
      }
    } catch (e) { return { err: String(e).slice(0, 160) } }
  }
  const frames = [...document.querySelectorAll('iframe')]
  return {
    top: describe(window),
    iframeCount: frames.length,
    iframes: frames.map((f) => {
      try { return describe(f.contentWindow) } catch (e) { return { err: String(e).slice(0, 160) } }
    }),
  }
})

// Prefer the frame that actually constructed an EventSource; fall back to the
// top document (in this probe the embed page often IS the top document — the
// Dataflare host is bypassed by the Vite proxy).
const candidates = [out.top, ...out.iframes]
const frame = candidates.find((f) => f && f.sse && (f.sse.urls || []).length > 0) || out.top
const probe = frame.sse
const pass = {
  frames: (probe?.frames ?? []).slice(0, 6),
  sseResponses,
  ipcCalls,
  embedGlobal: frame.embedGlobal,
  configMeta: frame.configMeta,
  sessionMeta: frame.sessionMeta,
  allEventSourceUrls: (probe?.urls ?? []),
  urlIsPrefixed: (probe?.urls ?? []).some((u) => u.includes('/office-engine/api/ipc/events')),
  urlIsNotRootRelative: !(probe?.urls ?? []).some((u) => u.startsWith('/api/')),
  sawOpen: (probe?.frames ?? []).includes('[open]'),
  receivedFrame: (probe?.frames ?? []).some((f) => f !== '[open]' && f !== '[error]'),
}

console.log(JSON.stringify({
  url,
  stimulus,
  sseOrigin: frame === out.top ? 'top-document' : 'iframe',
  iframeCount: out.iframeCount,
  topHref: out.top.href,
  ...pass,
  raw: out,
  OK: pass.urlIsPrefixed && pass.urlIsNotRootRelative && pass.sawOpen && pass.receivedFrame,
  consoleErrors: consoleErrors.slice(0, 6),
  failedRequests: failed.slice(0, 6),
}, null, 2))

await browser.close()

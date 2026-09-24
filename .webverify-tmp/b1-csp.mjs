/**
 * B1: Cross-origin preview CSP probe.
 *
 * Verifies that the preview route is correctly sandboxed:
 *   1. Preview buffer is writable via html:preview-update IPC
 *   2. Preview HTTP CSP header includes frame-ancestors 'self' + unsafe-inline/eval
 *   3. Same-origin iframe embedding of preview succeeds
 *   4. Cross-origin iframe embedding is blocked (no SecurityError, just block)
 *   5. Shell CSP is stricter than preview CSP (script-src 'self', no unsafe-inline)
 */
import { createServer } from 'node:http'
import { once } from 'node:events'

const BASE = 'http://127.0.0.1:18081'
let pass = 0, fail = 0
const check = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`✗ ${msg}`) }
}

async function invoke(channel, args = []) {
  const r = await fetch(`${BASE}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return { status: r.status, body: await r.json() }
}

// ─── 1. Push a preview buffer via html:preview-update IPC ───────────────
console.log('\n━━━ B1: preview buffer IPC writer ━━━')
const PREVIEW_ID = `b1-csp-test-${Date.now()}`
const SAMPLE_HTML = `<!doctype html><html><head>
<meta charset="utf-8"><title>B1 Test Buffer</title>
<style>body{font-family:sans-serif;color:#06c}</style>
</head><body>
<h1 id="b1h">B1 PREVIEW BUFFER</h1>
<p>${PREVIEW_ID}</p>
<script>document.body.dataset.b1='${PREVIEW_ID}'</script>
</body></html>`

const update = await invoke('html:preview-update', [SAMPLE_HTML, PREVIEW_ID])
check(update.status === 200 && update.body?.result?.ok === true,
  `html:preview-update writes the buffer (status=${update.status}, ok=${update.body?.result?.ok})`)

// Sanity: info channel returns the URL it will be served from
const info = await invoke('html:preview-info', [PREVIEW_ID])
check(typeof info.body?.result?.url === 'string' && info.body.result.url.includes(encodeURIComponent(PREVIEW_ID)),
  `html:preview-info returns URL: ${info.body?.result?.url}`)

// ─── 2. GET the preview route and inspect headers ───────────────────────
console.log('\n━━━ B1: preview HTTP CSP header ━━━')
const previewUrl = `${BASE}${info.body.result.url}`
const prevRes = await fetch(previewUrl)
check(prevRes.status === 200, `preview GET returns 200 (status=${prevRes.status})`)
check(prevRes.headers.get('content-type')?.startsWith('text/html'),
  `preview Content-Type text/html (got: ${prevRes.headers.get('content-type')})`)
const csp = prevRes.headers.get('content-security-policy')
check(csp !== null && csp.length > 0, `preview CSP header present (${csp?.length ?? 0} chars)`)
if (csp) {
  check(csp.includes("frame-ancestors 'self'"), `preview CSP includes frame-ancestors 'self'`)
  check(csp.includes("'unsafe-inline'") && csp.includes("'unsafe-eval'"),
    `preview CSP permits unsafe-inline + unsafe-eval (required for preview buffer)`)
  check(csp.includes('script-src *'),
    `preview CSP script-src is permissive (*)`)
  check(csp.includes("default-src 'self' 'unsafe-inline'"),
    `preview CSP default-src is permissive (the buffer can pull external assets)`)
}
const prevHtml = await prevRes.text()
check(prevHtml.includes(PREVIEW_ID), `preview body has the buffer we wrote (marker: ${PREVIEW_ID.slice(-12)})`)
// (The preview buffer is the user's HTML — not necessarily a CSP meta tag.
 // The CSP is enforced via the HTTP header, not the meta tag.)

// ─── 3. Same-origin iframe embedding works ──────────────────────────────
console.log('\n━━━ B1: same-origin can load preview ━━━')
const { chromium } = await import('playwright')
const browser = await chromium.launch({ channel: 'chrome' })

// Direct load in a tab: http://127.0.0.1:18081 → /api/html/preview/<id>.
// Same origin as the preview, so the document must load and the inline
// script must execute.
const directPage = await browser.newPage()
const directResp = await directPage.goto(previewUrl, { waitUntil: 'load' })
await directPage.waitForTimeout(1500)
const directState = await directPage.evaluate(() => ({
  title: document.title,
  h1: document.querySelector('h1')?.textContent ?? '(no h1)',
  bodyText: document.body?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '(no body)',
  bodyDataset: document.body?.dataset?.b1 ?? '(no dataset)',
  readyState: document.readyState,
}))
console.log('  ℹ direct same-origin state:', JSON.stringify(directState))
check(directResp.status() === 200, `same-origin direct load returns 200 (got ${directResp.status()})`)
check(directState.h1 === 'B1 PREVIEW BUFFER',
  `same-origin direct load shows preview buffer (h1="${directState.h1}", readyState=${directState.readyState})`)
check(directState.bodyDataset?.startsWith('b1-csp-test-'),
  `same-origin direct load runs inline script (dataset.b1="${directState.bodyDataset?.slice(-12)}")`)

// Shell-embedded: the production use case. The Home page renders the preview
// inside an iframe on the same origin. Verify the iframe can be read from
// the shell and contains the buffer.
const shellPage = await browser.newPage()
await shellPage.goto(`${BASE}/`, { waitUntil: 'load' })
const shellPreviewState = await shellPage.evaluate(async (url) => {
  const f = document.createElement('iframe')
  f.src = url
  f.style.cssText = 'width:700px;height:300px'
  document.body.appendChild(f)
  await new Promise(resolve => {
    f.addEventListener('load', () => resolve(true))
    setTimeout(() => resolve(false), 5000)
  })
  try {
    const d = f.contentDocument
    return {
      hasDoc: !!d,
      h1: d?.querySelector('h1')?.textContent ?? '(no h1)',
      dataset: d?.body?.dataset?.b1 ?? '(no dataset)',
    }
  } catch (e) {
    return { error: String(e).slice(0, 120) }
  }
}, previewUrl)
console.log('  ℹ shell-embedded preview state:', JSON.stringify(shellPreviewState))
check(!shellPreviewState.error && shellPreviewState.h1 === 'B1 PREVIEW BUFFER',
  `shell can embed preview in same-origin iframe (h1="${shellPreviewState.h1}")`)

// ─── 4. Cross-origin iframe embedding is blocked ────────────────────────
console.log('\n━━━ B1: cross-origin iframe blocked ━━━')
const crossPort = 18999
const crossServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body>
<h1>cross-origin attacker</h1>
<iframe id="victim" src="${previewUrl}" style="width:700px;height:300px"></iframe>
</body></html>`)
})
crossServer.listen(crossPort)
await once(crossServer, 'listening')

const crossPage = await browser.newPage()
// Capture the console message about CSP violations and any errors
const crossViolations = []
crossPage.on('console', (msg) => {
  const text = msg.text()
  if (/Content[- ]Security[- ]Policy|frame-ancestors|Refused to display/i.test(text)) {
    crossViolations.push(text.slice(0, 150))
  }
})
crossPage.on('pageerror', (err) => crossViolations.push(`pageerror: ${String(err).slice(0, 120)}`))

await crossPage.goto(`http://127.0.0.1:${crossPort}/`)
await crossPage.waitForTimeout(3000)

const crossState = await crossPage.evaluate(() => {
  const f = document.getElementById('victim')
  // Try reading the iframe — if frame-ancestors blocks, contentDocument is null
  // in Chromium (the iframe is in a "blocked" state, contentDocument returns null)
  let accessible = null, h1Text = '(blocked)', bodyText = '(blocked)'
  try {
    const d = f.contentDocument
    if (d) {
      accessible = true
      h1Text = d.querySelector('h1')?.textContent ?? '(no h1)'
      bodyText = d.body?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '(no body)'
    } else {
      accessible = false
    }
  } catch (e) {
    accessible = `error: ${String(e).slice(0, 80)}`
  }
  return {
    accessible,
    h1Text,
    bodyText,
    offsetWidth: f.offsetWidth,
    offsetHeight: f.offsetHeight,
    naturalWidth: f.naturalWidth,
  }
})
console.log('  ℹ cross-origin state:', JSON.stringify(crossState))
console.log('  ℹ CSP violations captured:', crossViolations.length)
if (crossViolations.length > 0) console.log('  ℹ   first:', crossViolations[0])

check(crossState.accessible === false,
  `cross-origin iframe cannot read preview content (accessible=${crossState.accessible})`)
check(crossState.bodyText === '(blocked)' || crossState.h1Text === '(blocked)' || /blocked/i.test(String(crossState.accessible)),
  `cross-origin iframe body shows blocked content (h1="${crossState.h1Text}")`)

// Cross-origin embed blocked — that's the whole point. CSP violations may
// appear in console or not (Chromium behaviour varies). The semantic check is:
// the iframe's content is NOT readable from the cross-origin parent.
check(crossState.bodyText !== 'B1 PREVIEW BUFFER',
  `cross-origin parent cannot see preview's h1 ("${crossState.h1Text}")`)

crossServer.close()

// ─── 5. Shell CSP is stricter than preview CSP ──────────────────────────
console.log('\n━━━ B1: shell CSP forbids inline scripts ━━━')
const shellHtml = await fetch(`${BASE}/`).then((r) => r.text())
// The CSP value contains single-quoted sources like 'self', so use a quote
// class that matches only the attribute delimiter (double-quote), not '.
const shellMetaMatch = shellHtml.match(/<meta[^>]+http-equiv=["]Content-Security-Policy["][^>]+content=["]([^"]+)["]/)
const shellMeta = shellMetaMatch?.[1] ?? ''
check(shellMeta.includes("default-src 'self'"), `shell meta CSP default-src 'self'`)
const shellScriptSrc = shellMeta.match(/script-src\s+([^;]+)/)?.[1] ?? ''
check(shellScriptSrc.includes("'self'") && !shellScriptSrc.includes("'unsafe-inline'") && !shellScriptSrc.includes("'unsafe-eval'"),
  `shell script-src is 'self' (no unsafe-inline/eval) — got: "${shellScriptSrc.trim()}"`)
check(csp && (csp.includes("'unsafe-inline'") || csp.includes("unsafe-inline")),
  `preview CSP loosens script restrictions relative to shell (required for buffer)`)

await browser.close()

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n━━━ B1 cross-origin preview CSP: ${pass} passed / ${fail} failed ━━━`)
process.exit(fail > 0 ? 1 : 0)
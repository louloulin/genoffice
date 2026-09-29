import { chromium } from 'playwright'
const WT = process.env.G27_WEB_TOKEN
const BASE = 'http://127.0.0.1:19099'

const T = (await (await fetch(`${BASE}/api/v1/auth/jwt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${WT}` },
  body: JSON.stringify({ sub: 'v', scope: ['files:read'], ttl: 600 }),
})).json()).token

const hostUrl = `${BASE}/__c__`
const embedUrl = `${BASE}/embed/doc-b.docx?token=${encodeURIComponent(T)}&app=docs`

let browser
try { browser = await chromium.launch({ channel: 'chrome' }) } catch { browser = await chromium.launch() }
const ctx = await browser.newContext()
const page = await ctx.newPage()
let setCookieHeader = null
page.on('response', (r) => { if (r.url().includes('/embed/doc-b')) setCookieHeader = r.headers()['set-cookie'] ?? null })
await ctx.route(hostUrl, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><iframe id="f" style="width:900px;height:600px"></iframe>' }))
await page.goto(hostUrl)
await page.evaluate((u) => { document.getElementById('f').src = u }, embedUrl)
await new Promise((r) => setTimeout(r, 5000))

console.log('embed response Set-Cookie :', setCookieHeader ? setCookieHeader.slice(0, 60) + '…' : '(none)')
console.log('ctx.cookies() names       :', JSON.stringify((await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, sameSite: c.sameSite }))))
const frame = page.frames().find((f) => f.url().includes('/embed/doc-b'))
if (frame) {
  const probe = await frame.evaluate(async () => {
    const r = await fetch('/api/ipc/' + encodeURIComponent('app:get-theme'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}' })
    return { status: r.status, body: (await r.text()).slice(0, 120) }
  })
  console.log('in-frame fetch (no header):', JSON.stringify(probe))
  const probe2 = await frame.evaluate(async () => {
    const r = await fetch('/api/ipc/' + encodeURIComponent('app:get-theme'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}' })
    return r.status
  })
  console.log('second call (cookie now?) :', probe2)
}
await browser.close()

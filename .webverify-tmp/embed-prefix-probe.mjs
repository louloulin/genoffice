/**
 * Decisive check: does the GenOffice embed actually boot when served through the
 * REAL Dataflarework reverse-proxy prefix (/office-engine/**)?
 *
 * The e2e/embed-loop-probe.mjs harness proxies /assets + /static at the host root
 * in addition to /office-engine. Neither the Vite dev config nor the Spring
 * OfficeEngineProxyController does that — both proxy ONLY /office-engine/**.
 * This script uses the real prefix and nothing else.
 */
import { chromium } from '@playwright/test'

const BASE = process.env.BASE || 'http://127.0.0.1:8991'
const DOC = process.env.DOC || 'prefix-probe.docx'
const url = `${BASE}/office-engine/embed/${DOC}?token=bogus&app=docs`

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()

const consoleErrors = []
const failed = []
const responses = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
page.on('requestfailed', (r) => failed.push(`${r.url()} — ${r.failure()?.errorText}`))
page.on('response', async (r) => {
  const u = new URL(r.url())
  if (u.origin !== new URL(BASE).origin) return
  if (/\.(js|css|mjs)$/.test(u.pathname)) {
    const ct = r.headers()['content-type'] || ''
    if (!/javascript|css|ecmascript/.test(ct)) responses.push({ path: u.pathname, status: r.status(), contentType: ct })
  }
})

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const mounted = await page.evaluate(() => {
  const b = document.body
  return { bodyLen: (b.innerText || '').trim().length, nodes: b.querySelectorAll('*').length, title: document.title }
})

console.log(JSON.stringify({
  url,
  mounted,
  misTypedScripts: responses,
  consoleErrors: consoleErrors.slice(0, 8),
  failedRequests: failed.slice(0, 8),
}, null, 2))

await browser.close()

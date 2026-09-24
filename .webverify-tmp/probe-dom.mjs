import { chromium } from '@playwright/test'
const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:18081'
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
for (const app of ['docs','sheets','slides','markdown','html']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`${BASE}/?app=${app}`, { waitUntil: 'load', timeout: 30000 })
  await page.waitForFunction(() => (document.querySelector('#root')?.children.length ?? 0) > 0, { timeout: 20000 })
  await page.waitForTimeout(3000)
  const info = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)].map(e => ({
      tag: e.tagName, cls: (e.className && typeof e.className === 'string' ? e.className : '').slice(0,90),
      role: e.getAttribute('role')||'', ph: e.getAttribute('placeholder')||'', text: (e.innerText||'').slice(0,40)
    }))
    return {
      contenteditable: q('[contenteditable="true"]').slice(0,4),
      textarea: q('textarea').slice(0,4),
      inputs: q('input').slice(0,6),
      canvas: q('canvas').slice(0,4),
      iframes: [...document.querySelectorAll('iframe')].map(f=>f.src||'(srcdoc)').slice(0,4),
    }
  })
  console.log(`\n=== ${app} ===`)
  console.log(JSON.stringify(info, null, 1))
  await page.close()
}
await browser.close()

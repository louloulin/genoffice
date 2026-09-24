import { chromium } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:18081'
const APPS = ['docs','sheets','slides','pdf','markdown','html','shell']
const OUT = '/tmp/webverify/shots'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
const report = []
for (const app of APPS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = [], pageErrors = [], assetFails = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0,300)) })
  page.on('pageerror', e => pageErrors.push(String(e.message||e).slice(0,300)))
  page.on('response', r => { const p = new URL(r.url()).pathname; if (r.status()>=400 && /\.(js|mjs|css|png|woff2?)$/.test(p)) assetFails.push(`${r.status()} ${p}`) })
  let mounted = false, err = null
  try {
    await page.goto(`${BASE}/?app=${app}`, { waitUntil: 'load', timeout: 30000 })
    await page.waitForFunction(() => (document.querySelector('#root')?.children.length ?? 0) > 0, { timeout: 20000 })
    mounted = true
    await page.waitForTimeout(2500)
  } catch (e) { err = String(e).split('\n')[0] }
  const rootKids = await page.evaluate(() => document.querySelector('#root')?.children.length ?? 0).catch(()=>-1)
  const title = await page.title().catch(()=> '')
  const bodyText = await page.evaluate(() => (document.body.innerText||'').slice(0,400)).catch(()=> '')
  const buttons = await page.evaluate(() => [...document.querySelectorAll('button')].map(b=>(b.innerText||b.getAttribute('aria-label')||'').trim()).filter(Boolean).slice(0,25)).catch(()=>[])
  await page.screenshot({ path: `${OUT}/${app}.png`, fullPage: false }).catch(()=>{})
  report.push({ app, mounted, err, rootKids, title, assetFails:[...new Set(assetFails)], consoleErrors:[...new Set(consoleErrors)].slice(0,8), pageErrors:[...new Set(pageErrors)].slice(0,8), buttons, bodyText: bodyText.slice(0,200) })
  await page.close()
}
await browser.close()
writeFileSync('/tmp/webverify/report.json', JSON.stringify(report,null,2))
for (const r of report) {
  console.log(`\n===== ${r.app} =====`)
  console.log(`mounted=${r.mounted} rootChildren=${r.rootKids} title=${JSON.stringify(r.title)}`)
  if (r.err) console.log(`  LOAD ERROR: ${r.err}`)
  if (r.assetFails.length) console.log(`  ASSET FAILS: ${r.assetFails.join(', ')}`)
  if (r.pageErrors.length) console.log(`  PAGE ERRORS:\n    ${r.pageErrors.join('\n    ')}`)
  if (r.consoleErrors.length) console.log(`  CONSOLE ERRORS:\n    ${r.consoleErrors.join('\n    ')}`)
  console.log(`  buttons(${r.buttons.length}): ${r.buttons.join(' | ')}`)
}

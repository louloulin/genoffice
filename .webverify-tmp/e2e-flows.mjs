import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:18081'
const FILES = '/tmp/genoffice-data/files'
mkdirSync(FILES, { recursive: true })
const results = []
const rec = (name, ok, detail='') => { results.push({name, ok, detail}); console.log(`${ok?'✓':'✗'} ${name}${detail?' :: '+detail:''}`) }
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())

async function newPage(app) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errs = []
  page.on('pageerror', e => errs.push(String(e.message||e).slice(0,200)))
  page.on('console', m => { if (m.type()==='error') errs.push('console: '+m.text().slice(0,200)) })
  return { page, errs }
}
const M = 'e2e-markdown-e2e.md'
const H = 'e2e-html-e2e.html'

// ---------- MARKDOWN ----------
{
  const p = join(FILES, M)
  writeFileSync(p, '# E2E Title\n\noriginal paragraph.\n')
  const { page, errs } = await newPage('markdown')
  await page.goto(`${BASE}/?app=markdown#open=${encodeURIComponent(p)}`, { waitUntil:'load', timeout:30000 })
  await page.waitForSelector('.doc-editor', { timeout:20000 })
  await page.waitForTimeout(2500)
  const loaded = (await page.locator('.doc-editor').innerText()).includes('E2E Title')
  rec('md: opened file renders content', loaded, loaded?'':'editor did not show E2E Title')
  await page.locator('.doc-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nAPPENDED-BY-E2E')
  await page.waitForTimeout(600)
  // save via Cmd/Ctrl+S
  await page.keyboard.press('Meta+s'); await page.keyboard.press('Control+s')
  await page.waitForTimeout(2000)
  const disk = existsSync(p) ? readFileSync(p,'utf8') : '(missing)'
  rec('md: save persists edit to disk', disk.includes('APPENDED-BY-E2E'), disk.includes('APPENDED-BY-E2E')?'':'disk='+JSON.stringify(disk.slice(0,120)))
  rec('md: no runtime errors', errs.length===0, errs.slice(0,3).join(' | '))
  await page.close()
}

// ---------- HTML ----------
{
  const p = join(FILES, H)
  writeFileSync(p, '<!doctype html><html><body><h1>E2E HTML</h1></body></html>')
  const { page, errs } = await newPage('html')
  await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`, { waitUntil:'load', timeout:30000 })
  await page.waitForSelector('.cm-content', { timeout:20000 })
  await page.waitForTimeout(2500)
  const code = await page.locator('.cm-content').innerText()
  rec('html: opened file shows source', code.includes('E2E HTML'), code.slice(0,80))
  const ifr = page.frames().find(f => f.url().includes('/api/html/preview/'))
  rec('html: preview iframe present', !!ifr, ifr? ifr.url().slice(0,80):'no preview iframe')
  if (ifr) {
    const body = await ifr.evaluate(()=>document.body.innerText).catch(()=> '')
    rec('html: preview renders content', body.includes('E2E HTML'), body.slice(0,60))
  }
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+End'); await page.keyboard.press('Control+End')
  await page.keyboard.type('\n<!-- E2E-MARK -->')
  await page.waitForTimeout(500)
  await page.keyboard.press('Meta+s'); await page.keyboard.press('Control+s')
  await page.waitForTimeout(2000)
  const disk = existsSync(p) ? readFileSync(p,'utf8') : '(missing)'
  rec('html: save persists edit to disk', disk.includes('E2E-MARK'), disk.includes('E2E-MARK')?'':'disk='+JSON.stringify(disk.slice(0,140)))
  rec('html: no runtime errors', errs.length===0, errs.slice(0,3).join(' | '))
  await page.close()
}
await browser.close()
console.log(`\n${results.filter(r=>r.ok).length}/${results.length} passed`)
process.exit(results.every(r=>r.ok)?0:1)

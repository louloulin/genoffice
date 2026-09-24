import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-deep.html'
writeFileSync(p,'<!doctype html><html><head><style>body{background:#ff0000}</style></head><body><h1 id="t">E2E-HTML-DEEP</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
const errs=[]; page.on('pageerror',e=>errs.push(String(e.message).slice(0,180))); page.on('console',m=>{if(m.type()==='error')errs.push('c:'+m.text().slice(0,180))})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
// iframe content + geometry
const ifr = page.frames().find(f=>f.url().includes('/api/html/preview/'))
console.log('iframe url:', ifr?.url())
if (ifr) {
  const info = await ifr.evaluate(()=>{
    const h1=document.querySelector('#t')
    const bg=getComputedStyle(document.body).backgroundColor
    return { text:document.body.innerText.slice(0,80), bg, h1:!!h1 }
  }).catch(e=>'ERR '+e.message)
  console.log('iframe content:', JSON.stringify(info))
}
// fetch preview URL directly
const pv = await page.evaluate(()=>[...document.querySelectorAll('iframe')].map(f=>f.src)[0])
if (pv) { const r = await fetch(pv); console.log('preview http', r.status, (await r.text()).slice(0,200).replace(/\n/g,' ')) }
await page.screenshot({path:'/tmp/webverify/shots/html-deep-preview.png'})
// switch to source view
const src = page.getByRole('button',{name:'源码'})
if (await src.count()) { await src.first().click(); await page.waitForTimeout(1200); console.log('clicked 源码') }
const vis = await page.locator('.pane-source').isVisible().catch(()=>false)
console.log('source pane visible:', vis)
if (vis) {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End'); await page.keyboard.press('Meta+End')
  await page.keyboard.type('\n<!-- E2E-DEEP-MARK -->')
  await page.waitForTimeout(600)
  await page.keyboard.press('Control+s'); await page.keyboard.press('Meta+s')
  await page.waitForTimeout(2500)
  const disk = readFileSync(p,'utf8')
  console.log('saved marker present:', disk.includes('E2E-DEEP-MARK'))
  await page.screenshot({path:'/tmp/webverify/shots/html-deep-source.png'})
}
console.log('errors:', errs.slice(0,5))
await b.close()

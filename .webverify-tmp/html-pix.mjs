import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-pix.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1>E2E-PIX</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
await page.locator('iframe.preview-frame').screenshot({ path:'/tmp/webverify/shots/html-iframe-only.png' }).catch(e=>console.log('iframe shot err',e.message))
await page.screenshot({ path:'/tmp/webverify/shots/html-full2.png' })
// sample pixels via canvas? Not possible cross-doc. Instead: ask the frame for its own painted size
const fr = page.frames().find(f=>f.url().includes('/api/html/preview/'))
const st = await fr.evaluate(()=>{
  const de=document.documentElement, bd=document.body
  return { deH:de.clientHeight, deW:de.clientWidth, bdH:bd.clientHeight, bodyBg:getComputedStyle(bd).backgroundColor, htmlBg:getComputedStyle(de).backgroundColor, innerH:window.innerHeight, innerW:window.innerWidth, h1:document.querySelector('h1')?.getBoundingClientRect() }
})
console.log(JSON.stringify(st,null,1))
await b.close()

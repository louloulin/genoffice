import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-rf.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1>E2E-RF</h1></body></html>')
const b=await chromium.launch({channel:'chrome', headless:false}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
await page.screenshot({path:'/tmp/webverify/shots/rf-0.png'})
// force iframe reload by reassigning src
await page.evaluate(()=>{ const f=document.querySelector('iframe.preview-frame'); const s=f.src; f.src='about:blank'; setTimeout(()=>{f.src=s},200) })
await page.waitForTimeout(3000)
await page.screenshot({path:'/tmp/webverify/shots/rf-1-reload.png'})
// force reflow by resizing viewport
await page.setViewportSize({width:1439,height:900}); await page.waitForTimeout(500); await page.setViewportSize({width:1440,height:900})
await page.waitForTimeout(1500)
await page.screenshot({path:'/tmp/webverify/shots/rf-2-resize.png'})
console.log('done')
await b.close()

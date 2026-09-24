import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-top.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1>E2E-TOP</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const meta = await page.evaluate(()=>{ const f=document.querySelector('iframe.preview-frame'); return { attrs:[...f.attributes].map(a=>a.name+'='+a.value.slice(0,60)), src:f.src, contentDocumentAccessible: !!f.contentDocument, cs:{position:getComputedStyle(f).position, transform:getComputedStyle(f).transform, opacity:getComputedStyle(f).opacity, zIndex:getComputedStyle(f).zIndex, visibility:getComputedStyle(f).visibility} } })
console.log('IFRAME:', JSON.stringify(meta,null,1))
const url = meta.src
// open preview url as top-level
const p2 = await b.newPage({viewport:{width:1080,height:732}})
await p2.goto(url,{waitUntil:'load',timeout:30000})
await p2.waitForTimeout(2500)
await p2.screenshot({path:'/tmp/webverify/shots/preview-toplevel.png'})
console.log('top-level shot done')
await b.close()

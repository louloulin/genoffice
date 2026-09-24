import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-rl.html'
writeFileSync(p,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100%"><h1>E2E-RL</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
const previewReqs=[]
page.on('request', r=>{ if(r.url().includes('/api/html/preview/')) previewReqs.push(Date.now()) })
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(10000)
console.log('preview requests in ~13s:', previewReqs.length)
console.log('timestamps:', previewReqs.map(t=>t-previewReqs[0]).join(','))
// frame count
const frames = page.frames().map(f=>({url:f.url().slice(0,80), name:f.name()}))
console.log('frames:', JSON.stringify(frames,null,1))
// current src & revision
const st = await page.evaluate(()=>({ src:document.querySelector('iframe.preview-frame')?.src, v:new URL(document.querySelector('iframe.preview-frame')?.src||'http://x').searchParams.get('v') }))
console.log('iframe src:', JSON.stringify(st))
await b.close()

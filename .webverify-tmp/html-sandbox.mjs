import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-sb.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1 style="font-size:70px">E2E-SB</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const url = await page.evaluate(()=>document.querySelector('iframe.preview-frame').src)
// TEST A: add allow-same-origin to the sandbox
await page.evaluate(()=>{ const f=document.querySelector('iframe.preview-frame'); f.setAttribute('sandbox','allow-scripts allow-forms allow-popups allow-modals allow-same-origin') })
await page.waitForTimeout(3000)
await page.screenshot({path:'/tmp/webverify/shots/sb-A-with-same-origin.png'})
// TEST B: remove sandbox entirely
await page.evaluate(()=>{ const f=document.querySelector('iframe.preview-frame'); f.removeAttribute('sandbox') })
await page.waitForTimeout(3000)
await page.screenshot({path:'/tmp/webverify/shots/sb-B-no-sandbox.png'})
// TEST C: plain iframe on a blank page pointing at same URL (cross-origin parent)
const p2 = await b.newPage({viewport:{width:800,height:600}})
await p2.setContent(`<body style="margin:0;background:#00ff00"><iframe src="${url}" style="border:0;width:800px;height:600px" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe></body>`)
await p2.waitForTimeout(3000)
await p2.screenshot({path:'/tmp/webverify/shots/sb-C-blankpage.png'})
console.log('done')
await b.close()

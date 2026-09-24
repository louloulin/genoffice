import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-inj.html'
writeFileSync(p,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100%"><h1>E2E-INJ</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
// inject a control iframe (srcdoc) as fixed overlay
await page.evaluate(()=>{
  const f=document.createElement('iframe')
  f.setAttribute('srcdoc','<body style="margin:0;background:#00ff00;height:100%"><h1 style="font-size:60px">CONTROL-GREEN</h1></body>')
  f.style.cssText='position:fixed;left:20px;top:20px;width:320px;height:200px;z-index:2147483647;border:4px solid blue'
  document.body.appendChild(f)
})
await page.waitForTimeout(2000)
await page.screenshot({path:'/tmp/webverify/shots/inject-control.png'})
// inject a control iframe loading the same preview URL but WITHOUT sandbox
const url = await page.evaluate(()=>document.querySelector('iframe.preview-frame').src)
await page.evaluate((u)=>{
  const f=document.createElement('iframe')
  f.src=u
  f.style.cssText='position:fixed;right:20px;bottom:20px;width:320px;height:200px;z-index:2147483647;border:4px solid purple'
  document.body.appendChild(f)
}, url)
await page.waitForTimeout(3000)
await page.screenshot({path:'/tmp/webverify/shots/inject-control2.png'})
console.log('done')
await b.close()

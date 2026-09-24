import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-du.html'
writeFileSync(p,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100%"><h1>E2E-DU</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const dataUrl='data:text/html,'+encodeURIComponent('<body style="margin:0;background:#ffcc00;height:100%"><h1 style="font-size:60px">DATA-URL-YELLOW</h1></body>')
// set the app iframe's src to data url (keep its sandbox)
await page.evaluate((u)=>{ document.querySelector('iframe.preview-frame').src=u }, dataUrl)
await page.waitForTimeout(2500)
await page.screenshot({path:'/tmp/webverify/shots/du-1-dataurl.png'})
console.log('done dataurl')
await b.close()

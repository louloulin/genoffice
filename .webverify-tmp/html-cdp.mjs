import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-cdp.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1>E2E-CDP</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(5000)
const cdp = await page.context().newCDPSession(page)
const { data } = await cdp.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false })
writeFileSync('/tmp/webverify/shots/html-cdp.png', Buffer.from(data,'base64'))
console.log('cdp shot written')
await b.close()

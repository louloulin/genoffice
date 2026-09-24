import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-lay.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1 style="font-size:70px">E2E-LAY</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4500)
for (const [name,sel] of [['iframe','iframe.preview-frame'],['host','.preview-host'],['stage','.preview-stage'],['pane','.pane-preview'],['workspace','.workspace'],['appcontent','.app-content']]) {
  try { await page.locator(sel).first().screenshot({path:`/tmp/webverify/shots/lay-${name}.png`, timeout:8000}); console.log('shot',name) } catch(e){ console.log('fail',name,e.message.slice(0,80)) }
}
await b.close()

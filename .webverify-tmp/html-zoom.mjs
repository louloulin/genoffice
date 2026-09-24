import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-zoom.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1 style="font-size:70px">E2E-ZOOM</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const before = await page.evaluate(()=>{ const h=document.querySelector('.preview-host'); return { zoom:getComputedStyle(h).zoom, inline:h.getAttribute('style') } })
console.log('preview-host before:', JSON.stringify(before))
await page.screenshot({path:'/tmp/webverify/shots/zoom-0-before.png'})
// remove zoom
await page.evaluate(()=>{ const h=document.querySelector('.preview-host'); h.style.zoom=''; })
await page.waitForTimeout(2500)
await page.screenshot({path:'/tmp/webverify/shots/zoom-1-nozoom.png'})
// set explicit 1
await page.evaluate(()=>{ const h=document.querySelector('.preview-host'); h.style.zoom='1'; })
await page.waitForTimeout(2500)
await page.screenshot({path:'/tmp/webverify/shots/zoom-2-explicit1.png'})
console.log('done')
await b.close()

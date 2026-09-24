import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-mut.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1>E2E-MUT</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(5000)
// 1) baseline screenshot
await page.screenshot({path:'/tmp/webverify/shots/mut-0-baseline.png'})
// 2) make ancestors transparent
await page.evaluate(()=>{ let e=document.querySelector('iframe.preview-frame')?.parentElement; while(e&&e!==document.body){ e.style.backgroundColor='transparent'; e=e.parentElement } })
await page.waitForTimeout(800)
await page.screenshot({path:'/tmp/webverify/shots/mut-1-transparent.png'})
// 3) find sibling elements under preview-host
const sib = await page.evaluate(()=>{
  const host=document.querySelector('.preview-host')
  return { hostChildren:[...host.children].map(c=>({tag:c.tagName,cls:(typeof c.className==='string'?c.className:'').slice(0,60),rect:(()=>{const r=c.getBoundingClientRect();return[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})(),z:getComputedStyle(c).zIndex,display:getComputedStyle(c).display})) }
})
console.log('preview-host children:', JSON.stringify(sib,null,1))
// 4) move iframe to body
await page.evaluate(()=>{ const f=document.querySelector('iframe.preview-frame'); f.style.cssText='position:fixed;left:40px;top:40px;width:600px;height:400px;z-index:99999;border:3px solid blue'; document.body.appendChild(f) })
await page.waitForTimeout(1500)
await page.screenshot({path:'/tmp/webverify/shots/mut-2-ondody.png'})
console.log('done')
await b.close()

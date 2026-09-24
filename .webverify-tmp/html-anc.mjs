import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-anc.html'
writeFileSync(p,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100%"><h1 style="font-size:70px">E2E-ANC</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const chain = await page.evaluate(()=>{
  const out=[]; let e=document.querySelector('iframe.preview-frame')
  while(e){ const s=getComputedStyle(e); const r=e.getBoundingClientRect()
    out.push({ tag:e.tagName, cls:(typeof e.className==='string'?e.className:'').slice(0,45),
      zoom:s.zoom, willChange:s.willChange, transformStyle:s.transformStyle, perspective:s.perspective, isolation:s.isolation, contain:s.contain, filter:s.filter, backdropFilter:s.backdropFilter, transform:s.transform.slice(0,25), opacity:s.opacity, rect:[Math.round(r.width),Math.round(r.height)], isInert:e.inert??null, contentVisibility:s.contentVisibility, mixBlendMode:s.mixBlendMode })
    e=e.parentElement }
  return out
})
for (const c of chain) console.log(JSON.stringify(c))
await b.close()

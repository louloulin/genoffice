import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-pe.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1>E2E-PE</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(5000)
const d = await page.evaluate(()=>{
  const out=[]
  for (const e of document.querySelectorAll('*')) {
    const s=getComputedStyle(e); if(s.display==='none'||s.visibility==='hidden')continue
    const r=e.getBoundingClientRect(); if(r.width<400||r.height<300)continue
    const pe=s.pointerEvents, bg=s.backgroundColor, op=s.opacity
    const coversPoint = r.x<=900 && r.right>=900 && r.y<=500 && r.bottom>=500
    if (coversPoint && (pe==='none' || op!=='1' || (bg!=='rgba(0, 0, 0, 0)' && bg!=='transparent'))) {
      out.push({tag:e.tagName, cls:(typeof e.className==='string'?e.className:'').slice(0,70), pe, bg, op, z:s.zIndex, pos:s.position, rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})
    }
  }
  // also: mixed blend modes / filter / contain
  const fx=[]
  for (const e of document.querySelectorAll('*')) { const s=getComputedStyle(e); if (s.mixBlendMode!=='normal'||s.filter!=='none'||s.contain!=='none'||s.contentVisibility!=='visible'||s.backdropFilter!=='none'){ const r=e.getBoundingClientRect(); if(r.width>300&&r.height>200) fx.push({tag:e.tagName,cls:(typeof e.className==='string'?e.className:'').slice(0,50),mix:s.mixBlendMode,filter:s.filter,contain:s.contain,cv:s.contentVisibility,bf:s.backdropFilter}) } }
  return { covering: out.slice(0,15), fx: fx.slice(0,15) }
})
console.log(JSON.stringify(d,null,1))
await b.close()

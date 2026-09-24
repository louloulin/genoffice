import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-why.html'
writeFileSync(p,'<!doctype html><html><head><style>body{background:#ff0000}</style></head><body><h1 id="t">E2E-WHY</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const info = await page.evaluate(()=>{
  const f=document.querySelector('iframe')
  const chain=[]; let e=f
  while(e && e!==document.documentElement){ const s=getComputedStyle(e); const r=e.getBoundingClientRect()
    chain.push({tag:e.tagName, cls:(typeof e.className==='string'?e.className:'').slice(0,60), display:s.display, vis:s.visibility, opacity:s.opacity, zIndex:s.zIndex, pos:s.position, rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)], overflow:s.overflow, transform:s.transform.slice(0,30), clipPath:s.clipPath.slice(0,20) }); e=e.parentElement }
  // what element is painted at the iframe centre?
  const r=f.getBoundingClientRect(); const cx=r.x+r.width/2, cy=r.y+r.height/2
  const top=document.elementFromPoint(cx,cy)
  const stack=document.elementsFromPoint(cx,cy).slice(0,6).map(el=>({tag:el.tagName,cls:(typeof el.className==='string'?el.className:'').slice(0,60)}))
  return { chain, point:[Math.round(cx),Math.round(cy)], topEl: top? top.tagName+'.'+(typeof top.className==='string'?top.className:'').slice(0,60):null, stack }
})
console.log(JSON.stringify(info,null,1))
await b.close()

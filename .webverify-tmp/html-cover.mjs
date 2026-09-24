import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-cover.html'
writeFileSync(p,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="font-size:72px">COVER-TEST</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const out = await page.evaluate(()=>{
  const f=document.querySelector('iframe.preview-frame')
  if(!f) return {err:'no frame'}
  const r=f.getBoundingClientRect()
  const cx=r.left+r.width/2, cy=r.top+r.height/2
  const stack=document.elementsFromPoint(cx,cy).map(e=>{
    const cs=getComputedStyle(e)
    return {tag:e.tagName,cls:(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className)+'',id:e.id,
      z:cs.zIndex,pos:cs.position,pe:cs.pointerEvents,bg:cs.backgroundColor,op:cs.opacity,vis:cs.visibility,
      disp:cs.display, ci:cs.contentVisibility, cv:cs.contain, filt:cs.filter, bf:cs.backdropFilter,
      w:Math.round(e.getBoundingClientRect().width),h:Math.round(e.getBoundingClientRect().height)}
  })
  return {rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}, cx:Math.round(cx), cy:Math.round(cy), stack}
})
console.log(JSON.stringify(out,null,2))
await b.close()

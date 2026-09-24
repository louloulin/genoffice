import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-look.html'
writeFileSync(p,'<!doctype html><html><body><h1>E2E HTML LOOK</h1><p>hello</p></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
await page.screenshot({path:'/tmp/webverify/shots/html-open.png'})
const st=await page.evaluate(()=>{
  const cm=document.querySelector('.cm-content')
  const r=cm?.getBoundingClientRect()
  return {
    cmVisible: !!cm && r.width>0 && r.height>0,
    cmRect: r? {x:r.x,y:r.y,w:r.width,h:r.height}:null,
    cmDisplay: cm? getComputedStyle(cm).display:'(none)',
    parentChain: (()=>{ let e=cm,out=[]; for(let i=0;i<5&&e;i++){const s=getComputedStyle(e); out.push(`${e.tagName}.${(e.className||'').toString().slice(0,40)} display=${s.display} vis=${s.visibility} op=${s.opacity}`); e=e.parentElement} return out })(),
    iframes:[...document.querySelectorAll('iframe')].map(f=>({src:f.src.slice(0,90),r:(()=>{const x=f.getBoundingClientRect();return {w:x.width,h:x.height}})()})),
  }
})
console.log(JSON.stringify(st,null,1))
await b.close()

import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-ov.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1>E2E-OV</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const d = await page.evaluate(()=>{
  const panes=[...document.querySelectorAll('.pane')].map(e=>({cls:e.className, display:getComputedStyle(e).display, vis:getComputedStyle(e).visibility}))
  const ws=document.querySelector('.workspace'); const wsc=ws?getComputedStyle(ws).display:null
  // fixed/absolute large elements
  const overlays=[...document.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e); if(s.position!=='fixed'&&s.position!=='absolute')return false; const r=e.getBoundingClientRect(); return r.width>500&&r.height>400 && s.display!=='none' && s.visibility!=='hidden' && Number(s.zIndex||0)>=0}).slice(0,10).map(e=>({tag:e.tagName,cls:(typeof e.className==='string'?e.className:'').slice(0,60),z:getComputedStyle(e).zIndex,bg:getComputedStyle(e).backgroundColor,rect:[Math.round(e.getBoundingClientRect().x),Math.round(e.getBoundingClientRect().y),Math.round(e.getBoundingClientRect().width),Math.round(e.getBoundingClientRect().height)]}))
  const probe=(x,y)=>{const el=document.elementFromPoint(x,y); return el? el.tagName+'.'+(typeof el.className==='string'?el.className:'').slice(0,50):null}
  const samples={ '400,300':probe(400,300),'900,500':probe(900,500),'1300,600':probe(1300,600),'700,800':probe(700,800) }
  // localStorage prefs
  let ls={}; try{ for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(/html|view|pane|pref/i.test(k)) ls[k]=String(localStorage.getItem(k)).slice(0,120)} }catch{}
  return { panes, workspaceDisplay:wsc, overlays, samples, ls }
})
console.log(JSON.stringify(d,null,1))
await b.close()

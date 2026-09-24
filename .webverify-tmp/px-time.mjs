import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const f='/tmp/genoffice-data/files/e2e-html-pxt.html'
writeFileSync(f,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="font-size:72px;color:#00ff00">PXT</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
const reqs=[]
page.on('request',r=>{ if(r.url().includes('/api/html/preview/')) reqs.push({t:Date.now(),url:r.url().slice(-40),rt:r.resourceType()}) })
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(f)}`,{waitUntil:'load',timeout:30000})
const t0=Date.now()
const samples=[]
for(let i=0;i<24;i++){
  await page.waitForTimeout(500)
  const buf=await page.screenshot()
  const b64=buf.toString('base64')
  const col=await page.evaluate(async (b64)=>{
    const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode()
    const c=document.createElement('canvas'); c.width=img.width;c.height=img.height
    const g=c.getContext('2d'); g.drawImage(img,0,0)
    const d=g.getImageData(900,500,1,1).data
    const src=document.querySelector('iframe.preview-frame')?.src.slice(-8)
    return `${d[0]},${d[1]},${d[2]}|src=${src}`
  }, b64)
  samples.push(`${((Date.now()-t0)/1000).toFixed(1)}s ${col}`)
}
console.log(samples.join('\n'))
console.log('preview requests:', reqs.length, JSON.stringify(reqs.map(r=>({dt:r.t-t0,rt:r.rt,u:r.url}))))
await b.close()

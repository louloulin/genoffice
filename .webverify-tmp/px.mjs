import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const f='/tmp/genoffice-data/files/e2e-html-px.html'
writeFileSync(f,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="font-size:72px;color:#00ff00">PIXEL-TEST</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})

async function pixelOf(pngPath, sample){
  const b64=readFileSync(pngPath).toString('base64')
  const p=await b.newPage()
  await p.setContent('<canvas id=c></canvas>')
  const col=await p.evaluate(async ({b64,sample})=>{
    const img=new Image(); img.src='data:image/png;base64,'+b64
    await img.decode()
    const c=document.getElementById('c'); c.width=img.width; c.height=img.height
    const g=c.getContext('2d'); g.drawImage(img,0,0)
    const pick=(x,y)=>{const d=g.getImageData(Math.max(0,Math.min(img.width-1,x)),Math.max(0,Math.min(img.height-1,y)),1,1).data;return `${d[0]},${d[1]},${d[2]}`}
    const out={size:[img.width,img.height]}
    for(const k in sample){ const [rx,ry]=sample[k]; out[k]=pick(Math.round(img.width*rx),Math.round(img.height*ry)) }
    return out
  },{b64,sample})
  await p.close()
  return col
}

await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(f)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)

const info=await page.evaluate(()=>{
  const fr=document.querySelector('iframe.preview-frame'); const r=fr.getBoundingClientRect()
  return {rect:{x:r.x,y:r.y,w:r.width,h:r.height,x2:r.right,y2:r.bottom}, src:fr.src, vp:[innerWidth,innerHeight]}
})
console.log('iframe rect', JSON.stringify(info))

// child frame self-report
const frame=page.frames().find(x=>x.url().includes('/api/html/preview/'))
console.log('child frame found:', !!frame, frame&&frame.url().slice(0,80))
if(frame){
  try{
    const cs=await frame.evaluate(()=>({ready:document.readyState, htmlBg:getComputedStyle(document.documentElement).backgroundColor, bodyBg:getComputedStyle(document.body).backgroundColor, len:document.documentElement.outerHTML.length, text:document.body.innerText.slice(0,40), inner:[innerWidth,innerHeight]}))
    console.log('child report', JSON.stringify(cs))
  }catch(e){ console.log('child eval err', e.message) }
}

await page.screenshot({path:'/tmp/webverify/shots/px-full.png'})
const el=await page.$('iframe.preview-frame'); await el.screenshot({path:'/tmp/webverify/shots/px-el.png'})

const s=info.rect
const full=await pixelOf('/tmp/webverify/shots/px-full.png', {center:[(s.x+s.w/2)/info.vp[0],(s.y+s.h/2)/info.vp[1]], nearTL:[(s.x+20)/info.vp[0],(s.y+20)/info.vp[1]]})
console.log('FULL-SCREENSHOT pixels', JSON.stringify(full))
const elp=await pixelOf('/tmp/webverify/shots/px-el.png',{center:[0.5,0.5], tl:[0.05,0.05]})
console.log('ELEMENT-SHOT pixels', JSON.stringify(elp))
await b.close()

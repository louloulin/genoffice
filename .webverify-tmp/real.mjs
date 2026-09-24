import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
const BASE='http://127.0.0.1:18081'
const f='/tmp/genoffice-data/files/e2e-html-real.html'
writeFileSync(f,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="font-size:72px;color:#00ff00">REAL-SCREEN</h1></body></html>')
const b=await chromium.launch({channel:'chrome',headless:false,args:['--window-position=0,0','--window-size=1460,1000','--force-device-scale-factor=1']})
const ctx=await b.newContext({viewport:null})
const page=await ctx.newPage()
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(f)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.bringToFront()
await page.waitForTimeout(6000)
execSync('screencapture -x -o /tmp/webverify/shots/real2-full.png')
const shot='/tmp/webverify/shots/real2-full.png'
const b64=readFileSync(shot).toString('base64')
const p2=await b.newPage()
await p2.setContent('<canvas id=c></canvas>')
const res=await p2.evaluate(async (b64)=>{
  const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode()
  const c=document.getElementById('c'); c.width=img.width; c.height=img.height
  const g=c.getContext('2d'); g.drawImage(img,0,0)
  const pick=(x,y)=>{const d=g.getImageData(x,y,1,1).data; return `${d[0]},${d[1]},${d[2]}`}
  return {size:[img.width,img.height], center:pick(Math.round(img.width*0.62),Math.round(img.height*0.5)), c2:pick(Math.round(img.width*0.7),Math.round(img.height*0.4))}
}, b64)
console.log('REAL SCREEN sample', JSON.stringify(res))
await b.close()

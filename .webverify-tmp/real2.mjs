import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
const BASE='http://127.0.0.1:18081'
const f='/tmp/genoffice-data/files/e2e-html-real2.html'
writeFileSync(f,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="font-size:72px;color:#00ff00">REAL2</h1></body></html>')
const b=await chromium.launch({channel:'chrome',headless:false,args:['--window-position=100,60','--window-size=1200,860','--force-device-scale-factor=1']})
const ctx=await b.newContext({viewport:null})
const page=await ctx.newPage()
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(f)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.bringToFront()
await page.waitForTimeout(6000)
const rect=await page.evaluate(()=>{const r=document.querySelector('iframe.preview-frame').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})
// window bounds (logical points) incl. chrome UI offset
const wb=execSync(`osascript -e 'tell application "Google Chrome" to get bounds of front window'`).toString().trim()
const [wx,wy,wr,wb2]=wb.split(',').map(s=>parseInt(s.trim(),10))
console.log('window bounds', {wx,wy,wr,wb2}, 'iframe rect in page', rect)
const titleH=(wb2-wy)-860
const px=Math.round(wx+rect.x), py=Math.round(wy+titleH+rect.y), pw=Math.round(rect.w), ph=Math.round(rect.h)
execSync(`screencapture -x -o -R${px},${py},${pw},${ph} /tmp/webverify/shots/real2-crop.png`)
const b64=readFileSync('/tmp/webverify/shots/real2-crop.png').toString('base64')
const p2=await b.newPage(); await p2.setContent('<canvas id=c></canvas>')
const res=await p2.evaluate(async (b64)=>{const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();const c=document.getElementById('c');c.width=img.width;c.height=img.height;const g=c.getContext('2d');g.drawImage(img,0,0);const pick=(x,y)=>{const d=g.getImageData(x,y,1,1).data;return `${d[0]},${d[1]},${d[2]}`};return {size:[img.width,img.height],center:pick(img.width>>1,img.height>>1),tl:pick(30,30)}},b64)
console.log('CROP OF PREVIEW REGION FROM REAL SCREEN', JSON.stringify(res))
await b.close()

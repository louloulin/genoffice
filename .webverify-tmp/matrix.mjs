import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081', D='/tmp/genoffice-data/files'
const cases=[
 ['A hash-open red',      `${BASE}/?app=html#open=${D}/mx-red.html`],
 ['B query-open red',     `${BASE}/?app=html&open=${D}/mx-red.html`],
 ['C hash-open nobg',     `${BASE}/?app=html#open=${D}/mx-nobg.html`],
 ['D missing file',       `${BASE}/?app=html#open=${D}/mx-nope.html`],
 ['E local asset+css',    `${BASE}/?app=html#open=${D}/mx-asset.html`],
 ['F .htm extension',     `${BASE}/?app=html#open=${D}/mx-ext.htm`],
]
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
for (const [name,url] of cases){
  const page=await b.newPage({viewport:{width:1440,height:900}})
  const errs=[]; page.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,90))})
  await page.goto(url,{waitUntil:'load',timeout:30000}).catch(e=>console.log(name,'goto err',e.message))
  await page.waitForSelector('iframe.preview-frame',{timeout:25000}).catch(()=>{})
  await page.waitForTimeout(5000)
  const r=await page.evaluate(async ()=>{
    const fr=document.querySelector('iframe.preview-frame')
    if(!fr) return {src:'NO-IFRAME', rect:[0,0,1,1]}
    const rr=fr.getBoundingClientRect()
    return {src:fr.src.slice(-14), rect:[Math.round(rr.x),Math.round(rr.y),Math.round(rr.width),Math.round(rr.height)]}
  })
  const buf=await page.screenshot()
  const col=await page.evaluate(async ({b64,r})=>{
    const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode()
    const c=document.createElement('canvas'); c.width=img.width;c.height=img.height
    const g=c.getContext('2d'); g.drawImage(img,0,0)
    const pick=(x,y)=>{const d=g.getImageData(x,y,1,1).data;return `${d[0]},${d[1]},${d[2]}`}
    const x=Math.round(r.rect[0]+r.rect[2]/2), y=Math.round(r.rect[1]+r.rect[3]/2)
    return {center:pick(x,y), q1:pick(Math.round(r.rect[0]+r.rect[2]*0.25),y), size:[img.width,img.height]}
  },{b64:buf.toString('base64'), r})
  console.log(`${name.padEnd(20)} ${JSON.stringify(r.src)} rect=${r.rect} px=${JSON.stringify(col.center)}/${col.q1} errs=${errs.length?errs[0]:'none'}`)
  await page.close()
}
await b.close()

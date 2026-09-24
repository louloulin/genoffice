import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081', F='/tmp/genoffice-data/files'
const cases=[
 ['docs',    `${BASE}/?app=docs#open=${F}/doc-1790234280236.docx`],
 ['sheets',  `${BASE}/?app=sheets#open=${F}/sheet-1790234280279.xlsx`],
 ['slides',  `${BASE}/?app=slides#open=${F}/slide-1790234280332.pptx`],
 ['pdf',     `${BASE}/?app=pdf#open=${F}/pdf-1790234280386.pdf`],
 ['markdown',`${BASE}/?app=markdown#open=${F}/md-1790234280427.md`],
 ['html',    `${BASE}/?app=html#open=/tmp/genoffice-data/html-1790234280463.html`],
 ['shell',   `${BASE}/?app=shell`],
]
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
for(const [name,url] of cases){
  const page=await b.newPage({viewport:{width:1440,height:900}})
  const errs=[],failed=[]
  page.on('console',m=>{if(m.type()==='error')errs.push(m.text().split('\n')[0].slice(0,110))})
  page.on('pageerror',e=>errs.push('PAGEERROR: '+e.message.slice(0,110)))
  page.on('response',r=>{if(r.status()>=400)failed.push(`${r.status()} ${r.url().replace(BASE,'').slice(0,60)}`)})
  await page.goto(url,{waitUntil:'load',timeout:35000}).catch(e=>errs.push('GOTO: '+e.message.slice(0,80)))
  await page.waitForTimeout(7000)
  const dom=await page.evaluate(()=>{
    const root=document.querySelector('#root')
    const canvases=[...document.querySelectorAll('canvas')].map(c=>`${c.width}x${c.height}`)
    return {rootKids:root?root.children.length:0, canvases:canvases.slice(0,6), text:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,160)}
  })
  const b64=(await page.screenshot()).toString('base64')
  const paint=await page.evaluate(async (b64)=>{
    const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode()
    const c=document.createElement('canvas'); c.width=img.width; c.height=img.height
    const g=c.getContext('2d'); g.drawImage(img,0,0)
    const d=g.getImageData(0,0,img.width,img.height).data
    const set=new Set(); let nonwhite=0
    for(let i=0;i<d.length;i+=4*97){ set.add((d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4)); if(!(d[i]>245&&d[i+1]>245&&d[i+2]>245)) nonwhite++ }
    const total=Math.floor(d.length/(4*97))
    return {distinctColors:set.size, nonWhitePct:Math.round(nonwhite/total*100)}
  }, b64)
  console.log(`${name.padEnd(9)} kids=${dom.rootKids} canvas=[${dom.canvases.join(' ')}] paint=${JSON.stringify(paint)}`)
  console.log(`          text="${dom.text.slice(0,120)}"`)
  if(errs.length) console.log('          ERR:', errs.slice(0,3).join(' | '))
  if(failed.length) console.log('          FAILED:', failed.slice(0,3).join(' | '))
  await page.close()
}
await b.close()

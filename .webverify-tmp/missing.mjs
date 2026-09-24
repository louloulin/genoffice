import { chromium } from '@playwright/test'
const BASE='http://127.0.0.1:18081', D='/tmp/genoffice-data/files'
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
const logs=[]; page.on('console',m=>logs.push(`[${m.type()}] ${m.text().slice(0,120)}`))
const failed=[]; page.on('response',r=>{ if(r.status()>=400) failed.push(`${r.status()} ${r.url().slice(-50)}`) })
await page.goto(`${BASE}/?app=html#open=${D}/mx-nope.html`,{waitUntil:'load',timeout:30000})
await page.waitForTimeout(6000)
const info=await page.evaluate(()=>{
  const stage=document.querySelector('.preview-stage')
  const txt=(document.body.innerText||'').replace(/\s+/g,' ').slice(0,600)
  return { hasIframe: !!document.querySelector('iframe.preview-frame'), stageHTML: stage?stage.innerHTML.slice(0,500):null, bodyText: txt }
})
console.log('hasIframe:',info.hasIframe)
console.log('stageHTML:', info.stageHTML)
console.log('bodyText:', info.bodyText)
console.log('failed responses:', failed)
console.log('console:', logs.slice(0,8))
await page.screenshot({path:'/tmp/webverify/shots/missing.png'})
await b.close()

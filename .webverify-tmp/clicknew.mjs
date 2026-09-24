import { chromium } from '@playwright/test'
const BASE='http://127.0.0.1:18081'
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const ctx=await b.newContext({viewport:{width:1440,height:900}})
const page=await ctx.newPage()
const opened=[]
ctx.on('page',p=>opened.push(p))
await page.goto(`${BASE}/?app=shell`,{waitUntil:'load',timeout:35000})
await page.waitForTimeout(6000)
for (const label of ['AI Markdown','AI HTML']) {
  opened.length=0
  const card=page.locator(`text="${label}"`).first()
  const n=await card.count()
  if(!n){ console.log(`${label}: card not found`); continue }
  await card.click({timeout:8000}).catch(e=>console.log(`${label} click err`,e.message.slice(0,60)))
  await page.waitForTimeout(5000)
  console.log(`--- click "${label}" → popups: ${opened.length}`)
  for(const p of opened.slice(0,2)){
    await p.waitForTimeout(3500)
    const u=p.url()
    const t=await p.evaluate(()=>(document.body.innerText||'').replace(/\s+/g,' ').slice(0,180)).catch(e=>'EVALERR')
    console.log('    url:', u.slice(0,120))
    console.log('    text:', t.slice(0,170))
  }
}
console.log('\nfiles now on disk:')
await b.close()

import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-csp.html'
writeFileSync(p,'<!doctype html><html><body style="margin:0;background:#ff0000;height:100%"><h1>E2E-CSP</h1></body></html>')
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:1440,height:900}})
await page.addInitScript(()=>{ window.__csp=[]; document.addEventListener('securitypolicyviolation', e=>window.__csp.push({d:e.violatedDirective, b:e.blockedURI, s:e.sourceFile||'', msg:e.originalPolicy?.slice(0,80)})) })
const msgs=[]; page.on('console',m=>msgs.push(m.type()+': '+m.text().slice(0,220)))
page.on('response', r=>{ if(r.url().includes('/api/html/preview/')) console.log('PREVIEW RESP', r.status(), JSON.stringify([...Object.entries(r.headers())].filter(([k])=>/content-security|frame|sandbox/i.test(k)))) })
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(4000)
const csp = await page.evaluate(()=>window.__csp)
console.log('CSP VIOLATIONS:', JSON.stringify(csp,null,1))
console.log('CONSOLE:'); for(const m of msgs.slice(0,25)) console.log('  ',m)
// check the parent meta CSP
const meta = await page.evaluate(()=>[...document.querySelectorAll('meta[http-equiv]')].map(m=>m.getAttribute('http-equiv')+' = '+m.getAttribute('content')))
console.log('META:', JSON.stringify(meta,null,1))
await b.close()

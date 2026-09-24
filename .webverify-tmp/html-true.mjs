import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const BASE='http://127.0.0.1:18081'
const p='/tmp/genoffice-data/files/e2e-html-true.html'
writeFileSync(p,'<!doctype html><html><head><style>html,body{margin:0;background:#ff0000;height:100%}</style></head><body><h1 style="font-size:80px">E2E-TRUE</h1></body></html>')
const b=await chromium.launch({ channel:'chrome', headless:false, args:['--start-maximized'] })
const ctx=await b.newContext({viewport:null})
const page=await ctx.newPage()
await page.goto(`${BASE}/?app=html#open=${encodeURIComponent(p)}`,{waitUntil:'load',timeout:30000})
await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0,{timeout:20000})
await page.waitForTimeout(6000)
await page.bringToFront()
await page.waitForTimeout(2000)
console.log('READY — leaving browser open for 25s')
await new Promise(r=>setTimeout(r,25000))
await b.close()

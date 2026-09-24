import { chromium } from '@playwright/test'
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const page=await b.newPage({viewport:{width:600,height:400}})
await page.setContent(`<body style="margin:0;background:#00ff00"><iframe id="f" style="border:0;width:600px;height:300px" srcdoc="<body style='margin:0;background:#ff0000;height:100%'><h1>IN</h1></body>"></iframe></body>`)
await page.waitForTimeout(1500)
await page.screenshot({path:'/tmp/webverify/shots/control-full.png'})
await page.locator('#f').screenshot({path:'/tmp/webverify/shots/control-iframe.png'})
console.log('done')
await b.close()

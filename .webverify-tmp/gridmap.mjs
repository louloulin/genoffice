import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
const shot=process.argv[2]
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch())
const p=await b.newPage()
const res=await p.evaluate(async (b64)=>{
  const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode()
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height
  const g=c.getContext('2d'); g.drawImage(img,0,0)
  const COLS=48, ROWS=24
  const grid=[]
  const stats={}
  for(let r=0;r<ROWS;r++){
    let line=''
    for(let col=0;col<COLS;col++){
      const x=Math.round((col+0.5)*img.width/COLS), y=Math.round((r+0.5)*img.height/ROWS)
      const d=g.getImageData(x,y,1,1).data
      const [R,G,B]=[d[0],d[1],d[2]]
      let ch='.'
      if(R>150&&R-G>60&&R-B>60) ch='R'
      else if(R>200&&G>200&&B>200) ch='W'
      else if(R<70&&G<70&&B<70) ch='#'
      else if(B>150&&B-R>50) ch='B'
      else ch='-'
      line+=ch
      stats[ch]=(stats[ch]||0)+1
    }
    grid.push(line)
  }
  return {size:[img.width,img.height], grid, stats}
}, readFileSync(shot).toString('base64'))
console.log('size',res.size,'stats',JSON.stringify(res.stats))
console.log(res.grid.join('\n'))
await b.close()

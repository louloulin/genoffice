// 调试 SSE write 行为
import http from 'node:http'

const session = `debug-${Date.now()}`

const req = http.get({
  host: '127.0.0.1', port: 18081,
  path: `/api/ipc/events?session=${session}`,
}, (res) => {
  console.log('Response headers:', JSON.stringify(res.headers, null, 2))
  console.log('Response statusCode:', res.statusCode)
  console.log('writable:', res.writable)
  console.log('writableEnded:', res.writableEnded)

  let bytes = 0
  res.on('data', (chunk) => {
    bytes += chunk.length
    console.log(`[data] ${chunk.length}B | ${chunk.toString().slice(0,60).replace(/\n/g,'\\n')}`)
  })
  res.on('close', () => console.log('[close]'))
  res.on('end', () => console.log('[end]'))
})

req.on('error', (e) => console.error('req error:', e.message))

// 同时：直接测试 response.write 是否能发送
// 模拟一个简单的 SSE write
const testRes = new http.ServerResponse({ method: 'GET', headers: {} })
testRes.writeHead(200, { 'Content-Type': 'text/event-stream' })
const ok1 = testRes.write(': test\n\n')
console.log('Direct writeHead+write works:', ok1)
testRes.end()

// 等待 28 秒看 SSE 事件
await new Promise(r => setTimeout(r, 28_000))
console.log('Total bytes received:', bytes)
req.destroy()
process.exit(0)

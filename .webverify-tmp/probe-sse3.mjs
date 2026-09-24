// 正确的 SSE 连接测试
import http from 'node:http'

const session = `ssetest-${Date.now()}`

// 连接 SSE 并等待 27 秒（确保至少等到一个心跳）
const t0 = Date.now()
const events = []
const types = new Set()

const req = http.get({
  host: '127.0.0.1', port: 18081,
  path: `/api/ipc/events?session=${session}`,
}, (res) => {
  console.log(`SSE status: ${res.statusCode}`)
  console.log(`Content-Type: ${res.headers['content-type']}`)
  console.log(`Transfer-Encoding: ${res.headers['transfer-encoding']}`)

  res.on('data', (chunk) => {
    const text = chunk.toString()
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) events.push(line.slice(5))
      if (line.startsWith('event:')) types.add(line.slice(6))
    }
  })
})

req.on('error', (e) => console.error('SSE req error:', e.message))

// 等待 27 秒
await new Promise(r => setTimeout(r, 27_000))

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nElapsed: ${elapsed}s`)
console.log(`Events received: ${events.length}`)
console.log(`Event types: ${[...types].join(', ') || '(none)'}`)
if (events.length > 0) {
  console.log('Last event:', events.at(-1)?.slice(0, 100))
  console.log('✅ Heartbeat confirmed')
} else {
  console.log('❌ No events in 27s — SSE endpoint or heartbeat broken')
}

req.destroy()
process.exit(0)

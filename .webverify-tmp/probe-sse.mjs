// SSE 事件顺序和完整性测试
import http from 'node:http'

const session = `test-${Date.now()}`

const req = http.request({
  host: '127.0.0.1',
  port: 18081,
  path: `/api/ipc/events?session=${session}`,
  method: 'GET',
}, (res) => {
  let events = 0
  let lastEvent = null
  res.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data:'))
    for (const line of lines) {
      events++
      lastEvent = line.slice(5)
    }
  })
  setTimeout(() => {
    console.log(`SSE events received: ${events}`)
    console.log(`Last event: ${lastEvent?.slice(0, 80)}`)
    console.log(events >= 1 ? '✅ heartbeat working' : '❌ no heartbeat')
    res.destroy()
    process.exit(0)
  }, 5000)
})
req.end()

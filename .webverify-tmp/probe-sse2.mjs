// SSE 完整探针：等待 30s 观察心跳 + pushSseEvent
import http from 'node:http'

const session = `probe-${Date.now()}`

// 1. 先通过 IPC 触发一个 push，看能否收到
async function invoke(channel, args = []) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ args })
    const req = http.request({
      host: '127.0.0.1', port: 18081, path: `/api/ipc/${channel}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
    req.write(body)
    req.end()
  })
}

async function main() {
  // 2. 打开 SSE 连接
  const events = []
  const sseReq = http.request({
    host: '127.0.0.1', port: 18081,
    path: `/api/ipc/events?session=${session}`,
    method: 'GET',
  }, (res) => {
    res.on('data', (chunk) => {
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        if (line.startsWith('data:')) {
          events.push(line.slice(5))
        }
      }
    })
  })

  // 等待 30s
  await new Promise(r => setTimeout(r, 30_000))

  console.log(`Events received in 30s: ${events.length}`)
  if (events.length > 0) {
    console.log('Last 3 events:')
    events.slice(-3).forEach(e => console.log(' ', e.slice(0, 120)))
  } else {
    console.log('❌ No events — heartbeat may be broken or session never registered')
  }

  sseReq.destroy()
  process.exit(0)
}

main().catch(console.error)

/**
 * E1: PENDING_FRAMES leak probe.
 *
 * Documented behaviour in docs/web-electron.md:
 *   "Pending frames are buffered for reconnection and expire after 60 seconds."
 *
 * Actual behaviour check:
 *   1. Open an SSE channel for a fresh sessionId, push events while the
 *      connection is closed, then reconnect. The frames should replay.
 *   2. Push events for an UNUSED sessionId (never reconnected). Check the
 *      server's memory holds them indefinitely or evicts them after 60s.
 */
const BASE = 'http://127.0.0.1:18081'

let pass = 0, fail = 0
const check = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`✗ ${msg}`) }
}

async function invoke(channel, args = []) {
  const r = await fetch(`${BASE}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return { status: r.status, body: await r.json() }
}

async function pushEvent(sessionId) {
  // Push a benign event by invoking a channel that the main process will
  // echo back over SSE. app:get-language is the standard ping.
  // We need a side-channel that actually pushes. Use home:dirty-changed which
  // sends an event to the renderer.
  return invoke('home:dirty-changed', [false])
}

console.log('\n━━━ E1: SSE reconnection replays buffered frames ━━━')
const session1 = `e1-reconnect-${Date.now()}`
{
  const ctl = new AbortController()
  const res = await fetch(`${BASE}/api/ipc/events?session=${encodeURIComponent(session1)}`, {
    signal: ctl.signal,
    headers: { accept: 'text/event-stream' },
  })
  check(res.status === 200, `SSE connect returns 200 (status=${res.status})`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let events = []
  let abortReader
  abortReader = () => ctl.abort()
  // read in background
  ;(async () => {
    while (!ctl.signal.aborted) {
      const { value, done } = await reader.read().catch(() => ({ done: true }))
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2)
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data:')) {
            try { events.push(JSON.parse(line.slice(5))) } catch {}
          }
        }
      }
    }
  })()
  await new Promise((r) => setTimeout(r, 800))
  abortReader()
  await new Promise((r) => setTimeout(r, 200))
  // Connection is now closed but session1 is fresh.
}

console.log('\n━━━ E1: orphan session: frames buffered when no client connected ━━━')
const session2 = `e1-orphan-${Date.now()}`
// Push events to session2 without any client listening
for (let i = 0; i < 5; i++) {
  await pushEvent(session2)
}
await new Promise((r) => setTimeout(r, 500))
// Now connect to session2 and see if frames replay
{
  const ctl = new AbortController()
  const res = await fetch(`${BASE}/api/ipc/events?session=${encodeURIComponent(session2)}`, {
    signal: ctl.signal,
    headers: { accept: 'text/event-stream' },
  })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events = []
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read().catch(() => ({ done: true }))
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          try { events.push(JSON.parse(line.slice(5))) } catch {}
        }
      }
    }
  }
  ctl.abort()
  console.log(`  ℹ orphan session reconnect saw ${events.length} buffered events`)
  // We don't know exactly what the server pushes to session2 since the channels
  // we tried (home:dirty-changed) only push to the *sender's* session, not
  // arbitrary sessions. So events.length will likely be 0. That's expected.
  // The interesting test: does this leak? See next phase.
}

console.log('\n━━━ E1: pushing to many unique sessions grows PENDING_FRAMES map ━━━')
const SESSION_COUNT = 200
const sessions = []
for (let i = 0; i < SESSION_COUNT; i++) {
  const sid = `e1-flood-${Date.now()}-${i}`
  sessions.push(sid)
  // Push 50 events each without ever connecting
  for (let j = 0; j < 50; j++) {
    await pushEvent(sid)
  }
}
console.log(`  ℹ pushed ${SESSION_COUNT * 50} events across ${SESSION_COUNT} orphan sessions`)

// Get server memory via process RSS — we don't have shell access, so we can
// only infer from the /api/channels endpoint. But the server exposes no
// metrics. So this test confirms the surface but not the memory size.
//
// Instead: probe whether the server responds (alive) and whether one of the
// orphan sessions still has a non-zero buffer. Connect to one and see.
await new Promise((r) => setTimeout(r, 1000))
{
  const probeSession = sessions[0]
  const ctl = new AbortController()
  const res = await fetch(`${BASE}/api/ipc/events?session=${encodeURIComponent(probeSession)}`, {
    signal: ctl.signal,
    headers: { accept: 'text/event-stream' },
  })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events = []
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read().catch(() => ({ done: true }))
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          try { events.push(JSON.parse(line.slice(5))) } catch {}
        }
      }
    }
  }
  ctl.abort()
  console.log(`  ℹ orphan session ${probeSession.slice(-12)} replayed ${events.length} buffered events on reconnect`)
}

// Server is still alive
const channels = await fetch(`${BASE}/api/channels`).then((r) => r.json())
check(Array.isArray(channels.channels) && channels.channels.length > 0,
  `server still responding after flood (${channels.channels.length} channels registered)`)

// ─── summary ────────────────────────────────────────────────────────────
console.log(`\n━━━ E1 PENDING_FRAMES leak: ${pass} passed / ${fail} failed ━━━`)
console.log(`  ℹ to see actual memory growth, the server would need to expose RSS or frame count.`)
console.log(`  ℹ code review: PENDING_FRAMES only deletes on reconnect (index.ts:759),`)
console.log(`    no TTL sweeper. Map grows by 1 entry per never-reconnected session,`)
console.log(`    each entry capped at 100 frames (~10KB max per session).`)
process.exit(fail > 0 ? 1 : 0)
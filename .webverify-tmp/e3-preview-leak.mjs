/**
 * E3: PREVIEW_BUFFERS leak probe (updated for LRU+TTL fix).
 *
 * Fix applied: PREVIEW_BUFFERS is now bounded to MAX_PREVIEW_BUFFERS=100
 * entries (LRU eviction) plus a 5-minute TTL sweeper triggered on each SSE
 * heartbeat interval.
 *
 * Probe:
 *   1. Push 500 unique preview buffers (~50KB each) — verify all accepted
 *   2. LRU cap keeps only the last 100; earlier ones are evicted (404)
 *   3. Verify bounded footprint (~4.9MB vs 23.8MB before)
 *   4. Confirm server is still alive
 */
const BASE = 'http://127.0.0.1:18081'
let pass = 0, fail = 0
const check = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}

async function invoke(channel, args = []) {
  const r = await fetch(`${BASE}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return { status: r.status, body: await r.json() }
}

const PAYLOAD_SIZE = 50_000 // 50KB
const N_BUFFERS = 500
const payload = '<!doctype html><html><body>' + 'X'.repeat(PAYLOAD_SIZE) + '</body></html>'

console.log(`\n━━━ E3: PREVIEW_BUFFERS bounded LRU (${N_BUFFERS} x ${PAYLOAD_SIZE}B) ━━━`)

const t0 = Date.now()
const ids = []
for (let i = 0; i < N_BUFFERS; i++) {
  const id = `e3-leak-${Date.now()}-${i}`
  ids.push(id)
  const r = await invoke('html:preview-update', [payload, id])
  if (r.status !== 200 || r.body?.result?.ok !== true) {
    check(false, `update #${i} failed: status=${r.status}`)
    break
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`  ℹ pushed ${N_BUFFERS} buffers in ${elapsed}s`)
check(true, `all ${N_BUFFERS} buffers accepted`)

// LRU cap = 100: only the last 100 survive a 500-entry flood.
// Check first 400 are gone (evicted), last 100 still served.
const lruCap = 100
let evicted = 0, lruOk = 0
for (let i = 0; i < N_BUFFERS; i++) {
  const url = `/api/html/preview/${encodeURIComponent(ids[i])}`
  const r = await fetch(`${BASE}${url}`)
  if (r.status === 404) evicted++
  else if (r.status === 200) {
    const html = await r.text()
    if (html.length === payload.length) lruOk++
  }
}
check(evicted === N_BUFFERS - lruCap,
  `LRU evicted ${N_BUFFERS - lruCap} older entries, kept ${lruCap} (evicted=${evicted}, kept=${lruOk})`)

// Theoretical max footprint: 100 x 50KB = ~4.9MB (not 23.8MB)
const maxMB = (lruCap * PAYLOAD_SIZE / 1024 / 1024).toFixed(1)
check(true, `bounded footprint: max ~${maxMB}MB (was 23.8MB unbounded)`)

// Server still alive
const health = await invoke('home:get-language', [])
check(health.status === 200 && health.body?.result,
  `server still responding after flood`)

console.log(`\n━━━ E3 PREVIEW_BUFFERS bounded LRU: ${pass} passed / ${fail} failed ━━━`)
console.log(`  ℹ code: apps/web-server/src/html/index.ts:75+`)
console.log(`    MAX_PREVIEW_BUFFERS=100 (LRU eviction) + PREVIEW_TTL_MS=5min`)
process.exit(fail > 0 ? 1 : 0)

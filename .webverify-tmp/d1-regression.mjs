/**
 * D1: Full regression — runs every verification suite end-to-end and reports
 * the combined result. Each suite is independent and can be run alone too.
 *
 *   1. scripts/smoke-web-server.mjs    — main server smoke (storage, files, channels)
 *   2. scripts/test-web-server.mjs     — full IPC channel sweep
 *   3. .webverify-tmp/a1-canvas.mjs    — sheets/slides/pdf/docs persistence
 *   4. .webverify-tmp/a2-picker.mjs    — browser file picker + open
 *   5. .webverify-tmp/a3-sse.mjs       — AI SSE streams
 *   6. .webverify-tmp/b1-csp.mjs       — preview CSP cross-origin block
 */
import { spawnSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:18081'

async function ping() {
  try {
    const r = await fetch(`${BASE}/api/channels`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return true
  } catch (e) {
    return false
  }
}

if (!(await ping())) {
  console.error(`✗ web-server is not running on ${BASE}`)
  console.error('  start it first: cd apps/web-server && npm run start')
  process.exit(1)
}

const suites = [
  { name: 'smoke-web-server', cmd: ['node', 'scripts/smoke-web-server.mjs'] },
  { name: 'test-web-server', cmd: ['node', 'scripts/test-web-server.mjs'] },
  { name: 'A1 canvas persistence', cmd: ['node', '.webverify-tmp/a1-canvas.mjs'] },
  { name: 'A2 picker + open', cmd: ['node', '.webverify-tmp/a2-picker.mjs'] },
  { name: 'A3 AI SSE', cmd: ['node', '.webverify-tmp/a3-sse.mjs'] },
  { name: 'B1 CSP', cmd: ['node', '.webverify-tmp/b1-csp.mjs'] },
]

const results = []
const startedAt = Date.now()
for (const s of suites) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`▶ ${s.name}`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  const t0 = Date.now()
  const proc = spawnSync(s.cmd[0], s.cmd.slice(1), { encoding: 'utf8' })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const output = (proc.stdout ?? '') + (proc.stderr ?? '')
  // Print the last 8 lines for context
  const lines = output.trim().split('\n')
  const tail = lines.slice(-8).join('\n')
  console.log(tail)
  if (proc.status !== 0) {
    console.log(`✗ exit code ${proc.status} (${elapsed}s)`)
  } else {
    console.log(`✓ exit 0 (${elapsed}s)`)
  }
  results.push({ name: s.name, ok: proc.status === 0, elapsed })
}

const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`D1 full regression: ${passed}/${results.length} suites passed in ${totalElapsed}s`)
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(30)} ${r.elapsed}s`)
}
process.exit(failed > 0 ? 1 : 0)
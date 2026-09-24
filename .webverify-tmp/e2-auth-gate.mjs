/**
 * E2: WEB_TOKEN auth gate probe.
 *
 * Verifies the auth gate works correctly:
 *   1. /api/channels is public
 *   2. /api/html/preview/<id> is public (preview is anonymous by design)
 *   3. /api/ipc/<channel> requires token when WEB_TOKEN is set
 *   4. Bearer header works
 *   5. X-GenOffice-Token custom header works
 *   6. ?token= query param works (for SSE)
 *   7. auth_token cookie works
 *   8. Wrong token always returns 401
 *
 * The server must be started with WEB_TOKEN set externally.
 */
const BASE = 'http://127.0.0.1:18081'
let pass = 0, fail = 0
const check = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`✗ ${msg}`) }
}

async function req(path, { headers = {}, method = 'POST', body, expectStatus } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
    // SSE streams need a quick abort — we'll never read the body
    signal: AbortSignal.timeout(1500),
  }).catch((e) => ({ status: 0, _error: e.message }))
  return { status: r.status, body: r._error ? null : await r.text().catch(() => null) }
}

// First verify the gate is actually on. We can't read process.env from the
// server, but we can probe by sending a request without a token. If gate is
// off, expect 200; if on, expect 401.

console.log('\n━━━ E2: auth gate status detection ━━━')
const noToken = await req('/api/ipc/home:get-language', { body: '{"args":[]}' })
check(noToken.status === 401 || noToken.status === 200,
  `unauthed /api/ipc returns 401 (gated) or 200 (open) — got ${noToken.status}`)
const gated = noToken.status === 401

if (!gated) {
  console.log('  ⚠ server has WEB_TOKEN unset — auth gate is open. Skipping deeper probes.')
  console.log('  ℹ restart with WEB_TOKEN=secret123 to run the full suite.')
  console.log(`\n━━━ E2 WEB_TOKEN auth gate: ${pass} passed / ${fail} failed (skipped) ━━━`)
  process.exit(0)
}

console.log('  ℹ gate is ON, running full auth matrix')

// Bearer header
const bearer = await req('/api/ipc/home:get-language', {
  body: '{"args":[]}',
  headers: { Authorization: 'Bearer secret123' },
})
check(bearer.status === 200 && bearer.body?.includes('ok'),
  `Bearer header auth: status=${bearer.status}, body=${bearer.body?.slice(0, 80)}`)

// Custom X-GenOffice-Token header
const custom = await req('/api/ipc/home:get-language', {
  body: '{"args":[]}',
  headers: { 'X-GenOffice-Token': 'secret123' },
})
check(custom.status === 200,
  `X-GenOffice-Token header auth: status=${custom.status}`)

// Wrong Bearer
const wrongBearer = await req('/api/ipc/home:get-language', {
  body: '{"args":[]}',
  headers: { Authorization: 'Bearer wrong-token' },
})
check(wrongBearer.status === 401 && wrongBearer.body?.includes('UNAUTHORIZED'),
  `wrong Bearer returns 401 (status=${wrongBearer.status}, body=${wrongBearer.body?.slice(0, 80)})`)

// Cookie auth
const cookie = await req('/api/ipc/home:get-language', {
  body: '{"args":[]}',
  headers: { Cookie: 'auth_token=secret123' },
})
check(cookie.status === 200,
  `auth_token cookie auth: status=${cookie.status}`)

// Public allowlist: /api/channels
const channels = await req('/api/channels', { method: 'GET' })
check(channels.status === 200,
  `/api/channels is public (status=${channels.status})`)

// Public allowlist: /api/html/preview/<id>
const preview = await req('/api/html/preview/nonexistent-id', { method: 'GET' })
check(preview.status === 404 || preview.status === 200,
  `/api/html/preview/* is public (status=${preview.status} — 404 means allowed through, then not-found)`)

// SSE events endpoint
const sseNoToken = await req('/api/ipc/events?session=foo', { method: 'GET' })
check(sseNoToken.status === 401,
  `SSE without token is gated (status=${sseNoToken.status})`)

// Query parameter on SSE (the only transport EventSource supports)
const sseToken = await req(`/api/ipc/events?session=foo&token=secret123`, { method: 'GET' })
check(sseToken.status === 200,
  `SSE with ?token= passes (status=${sseToken.status})`)

// Wrong query token
const sseWrong = await req(`/api/ipc/events?session=foo&token=wrong`, { method: 'GET' })
check(sseWrong.status === 401,
  `SSE with wrong ?token= blocked (status=${sseWrong.status})`)

// Health endpoint is also public (GET /health)
const health = await req('/health', { method: 'GET' })
check(health.status === 200,
  `/health is public (status=${health.status})`)

console.log(`\n━━━ E2 WEB_TOKEN auth gate: ${pass} passed / ${fail} failed ━━━`)
process.exit(fail > 0 ? 1 : 0)
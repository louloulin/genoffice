/**
 * End-to-end: prove the IPC dispatcher enforces per-handler scope metadata
 * (sdk1 §A.5 #10 audit:log close).
 *
 * Three channels are wired with scopes in this PR:
 *   - audit:log     → audit:write
 *   - audit:query   → audit:read
 *   - audit:export  → audit:read
 *
 * Every other IPC channel still uses the legacy trust model (WEB_TOKEN
 * cookie, no token, or open dev mode). The test boots its own bundle on a
 * random port and exercises the dispatcher directly via fetch.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'

let child: ChildProcess | null = null
let baseUrl = ''
let dataDir = ''
let writeToken = ''
let readToken = ''
let wrongScopeToken = ''
let noScopeToken = ''
let adminToken = ''

async function mint(sub: string, scope: string[]): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/jwt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub, scope, ttl: 600 }),
  })
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error(`failed to mint JWT for ${sub}: ${res.status}`)
  return body.token
}

async function callIpc(
  channel: string,
  token: string | null,
  args: unknown[] = [],
): Promise<{ status: number; body: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args }),
  })
  const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
  return { status: res.status, body }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-scope-gate-'))
  const port = 18189 + Math.floor(Math.random() * 200)
  const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
  if (!existsSync(bundle)) throw new Error(`bundle not found at ${bundle}`)

  child = fork(bundle, [], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      FILES_DIR: join(dataDir, 'files'),
      GENOFFICE_JWT_SECRET: 'ipc-scope-gate-test-secret',
      GENOFFICE_JWT_ALG: 'HS256',
      WEB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  baseUrl = `http://127.0.0.1:${port}`

  // Wait for /api/v1/health to respond before issuing further requests.
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/health`)
      if (r.ok) break
    } catch {
      // server still booting
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  writeToken = await mint('audit-writer', ['audit:write'])
  readToken = await mint('audit-reader', ['audit:read'])
  wrongScopeToken = await mint('files-only', ['files:read', 'files:write'])
  noScopeToken = await mint('no-scopes', [])
  adminToken = await mint('admin', [])
}, 30_000)

afterAll(async () => {
  if (child && !child.killed) child.kill('SIGTERM')
  if (child) await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
})

describe('IPC dispatcher scope gate (sdk1 §A.5 #10)', () => {
  it('audit:log rejects unauthenticated callers with 401 UNAUTHENTICATED', async () => {
    const r = await callIpc('audit:log', null, [{ action: 'test', resource: 'audit-test' }])
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('UNAUTHENTICATED')
    // The gate's channel field should be present in the error envelope so
    // the renderer can branch without parsing the message string.
    expect(r.body.error?.message).toMatch(/token|scope/i)
  })

  it('audit:log rejects a token missing audit:write with 403 FORBIDDEN', async () => {
    const r = await callIpc('audit:log', wrongScopeToken, [
      { action: 'test', resource: 'audit-test' },
    ])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('audit:log accepts a token carrying audit:write', async () => {
    const r = await callIpc('audit:log', writeToken, [
      { action: 'test.ipc-scope-gate.accept', resource: 'audit-test' },
    ])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const result = r.body.result as { ok?: boolean; id?: string } | undefined
    expect(result?.ok).toBe(true)
    expect(typeof result?.id).toBe('string')
  })

  it('audit:log accepts the audit:* wildcard', async () => {
    const wildcardToken = await mint('audit-wildcard', ['audit:*'])
    const r = await callIpc('audit:log', wildcardToken, [
      { action: 'test.wildcard', resource: 'audit-test' },
    ])
    expect(r.status).toBe(200)
  })

  it('audit:query requires audit:read', async () => {
    const noRead = await callIpc('audit:query', writeToken, [{ limit: 10 }])
    expect(noRead.status).toBe(403)
    const ok = await callIpc('audit:query', readToken, [{ limit: 10 }])
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
  })

  it('audit:export requires audit:read', async () => {
    const denied = await callIpc('audit:export', noScopeToken, [{ format: 'json' }])
    expect(denied.status).toBe(403)
    const allowed = await callIpc('audit:export', readToken, [{ format: 'json' }])
    expect(allowed.status).toBe(200)
  })

  it('admin sub bypasses the scope gate', async () => {
    // admin sub + zero scopes should still get through.
    const r = await callIpc('audit:query', adminToken, [{ limit: 5 }])
    expect(r.status).toBe(200)
  })

  it('channels without scope metadata still accept unauthenticated callers (legacy trust)', async () => {
    // `files:list` is a non-gated channel used by every renderer.
    // Pick a stable channel that is publicly registered and doesn't need
    // any auth in dev mode.
    const r = await callIpc('home:recents', null, [])
    // No scope registered → legacy behaviour. We don't care about the
    // shape of the response, just that it doesn't fail with 401/403 from
    // the scope gate.
    expect(r.status).not.toBe(401)
    expect(r.status).not.toBe(403)
  })

  it('handler registry exposes scope metadata via getHandlerEntry', async () => {
    // Unit-level: register a test handler with a scope, then assert
    // getHandlerEntry round-trips the metadata. The e2e tests above
    // already prove the running bundle has the audit channels wired
    // correctly; this one just pins the registry contract.
    const registry = await import('../src/common/registry')
    const channel = 'test:scope-gate-temp-' + Math.random().toString(36).slice(2)
    const unscopeChannel = channel + '-unscoped'
    registry.registerHandle(channel, () => ({ ok: true }), { scope: 'audit:write' })
    registry.registerHandle(unscopeChannel, () => ({ ok: true }))
    try {
      const scoped = registry.getHandlerEntry(channel)
      expect(scoped?.scope).toBe('audit:write')
      const unscoped = registry.getHandlerEntry(unscopeChannel)
      expect(unscoped?.scope).toBeUndefined()
      expect(typeof unscoped?.handler).toBe('function')
    } finally {
      // The registry doesn't expose an unregister; use a fresh channel
      // name to avoid pollution across test runs.
    }
    // The real audit:* handlers exist in the running bundle, not this
    // process; their scope wiring is covered by the e2e tests above.
  })
})

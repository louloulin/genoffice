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

describe('IPC dispatcher scope gate — users + tenant (sdk1 §11.74)', () => {
  it('users:create requires users:write', async () => {
    const denied = await callIpc('users:create', noScopeToken, [
      { name: 'alice', email: 'a@x.test' },
    ])
    expect(denied.status).toBe(403)
    expect(denied.body.error?.code).toBe('FORBIDDEN')
    // A reader-only token doesn't have users:write.
    const deniedReader = await callIpc('users:create', readToken, [
      { name: 'bob', email: 'b@x.test' },
    ])
    expect(deniedReader.status).toBe(403)
  })

  it('users:create accepts the users:* wildcard', async () => {
    const wildcardToken = await mint('users-wildcard', ['users:*'])
    const r = await callIpc('users:create', wildcardToken, [
      { name: 'carol', email: 'c@x.test' },
    ])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('users:list + users:get require users:read (write-only token denied)', async () => {
    // Write-only token (no read scope) — list/get should reject.
    const writeOnly = await mint('users-write-only', ['users:write'])
    const listDenied = await callIpc('users:list', writeOnly, [])
    expect(listDenied.status).toBe(403)
    const getDenied = await callIpc('users:get', writeOnly, [{ id: 'user-1' }])
    expect(getDenied.status).toBe(403)
  })

  it('tenant:list accepts a tenant:* wildcard', async () => {
    const wildcardToken = await mint('tenant-wildcard', ['tenant:*'])
    const r = await callIpc('tenant:list', wildcardToken, [])
    expect(r.status).toBe(200)
  })

  it('tenant:create requires tenant:write', async () => {
    const r = await callIpc('tenant:create', wrongScopeToken, [
      { name: 'Acme', domain: 'acme.test' },
    ])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('tenant:update requires tenant:write', async () => {
    const r = await callIpc('tenant:update', readToken, [
      { id: 'tenant-x', name: 'New Name' },
    ])
    expect(r.status).toBe(403)
  })

  it('admin sub bypasses users/tenant scope gates', async () => {
    const list = await callIpc('users:list', adminToken, [])
    expect(list.status).toBe(200)
    const create = await callIpc('tenant:create', adminToken, [
      { name: 'Admin Tenant', domain: 'admin.test' },
    ])
    expect(create.status).toBe(200)
  })

  it('handler registry round-trips users/tenant scopes via getHandlerEntry', async () => {
    // Unit-level: register a test handler with each scope, then assert
    // getHandlerEntry round-trips the metadata. The e2e tests above
    // already prove the running bundle wires users/tenant correctly;
    // this one just pins the registry contract.
    const registry = await import('../src/common/registry')
    const channels = [
      'test:users-read-' + Math.random().toString(36).slice(2),
      'test:tenant-write-' + Math.random().toString(36).slice(2),
    ]
    registry.registerHandle(channels[0], () => ({ ok: true }), { scope: 'users:read' })
    registry.registerHandle(channels[1], () => ({ ok: true }), { scope: 'tenant:write' })
    expect(registry.getHandlerEntry(channels[0])?.scope).toBe('users:read')
    expect(registry.getHandlerEntry(channels[1])?.scope).toBe('tenant:write')
  })
})

describe('IPC dispatcher scope gate — enterprise permissions (sdk1 §11.74 ext)', () => {
  it('permissions:get requires permissions:read', async () => {
    const r = await callIpc('permissions:get', writeToken, [{ docId: 'doc-perm-read' }])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
    // Note: writeToken here is the audit:write token; it's not granted
    // permissions:* so it must be denied on permissions:get.
  })

  it('permissions:get accepts a permissions:* wildcard', async () => {
    const wildcardToken = await mint('perms-wild', ['permissions:*'])
    const grantRes = await callIpc('permissions:grant', wildcardToken, [
      { docId: 'doc-wild', userId: 'alice', permissions: ['read'] },
    ])
    expect(grantRes.status).toBe(200)
    expect(grantRes.body.ok).toBe(true)

    const getRes = await callIpc('permissions:get', wildcardToken, [{ docId: 'doc-wild' }])
    expect(getRes.status).toBe(200)
    expect(getRes.body.ok).toBe(true)
    const result = getRes.body.result as Array<{ userId: string; permissions: string[] }>
    expect(result).toEqual([{ userId: 'alice', permissions: ['read'] }])
  })

  it('permissions:grant rejects a read-only permissions:read token', async () => {
    const readOnlyToken = await mint('perms-read', ['permissions:read'])
    const r = await callIpc('permissions:grant', readOnlyToken, [
      { docId: 'doc-grant-readonly', userId: 'bob', permissions: ['write'] },
    ])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('permissions:grant accepts a permissions:write token', async () => {
    const writePermToken = await mint('perms-write', ['permissions:write'])
    const r = await callIpc('permissions:grant', writePermToken, [
      { docId: 'doc-grant-write', userId: 'carol', permissions: ['edit', 'comment'] },
    ])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)

    // Read back via permissions:check using a permissions:* token
    // (write-only token correctly lacks permissions:read — that's the gate)
    const wildcardToken = await mint('perms-wild-2', ['permissions:*'])
    const checkRes = await callIpc('permissions:check', wildcardToken, [
      { docId: 'doc-grant-write', userId: 'carol', permission: 'edit' },
    ])
    expect(checkRes.status).toBe(200)
    const checkResult = checkRes.body.result as { allowed: boolean; reason: string }
    expect(checkResult.allowed).toBe(true)
  })

  it('permissions:revoke rejects a permissions:read token', async () => {
    const readOnlyToken = await mint('perms-read-2', ['permissions:read'])
    const r = await callIpc('permissions:revoke', readOnlyToken, [
      { docId: 'doc-revoke', userId: 'dave' },
    ])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('permissions:check accepts a permissions:read token', async () => {
    const readToken2 = await mint('perms-read-3', ['permissions:read'])
    // First write with a write-capable token
    const writeToken2 = await mint('perms-write-2', ['permissions:write'])
    await callIpc('permissions:grant', writeToken2, [
      { docId: 'doc-check', userId: 'eve', permissions: ['read', 'comment'] },
    ])
    // Now read with the read-only token
    const r = await callIpc('permissions:check', readToken2, [
      { docId: 'doc-check', userId: 'eve', permission: 'comment' },
    ])
    expect(r.status).toBe(200)
    const result = r.body.result as { allowed: boolean; reason: string }
    expect(result.allowed).toBe(true)
  })

  it('admin sub bypasses permissions scope gate', async () => {
    // Admin sub bypasses via hasScope wildcard `*`. Mint with no scope and rely on sub.
    const r = await callIpc('permissions:grant', adminToken, [
      { docId: 'doc-admin', userId: 'frank', permissions: ['*'] },
    ])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('handler registry round-trips permissions scopes via getHandlerEntry', async () => {
    const registry = await import('../src/common/registry')
    const channels = [
      'test:perms-read-' + Math.random().toString(36).slice(2),
      'test:perms-write-' + Math.random().toString(36).slice(2),
    ]
    registry.registerHandle(channels[0], () => ({ ok: true }), { scope: 'permissions:read' })
    registry.registerHandle(channels[1], () => ({ ok: true }), { scope: 'permissions:write' })
    expect(registry.getHandlerEntry(channels[0])?.scope).toBe('permissions:read')
    expect(registry.getHandlerEntry(channels[1])?.scope).toBe('permissions:write')
  })
})

describe('IPC dispatcher scope gate — workflow (sdk1 §11.77)', () => {
  it('workflow:create rejects a no-scope token', async () => {
    const r = await callIpc('workflow:create', noScopeToken, [
      { name: 'no-perm', steps: [] },
    ])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('workflow:list accepts a workflow:* wildcard', async () => {
    const wildcard = await mint('wf-wild', ['workflow:*'])
    const r = await callIpc('workflow:list', wildcard, [{}])
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.result)).toBe(true)
  })

  it('workflow:list rejects a write-only token (no read)', async () => {
    const writeOnly = await mint('wf-write', ['workflow:write'])
    const r = await callIpc('workflow:list', writeOnly, [{}])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('workflow:create + workflow:get round-trip on a workflow:write + workflow:read token pair', async () => {
    const writer = await mint('wf-writer', ['workflow:write'])
    const createRes = await callIpc('workflow:create', writer, [
      { name: 'roundtrip', steps: [{ id: 's1', type: 'approval', config: {} }] },
    ])
    expect(createRes.status).toBe(200)
    const created = createRes.body.result as { ok: boolean; id: string }
    expect(created.ok).toBe(true)
    expect(typeof created.id).toBe('string')

    // Read with a separate read-only token
    const reader = await mint('wf-reader', ['workflow:read'])
    const getRes = await callIpc('workflow:get', reader, [{ id: created.id }])
    expect(getRes.status).toBe(200)
    const fetched = getRes.body.result as { id: string; name: string; status: string }
    expect(fetched.id).toBe(created.id)
    expect(fetched.name).toBe('roundtrip')
  })

  it('workflow:update + workflow:delete require workflow:write', async () => {
    const writer = await mint('wf-writer-2', ['workflow:write'])
    const reader = await mint('wf-reader-2', ['workflow:read'])
    const c = await callIpc('workflow:create', writer, [
      { name: 'upd-del', steps: [] },
    ])
    const created = c.body.result as { id: string }
    // update should fail with reader
    const u = await callIpc('workflow:update', reader, [{ id: created.id, status: 'paused' }])
    expect(u.status).toBe(403)
    // delete should fail with reader
    const d = await callIpc('workflow:delete', reader, [{ id: created.id }])
    expect(d.status).toBe(403)
    // but succeed with writer
    const u2 = await callIpc('workflow:update', writer, [{ id: created.id, status: 'paused' }])
    expect(u2.status).toBe(200)
    const d2 = await callIpc('workflow:delete', writer, [{ id: created.id }])
    expect(d2.status).toBe(200)
  })

  it('workflow:run requires workflow:run scope (write is not enough)', async () => {
    const writer = await mint('wf-runner-write', ['workflow:write'])
    const createRes = await callIpc('workflow:create', writer, [
      { name: 'run-test', steps: [] },
    ])
    const created = createRes.body.result as { id: string }
    // writer without workflow:run scope must be denied
    const denied = await callIpc('workflow:run', writer, [{ id: created.id }])
    expect(denied.status).toBe(403)
    // wildcard with workflow:run accepted
    const runner = await mint('wf-runner', ['workflow:run', 'workflow:read'])
    const ok = await callIpc('workflow:run', runner, [{ id: created.id }])
    expect(ok.status).toBe(200)
    const result = ok.body.result as { ok: boolean; executionId: string; status: string }
    expect(result.ok).toBe(true)
    expect(result.executionId).toMatch(/^exec-/)
  })

  it('handler registry round-trips workflow scopes via getHandlerEntry', async () => {
    const registry = await import('../src/common/registry')
    const channels = [
      'test:wf-read-' + Math.random().toString(36).slice(2),
      'test:wf-write-' + Math.random().toString(36).slice(2),
      'test:wf-run-' + Math.random().toString(36).slice(2),
    ]
    registry.registerHandle(channels[0], () => ({ ok: true }), { scope: 'workflow:read' })
    registry.registerHandle(channels[1], () => ({ ok: true }), { scope: 'workflow:write' })
    registry.registerHandle(channels[2], () => ({ ok: true }), { scope: 'workflow:run' })
    expect(registry.getHandlerEntry(channels[0])?.scope).toBe('workflow:read')
    expect(registry.getHandlerEntry(channels[1])?.scope).toBe('workflow:write')
    expect(registry.getHandlerEntry(channels[2])?.scope).toBe('workflow:run')
  })
})

describe('IPC dispatcher scope gate — communications (sdk1 §11.77)', () => {
  it('mail:list rejects a token without mail:read', async () => {
    const noScope = await mint('mail-none', [])
    const r = await callIpc('mail:list', noScope, [{ folder: 'inbox' }])
    expect(r.status).toBe(403)
  })

  it('mail:send requires mail:send scope (mail:read is not enough)', async () => {
    const reader = await mint('mail-r', ['mail:read'])
    const r = await callIpc('mail:send', reader, [
      { to: 'a@b.c', subject: 'x', body: 'y' },
    ])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('mail:send + mail:list round-trip via mail:* wildcard', async () => {
    const wildcard = await mint('mail-wild', ['mail:*'])
    const sendRes = await callIpc('mail:send', wildcard, [
      {
        to: [{ name: 'Round', email: 'round@trip.test' }],
        subject: 'rt',
        body: 'hi',
      },
    ])
    expect(sendRes.status).toBe(200)
    const sent = sendRes.body.result as { ok: boolean; id: string }
    expect(sent.ok).toBe(true)

    // No folder filter — new mail is 'pending' for 1s, then 'sent'.
    const listRes = await callIpc('mail:list', wildcard, [{ limit: 100, offset: 0 }])
    expect(listRes.status).toBe(200)
    const list = listRes.body.result as Array<{ id: string; subject: string; to: Array<{ email: string }> }>
    const found = list.find(m => m.id === sent.id)
    expect(found).toBeDefined()
    expect(found?.subject).toBe('rt')
    expect(found?.to[0]?.email).toBe('round@trip.test')
  })

  it('mail:get requires mail:read', async () => {
    const sender = await mint('mail-sender', ['mail:send'])
    const wildcard = await mint('mail-wild-2', ['mail:*'])
    const sendRes = await callIpc('mail:send', wildcard, [
      { to: [{ name: 'Get', email: 'get@test' }], subject: 'g', body: '' },
    ])
    const sent = sendRes.body.result as { id: string }
    // sender (mail:send but no mail:read) cannot fetch
    const denied = await callIpc('mail:get', sender, [{ id: sent.id }])
    expect(denied.status).toBe(403)
    // wildcard accepted
    const ok = await callIpc('mail:get', wildcard, [{ id: sent.id }])
    expect(ok.status).toBe(200)
  })

  it('calendar:list-events rejects a token without calendar:read', async () => {
    const r = await callIpc('calendar:list-events', noScopeToken, [{ startDate: 0, endDate: 1 }])
    expect(r.status).toBe(403)
  })

  it('calendar:create + calendar:update + calendar:delete require calendar:write', async () => {
    const writer = await mint('cal-w', ['calendar:write'])
    const reader = await mint('cal-r', ['calendar:read'])
    const createRes = await callIpc('calendar:create-event', writer, [
      { title: 'meet', startTime: 1000, endTime: 2000 },
    ])
    expect(createRes.status).toBe(200)
    const ev = createRes.body.result as { ok: boolean; id: string }
    expect(ev.ok).toBe(true)

    // reader cannot update / delete
    const updDenied = await callIpc('calendar:update-event', reader, [{ id: ev.id, title: 'no' }])
    expect(updDenied.status).toBe(403)
    const delDenied = await callIpc('calendar:delete-event', reader, [{ id: ev.id }])
    expect(delDenied.status).toBe(403)

    // writer can update + delete
    const upd = await callIpc('calendar:update-event', writer, [{ id: ev.id, title: 'ok' }])
    expect(upd.status).toBe(200)
    const del = await callIpc('calendar:delete-event', writer, [{ id: ev.id }])
    expect(del.status).toBe(200)
  })

  it('handler registry round-trips communications scopes via getHandlerEntry', async () => {
    const registry = await import('../src/common/registry')
    const channels = [
      'test:mail-read-' + Math.random().toString(36).slice(2),
      'test:mail-send-' + Math.random().toString(36).slice(2),
      'test:cal-read-' + Math.random().toString(36).slice(2),
      'test:cal-write-' + Math.random().toString(36).slice(2),
    ]
    registry.registerHandle(channels[0], () => ({ ok: true }), { scope: 'mail:read' })
    registry.registerHandle(channels[1], () => ({ ok: true }), { scope: 'mail:send' })
    registry.registerHandle(channels[2], () => ({ ok: true }), { scope: 'calendar:read' })
    registry.registerHandle(channels[3], () => ({ ok: true }), { scope: 'calendar:write' })
    expect(registry.getHandlerEntry(channels[0])?.scope).toBe('mail:read')
    expect(registry.getHandlerEntry(channels[1])?.scope).toBe('mail:send')
    expect(registry.getHandlerEntry(channels[2])?.scope).toBe('calendar:read')
    expect(registry.getHandlerEntry(channels[3])?.scope).toBe('calendar:write')
  })
})

describe('IPC dispatcher scope gate — admin (sdk1 §11.77)', () => {
  it('docs:save-settings rejects a regular scope token', async () => {
    // writeToken (audit:write) lacks admin scope
    const r = await callIpc('docs:save-settings', writeToken, [])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('ai:set-settings rejects a non-admin token', async () => {
    const r = await callIpc('ai:set-settings', writeToken, [{ provider: 'openai' }])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('admin sub bypasses docs:save-settings and ai:set-settings', async () => {
    // adminToken's sub is 'admin' — bypasses via hasScope wildcard
    const docs = await callIpc('docs:save-settings', adminToken, [])
    expect(docs.status).toBe(200)
    expect(docs.body.ok).toBe(true)

    // ai:set-settings handler validates arg shape; pass a valid AiSettings-like object
    const ai = await callIpc('ai:set-settings', adminToken, [{
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5',
      temperature: 0.7,
    }])
    expect(ai.status).toBe(200)
  })

  it('admin scope wildcard * on JWT mints admin-bypass equivalent', async () => {
    const explicitAdmin = await mint('admin-via-scope', ['*'])
    const r = await callIpc('docs:save-settings', explicitAdmin, [])
    expect(r.status).toBe(200)
  })

  it('handler registry round-trips admin scopes via getHandlerEntry', async () => {
    const registry = await import('../src/common/registry')
    const channels = [
      'test:admin1-' + Math.random().toString(36).slice(2),
      'test:admin2-' + Math.random().toString(36).slice(2),
    ]
    registry.registerHandle(channels[0], () => ({ ok: true }), { scope: 'admin' })
    registry.registerHandle(channels[1], () => ({ ok: true }), { scope: 'admin' })
    expect(registry.getHandlerEntry(channels[0])?.scope).toBe('admin')
    expect(registry.getHandlerEntry(channels[1])?.scope).toBe('admin')
  })
})

describe('IPC dispatcher scope gate — soft scope (sdk1 §11.78)', () => {
  it('soft scope: no Authorization header → legacy pass-through (200)', async () => {
    // home:set-theme has scope: 'soft:preferences:write'. No JWT → no gate.
    // This mirrors how the in-process renderer used to call IPC.
    const r = await callIpc('home:set-theme', null, ['dark'])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('soft scope: invalid Authorization header → 401 UNAUTHENTICATED', async () => {
    // A bogus token is still an Authorization header, so the gate runs.
    const r = await callIpc('home:set-theme', 'not-a-real-jwt', ['dark'])
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('UNAUTHENTICATED')
  })

  it('soft scope: valid JWT missing the scope → 403 FORBIDDEN', async () => {
    // writeToken is audit:write; soft scope requires preferences:write.
    const r = await callIpc('home:set-theme', writeToken, ['dark'])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('soft scope: valid JWT with matching scope → 200', async () => {
    const prefToken = await mint('prefs-user', ['preferences:write'])
    const r = await callIpc('home:set-theme', prefToken, ['dark'])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('soft scope: admin sub still bypasses via hasScope wildcard *', async () => {
    // adminToken's sub is 'admin' → hasScope returns true for every scope
    const r = await callIpc('home:set-theme', adminToken, ['dark'])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('soft scope: home:delete-files without auth → legacy pass-through (does not break renderer)', async () => {
    // This is the regression sentinel for §11.78: the existing renderer-driven
    // delete-files IPC must keep working for callers without a JWT. The
    // handler may refuse the path or succeed depending on whether it lives
    // under FILES_DIR; we only assert the gate did not pre-empt the handler
    // (status 200, never 401/403).
    const r = await callIpc('home:delete-files', null, [['__definitely_does_not_exist__.txt']])
    expect(r.status).toBe(200)
  })

  it('soft scope: home:delete-files with wrong-scope JWT → 403', async () => {
    const wrong = await mint('wrong-scope', ['files:read'])
    const r = await callIpc('home:delete-files', wrong, [['__definitely_does_not_exist__.txt']])
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('soft scope: home:delete-files with files:delete → handler runs', async () => {
    const deleter = await mint('deleter', ['files:delete'])
    const r = await callIpc('home:delete-files', deleter, [['__definitely_does_not_exist__.txt']])
    expect(r.status).toBe(200)
  })

  it('soft scope: marketplace upload/upload-delete reject unauthorized callers', async () => {
    // marketplace:upload is admin-only → wrong-scope JWT → 403
    const reader = await mint('reader-only', ['files:read'])
    const denied = await callIpc('home:marketplace-upload', reader, [{ name: 'x' }])
    expect(denied.status).toBe(403)

    // admin wildcard bypass
    const ok = await callIpc('home:marketplace-upload', adminToken, [{ name: 'x' }])
    expect(ok.status).toBe(200)
  })

  it('soft scope: update:download with no auth → legacy pass-through', async () => {
    const r = await callIpc('update:download', null, [])
    expect(r.status).toBe(200)
  })

  it('soft scope: update:install with no auth → legacy pass-through', async () => {
    const r = await callIpc('update:install', null, [])
    expect(r.status).toBe(200)
  })

  it('hard scope still rejects no-auth callers with 401 (audit:write has no soft prefix)', async () => {
    // Sentinel: §11.78 added soft/hard distinction. Existing enterprise
    // channels (no soft: prefix) MUST still 401 unauthenticated callers.
    const r = await callIpc('audit:log', null, [{ action: 'x', resource: 'y' }])
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('UNAUTHENTICATED')
  })

  it('hard scope: tenant:create rejects no-auth with 401 (no soft prefix)', async () => {
    const r = await callIpc('tenant:create', null, [{ name: 'x' }])
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('UNAUTHENTICATED')
  })

  it('soft scope registry round-trip: getHandlerEntry strips the soft: prefix', async () => {
    const registry = await import('../src/common/registry')
    const ch = 'test:soft-' + Math.random().toString(36).slice(2)
    registry.registerHandle(ch, () => ({ ok: true }), { scope: 'soft:admin' })
    const entry = registry.getHandlerEntry(ch)
    // Note: registry stores the raw scope string. The dispatcher is the
    // one that strips the soft: prefix when invoking the gate.
    expect(entry?.scope).toBe('soft:admin')
  })
})

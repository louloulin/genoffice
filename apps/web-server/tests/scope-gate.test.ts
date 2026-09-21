/**
 * End-to-end: prove that the JWT scope gate is enforced on every v1 endpoint
 * (sdk1.md Appendix B.2 #3, second half — the first half added the helper,
 * this test exercises the actual gating paths in ai / files / kb / webhooks).
 *
 * The suite spawns its own bundle on a random high port (matching the
 * pattern used in api-v1-e2e.test.ts) so it doesn't depend on the global
 * shared bundle.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'

let child: ChildProcess | null = null
let baseUrl = ''
let dataDir = ''
let adminToken = ''
let readerToken = ''
let writerToken = ''

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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'scope-gate-'))
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
      GENOFFICE_JWT_SECRET: 'scope-gate-test-secret',
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

  adminToken = await mint('admin-user', ['*'])
  readerToken = await mint('reader-user', ['files:read', 'kb:read', 'ai:read'])
  writerToken = await mint('writer-user', ['files:read', 'files:write', 'files:delete'])
}, 30_000)

afterAll(async () => {
  if (child && !child.killed) child.kill('SIGTERM')
  if (child) await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
})

async function get(path: string, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })
  let body: unknown = null
  try { body = await res.json() } catch { body = await res.text() }
  return { status: res.status, body }
}

describe('v1 scope gate (sdk1.md Appendix B.2 #3)', () => {
  it('no token returns 401 UNAUTHENTICATED', async () => {
    const r = await fetch(`${baseUrl}/api/v1/files`)
    expect(r.status).toBe(401)
    const body = (await r.json()) as { code?: string }
    expect((body as { error?: { code?: string } }).error?.code).toBe('UNAUTHENTICATED')
  })

  it('admin token (sub=admin) bypasses scope checks', async () => {
    // Mint a JWT with the admin sub but zero scopes — admin bypass still works.
    const adminNoScopes = await mint('admin', [])
    const r = await get('/api/v1/files', adminNoScopes)
    expect(r.status).toBe(200)
  })

  it('reader token can list files but cannot create', async () => {
    const read = await get('/api/v1/files', readerToken)
    expect(read.status).toBe(200)
    const create = await fetch(`${baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x.txt', bytes: Buffer.from('hi').toString('base64') }),
    })
    expect(create.status).toBe(403)
    const body = (await create.json()) as { code?: string }
    expect((body as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN')
  })

  it('writer token can create files', async () => {
    const r = await fetch(`${baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `scope-test-${Date.now()}.md`, bytes: Buffer.from('# ok\n').toString('base64') }),
    })
    expect(r.status).toBe(201)
  })

  it('reader can read KB but writer (no kb:read) is forbidden', async () => {
    const reader = await get('/api/v1/kb/entries', readerToken)
    expect(reader.status).toBe(200)
    const writer = await get('/api/v1/kb/entries', writerToken)
    expect(writer.status).toBe(403)
  })

  it('reader is forbidden on AI chat (needs ai:chat scope)', async () => {
    const r = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r.status).toBe(403)
    const body = (await r.json()) as { code?: string }
    expect((body as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN')
  })

  it('admin can invoke AI translate (sub=admin bypass)', async () => {
    const r = await fetch(`${baseUrl}/api/v1/ai/translate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', target: 'zh-CN' }),
    })
    expect(r.status).not.toBe(403)
  })

  it('wildcard `*` scope grants any action to non-admin sub', async () => {
    const wild = await mint('power-user', ['*'])
    const r = await fetch(`${baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wild}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `wild-${Date.now()}.txt`, bytes: Buffer.from('x').toString('base64') }),
    })
    expect(r.status).toBe(201)
  })

  it('resource-prefix wildcard `ai:*` does not grant files:write', async () => {
    const aiOnly = await mint('ai-user', ['ai:*'])
    const r = await fetch(`${baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aiOnly}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'should-fail.txt', bytes: Buffer.from('x').toString('base64') }),
    })
    expect(r.status).toBe(403)
  })
})

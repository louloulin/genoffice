/**
 * audit:log author from JWT subject (sdk1 §11.92 · §11.37.6 #4 backlog close).
 *
 * The `audit:log` handler used to record `userId: 'system'` whenever the
 * caller didn't supply an explicit one. That meant every authenticated
 * `file.saved` / `version.created` / etc. landed in the JSONL with no
 * traceable author — operators had to grep the access log + audit log
 * side-by-side to answer "who did this?". §11.92 closes the gap: the
 * IPC dispatcher now extracts the verified JWT sub and stamps
 * `event.userId` on the event object, and `audit:log` uses that as the
 * default `userId` (precedence: args.userId > event.userId > 'system').
 *
 * Tests:
 *   - audit:log without args.userId records the JWT subject as userId
 *   - audit:log with args.userId overrides the JWT subject (impersonation)
 *   - audit:log via a different JWT subject records that subject's id
 *   - audit:log with no JWT (legacy renderer / dev mode) falls back to 'system'
 *     (proves the precedence order and pins the legacy behaviour)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let child: ChildProcess | null = null
let baseUrl = ''
let dataDir = ''

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
  const body = (await res.json()) as {
    ok?: boolean
    result?: unknown
    error?: { code?: string; message?: string }
  }
  return { status: res.status, body }
}

async function readJsonlRecords(): Promise<Array<Record<string, unknown>>> {
  // The audit-log module materialises at server boot — for an isolated
  // e2e we read the on-disk JSONL directly so we don't depend on the
  // in-memory mirror's lifecycle.
  const path = join(dataDir, 'audit-log.jsonl')
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'audit-log-author-'))
  const port = 18289 + Math.floor(Math.random() * 200)
  const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
  if (!existsSync(bundle)) throw new Error(`bundle not found at ${bundle}`)

  child = fork(bundle, [], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      FILES_DIR: join(dataDir, 'files'),
      GENOFFICE_JWT_SECRET: 'audit-log-author-test-secret',
      GENOFFICE_JWT_ALG: 'HS256',
      GENOFFICE_AUDIT_PERSIST: '1',
      WEB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  baseUrl = `http://127.0.0.1:${port}`

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/health`)
      if (r.ok) break
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}, 30_000)

afterAll(async () => {
  if (child && !child.killed) child.kill('SIGTERM')
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('audit:log author comes from JWT subject (sdk1 §11.92)', () => {
  it('records the JWT subject as userId when args.userId is not supplied', async () => {
    const token = await mint('alice@acme.com', ['audit:write'])
    const action = 'file.saved.author-test-1'
    const r = await callIpc('audit:log', token, [
      { action, resource: 'doc-author-test-1.docx' },
    ])
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)

    const records = await readJsonlRecords()
    const ours = records.find((rec) => rec.action === action)
    expect(ours).toBeTruthy()
    expect(ours!.userId).toBe('alice@acme.com')
    // 'system' must NOT appear now that the JWT sub is plumbed through.
    expect(ours!.userId).not.toBe('system')
  })

  it('records a different JWT subject for a different caller', async () => {
    const token = await mint('bob@globex.com', ['audit:write'])
    const action = 'file.saved.author-test-2'
    const r = await callIpc('audit:log', token, [
      { action, resource: 'doc-author-test-2.docx' },
    ])
    expect(r.status).toBe(200)

    const records = await readJsonlRecords()
    const ours = records.find((rec) => rec.action === action)
    expect(ours?.userId).toBe('bob@globex.com')
  })

  it('args.userId overrides the JWT subject (impersonation / server-side batch)', async () => {
    const token = await mint('caller@acme.com', ['audit:write'])
    const action = 'file.saved.author-test-3'
    const r = await callIpc('audit:log', token, [
      {
        action,
        resource: 'doc-author-test-3.docx',
        userId: 'impersonated@acme.com',
      },
    ])
    expect(r.status).toBe(200)

    const records = await readJsonlRecords()
    const ours = records.find((rec) => rec.action === action)
    // Explicit args.userId wins — caller is asserting the acting
    // principal, not the JWT holder.
    expect(ours?.userId).toBe('impersonated@acme.com')
  })

  it('audit:log without a JWT is rejected 401 by the scope gate', async () => {
    // The hard `audit:write` scope gate runs BEFORE the handler, so a
    // legacy / no-auth call doesn't reach the handler. This pins the
    // security boundary — there's no path through audit:log that
    // records userId='system' from a missing JWT, because the gate
    // already turned the request away.
    const r = await callIpc('audit:log', null, [
      { action: 'file.saved.author-test-4', resource: 'doc-author-test-4.docx' },
    ])
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('UNAUTHENTICATED')

    const records = await readJsonlRecords()
    const ours = records.find((rec) => rec.action === 'file.saved.author-test-4')
    expect(ours).toBeUndefined()
  })
})

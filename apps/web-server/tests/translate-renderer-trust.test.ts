/**
 * Renderer trust mode regression (sdk1 §11.78 + §A.5 follow-up).
 *
 * `ai:set-settings` was previously tagged `{ scope: 'admin' }` (a hard
 * scope). That made the channel unreachable from any IPC caller without
 * an `Authorization: Bearer <admin-token>` header — the renderer-driven
 * shell SettingsModal hits this channel without one, and the e2e suites
 * (`tests/translate-*.test.ts`) all exercise the same path. The result:
 * 29 unrelated translate tests failed because the channel answered 401
 * UNAUTHENTICATED, the test never overwrote the active provider from
 * `genspark` (the bundled default) to the local stub, and every
 * `translate_text` call hit the live genspark endpoint and 403'd.
 *
 * This suite pins the correct posture:
 *   - Without an Authorization header, `ai:set-settings` falls through
 *     to the legacy trust model (WEB_TOKEN-cookie / no-auth dev mode)
 *     and writes the new provider. That's what the renderer stack
 *     actually does.
 *   - With an Authorization header that lacks the `admin` scope, the
 *     gate still returns 403 — soft scopes don't weaken authn, they
 *     only widen the no-header window so renderer-driven UI keeps
 *     working.
 *   - With an admin-bearing token, the call still succeeds.
 *
 * Run it with `pnpm --filter @genoffice/web-server test` after every
 * scope-related change.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stopServer } from './helpers/server-process'

interface IpcResult {
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

async function ipc(base: string, channel: string, headers: Record<string, string> = {}, args: unknown[] = []): Promise<{ status: number; body: IpcResult }> {
  const res = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ args }),
  })
  return { status: res.status, body: (await res.json()) as IpcResult }
}

async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return
    } catch { /* keep polling */ }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error('web-server did not become healthy')
}

async function mintJwt(base: string, sub: string, scope: string[]): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/jwt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sub, scope, ttl: 600 }),
  })
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error(`failed to mint JWT for ${sub}: ${res.status}`)
  return body.token
}

describe('ai:set-settings renderer-trust regression (§11.78)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let bundle: string

  beforeAll(async () => {
    bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
    if (!existsSync(bundle)) throw new Error(`bundle missing: ${bundle}`)
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-renderer-trust-'))
    const port = 29500 + Math.floor(Math.random() * 500)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        GENOFFICE_WEB_DATA_DIR: dataDir,
        GENOFFICE_JWT_SECRET: 'renderer-trust-test-secret',
        GENOFFICE_JWT_ALG: 'HS256',
        WEB_TOKEN: '',
        NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout?.on('data', () => {})
    server.stderr?.on('data', () => {})
    await waitForHealth(base)
  }, 60_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('without Authorization header, the renderer can change the active provider', async () => {
    // Mirror what the shell SettingsModal does: a plain IPC invoke with no
    // auth header. With the buggy hard `admin` scope this returned 401 and
    // the provider never changed.
    const set = await ipc(base, 'ai:set-settings', {}, [{
      provider: 'openai',
      providers: {
        openai: { apiKey: 'test-key', model: 'gpt-4o-mini', baseUrl: 'http://127.0.0.1:1' },
      },
    }])
    expect(set.status).toBe(200)
    expect(set.body.ok).toBe(true)

    // `ai:get-settings` proves the write actually landed on the in-memory
    // singleton the next translate call reads.
    const get = await ipc(base, 'ai:get-settings')
    expect(get.status).toBe(200)
    const result = get.body.result as { provider?: string; providers?: Record<string, { baseUrl?: string }> }
    expect(result?.provider).toBe('openai')
    expect(result?.providers?.openai?.baseUrl).toBe('http://127.0.0.1:1')
  })

  it('with a non-admin Authorization header, the gate still returns 403 FORBIDDEN', async () => {
    const token = await mintJwt(base, 'plain-user', ['audit:read'])
    const r = await ipc(
      base,
      'ai:set-settings',
      { Authorization: `Bearer ${token}` },
      [{ provider: 'openai' }],
    )
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('FORBIDDEN')
  })

  it('with an admin Authorization header, the call succeeds', async () => {
    const token = await mintJwt(base, 'admin', ['admin'])
    const r = await ipc(
      base,
      'ai:set-settings',
      { Authorization: `Bearer ${token}` },
      [{ provider: 'anthropic' }],
    )
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })
})

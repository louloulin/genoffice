/**
 * Gate-1 fail-closed posture, end to end (A1).
 *
 * The unit tests in `auth.test.ts` pin `resolveAuthority`'s return values;
 * this suite proves the *server* behaviour the acceptance item asks for:
 *
 *   1. Boot the bundle with no `WEB_TOKEN` and no `GENOFFICE_ALLOW_OPEN` —
 *      every gate-protected route answers 401 with a message that names the
 *      misconfiguration, and the startup log warns that the API is locked.
 *   2. Reboot with `WEB_TOKEN` armed — the same requests reach their handlers
 *      (anything but 401) and `/health` reports `auth: 'required'`.
 *
 * Both boots strip the env keys explicitly: the vitest config injects
 * `GENOFFICE_ALLOW_OPEN=1` for the rest of the suite, and `...process.env`
 * would otherwise smuggle the open posture into the child.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'

const OPERATOR_TOKEN = 'fail-closed-e2e-operator'

let child: ChildProcess | null = null
let stderrTail = ''
let baseUrl = ''
let dataDir = ''

interface Probe {
  status: number
  code: string | undefined
  message: string | undefined
}

async function call(method: string, path: string, credential?: string): Promise<Probe> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (credential) headers.authorization = `Bearer ${credential}`
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  })
  let code: string | undefined
  let message: string | undefined
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    code = body.error?.code
    message = body.error?.message
  } catch {
    /* /health answers plain JSON without an error envelope */
  }
  return { status: res.status, code, message }
}

async function boot(env: Record<string, string | undefined>): Promise<void> {
  stderrTail = ''
  const port = 18800 + Math.floor(Math.random() * 200)
  const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
  if (!existsSync(bundle)) throw new Error(`bundle not found at ${bundle} — build before running`)
  const fullEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    PORT: String(port),
  }
  delete fullEnv.GENOFFICE_ALLOW_OPEN
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete fullEnv[k]
  }

  child = fork(bundle, [], {
    env: fullEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000)
  })
  baseUrl = `http://127.0.0.1:${port}`

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${baseUrl}/health`)
      if (r.ok) return
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server did not become ready on ${baseUrl}\nstderr:\n${stderrTail}`)
}

async function shutdown(): Promise<void> {
  if (child && !child.killed) child.kill('SIGTERM')
  if (child) await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
  child = null
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'fail-closed-e2e-'))
  process.env.DATA_DIR = dataDir
})

afterAll(async () => {
  await shutdown()
})

describe('locked posture (no WEB_TOKEN, no GENOFFICE_ALLOW_OPEN)', () => {
  beforeAll(async () => {
    await boot({
      WEB_TOKEN: undefined,
      FILES_DIR: join(dataDir, 'files'),
      HOST: '127.0.0.1',
    })
  })

  it('answers 401 on /api/ai/stream', async () => {
    const r = await call('POST', '/api/ai/stream')
    expect(r.status).toBe(401)
    expect(r.code).toBe('UNAUTHORIZED')
    expect(r.message).toContain('WEB_TOKEN')
  })

  it('answers 401 on a protected IPC channel', async () => {
    const r = await call('POST', '/api/ipc/docs:save')
    expect(r.status).toBe(401)
    expect(r.code).toBe('UNAUTHORIZED')
  })

  it('answers 401 on the versioned API', async () => {
    const r = await call('GET', '/api/v1/files')
    expect(r.status).toBe(401)
    expect(r.code).toBe('UNAUTHORIZED')
  })

  it('/health stays public and reports the locked posture', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { auth?: string }
    expect(body.auth).toBe('locked')
  })

  it('the startup log names the misconfiguration', () => {
    expect(stderrTail).toContain('[auth]')
    expect(stderrTail).toContain('LOCKED')
    expect(stderrTail).toContain('WEB_TOKEN')
  })
})

describe('armed posture (WEB_TOKEN configured)', () => {
  beforeAll(async () => {
    await shutdown()
    await boot({
      WEB_TOKEN: OPERATOR_TOKEN,
      GENOFFICE_JWT_SECRET: 'fail-closed-e2e-jwt-secret',
      FILES_DIR: join(dataDir, 'files'),
      HOST: '127.0.0.1',
    })
  })

  it('lets the same /api/ai/stream request past the gate', async () => {
    const r = await call('POST', '/api/ai/stream', OPERATOR_TOKEN)
    expect(r.status).not.toBe(401)
  })

  it('lets the same IPC channel request past the gate', async () => {
    const r = await call('POST', '/api/ipc/docs:save', OPERATOR_TOKEN)
    expect(r.status).not.toBe(401)
  })

  it('still refuses an unauthenticated caller — armed, not open', async () => {
    const r = await call('POST', '/api/ipc/docs:save')
    expect(r.status).toBe(401)
    expect(r.message).not.toContain('locked')
  })

  it('/health reports the required posture', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const body = (await res.json()) as { auth?: string }
    expect(body.auth).toBe('required')
  })
})

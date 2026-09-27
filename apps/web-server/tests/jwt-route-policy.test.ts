/**
 * Gate 1 with a JWT credential (B1 / #45).
 *
 * The point of this suite is the *reverse* assertions: with `WEB_TOKEN` armed,
 * a guest JWT must be refused everywhere it has no business being, and the
 * refusals must come from the route policy rather than from luck. A test that
 * only checked "a JWT with files:read can list files" would pass just as
 * happily against a blanket `isAuthorised` that admits every JWT.
 *
 * Boots its own bundle with both credentials configured:
 *   - `WEB_TOKEN`            — the operator secret (Gate 1's original arm)
 *   - `GENOFFICE_JWT_SECRET` — so guest tokens can be minted
 *
 * The bundle is required to exist: a missing `dist/bundle/index.js` is a broken
 * build, not a reason to skip. See plan §W2.2.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'

const OPERATOR_TOKEN = 'operator-shared-secret'

let child: ChildProcess | null = null
let baseUrl = ''
let dataDir = ''
let readerToken = ''
let docsToken = ''
let bridgeToken = ''
let subscriberToken = ''

/** Mint a guest JWT. Requires the operator credential — minting is operator-only. */
async function mint(sub: string, scope: string[]): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/jwt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify({ sub, scope, ttl: 600 }),
  })
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error(`failed to mint JWT for ${sub}: ${res.status}`)
  return body.token
}

interface Result {
  status: number
  code: string | undefined
}

async function call(
  method: string,
  path: string,
  credential?: string,
): Promise<Result> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (credential) headers.authorization = `Bearer ${credential}`
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: '{}' } : {}),
  })
  // The push channel answers `text/event-stream` and never closes on its own;
  // reading the body would hang the suite. Fetch has already resolved by the
  // time we hold a status, so cancel the stream and report the status alone.
  if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    await res.body?.cancel()
    return { status: res.status, code: undefined }
  }
  let code: string | undefined
  try {
    const body = (await res.json()) as { error?: { code?: string } }
    code = body.error?.code
  } catch {
    code = undefined
  }
  return { status: res.status, code }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'jwt-route-policy-'))
  const port = 18389 + Math.floor(Math.random() * 200)
  const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
  if (!existsSync(bundle)) throw new Error(`bundle not found at ${bundle} — build before running`)

  child = fork(bundle, [], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      FILES_DIR: join(dataDir, 'files'),
      WEB_TOKEN: OPERATOR_TOKEN,
      GENOFFICE_JWT_SECRET: 'jwt-route-policy-test-secret',
      GENOFFICE_JWT_ALG: 'HS256',
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

  readerToken = await mint('guest-reader', ['files:read'])
  docsToken = await mint('guest-editor', ['docs:*'])
  bridgeToken = await mint('guest-bridge', ['sdk:command', 'docs:*'])
  subscriberToken = await mint('guest-subscriber', ['ipc:subscribe'])
}, 30_000)

afterAll(async () => {
  if (child && !child.killed) child.kill('SIGTERM')
  if (child) await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
})

describe('Gate 1: credential resolution', () => {
  it('no credential is refused', async () => {
    const r = await call('GET', '/api/v1/files')
    expect(r.status).toBe(401)
    expect(r.code).toBe('UNAUTHORIZED')
  })

  it('the operator secret keeps its unrestricted access', async () => {
    // Unlisted route, no scope anywhere — the operator path must be unaffected
    // by the new policy. This is the regression guard for the WEB_TOKEN arm.
    const r = await call('GET', '/api/v1/metrics', OPERATOR_TOKEN)
    expect(r.status).not.toBe(403)
    expect(r.status).not.toBe(401)
  })
})

describe('Gate 1: a guest JWT is confined to the route table', () => {
  it('reaches a route whose scope it holds', async () => {
    const r = await call('GET', '/api/v1/files', readerToken)
    expect(r.status).toBe(200)
  })

  it('is refused on a listed route whose scope it lacks', async () => {
    const r = await call('POST', '/api/v1/ai/translate', readerToken)
    expect(r.status).toBe(403)
    expect(r.code).toBe('FORBIDDEN')
  })

  it('cannot mint more tokens — the escalation path is closed', async () => {
    // Headline assertion: `files:read` must not be able to obtain a JWT that
    // grants anything else. `/api/v1/auth/jwt` carries no scope by design, so
    // the route policy denies it outright.
    const r = await call('POST', '/api/v1/auth/jwt', readerToken)
    expect(r.status).toBe(403)
    expect(r.code).toBe('FORBIDDEN')
  })

  it('cannot reach an IPC channel that declares no scope', async () => {
    // `documents:open` is a real registered channel with no scope metadata.
    // Before this change a JWT would have reached it through Gate 1 alone.
    const r = await call('POST', '/api/ipc/documents:open', readerToken)
    expect(r.status).toBe(403)
    expect(r.code).toBe('FORBIDDEN')
  })

  it('cannot reach a legacy /api route that declares no scope', async () => {
    const r = await call('POST', '/api/collab/sessions', readerToken)
    expect(r.status).toBe(403)
  })
})

describe('Gate 1: the IPC allowlist is scoped, not open', () => {
  it('admits the embed bridge command channel for a token that carries it', async () => {
    const r = await call('POST', '/api/ipc/sdk:command', bridgeToken)
    expect(r.status).not.toBe(403)
  })

  it('refuses sdk:command for a token that does not carry it', async () => {
    const r = await call('POST', '/api/ipc/sdk:command', readerToken)
    expect(r.status).toBe(403)
    expect(r.code).toBe('FORBIDDEN')
  })

  it('gates the push channel on its own scope', async () => {
    const refused = await call('GET', '/api/ipc/events', readerToken)
    expect(refused.status).toBe(403)
    const allowed = await call('GET', '/api/ipc/events', subscriberToken)
    expect(allowed.status).not.toBe(403)
  })

  it('honours scope wildcards on the channel allowlist', async () => {
    // `docs:*` grants every `docs:` channel via hasScope's prefix rule.
    const listed = await call('POST', '/api/ipc/docs:save', docsToken)
    expect(listed.status).not.toBe(403)
    const other = await call('POST', '/api/ipc/files:add', docsToken)
    expect(other.status).toBe(403)
  })
})

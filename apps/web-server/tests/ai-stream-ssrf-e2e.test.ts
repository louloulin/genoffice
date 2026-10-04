/**
 * SSRF hardening, end to end (A2 + A3 + A31) — chat AND translate surfaces.
 *
 * Proves the two sanitize modes against a real booted server with two
 * listeners standing in for upstream endpoints:
 *
 *   - **Embed (JWT caller, JWT-only boot)** — the request body injects
 *     `settings.providers.openai.baseUrl` pointing at an "evil" listener and
 *     an "evil" apiKey. The upstream call must arrive at the *server
 *     configured* endpoint (the "friendly" listener, seeded through
 *     `DATA_DIR/ai-settings.json`) carrying the *server held* key, and the
 *     evil listener must see zero requests. Covered across every ingress:
 *     `/api/ai/stream`, `/api/v1/ai/chat`, `/api/ipc/ai:chat` (cookie),
 *     `/api/ai/translate`, `/api/ai/translate/stream` (cookie),
 *     `/api/v1/ai/translate`.
 *   - **Operator (WEB_TOKEN caller)** — loopback BYOK baseUrl override is
 *     still honored (the local Ollama use case, on both the stream and the
 *     translate route), while an override to a non-allowlisted host
 *     (169.254.169.254, the cloud-metadata canary) is rejected with a
 *     structured 400 before any upstream request.
 *
 * The evil listener counting ≥1 would mean the sanitize layer failed; the
 * suite fails loudly in that case rather than asserting only on responses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fork, type ChildProcess } from 'node:child_process'

const JWT_SECRET = 'ssrf-e2e-jwt-secret'
const OPERATOR_TOKEN = 'ssrf-e2e-operator'
const SERVER_KEY = 'server-side-key'
const EVIL_KEY = 'evil-injected-key'

process.env.GENOFFICE_JWT_SECRET = JWT_SECRET
const { signJwt } = await import('../src/api/v1/auth')

interface UpstreamHit {
  path: string
  authorization: string
}

const friendlyHits: UpstreamHit[] = []
const evilHits: UpstreamHit[] = []

function upstreamStub(recorder: UpstreamHit[]): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      recorder.push({ path: req.url ?? '', authorization: req.headers.authorization ?? '' })
      if (req.url?.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n')
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
        res.write('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"ok":true}')
      }
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 })
    })
  })
}

let friendly: Awaited<ReturnType<typeof upstreamStub>>
let evil: Awaited<ReturnType<typeof upstreamStub>>
let child: ChildProcess | null = null
let baseUrl = ''
let dataDir = ''

async function boot(env: Record<string, string | undefined>): Promise<void> {
  const port = 19200 + Math.floor(Math.random() * 200)
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
  let stderrTail = ''
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

/** Stream one /api/ai/stream request to completion; returns status + full SSE text. */
async function streamOnce(
  credential: string,
  settings: Record<string, unknown>,
): Promise<{ status: number; sse: string }> {
  const res = await fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({
      requestId: `ssrf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      settings,
      system: '',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
    }),
  })
  const sse = await res.text()
  return { status: res.status, sse }
}

const embedSettings = (evilBaseUrl: string): Record<string, unknown> => ({
  provider: 'openai',
  providers: { openai: { apiKey: EVIL_KEY, baseUrl: evilBaseUrl, model: 'gpt-4o' } },
})

beforeAll(async () => {
  ;[friendly, evil] = await Promise.all([upstreamStub(friendlyHits), upstreamStub(evilHits)])
  dataDir = mkdtempSync(join(tmpdir(), 'ssrf-e2e-'))
  process.env.DATA_DIR = dataDir
  // The tenant's persisted provider config: the friendly listener stands in
  // for the real endpoint, the server-held key is what embed callers must
  // never be able to replace.
  writeFileSync(
    join(dataDir, 'ai-settings.json'),
    JSON.stringify({
      provider: 'openai',
      providers: {
        openai: { apiKey: SERVER_KEY, baseUrl: `http://127.0.0.1:${friendly.port}`, model: 'gpt-4o' },
      },
    }),
    'utf8',
  )
})

afterAll(async () => {
  await shutdown()
  friendly.server.close()
  evil.server.close()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
})

describe('embed caller (JWT, JWT-only boot — Dataflarework deployment shape)', () => {
  beforeAll(async () => {
    await boot({
      WEB_TOKEN: undefined,
      GENOFFICE_JWT_SECRET: JWT_SECRET,
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
    })
  })

  const embedJwt = (scope: string[]): string =>
    signJwt({
      sub: 'embed-guest',
      scope,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: 'genoffice',
      aud: 'genoffice-web',
    })

  it('routes the upstream call to the server-configured endpoint with the server-held key', async () => {
    const before = friendlyHits.length
    const { status, sse } = await streamOnce(embedJwt(['ai:chat']), embedSettings(`http://127.0.0.1:${evil.port}`))
    expect(status).toBe(200)
    expect(sse).toContain('data:')
    // Upstream reached the tenant endpoint — never the injected one — and the
    // Authorization header the upstream saw is the server's key, not the
    // caller's injected one.
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(evilHits).toHaveLength(0)
    expect(friendlyHits.at(-1)?.authorization).toBe(`Bearer ${SERVER_KEY}`)
    expect(friendlyHits.at(-1)?.path).toContain('/chat/completions')
  }, 30_000)

  it('sanitizes settings injected through the v1 REST ingress too (Bearer JWT, ai:chat)', async () => {
    // A2 regression: /api/v1/ai/chat used to forward the call through
    // invokeIpc with a userId-less event, so isEmbedCaller saw "local" and
    // kept the injected apiKey/baseUrl as if they were operator BYOK.
    const before = friendlyHits.length
    const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${embedJwt(['ai:chat'])}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'ping' }],
        settings: embedSettings(`http://127.0.0.1:${evil.port}`),
      }),
    })
    expect(res.status).toBe(200)
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(evilHits).toHaveLength(0)
    expect(friendlyHits.at(-1)?.authorization).toBe(`Bearer ${SERVER_KEY}`)
    expect(friendlyHits.at(-1)?.path).toContain('/chat/completions')
  }, 30_000)

  it('sanitizes settings injected through /api/ipc with a cookie-carried JWT', async () => {
    // A2 regression, transport variant: the gate admits a JWT via the
    // auth_token cookie, but the dispatcher used to resolve the subject from
    // the Authorization header only — cookie-JWT callers got a userId-less
    // event and degraded to local BYOK policy.
    const before = friendlyHits.length
    const res = await fetch(`${baseUrl}/api/ipc/ai%3Achat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `auth_token=${embedJwt(['ai:chat'])}` },
      body: JSON.stringify({ args: [{ user: 'ping', settings: embedSettings(`http://127.0.0.1:${evil.port}`) }] }),
    })
    expect(res.status).toBe(200)
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(evilHits).toHaveLength(0)
    expect(friendlyHits.at(-1)?.authorization).toBe(`Bearer ${SERVER_KEY}`)
  }, 30_000)

  const translateBody = (evilBaseUrl: string): Record<string, unknown> => ({
    units: [{ unitId: 'u1', kind: 'paragraph', sourceText: 'hello', order: 0 }],
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    settings: embedSettings(evilBaseUrl),
  })

  it('sanitizes settings injected through the legacy translate batch route', async () => {
    // Iteration-3 A2 regression: translate-http.ts used to return
    // req.settings wholesale (pickSettings) and feed it into translateBatch —
    // an SSRF hole on the Dataflare bridge's primary path.
    const before = friendlyHits.length
    const res = await fetch(`${baseUrl}/api/ai/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${embedJwt(['ai:translate'])}` },
      body: JSON.stringify(translateBody(`http://127.0.0.1:${evil.port}`)),
    })
    expect(res.status).toBe(200)
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(evilHits).toHaveLength(0)
    expect(friendlyHits.at(-1)?.authorization).toBe(`Bearer ${SERVER_KEY}`)
    expect(friendlyHits.at(-1)?.path).toContain('/chat/completions')
  }, 30_000)

  it('sanitizes settings injected through the legacy translate stream route with a cookie-carried JWT', async () => {
    const before = friendlyHits.length
    const res = await fetch(`${baseUrl}/api/ai/translate/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `auth_token=${embedJwt(['ai:translate'])}` },
      body: JSON.stringify(translateBody(`http://127.0.0.1:${evil.port}`)),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain('event:')
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(evilHits).toHaveLength(0)
    expect(friendlyHits.at(-1)?.authorization).toBe(`Bearer ${SERVER_KEY}`)
  }, 30_000)

  it('sanitizes settings injected through the v1 translate units ingress', async () => {
    const before = friendlyHits.length
    const res = await fetch(`${baseUrl}/api/v1/ai/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${embedJwt(['ai:translate'])}` },
      body: JSON.stringify(translateBody(`http://127.0.0.1:${evil.port}`)),
    })
    expect(res.status).toBe(200)
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(evilHits).toHaveLength(0)
    expect(friendlyHits.at(-1)?.authorization).toBe(`Bearer ${SERVER_KEY}`)
  }, 30_000)

  it('rejects a scope-limited JWT without ai:translate on the legacy translate routes with 403', async () => {
    // jwt-open boots skip the route table, so these routes enforce their
    // declared scope at the entry — a files:read-only guest must not reach
    // provider spend, no matter which transport carried its JWT.
    for (const path of ['/api/ai/translate', '/api/ai/translate/stream', '/api/ai/stream']) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${embedJwt(['files:read'])}` },
        body: JSON.stringify({ units: [] }),
      })
      expect(res.status).toBe(403)
    }
    expect(evilHits).toHaveLength(0)
  }, 30_000)
})

describe('operator caller (WEB_TOKEN-armed boot)', () => {
  beforeAll(async () => {
    await shutdown()
    await boot({
      WEB_TOKEN: OPERATOR_TOKEN,
      GENOFFICE_JWT_SECRET: JWT_SECRET,
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
    })
  })

  it('still honors a loopback BYOK baseUrl override (local Ollama use case)', async () => {
    const before = friendlyHits.length
    const { status } = await streamOnce(OPERATOR_TOKEN, {
      provider: 'openai',
      providers: { openai: { apiKey: 'operator-byok-key', baseUrl: `http://127.0.0.1:${friendly.port}`, model: 'gpt-4o' } },
    })
    expect(status).toBe(200)
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(friendlyHits.at(-1)?.authorization).toBe('Bearer operator-byok-key')
  }, 30_000)

  it('still honors a loopback BYOK baseUrl override on the translate batch route', async () => {
    const before = friendlyHits.length
    const res = await fetch(`${baseUrl}/api/ai/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
      body: JSON.stringify({
        units: [{ unitId: 'u1', kind: 'paragraph', sourceText: 'hello', order: 0 }],
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        settings: {
          provider: 'openai',
          providers: { openai: { apiKey: 'operator-byok-key', baseUrl: `http://127.0.0.1:${friendly.port}`, model: 'gpt-4o' } },
        },
      }),
    })
    expect(res.status).toBe(200)
    expect(friendlyHits.length).toBeGreaterThan(before)
    expect(friendlyHits.at(-1)?.authorization).toBe('Bearer operator-byok-key')
    expect(evilHits).toHaveLength(0)
  }, 30_000)

  it('rejects a non-allowlisted baseUrl with a structured 400 before any upstream call', async () => {
    const res = await fetch(`${baseUrl}/api/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
      body: JSON.stringify({
        requestId: 'ssrf-metadata-canary',
        settings: {
          provider: 'openai',
          providers: { openai: { apiKey: 'k', baseUrl: 'http://169.254.169.254/latest/meta-data', model: 'gpt-4o' } },
        },
        system: '',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string; message?: string; channel?: string } }
    expect(body.error?.code).toBe('INVALID_ARGUMENT')
    expect(body.error?.message).toContain('allowlist')
    expect(body.error?.channel).toBe('/api/ai/stream')
    expect(evilHits).toHaveLength(0)
  })
})

describe('global invariants', () => {
  it('the evil listener never received a single request across all scenarios', () => {
    expect(evilHits).toHaveLength(0)
  })
})

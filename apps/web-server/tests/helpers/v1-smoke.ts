/**
 * Reusable helpers for v1 REST API smoke tests.
 *
 * Centralizes the boilerplate that every "hit the live bundle" suite
 * would otherwise reimplement:
 *
 *   - HS256 JWT minting with arbitrary scopes
 *   - JSON-over-HTTP fetch that returns `{ status, body, text }` so
 *     callers can branch on either
 *   - a `ServerHarness` that boots `dist/bundle/index.js` against a
 *     temp DATA_DIR with a configurable port and JWT secret
 *   - poll-until-healthy helper for the boot race
 *
 * Usage:
 *
 *   import { mintJwt, fetchJson, ServerHarness } from './helpers/v1-smoke'
 *
 *   const harness = await ServerHarness.start({ port: 19090 })
 *   const token = await mintJwt(harness.secret, 'tester', ['files:read'])
 *   const r = await fetchJson(`${harness.base}/api/v1/files`, {
 *     headers: { authorization: `Bearer ${token}` },
 *   })
 *   expect(r.status).toBe(200)
 *   await harness.stop()
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface JwtPayload {
  sub: string
  scope: string[]
  iat?: number
  exp?: number
  iss?: string
  aud?: string
  [k: string]: unknown
}

const encoder = new TextEncoder()
async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Buffer.from(sig).toString('base64url')
}
function b64url(s: string): string {
  return Buffer.from(s).toString('base64url')
}

/**
 * Mint an HS256 JWT for use against the live web-server.
 *
 * Default `iat`/`exp` is now + 1h. `iss` and `aud` match what the
 * server's `verifyJwtWithRevocation` expects (`genoffice` / `genoffice-web`).
 */
export async function mintJwt(
  secret: string,
  sub: string,
  scope: string[],
  extras: Partial<JwtPayload> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtPayload = {
    sub,
    scope,
    iat: now,
    exp: now + 3600,
    iss: 'genoffice',
    aud: 'genoffice-web',
    ...extras,
  }
  const header = { alg: 'HS256', typ: 'JWT' }
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = await hmacSign(secret, data)
  return `${data}.${sig}`
}

export interface FetchJsonResult<T = unknown> {
  status: number
  body: T
  text: string
  headers: Headers
}

/**
 * fetch() wrapper that always returns parsed JSON (or the raw text on
 * parse failure) plus the status code. Mirrors what the v1 endpoints
 * speak — `body.error.code` etc. on the failure envelope.
 */
export async function fetchJson<T = unknown>(
  url: string,
  opts: RequestInit = {},
): Promise<FetchJsonResult<T>> {
  const res = await fetch(url, opts)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body: body as T, text, headers: res.headers }
}

export interface ServerHarnessOptions {
  /** Port to bind. Defaults to a random free port (probe 19090..19199). */
  port?: number
  /** JWT secret. Defaults to a per-harness random string. */
  secret?: string
  /** Extra env vars to set on the spawned process. */
  env?: Record<string, string>
  /** Milliseconds to wait for `/health` to respond. Defaults to 10s. */
  healthDeadlineMs?: number
  /** If true, do NOT spawn a process — useful for tests against a pre-started server. */
  external?: { base: string; secret: string }
}

export class ServerHarness {
  readonly base: string
  readonly secret: string
  readonly dataDir: string
  readonly port: number
  private server: ChildProcess | undefined

  private constructor(opts: {
    base: string
    secret: string
    dataDir: string
    port: number
    server?: ChildProcess
  }) {
    this.base = opts.base
    this.secret = opts.secret
    this.dataDir = opts.dataDir
    this.port = opts.port
    this.server = opts.server
  }

  /**
   * Boot a fresh server. Returns a harness with a temp DATA_DIR.
   * Caller MUST call `stop()` to clean up (typically in `afterAll`).
   */
  static async start(opts: ServerHarnessOptions = {}): Promise<ServerHarness> {
    if (opts.external) {
      return new ServerHarness({
        base: opts.external.base,
        secret: opts.external.secret,
        dataDir: '',
        port: 0,
      })
    }
    const port = opts.port ?? (await pickFreePort())
    const secret = opts.secret ?? `harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const dataDir = mkdtempSync(join(tmpdir(), `genoffice-harness-${port}-`))
    const pkgRoot = join(import.meta.dirname, '..', '..')
    const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
    if (!existsSync(bundle)) {
      throw new Error(`bundle not found at ${bundle}; run \`pnpm build\` first`)
    }
    const base = `http://127.0.0.1:${port}`
    const server = spawn('node', [bundle], {
      env: {
        ...process.env,
        GENOFFICE_JWT_SECRET: secret,
        GENOFFICE_TEST_DATA_DIR: dataDir,
        DATA_DIR: dataDir,
        GENOFFICE_DATA_DIR: dataDir,
        GENOFFICE_WEB_DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, opts.healthDeadlineMs ?? 10_000)
    return new ServerHarness({ base, secret, dataDir, port, server })
  }

  /**
   * Mint a JWT bound to this harness's secret. Convenience wrapper
   * around `mintJwt(this.secret, ...)`.
   */
  token(sub: string, scope: string[], extras: Partial<JwtPayload> = {}): Promise<string> {
    return mintJwt(this.secret, sub, scope, extras)
  }

  /**
   * Send a request with optional Bearer token. Convenience over fetchJson.
   */
  async req<T = unknown>(
    path: string,
    opts: RequestInit & { token?: string } = {},
  ): Promise<FetchJsonResult<T>> {
    const { token, ...rest } = opts
    const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) }
    if (token) headers.authorization = `Bearer ${token}`
    return fetchJson<T>(`${this.base}${path}`, { ...rest, headers })
  }

  async stop(): Promise<void> {
    const { stopServer } = await import('./server-process')
    await stopServer(this.server, this.dataDir)
  }
}

async function pollHealth(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error(`server did not become healthy within ${deadlineMs}ms`)
}

async function pickFreePort(): Promise<number> {
  // Use a randomized ephemeral port range to avoid collisions when
  // multiple bundle tests run in parallel. The old fixed range
  // 19090..19199 (110 ports) was too narrow for the full suite which
  // now boots 4+ bundles concurrently. The seed uses crypto when
  // available; falls back to Math.random in environments without it.
  const rand = (n: number) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { randomInt } = require('node:crypto') as { randomInt?: (max: number) => number }
      return randomInt ? randomInt(n) : Math.floor(Math.random() * n)
    } catch {
      return Math.floor(Math.random() * n)
    }
  }
  // 20000..50000 is well above any well-known service range and gives
  // 30k candidates — collision probability for 8 concurrent tests is
  // < 1% per pair (birthday paradox: p ≈ 1 - exp(-n²/(2*30k))).
  const start = 20000 + rand(30_000)
  for (let i = 0; i < 200; i++) {
    const p = start + i
    if (p > 65535) break
    if (await isPortFree(p)) return p
  }
  // Last resort: scan the whole range sequentially. Slow but always works.
  for (let p = 20000; p < 60000; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error('no free port in 20000..59999')
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.once('listening', () => s.close(() => resolve(true)))
      s.listen(port, '127.0.0.1')
    })
  })
}

/**
 * Convenience recorder for smoke-style suites: collect pass/fail per
 * case, print a one-line summary, and return whether everything passed.
 */
export class SmokeRecorder {
  private results: { name: string; ok: boolean; detail: string }[] = []

  record(name: string, ok: boolean, detail = ''): void {
    this.results.push({ name, ok, detail })
    const mark = ok ? '✅' : '❌'
    console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  summary(): { passed: number; failed: number; total: number; ok: boolean } {
    const passed = this.results.filter((r) => r.ok).length
    const failed = this.results.length - passed
    return { passed, failed, total: this.results.length, ok: failed === 0 }
  }

  printSummary(): void {
    const s = this.summary()
    console.log(`\n=== Summary ===`)
    console.log(`Total: ${s.total}, Passed: ${s.passed}, Failed: ${s.failed}`)
    if (s.failed > 0) {
      console.log('\nFailed:')
      for (const r of this.results) if (!r.ok) console.log(`  - ${r.name} (${r.detail})`)
    }
  }
}

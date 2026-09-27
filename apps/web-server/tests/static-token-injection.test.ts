/**
 * The operator token is only handed to a caller that already presented it.
 *
 * A `WEB_TOKEN`-configured server inlines the token into any HTML it serves as
 * both a readable `<meta name="genoffice-token">` and an `auth_token` cookie —
 * that is how the iframe's `EventSource`/fetch learn the credential. Both were
 * stamped unconditionally, so `GET /docs/` (which is not under `/api/`, and so
 * never touches Gate 1) answered an anonymous caller with the operator secret
 * in the body. That token is a full operator credential: replaying it reached
 * `GET /api/v1/metrics` → 200.
 *
 * Two things must stay true, and they pull in opposite directions:
 *
 *   1. an anonymous caller gets *nothing* (the disclosure above), and
 *   2. the Dataflarework embed still works — its reverse proxy injects
 *      `X-GenOffice-Token` on every `/office-engine/**` request, so the
 *      iframe's page load *does* present the credential.
 *
 * (2) is why the fix gates on the request rather than removing the injection:
 * asserting only (1) would be satisfied by breaking the embed. The
 * `x-genoffice-token` case below is the proxy topology in miniature.
 *
 * Boots its own bundle, like `jwt-route-policy.test.ts`. A missing bundle is a
 * broken build, not a reason to skip (plan §W2.2).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'

const OPERATOR_TOKEN = 'operator-shared-secret'

let child: ChildProcess | null = null
let baseUrl = ''

/** The `<meta name="genoffice-token" content="…">` value, if the page has one. */
function injectedToken(html: string): string | null {
  const m = /<meta name="genoffice-token" content="([^"]*)">/.exec(html)
  return m ? m[1]! : null
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; html: string; setCookie: string | null }> {
  const res = await fetch(`${baseUrl}${path}`, { headers })
  return {
    status: res.status,
    html: await res.text(),
    setCookie: res.headers.get('set-cookie'),
  }
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'static-token-injection-'))
  const port = 18601 + Math.floor(Math.random() * 150)
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
      // Armed so the wrapper's JWT branch is live rather than passthrough.
      GENOFFICE_JWT_SECRET: 'static-token-injection-suite-secret',
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
}, 30_000)

afterAll(async () => {
  if (child && !child.killed) child.kill('SIGTERM')
  if (child) await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
})

describe('the SPA/HTML handler discloses the operator token only to a caller holding it', () => {
  it('serves the editor page to an anonymous caller with no token anywhere in it', async () => {
    const r = await get('/docs/?embed=1')
    expect(r.status).toBe(200)
    // The regression: this used to be the operator secret, in the body.
    expect(injectedToken(r.html)).toBeNull()
    expect(r.html).not.toContain(OPERATOR_TOKEN)
    expect(r.setCookie ?? '').not.toContain('auth_token')
  })

  it('injects the token when the caller supplies it in the query', async () => {
    const r = await get(`/docs/?embed=1&token=${OPERATOR_TOKEN}`)
    expect(r.status).toBe(200)
    expect(injectedToken(r.html)).toBe(OPERATOR_TOKEN)
    expect(r.setCookie).toContain(`auth_token=${OPERATOR_TOKEN}`)
  })

  it('injects the token when the reverse proxy supplies the header (Dataflare topology)', async () => {
    // This is the load-bearing case: if it regresses, the embed breaks in the
    // real deployment even though every other assertion here still passes.
    const r = await get('/docs/?embed=1', { 'x-genoffice-token': OPERATOR_TOKEN })
    expect(r.status).toBe(200)
    expect(injectedToken(r.html)).toBe(OPERATOR_TOKEN)
    expect(r.setCookie).toContain(`auth_token=${OPERATOR_TOKEN}`)
  })

  it('injects the token when the caller supplies it as a Bearer', async () => {
    const r = await get('/docs/?embed=1', { authorization: `Bearer ${OPERATOR_TOKEN}` })
    expect(r.status).toBe(200)
    expect(injectedToken(r.html)).toBe(OPERATOR_TOKEN)
  })

  it('rejects a wrong token the same way as none — no partial trust', async () => {
    const r = await get('/docs/?embed=1&token=not-the-token')
    expect(r.status).toBe(200)
    expect(injectedToken(r.html)).toBeNull()
    expect(r.html).not.toContain(OPERATOR_TOKEN)
  })
})

describe('the /embed wrapper never stamps the operator token for an unproven caller', () => {
  it('answers an invented token with no credential cookie', async () => {
    const r = await get('/embed/doc_abc?app=docs&token=garbage')
    expect(r.status).toBe(200)
    expect(r.setCookie ?? '').not.toContain('auth_token')
    expect(r.html).not.toContain(OPERATOR_TOKEN)
  })

  it('still honours the legacy flow — the operator token passed as ?token=', async () => {
    const r = await get(`/embed/doc_abc?app=docs&token=${OPERATOR_TOKEN}`)
    expect(r.status).toBe(200)
    expect(r.setCookie).toContain(`auth_token=${OPERATOR_TOKEN}`)
  })
})

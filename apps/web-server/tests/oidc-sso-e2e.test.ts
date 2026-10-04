/**
 * SSO / OIDC authorization-code flow, end to end (A21 / A67 / A68).
 *
 * The unit-level pieces of this flow (PKCE generation, state bookkeeping, ID
 * token verification, claims → scope mapping) are covered where they live.
 * What this suite adds is the only thing that can catch a shared
 * misunderstanding of the *protocol*: a real third-party OpenID Provider,
 * running in a container, driving the full chain
 *
 *     discovery document
 *       → authorization request (PKCE S256 challenge)
 *         → the provider's own interactive login
 *           → local JWT minted from the verified ID token
 *             → that JWT admitted on a protected API route
 *
 * Dex (`ghcr.io/dexidp/dex`) is the provider. It is a widely deployed OIDC
 * implementation written by someone else, which is the point: a provider we
 * wrote ourselves would only re-assert our own reading of RFC 6749 §4.1 and
 * OpenID Connect Core §3.1. Dex also enforces PKCE itself — the exchange
 * below fails with `400 Invalid code_verifier` if the verifier our module
 * sends does not hash to the challenge it sent, so the S256 leg is verified
 * by a party that has no stake in our implementation.
 *
 * The provider is configured with two users in different groups so that the
 * claims → scope table is observable in both directions:
 *
 *   - `editor@example.com` in `genoffice:editor` → the editor scope set, which
 *     is strictly wider than the read-only default. This is what proves the
 *     table routed the claims rather than everything falling through to the
 *     default.
 *   - `outsider@example.com` in `contractors`, a group the table does not
 *     know → the read-only default.
 *
 * The suite skips when Docker is unavailable and fails loudly when Docker is
 * present but Dex never becomes ready — a silent skip there would make the
 * acceptance claim vacuous. Override the image with `GENOFFICE_DEX_IMAGE`.
 *
 * One deliberate design note: the protected API is reached on a `WEB_TOKEN`-
 * armed boot. That is the posture where `route-policy` actually applies to a
 * guest JWT; on a JWT-only boot the same token would be admitted by every
 * dispatcher's own gate and a missing scope would *not* be a 403, so the
 * denial assertions below would be meaningless.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ServerHarness, fetchJson } from './helpers/v1-smoke'
import { reserveFreePort } from './helpers/server-process'

const execFileAsync = promisify(execFile)

const IMAGE = process.env.GENOFFICE_DEX_IMAGE?.trim() || 'ghcr.io/dexidp/dex:latest'
const CLIENT_ID = 'genoffice-web'
const CLIENT_SECRET = 'genoffice-test-secret'
const PASSWORD = 'genoffice-test-password'
const CONTAINER_PORT = 5556

/**
 * bcrypt hash of {@link PASSWORD} (cost 10), generated once with
 * `htpasswd -bnBC 10`. Dex's password DB takes bcrypt, so it cannot be
 * derived at test time without a bcrypt dependency the repo does not have.
 */
const PASSWORD_HASH = '$2y$10$Cvv4dA2oJ9G.XpbwuD7ktu0I.1w4ThXOqVjbBThq/t/Xe7tMBrsvy'

const EDITOR = { email: 'editor@example.com', group: 'genoffice:editor' }
const OUTSIDER = { email: 'outsider@example.com', group: 'contractors' }

/** The scope set `SCOPES_FOR_GROUP['genoffice:editor']` resolves to, sorted. */
const EDITOR_SCOPES = [
  'ai:chat',
  'ai:translate',
  'files:comment',
  'files:read',
  'files:write',
  'kb:read',
]
/** `DEFAULT_SCOPES` — what an IdP group the table does not know resolves to. */
const DEFAULT_SCOPES = ['files:read']

interface DockerResult {
  stdout: string
  stderr: string
}

function docker(args: string[], timeoutMs = 120_000): Promise<DockerResult> {
  return execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
}

function failureLine(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr
  const message = stderr?.trim() || (error as Error)?.message || String(error)
  return message.split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown error'
}

/* Probed synchronously so `describe.skipIf` can see the answer at collection
 * time; `docker version` fails fast on a machine with no CLI or no daemon. */
const dockerUsable = (() => {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeout: 20_000,
    encoding: 'utf8',
  })
  return probe.status === 0
})()

let containerName = ''
let issuer = ''
let callbackUri = ''
let harness: ServerHarness | undefined
let webToken = ''
const webOrigin = () => harness?.base ?? ''

async function resolveImage(): Promise<string> {
  try {
    await docker(['image', 'inspect', IMAGE], 20_000)
    return IMAGE
  } catch {
    /* not cached */
  }
  try {
    await docker(['pull', IMAGE], 900_000)
    return IMAGE
  } catch (error) {
    throw new Error(`could not obtain the Dex image ${IMAGE}: ${failureLine(error)}`)
  }
}

function dexConfig(port: number, redirectUri: string): string {
  const user = (id: string, entry: { email: string; group: string }) => `  - email: ${entry.email}
    hash: "${PASSWORD_HASH}"
    username: ${id}
    userID: ${id}
    groups: ["${entry.group}"]
`
  return `issuer: http://127.0.0.1:${port}/dex
storage:
  type: memory
web:
  http: 0.0.0.0:${CONTAINER_PORT}
staticClients:
  - id: ${CLIENT_ID}
    secret: ${CLIENT_SECRET}
    name: GenOffice
    redirectURIs:
      - ${redirectUri}
enablePasswordDB: true
staticPasswords:
${user('11111111-2222-3333-4444-555555555555', EDITOR)}${user('66666666-7777-8888-9999-000000000000', OUTSIDER)}`
}

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

let discovery: Discovery

async function waitForDiscovery(url: string, timeoutMs = 60_000): Promise<Discovery> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/.well-known/openid-configuration`)
      if (res.ok) return (await res.json()) as Discovery
    } catch {
      /* Dex is still starting */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  const logs = await docker(['logs', '--tail', '40', containerName]).catch(() => ({
    stdout: '',
    stderr: '',
  }))
  throw new Error(`Dex never served its discovery document at ${url}\n${logs.stdout}${logs.stderr}`)
}

/**
 * Drive Dex's interactive login the way a browser would — open the URL the
 * server handed back, follow the redirect chain, POST the credentials form,
 * POST the consent form — and return the callback URL the provider redirects
 * to.
 *
 * This is test scaffolding standing in for a human with a browser, not part
 * of the code under test: the module under test only ever sees the `code` and
 * `state` this produces, exactly as it would from a real redirect. The entry
 * point is the `authUrl` `auth:sso-login` returned, which is what carries its
 * state and PKCE challenge into the provider.
 */
async function authorise(authUrl: string, email: string): Promise<URL> {
  const get = (u: string) => fetch(u, { redirect: 'manual' })
  const postForm = (u: string, params: URLSearchParams) =>
    fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual',
    })

  let location = (await get(authUrl)).headers.get('location')
  for (let hop = 0; hop < 8 && location; hop += 1) {
    const absolute = new URL(location, issuer).toString()
    const path = new URL(absolute).pathname
    if (!path.startsWith('/dex/')) return new URL(absolute)

    if (path.endsWith('/auth/local/login')) {
      const html = await (await get(absolute)).text()
      const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&')
      expect(action, 'Dex login form had no action').toBeTruthy()
      const params = new URLSearchParams({ login: email, password: PASSWORD })
      for (const [k, v] of new URL(absolute).searchParams) params.set(k, v)
      location = (await postForm(new URL(action as string, issuer).toString(), params)).headers.get(
        'location',
      )
      continue
    }

    if (path.endsWith('/approval')) {
      const html = await (await get(absolute)).text()
      const req = /name="req" value="([^"]+)"/.exec(html)?.[1]
      expect(req, 'Dex consent form had no request id').toBeTruthy()
      location = (
        await postForm(absolute, new URLSearchParams({ req: req as string, approval: 'approve' }))
      ).headers.get('location')
      continue
    }

    location = (await get(absolute)).headers.get('location')
  }
  throw new Error('never reached the OIDC callback — Dex changed its login flow')
}

interface SsoLogin {
  authUrl: string
  state: string
}

/** `auth:sso-login` through the real HTTP IPC dispatcher, as an operator would. */
async function ssoLogin(redirectUri = callbackUri): Promise<SsoLogin> {
  const res = await fetchJson<{ ok: boolean; result: SsoLogin }>(
    `${webOrigin()}/api/ipc/auth:sso-login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-genoffice-token': webToken },
      body: JSON.stringify({ args: [{ provider: 'dex', redirectUri }] }),
    },
  )
  expect(res.status, `auth:sso-login failed: ${res.text}`).toBe(200)
  return res.body.result
}

interface SsoCallback {
  ok: true
  provider: string
  accessToken: string
  expiresIn: number
  scopes: string[]
  user: { id: string; email?: string; name?: string }
}

async function ssoCallback(input: { code: string; state: string }) {
  return await fetchJson<{ ok: boolean; result: SsoCallback }>(
    `${webOrigin()}/api/ipc/auth:sso-callback`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-genoffice-token': webToken },
      body: JSON.stringify({ args: [input] }),
    },
  )
}

/** The whole chain: begin → provider login → callback → local JWT. */
async function loginAs(email: string): Promise<SsoCallback> {
  const started = await ssoLogin()
  const callback = await authorise(started.authUrl, email)
  const code = callback.searchParams.get('code')
  expect(code, 'provider returned no code').toBeTruthy()
  // The provider echoes the state we minted — the CSRF round-trip.
  expect(callback.searchParams.get('state')).toBe(started.state)

  const finished = await ssoCallback({ code: code as string, state: started.state })
  expect(finished.status, `auth:sso-callback failed: ${finished.text}`).toBe(200)
  return finished.body.result
}

describe.skipIf(!dockerUsable)('SSO over a real OIDC provider container (A21 / A67 / A68)', () => {
  beforeAll(async () => {
    await resolveImage()

    // Both ports are reserved up front so the redirect URI Dex registers and
    // the issuer our module is configured with are fixed before either side
    // starts. Dex needs the redirect URI at boot; the server needs the issuer
    // in its environment at fork.
    const dexPort = await reserveFreePort()
    const callbackPort = await reserveFreePort()
    callbackUri = `http://127.0.0.1:${callbackPort}/sso/callback`
    // `issuer` is the OIDC issuer identity, which Dex publishes verbatim in
    // its discovery document and its ID tokens.
    issuer = `http://127.0.0.1:${dexPort}/dex`

    const configDir = mkdtempSync(join(tmpdir(), 'genoffice-dex-'))
    const configPath = join(configDir, 'config.yaml')
    writeFileSync(configPath, dexConfig(dexPort, callbackUri))
    // The container runs as an unprivileged user; the bind-mounted file must
    // be world-readable or Dex exits on startup.
    chmodSync(configPath, 0o644)

    containerName = `genoffice-dex-${process.pid}-${Date.now().toString(36)}`
    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      containerName,
      '-p',
      `127.0.0.1:${dexPort}:${CONTAINER_PORT}`,
      '-v',
      `${configPath}:/etc/dex/config.yaml:ro`,
      IMAGE,
      'dex',
      'serve',
      '/etc/dex/config.yaml',
    ])
    discovery = await waitForDiscovery(issuer)

    webToken = `web-token-${randomBytes(8).toString('hex')}`
    harness = await ServerHarness.start({
      env: {
        WEB_TOKEN: webToken,
        GENOFFICE_OIDC_PROVIDERS: JSON.stringify({
          dex: {
            issuer,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            scopes: ['openid', 'profile', 'email', 'groups'],
          },
        }),
      },
    })
  }, 900_000)

  afterAll(async () => {
    await harness?.stop()
    if (containerName) await docker(['rm', '-f', containerName], 60_000).catch(() => {})
  })

  it('signs in through the provider and reaches a protected API with the local JWT', async () => {
    const login = await loginAs(EDITOR.email)

    expect(login.ok).toBe(true)
    expect(login.provider).toBe('dex')
    // The subject is the provider's — not a locally invented id, and not the
    // `token-<now>` the placeholder used to return.
    expect(login.user.id).toMatch(/^.{8,}$/)
    expect(login.user.email).toBe(EDITOR.email)
    expect(login.accessToken).not.toContain('token-')
    expect(login.accessToken.split('.')).toHaveLength(3)
    expect(login.expiresIn).toBeGreaterThan(0)

    // The IdP group decided the scopes — wider than the read-only default, so
    // this asserts the table routed the claims rather than a fallthrough.
    expect([...login.scopes].sort()).toEqual(EDITOR_SCOPES)

    // A protected route, reached with only the minted guest JWT.
    const files = await fetchJson<{ files?: unknown[] }>(`${webOrigin()}/api/v1/files`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    })
    expect(files.status, files.text).toBe(200)

    // Reusable until it expires. A `jti` would make the single-use revocation
    // hook in `api/v1/files.ts` consume this token on first use, so the second
    // call is the assertion that guards that regression.
    const again = await fetchJson(`${webOrigin()}/api/v1/files`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    })
    expect(again.status, again.text).toBe(200)
  }, 120_000)

  it('admits the token only on routes its scopes name', async () => {
    const login = await loginAs(EDITOR.email)

    // `admin` is not in the editor set: the route table denies it.
    const metrics = await fetchJson<{ error?: { code?: string } }>(
      `${webOrigin()}/api/v1/metrics`,
      { headers: { authorization: `Bearer ${login.accessToken}` } },
    )
    expect(metrics.status).toBe(403)
    expect(metrics.body.error?.code).toBe('FORBIDDEN')

    // No credential at all on an armed boot.
    const anonymous = await fetchJson(`${webOrigin()}/api/v1/files`)
    expect(anonymous.status).toBe(401)
  }, 120_000)

  it('gives an IdP group the table does not know only the read-only default', async () => {
    const login = await loginAs(OUTSIDER.email)
    expect([...login.scopes].sort()).toEqual(DEFAULT_SCOPES)

    const files = await fetchJson(`${webOrigin()}/api/v1/files`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    })
    expect(files.status).toBe(200)

    const metrics = await fetchJson(`${webOrigin()}/api/v1/metrics`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    })
    expect(metrics.status).toBe(403)
  }, 120_000)

  it('returns the provider\'s own authorization URL, never a hard-coded one', async () => {
    const started = await ssoLogin()
    const url = new URL(started.authUrl)

    // The placeholder this replaced pointed every deployment at a host that
    // could not possibly be the configured identity provider.
    expect(started.authUrl).not.toContain('sso.genoffice.ai')
    expect(started.authUrl.startsWith(issuer)).toBe(true)
    expect(url.pathname).toBe(new URL(discovery.authorization_endpoint).pathname)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUri)
    expect(url.searchParams.get('scope')).toContain('openid')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(started.state).toBeTruthy()

    // Each call is an independent authorisation: states must not repeat.
    const second = await ssoLogin()
    expect(second.state).not.toBe(started.state)
  }, 120_000)

  it('refuses a callback whose state it never issued', async () => {
    const forged = await ssoCallback({ code: 'anything', state: 'not-a-state-we-minted' })
    expect(forged.status).toBe(400)
    expect((forged.body as { error?: { code?: string } }).error?.code).toBe('INVALID_ARGUMENT')

    // And a state is single-use: replaying a real callback fails.
    const started = await ssoLogin()
    const callback = await authorise(started.authUrl, EDITOR.email)
    const code = callback.searchParams.get('code') as string
    const first = await ssoCallback({ code, state: started.state })
    expect(first.status, first.text).toBe(200)
    const replay = await ssoCallback({ code, state: started.state })
    expect(replay.status).toBe(400)
  }, 120_000)

  it('refuses to invent a URL for a provider it does not know', async () => {
    const res = await fetchJson<{ error?: { code?: string; message?: string } }>(
      `${webOrigin()}/api/ipc/auth:sso-login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-genoffice-token': webToken },
        body: JSON.stringify({ args: [{ provider: 'not-configured' }] }),
      },
    )
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('INVALID_ARGUMENT')
  }, 60_000)
})

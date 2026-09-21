/**
 * Integration smoke for the REST API v1 surface — the stable SDK contract.
 *
 * Boots the same HTTP server the production bundle exposes, mints a JWT,
 * walks every documented endpoint, and asserts the v1.0 envelope + JSON
 * shapes hold. The web-server's `global-setup` rebuilds the bundle if any
 * source changed since the last build, so this test stays in sync with the
 * shipped surface.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'

// Booted child server details — set in beforeAll.
let child: import('node:child_process').ChildProcess | null = null
let baseUrl = ''
let jwt = ''
let dataDir = ''

interface V1Error {
  error: { message: string; code: string; channel?: string }
}

function isV1Error(value: unknown): value is V1Error {
  return !!value && typeof value === 'object' && 'error' in (value as Record<string, unknown>)
}

async function fetchJson(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, init)
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* leave as text */
  }
  return { status: res.status, body }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'api-v1-'))
  const port = 18089 + Math.floor(Math.random() * 200)

  // Boot the bundled web-server with a clean DATA_DIR and a deterministic
  // JWT secret so tests can sign/verify their own tokens.
  const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
  if (!existsSync(bundle)) {
    throw new Error(`bundle not found at ${bundle}; run \`node scripts/bundle.mjs\` first`)
  }
  child = fork(bundle, [], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      FILES_DIR: join(dataDir, 'files'),
      GENOFFICE_JWT_SECRET: 'api-v1-test-secret',
      GENOFFICE_JWT_ALG: 'HS256',
      WEB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  baseUrl = `http://127.0.0.1:${port}`

  // Wait for the server to print its banner — the bundle is synchronous so
  // the first stdout line is reliable. Cap at 15 s in case CI is slow.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not boot in 15s')), 15_000)
    child!.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('Channels')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child!.stderr?.on('data', (chunk: Buffer) => {
      // Surface early failures.
      if (chunk.toString('utf8').toLowerCase().includes('error')) {
        // eslint-disable-next-line no-console
        console.error('[child stderr]', chunk.toString('utf8'))
      }
    })
  })

  // Mint a JWT via the documented endpoint.
  const mint = await fetchJson('/api/v1/auth/jwt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sub: 'test-user',
      ttl: 600,
      // Request every scope this e2e suite exercises; without these the
      // scope-gated endpoints introduced in sdk1.md Appendix B.2 #3 would
      // respond 403 and the tests would fail for the wrong reason.
      scope: [
        'files:read',
        'files:write',
        'files:delete',
        'ai:read',
        'ai:chat',
        'ai:translate',
        'ai:image',
        'ai:skill',
        'kb:read',
        'kb:write',
        'webhooks:manage',
        'admin',
      ],
    }),
  })
  expect(mint.status).toBe(200)
  if (typeof mint.body !== 'object' || !mint.body || !('token' in mint.body)) {
    throw new Error('failed to mint JWT')
  }
  jwt = (mint.body as { token: string }).token
}, 30_000)

afterAll(async () => {
  if (child && !child.killed) child.kill('SIGTERM')
  if (child) await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
})

describe('GET /api/v1/health', () => {
  it('returns 200 with implementation metadata', async () => {
    const { status, body } = await fetchJson('/api/v1/health')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      status: 'ok',
    })
    expect((body as { apiVersion: string }).apiVersion).toMatch(/^v?1(\.0)?$/)
    expect((body as { implementedChannels: number }).implementedChannels).toBeGreaterThan(0)
  })

  it('is public — does not require Authorization even when WEB_TOKEN is set', async () => {
    // sdk1.md §2.1.A lists `/api/v1/health` as a public endpoint.
    // The test fixture sets WEB_TOKEN='' so we can't probe the
    // auth-required path here; instead, we verify the path is on the
    // public allowlist via the helper.
    const { isPublicApiPath } = await import('../src/auth/index')
    expect(isPublicApiPath('/api/v1/health')).toBe(true)
  })
})

describe('GET /api/v1/changelog', () => {
  it('is on the public allowlist (no Authorization required)', async () => {
    // sdk1.md §2.1.A marks this endpoint 公开. Probe the allowlist helper
    // directly because the test fixture runs with WEB_TOKEN=''.
    const { isPublicApiPath } = await import('../src/auth/index')
    expect(isPublicApiPath('/api/v1/changelog')).toBe(true)
  })

  it('returns 200 with markdown content or 404 if no CHANGELOG.md is shipped', async () => {
    const { status, body } = await fetchJson('/api/v1/changelog')
    expect([200, 404]).toContain(status)
    if (status === 200) {
      expect((body as { format: string }).format).toBe('markdown')
      expect(typeof (body as { content: string }).content).toBe('string')
      expect((body as { content: string }).content.length).toBeGreaterThan(0)
    }
  })
})

describe('POST /api/v1/auth/jwt', () => {
  it('rejects an empty body with INVALID_ARGUMENT', async () => {
    const { status, body } = await fetchJson('/api/v1/auth/jwt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(status).toBe(400)
    expect(isV1Error(body)).toBe(true)
    if (isV1Error(body)) expect(body.error.code).toBe('INVALID_ARGUMENT')
  })

  it('mints a usable token', async () => {
    const { status, body } = await fetchJson('/api/v1/auth/jwt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'mint-test', perm: ['files:write'] }),
    })
    expect(status).toBe(200)
    expect(typeof (body as { token: string }).token).toBe('string')
  })
})

describe('POST /api/v1/auth/oauth/token', () => {
  it('rejects unknown grant_type', async () => {
    const { status, body } = await fetchJson('/api/v1/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=unknown&client_id=x&client_secret=y',
    })
    expect(status).toBe(400)
    expect(isV1Error(body)).toBe(true)
  })
})

describe('auth-gated endpoints', () => {
  it('returns 401 without a Bearer token', async () => {
    const { status, body } = await fetchJson('/api/v1/files')
    expect(status).toBe(401)
    expect(isV1Error(body)).toBe(true)
    if (isV1Error(body)) expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('returns 401 for a forged token', async () => {
    const { status } = await fetchJson('/api/v1/files', {
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    expect(status).toBe(401)
  })
})

describe('file CRUD', () => {
  it('uploads a small file then lists it', async () => {
    const name = `notes-${Date.now()}.md`
    const payload = '# test\n\nHello world'
    const created = await fetchJson('/api/v1/files', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, bytes: Buffer.from(payload).toString('base64') }),
    })
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id
    expect(id).toContain(name)

    const list = await fetchJson('/api/v1/files', {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(list.status).toBe(200)
    const files = (list.body as { files: { id: string; name: string }[] }).files
    expect(files.map((f) => f.id)).toContain(id)
  })

  it('rejects an empty upload with INVALID_ARGUMENT', async () => {
    const { status, body } = await fetchJson('/api/v1/files', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'empty.md', bytes: '' }),
    })
    expect(status).toBe(400)
    expect(isV1Error(body)).toBe(true)
  })

  it('rejects a name with traversal characters', async () => {
    const { status, body } = await fetchJson('/api/v1/files', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: '../escape.md', bytes: Buffer.from('x').toString('base64') }),
    })
    // Either 400 (invalid name) or 201 with a sanitized id is acceptable —
    // what matters is that the path never escapes FILES_DIR.
    expect([201, 400]).toContain(status)
    if (status === 201) {
      const id = (body as { id: string }).id
      expect(id).not.toMatch(/\.\./)
    }
  })
})

describe('file-scoped sub-routes', () => {
  it('registers a callback via /api/v1/files/:id/callback', async () => {
    const name = `sub-route-${Date.now()}.md`
    const created = await fetchJson('/api/v1/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, bytes: Buffer.from('hi').toString('base64') }),
    })
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id
    const reg = await fetchJson(`/api/v1/files/${encodeURIComponent(id)}/callback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9/never', events: ['file.saved'] }),
    })
    expect(reg.status).toBe(201)
    expect((reg.body as { fileId: string }).fileId).toBe(id)
  })

  it('mints a file-scoped JWT via /api/v1/files/:id/jwt', async () => {
    const name = `sub-jwt-${Date.now()}.md`
    const created = await fetchJson('/api/v1/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, bytes: Buffer.from('hi').toString('base64') }),
    })
    const id = (created.body as { id: string }).id
    const jwtRes = await fetchJson(`/api/v1/files/${encodeURIComponent(id)}/jwt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(jwtRes.status).toBe(200)
    expect(typeof (jwtRes.body as { token: string }).token).toBe('string')
  })
})

describe('webhook subscription', () => {
  it('registers a callback, then deletes it', async () => {
    const upsert = await fetchJson('/api/v1/webhooks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: 'http://127.0.0.1:9/never-listening', events: ['file.saved'] }),
    })
    expect(upsert.status).toBe(201)

    const del = await fetchJson('/api/v1/webhooks', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(del.status).toBe(200)
  })
})

describe('AI capability surface', () => {
  it('requires auth on /api/v1/ai/capabilities', async () => {
    const { status } = await fetchJson('/api/v1/ai/capabilities')
    expect(status).toBe(401)
  })

  it('returns a capabilities document when authenticated', async () => {
    const { status, body } = await fetchJson('/api/v1/ai/capabilities', {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(status).toBe(200)
    expect(body).toBeDefined()
  })
})

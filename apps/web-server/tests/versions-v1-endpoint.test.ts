/**
 * v1 endpoints /api/v1/files/:id/versions[…] (sdk1.md §B.5.1 #3 Kestrel M3).
 *
 * Pins the wire-level contract of `apps/web-server/src/api/v1/versions.ts`:
 *
 *   1. GET    /api/v1/files/:id/versions             scope `files:read`
 *   2. GET    /api/v1/files/:id/versions/:vid        scope `files:read`
 *   3. POST   /api/v1/files/:id/versions             scope `files:write` (manual snapshot)
 *   4. POST   /api/v1/files/:id/versions/:vid/restore scope `files:restore`
 *   5. DELETE /api/v1/files/:id/versions/:vid        scope `files:restore`
 *
 * Plus the scope-gate contract:
 *   - 401 UNAUTHENTICATED on missing JWT
 *   - 403 FORBIDDEN on insufficient scope
 *   - 404 NOT_FOUND on unknown version id
 *
 * The `files:restore` scope is new in Kestrel M3 and is intentionally
 * NOT implied by `files:write`. A `files:write`-only token cannot
 * restore, even though it can create manual snapshots.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'versions-v1-test-secret'
})

const TMP = mkdtempSync(join(tmpdir(), 'versions-v1-'))
process.env.GENOFFICE_TEST_DATA_DIR = TMP
process.env.DATA_DIR = TMP
vi.stubEnv('DATA_DIR', TMP)

import { handleApiV1 } from '../src/api/v1'
import { FILES_DIR } from '../src/common'
import { _resetForTests as _resetVersionHistory } from '../src/common/version-history'
import { signJwt } from '../src/api/v1/auth'

// ── Mock HTTP plumbing ───────────────────────────────────────────────────────

function makeCtx(
  url: string,
  method: string,
  headers: Record<string, string> = {},
  bodyStr = '',
): {
  ctx: Parameters<typeof handleApiV1>[0]
  body: () => string
  status: { code: number }
} {
  let emitted = ''
  const status = { code: 0 }
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    getHeader: () => undefined,
    removeHeader: () => undefined,
    write: (chunk: string) => {
      emitted += chunk
      return true
    },
    end: (chunk?: string) => {
      if (chunk) emitted += chunk
      return undefined
    },
    writeHead: (code: number, _hdrs?: unknown) => {
      status.code = code
      return response
    },
    on: () => response,
    once: () => response,
    emit: () => true,
  } as unknown as ServerResponse
  const requestListeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const request = {
    method,
    url,
    headers: { host: 'localhost', ...headers },
    on: (ev: string, l: (...a: unknown[]) => void) => {
      (requestListeners[ev] ||= []).push(l)
      queueMicrotask(() => {
        if (ev === 'data' && bodyStr) {
          l(Buffer.from(bodyStr, 'utf8'))
        } else if (ev === 'end') {
          l()
        }
      })
      return request
    },
    once: (ev: string, l: (...a: unknown[]) => void) => {
      const wrap = (...args: unknown[]) => {
        requestListeners[ev] = (requestListeners[ev] ?? []).filter((x) => x !== wrap)
        ;(l as (...a: unknown[]) => void)(...args)
      }
      ;(requestListeners[ev] ||= []).push(wrap)
      queueMicrotask(() => {
        if (ev === 'data' && bodyStr) {
          wrap(Buffer.from(bodyStr, 'utf8'))
        } else if (ev === 'end') {
          wrap()
        }
      })
      return request
    },
    emit: (ev: string, ...args: unknown[]) => {
      const list = requestListeners[ev] ?? []
      for (const l of list) (l as (...a: unknown[]) => void)(...args)
      return true
    },
  } as unknown as IncomingMessage
  return {
    ctx: { request, response, pathname: new URL(url, 'http://localhost').pathname, method },
    body: () => emitted,
    status,
  }
}

function mintToken(scope: string[], sub = 'restorer-1'): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub,
    scope,
    iat: now,
    exp: now + 60,
    iss: 'genoffice',
    aud: 'genoffice-web',
  })
}

function seedFile(fileId: string, content: string): void {
  const path = join(FILES_DIR, fileId)
  writeFileSync(path, content, 'utf8')
}

beforeEach(() => {
  _resetVersionHistory()
})

afterEach(() => {
  _resetVersionHistory()
  // FILES_DIR is shared across tests; clean only the fileIds we touched.
  for (const id of ['doc-1', 'doc-2', 'doc-3']) {
    const p = join(FILES_DIR, id)
    if (existsSync(p)) rmSync(p, { force: true })
  }
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('v1 endpoint /api/v1/files/:id/versions[…] (Kestrel M3)', () => {
  describe('GET (list) — scope files:read', () => {
    it('returns 401 UNAUTHENTICATED on missing JWT', async () => {
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/versions', 'GET')
      await handleApiV1(ctx)
      expect(status.code).toBe(401)
      expect(getBody()).toContain('UNAUTHENTICATED')
    })

    it('returns 200 with empty list when no snapshots exist', async () => {
      const token = mintToken(['files:read'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/versions', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(ctx)
      expect(status.code).toBe(200)
      expect(JSON.parse(getBody())).toEqual({ fileId: 'doc-1', count: 0, versions: [] })
    })

    it('returns existing snapshots', async () => {
      seedFile('doc-1', 'initial content v1')
      const token = mintToken(['files:read', 'files:write'])
      const post = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ label: 'first snapshot' }))
      await handleApiV1(post.ctx)

      const list = makeCtx('/api/v1/files/doc-1/versions', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(list.ctx)
      expect(list.status.code).toBe(200)
      const parsed = JSON.parse(list.body())
      expect(parsed.count).toBe(1)
      expect(parsed.versions[0].message).toBe('first snapshot')
      expect(parsed.versions[0].size).toBe('initial content v1'.length)
      expect(typeof parsed.versions[0].sha256).toBe('string')
      expect(parsed.versions[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('POST (manual snapshot) — scope files:write', () => {
    it('creates a manual snapshot and returns 201 with id', async () => {
      seedFile('doc-1', 'manually captured content')
      const token = mintToken(['files:write'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ label: 'pre-edit save point' }))
      await handleApiV1(ctx)
      expect(status.code).toBe(201)
      const parsed = JSON.parse(getBody())
      expect(parsed.id).toMatch(/^v-doc-1-\d+/) // version-history uses v-<docId>-<n> format
      expect(parsed.message).toBe('pre-edit save point')
      expect(parsed.size).toBe('manually captured content'.length)
    })

    it('returns 404 on unknown file id', async () => {
      const token = mintToken(['files:write'])
      const { ctx, status } = makeCtx('/api/v1/files/nonexistent/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({}))
      await handleApiV1(ctx)
      expect(status.code).toBe(404)
    })

    it('returns 403 when scope is files:read only', async () => {
      seedFile('doc-1', 'x')
      const token = mintToken(['files:read'])
      const { ctx, status } = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({}))
      await handleApiV1(ctx)
      expect(status.code).toBe(403)
    })

    it('returns 400 on label > 200 chars', async () => {
      seedFile('doc-1', 'x')
      const token = mintToken(['files:write'])
      const longLabel = 'x'.repeat(201)
      const { ctx, status } = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ label: longLabel }))
      await handleApiV1(ctx)
      expect(status.code).toBe(400)
    })
  })

  describe('GET (single) — scope files:read', () => {
    it('returns base64 bytes for the version', async () => {
      const content = 'snapshot payload bytes'
      seedFile('doc-1', content)
      const token = mintToken(['files:read', 'files:write'])
      const post = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ label: 'with-bytes' }))
      await handleApiV1(post.ctx)
      const id = JSON.parse(post.body()).id

      const get = makeCtx(`/api/v1/files/doc-1/versions/${id}`, 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(get.ctx)
      expect(get.status.code).toBe(200)
      const parsed = JSON.parse(get.body())
      const decoded = Buffer.from(parsed.bytes, 'base64').toString('utf8')
      expect(decoded).toBe(content)
      expect(parsed.id).toBe(id)
    })

    it('returns 404 on unknown version id', async () => {
      seedFile('doc-1', 'x')
      const token = mintToken(['files:read'])
      const { ctx, status } = makeCtx('/api/v1/files/doc-1/versions/v_nope', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(ctx)
      expect(status.code).toBe(404)
    })
  })

  describe('POST .../restore — scope files:restore (NEW)', () => {
    it('restores file bytes to the chosen version', async () => {
      // Seed v1 → modify file → snapshot v2 → restore v1.
      seedFile('doc-1', 'V1 content')
      const token = mintToken(['files:read', 'files:write', 'files:restore'])
      const postV1 = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ label: 'v1' }))
      await handleApiV1(postV1.ctx)
      const idV1 = JSON.parse(postV1.body()).id

      // Modify file
      seedFile('doc-1', 'V2 modified content')
      const postV2 = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ label: 'v2' }))
      await handleApiV1(postV2.ctx)

      // Restore v1
      const restore = makeCtx(`/api/v1/files/doc-1/versions/${idV1}/restore`, 'POST', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(restore.ctx)
      expect(restore.status.code).toBe(200)
      expect(JSON.parse(restore.body()).version).toBe(idV1)

      // File on disk should now be V1 content.
      const onDisk = readFileSync(join(FILES_DIR, 'doc-1'), 'utf8')
      expect(onDisk).toBe('V1 content')
    })

    it('returns 404 on unknown version id', async () => {
      seedFile('doc-1', 'x')
      const token = mintToken(['files:restore'])
      const { ctx, status } = makeCtx('/api/v1/files/doc-1/versions/v_nope/restore', 'POST', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(ctx)
      expect(status.code).toBe(404)
    })

    it('returns 403 when scope is files:write (NOT implied)', async () => {
      // Critical contract: files:write alone CANNOT restore. This is
      // the Kestrel M3 scope separation that lets hosts mint a
      // 'commenter' token without restore power.
      seedFile('doc-1', 'x')
      const token = mintToken(['files:write'])
      const { ctx, status } = makeCtx('/api/v1/files/doc-1/versions/v_anything/restore', 'POST', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(ctx)
      expect(status.code).toBe(403)
    })
  })

  describe('DELETE — scope files:restore', () => {
    it('removes a snapshot', async () => {
      seedFile('doc-1', 'x')
      const token = mintToken(['files:read', 'files:write', 'files:restore'])
      const post = makeCtx('/api/v1/files/doc-1/versions', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ label: 'doomed' }))
      await handleApiV1(post.ctx)
      const id = JSON.parse(post.body()).id

      const del = makeCtx(`/api/v1/files/doc-1/versions/${id}`, 'DELETE', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(del.ctx)
      expect(del.status.code).toBe(204)

      const list = makeCtx('/api/v1/files/doc-1/versions', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(list.ctx)
      expect(JSON.parse(list.body()).count).toBe(0)
    })

    it('returns 404 on unknown id', async () => {
      seedFile('doc-1', 'x')
      const token = mintToken(['files:restore'])
      const { ctx, status } = makeCtx('/api/v1/files/doc-1/versions/v_nope', 'DELETE', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(ctx)
      expect(status.code).toBe(404)
    })
  })
})

/**
 * v1 endpoints /api/v1/files/:id/comments[…] (sdk1.md §B.5.1 #4 Kestrel M2).
 *
 * Pins the wire-level contract of `apps/web-server/src/api/v1/comments.ts`:
 *
 *   1. GET    /api/v1/files/:id/comments         list (scope `files:read`)
 *   2. POST   /api/v1/files/:id/comments         add  (scope `files:comment`)
 *   3. GET    /api/v1/files/:id/comments/:cid    get one (scope `files:read`)
 *   4. PATCH  /api/v1/files/:id/comments/:cid    resolve toggle (scope `files:comment`)
 *   5. DELETE /api/v1/files/:id/comments/:cid    hard delete (scope `files:comment`)
 *
 * Plus the auth / scope-gate contract:
 *   - 401 UNAUTHENTICATED on missing JWT
 *   - 403 FORBIDDEN on wrong scope
 *   - 200 / 201 / 204 on success
 *   - 400 INVALID_ARGUMENT on bad input
 *   - 404 NOT_FOUND on unknown comment id
 *   - 500 INTERNAL on store failure (covered indirectly via smoke)
 *
 * Plus a contract that the author is stamped from the JWT sub (the
 * client-supplied author is never trusted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'comments-v1-test-secret'
})

const TMP = mkdtempSync(join(tmpdir(), 'comments-v1-'))
process.env.GENOFFICE_TEST_DATA_DIR = TMP
process.env.DATA_DIR = TMP
vi.stubEnv('DATA_DIR', TMP)

import { handleApiV1 } from '../src/api/v1'
import {
  _resetCommentsForTests,
} from '../src/common/comments-store'
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
  let body = bodyStr
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
      body = emitted
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
  // EventEmitter-shaped mock so `readBodyWithCap` (in
  // `apps/web-server/src/common/read-body.ts`) gets its 'data' + 'end'
  // notifications when a handler calls `readBody(request)`. Without
  // these, every POST hangs forever waiting for 'end'. We only emit
  // when the caller provided a body string — GET / DELETE / etc. get
  // an immediate 'end' with no chunks.
  const requestListeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const request = {
    method,
    url,
    headers: { host: 'localhost', ...headers },
    on: (ev: string, l: (...a: unknown[]) => void) => {
      (requestListeners[ev] ||= []).push(l)
      // Defer emission to the next microtask so the listener is
      // registered before the event fires. This matches Node's
      // IncomingMessage behavior (data events arrive asynchronously).
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
        // Remove from registry so we don't double-fire (some handlers
        // register both `on('end')` and `once('end')`).
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
    body: () => body,
    status,
  }
}

function mintToken(scope: string[], sub = 'commenter-1'): string {
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

beforeEach(() => {
  _resetCommentsForTests()
})

afterEach(() => {
  _resetCommentsForTests()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('v1 endpoint /api/v1/files/:id/comments[…] (Kestrel M2)', () => {
  describe('GET (list) — scope files:read', () => {
    it('returns 401 UNAUTHENTICATED on missing JWT', async () => {
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/comments', 'GET')
      const handled = await handleApiV1(ctx)
      expect(handled).toBe(true)
      expect(status.code).toBe(401)
      expect(getBody()).toContain('UNAUTHENTICATED')
    })

    it('returns 403 FORBIDDEN on wrong scope (files:write is not enough)', async () => {
      const token = mintToken(['files:write'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/comments', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(ctx)
      expect(status.code).toBe(403)
      expect(getBody()).toContain('FORBIDDEN')
    })

    it('returns empty list when no comments exist', async () => {
      const token = mintToken(['files:read'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/comments', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(ctx)
      expect(status.code).toBe(200)
      expect(JSON.parse(getBody())).toEqual({ fileId: 'doc-1', count: 0, comments: [] })
    })

    it('returns the comments with author stamped from JWT', async () => {
      const token = mintToken(['files:comment', 'files:read'])
      // Add a comment via POST so the author is taken from the JWT sub.
      const post = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: 'first' }))
      await handleApiV1(post.ctx)
      expect(post.status.code).toBe(201)

      // Then list it.
      const list = makeCtx('/api/v1/files/doc-1/comments', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(list.ctx)
      expect(list.status.code).toBe(200)
      const parsed = JSON.parse(list.body())
      expect(parsed.count).toBe(1)
      expect(parsed.comments[0].author).toBe('commenter-1')
      expect(parsed.comments[0].text).toBe('first')
      expect(parsed.comments[0].resolved).toBe(false)
    })
  })

  describe('POST (add) — scope files:comment', () => {
    it('returns 201 with the new comment', async () => {
      const token = mintToken(['files:comment'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A2' }, text: 'hello world' }))
      await handleApiV1(ctx)
      expect(status.code).toBe(201)
      const parsed = JSON.parse(getBody())
      expect(parsed.comment.author).toBe('commenter-1')
      expect(parsed.comment.text).toBe('hello world')
      expect(parsed.comment.anchor).toEqual({ cell: 'A2' })
      expect(parsed.comment.id).toMatch(/^cm_/)
    })

    it('ignores client-supplied author (trusts JWT sub)', async () => {
      const token = mintToken(['files:comment'])
      const { ctx, body: getBody } = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: 'spoof attempt', author: 'admin-evil' }))
      await handleApiV1(ctx)
      const parsed = JSON.parse(getBody())
      expect(parsed.comment.author).toBe('commenter-1')
      expect(parsed.comment.author).not.toBe('admin-evil')
    })

    it('returns 400 on missing anchor', async () => {
      const token = mintToken(['files:comment'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ text: 'no anchor here' }))
      await handleApiV1(ctx)
      expect(status.code).toBe(400)
      expect(getBody()).toContain('INVALID_ARGUMENT')
    })

    it('returns 400 on empty text', async () => {
      const token = mintToken(['files:comment'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: '' }))
      await handleApiV1(ctx)
      expect(status.code).toBe(400)
      expect(getBody()).toContain('INVALID_ARGUMENT')
    })

    it('returns 403 FORBIDDEN when scope is files:read only', async () => {
      const token = mintToken(['files:read'])
      const { ctx, status } = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: 'x' }))
      await handleApiV1(ctx)
      expect(status.code).toBe(403)
    })
  })

  describe('PATCH (resolve toggle)', () => {
    async function seedOne(): Promise<string> {
      const token = mintToken(['files:comment', 'files:read'])
      const post = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: 'to resolve' }))
      await handleApiV1(post.ctx)
      return JSON.parse(post.body()).comment.id
    }

    it('toggles resolved=true', async () => {
      const id = await seedOne()
      const token = mintToken(['files:comment'])
      const { ctx, status, body: getBody } = makeCtx(`/api/v1/files/doc-1/comments/${id}`, 'PATCH', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ resolved: true }))
      await handleApiV1(ctx)
      expect(status.code).toBe(200)
      const parsed = JSON.parse(getBody())
      expect(parsed.comment.resolved).toBe(true)
      expect(typeof parsed.comment.resolvedAt).toBe('number')
    })

    it('returns 404 on unknown id', async () => {
      const token = mintToken(['files:comment'])
      const { ctx, status, body: getBody } = makeCtx('/api/v1/files/doc-1/comments/cm_nope', 'PATCH', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ resolved: true }))
      await handleApiV1(ctx)
      expect(status.code).toBe(404)
      expect(getBody()).toContain('NOT_FOUND')
    })

    it('returns 400 on missing resolved field', async () => {
      const id = await seedOne()
      const token = mintToken(['files:comment'])
      const { ctx, status } = makeCtx(`/api/v1/files/doc-1/comments/${id}`, 'PATCH', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({}))
      await handleApiV1(ctx)
      expect(status.code).toBe(400)
    })
  })

  describe('DELETE', () => {
    it('returns 204 on success', async () => {
      const token = mintToken(['files:comment', 'files:read'])
      const post = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: 'bye' }))
      await handleApiV1(post.ctx)
      const id = JSON.parse(post.body()).comment.id

      const del = makeCtx(`/api/v1/files/doc-1/comments/${id}`, 'DELETE', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(del.ctx)
      expect(del.status.code).toBe(204)
    })

    it('returns 404 on unknown id (idempotent caller can retry safely)', async () => {
      const token = mintToken(['files:comment'])
      const del = makeCtx('/api/v1/files/doc-1/comments/cm_nope', 'DELETE', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(del.ctx)
      expect(del.status.code).toBe(404)
    })
  })

  describe('GET (single)', () => {
    it('returns the comment by id', async () => {
      const token = mintToken(['files:comment', 'files:read'])
      const post = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: 'single-get' }))
      await handleApiV1(post.ctx)
      const id = JSON.parse(post.body()).comment.id

      const get = makeCtx(`/api/v1/files/doc-1/comments/${id}`, 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(get.ctx)
      expect(get.status.code).toBe(200)
      const parsed = JSON.parse(get.body())
      expect(parsed.comment.id).toBe(id)
      expect(parsed.comment.text).toBe('single-get')
    })

    it('returns 404 on unknown id', async () => {
      const token = mintToken(['files:read'])
      const get = makeCtx('/api/v1/files/doc-1/comments/cm_nope', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(get.ctx)
      expect(get.status.code).toBe(404)
    })
  })

  describe('end-to-end: list with resolved filter', () => {
    it('returns only resolved comments when ?resolved=true', async () => {
      const token = mintToken(['files:comment', 'files:read'])
      // Seed two: one open, one resolved.
      const post1 = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A1' }, text: 'open' }))
      await handleApiV1(post1.ctx)
      const id1 = JSON.parse(post1.body()).comment.id
      const post2 = makeCtx('/api/v1/files/doc-1/comments', 'POST', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ anchor: { cell: 'A2' }, text: 'closed' }))
      await handleApiV1(post2.ctx)
      const id2 = JSON.parse(post2.body()).comment.id
      // Only resolve the SECOND comment; id1 stays open.
      const patch = makeCtx(`/api/v1/files/doc-1/comments/${id2}`, 'PATCH', {
        authorization: `Bearer ${token}`,
      }, JSON.stringify({ resolved: true }))
      await handleApiV1(patch.ctx)

      const list = makeCtx('/api/v1/files/doc-1/comments?resolved=true', 'GET', {
        authorization: `Bearer ${token}`,
      })
      await handleApiV1(list.ctx)
      expect(list.status.code).toBe(200)
      const parsed = JSON.parse(list.body())
      expect(parsed.count).toBe(1)
      expect(parsed.comments[0].id).toBe(id2)
    })
  })
})

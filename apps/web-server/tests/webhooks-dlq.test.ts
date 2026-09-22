/**
 * Webhook dead-letter queue (sdk1.md §11.33).
 *
 * Tests pin three contracts:
 *
 *   1. `webhooks-dlq.ts` module: ring-buffer store (add / get / list /
 *      remove / LRU eviction / clear); `replayDeadLetter()` returns the
 *      correct shape for delivered / still-failing / unknown-id cases.
 *
 *   2. `webhooks-store.ts:notifyFileSaved` integration: a save that
 *      triggers a webhook to a 500-only target drops into the DLQ after
 *      maxAttempts retries are exhausted.
 *
 *   3. v1 endpoint `/api/v1/webhooks/dlq[…]`: scope gate, list with
 *      limit, get one, replay, delete, error envelopes for unknown ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Set env BEFORE importing modules that read process.env at module init.
vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'webhooks-dlq-test-secret'
})

const TMP = mkdtempSync(join(tmpdir(), 'webhooks-dlq-'))
process.env.GENOFFICE_TEST_DATA_DIR = TMP
process.env.DATA_DIR = TMP
vi.stubEnv('DATA_DIR', TMP)

import {
  _resetDeadLetterForTests,
  _resetDeadLetterMetricsForTests,
  deleteDeadLetter,
  getDeadLetter,
  getDeadLetterMetrics,
  listDeadLetters,
  pushDeadLetter,
  replayDeadLetter,
} from '../src/common/webhooks-dlq'
import { saveCallback, notifyFileSaved } from '../src/common/webhooks-store'
import { handleApiV1 } from '../src/api/v1/index'
import { signJwt } from '../src/api/v1/auth'
import type { IncomingMessage, ServerResponse } from 'node:http'

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  _resetDeadLetterForTests()
})

function makeCtx(url: string, method: string, headers: Record<string, string> = {}): {
  ctx: Parameters<typeof handleApiV1>[0]
  body(): string
  status: { code: number }
} {
  let body = ''
  const status = { code: 0 }
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    getHeader: () => undefined,
    removeHeader: () => undefined,
    write: (chunk: string) => {
      body += chunk
      return true
    },
    end: (chunk?: string) => {
      if (chunk) body += chunk
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
  const request = {
    method,
    url,
    headers: { host: 'localhost', ...headers },
    on: () => request,
    once: () => request,
    emit: () => true,
  } as unknown as IncomingMessage
  return {
    ctx: { request, response, pathname: new URL(url, 'http://localhost').pathname, method },
    body: () => body,
    status,
  }
}

function readJson(chunks: string[]): unknown {
  return JSON.parse(body())
}

function mintToken(scope: string[]): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: 'tester',
    scope,
    iat: now,
    exp: now + 60,
    iss: 'genoffice',
    aud: 'genoffice-web',
  })
}

describe('webhooks-dlq store (sdk1.md §11.33)', () => {
  it('round-trips add → get → list → remove', () => {
    const id = pushDeadLetter({
      url: 'https://hook.test/a',
      event: 'file.saved',
      fileId: 'a.txt',
      body: '{"v":"1.0"}',
      attempts: 3,
      lastStatus: 503,
      lastError: null,
      reason: 'max_attempts',
    })
    expect(getDeadLetter(id)?.url).toBe('https://hook.test/a')
    const listed = listDeadLetters()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(id)
    expect(deleteDeadLetter(id)).toBe(true)
    expect(getDeadLetter(id)).toBeNull()
    expect(listDeadLetters()).toHaveLength(0)
  })

  it('returns false when removing an unknown id', () => {
    expect(deleteDeadLetter('never-inserted')).toBe(false)
  })

  it('newest-first listing order', () => {
    const id1 = pushDeadLetter({
      url: 'https://a', event: 'file.saved', fileId: 'a', body: '', attempts: 3,
      lastStatus: 500, lastError: null, reason: 'max_attempts',
    })
    const id2 = pushDeadLetter({
      url: 'https://b', event: 'file.saved', fileId: 'b', body: '', attempts: 3,
      lastStatus: 502, lastError: null, reason: 'max_attempts',
    })
    const listed = listDeadLetters()
    expect(listed.map((e) => e.id)).toEqual([id2, id1])
  })

  it('list limit caps returned slice', () => {
    for (let i = 0; i < 10; i++) {
      pushDeadLetter({
        url: `https://h/${i}`, event: 'file.saved', fileId: `f${i}`, body: '', attempts: 3,
        lastStatus: 500, lastError: null, reason: 'max_attempts',
      })
    }
    expect(listDeadLetters()).toHaveLength(10)
    expect(listDeadLetters({ limit: 3 })).toHaveLength(3)
    expect(listDeadLetters({ limit: 9999 })).toHaveLength(10)
  })

  it('LRU eviction kicks in past 1024 entries', () => {
    const ids: string[] = []
    for (let i = 0; i < 1025; i++) {
      ids.push(pushDeadLetter({
        url: `https://h/${i}`, event: 'file.saved', fileId: `f${i}`, body: '', attempts: 3,
        lastStatus: 500, lastError: null, reason: 'max_attempts',
      }))
    }
    // Internal size is bounded; first id evicted; newest retained.
    expect(getDeadLetter(ids[0]!)).toBeNull()
    expect(getDeadLetter(ids[1024]!)).not.toBeNull()
    expect(listDeadLetters({ limit: 1024 })).toHaveLength(1024)
  })

  it('reason distinguishes max_attempts vs non_retryable_4xx', () => {
    const max = pushDeadLetter({
      url: 'https://h', event: 'file.saved', fileId: 'f', body: '', attempts: 3,
      lastStatus: 503, lastError: null, reason: 'max_attempts',
    })
    const non4xx = pushDeadLetter({
      url: 'https://h', event: 'file.saved', fileId: 'f', body: '', attempts: 1,
      lastStatus: 401, lastError: null, reason: 'non_retryable_4xx',
    })
    expect(getDeadLetter(max)?.reason).toBe('max_attempts')
    expect(getDeadLetter(non4xx)?.reason).toBe('non_retryable_4xx')
  })
})

describe('replayDeadLetter (sdk1.md §11.33)', () => {
  it('returns ok:false reason:unknown_id for missing entries', async () => {
    const result = await replayDeadLetter('nope')
    expect(result).toEqual({ ok: false, reason: 'unknown_id' })
  })

  it('removes the entry on successful replay', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const id = pushDeadLetter({
      url: 'https://hook.test/replay-ok',
      event: 'file.saved', fileId: 'f', body: '{"v":"1.0"}', attempts: 3,
      lastStatus: 503, lastError: null, reason: 'max_attempts',
    })
    const result = await replayDeadLetter(id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.removed).toBe(true)
      expect(result.result.delivered).toBe(true)
    }
    expect(getDeadLetter(id)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the entry (with updated lastError) on failed replay', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const id = pushDeadLetter({
      url: 'https://hook.test/replay-fail',
      event: 'file.saved', fileId: 'f', body: '{"v":"1.0"}', attempts: 3,
      lastStatus: 502, lastError: 'old error', reason: 'max_attempts',
    })
    const result = await replayDeadLetter(id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.removed).toBe(false)
      expect(result.result.delivered).toBe(false)
      if (!result.removed) {
        expect(result.entry.attempts).toBe(4)
        expect(result.entry.lastStatus).toBe(503)
        expect(result.entry.lastError).toBeTruthy()
      }
    }
    expect(getDeadLetter(id)).not.toBeNull()
  })

  it('handles fetch throwing (network error during replay)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    vi.stubGlobal('fetch', fetchMock)
    const id = pushDeadLetter({
      url: 'https://hook.test/network',
      event: 'file.saved', fileId: 'f', body: '{}', attempts: 3,
      lastStatus: null, lastError: null, reason: 'max_attempts',
    })
    const result = await replayDeadLetter(id)
    expect(result.ok).toBe(true)
    if (result.ok && !result.removed) {
      expect(result.entry.lastError).toBe('ECONNRESET')
    }
  })
})

describe('notifyFileSaved → DLQ integration (sdk1.md §11.33)', () => {
  it('drops a failed delivery into the DLQ after retries exhaust', async () => {
    saveCallback({
      fileId: 'foo.md',
      url: 'https://hook.test/dead',
      events: ['file.saved'],
    })
    // 429 is retryable; fireCallback will retry 3 times with exponential
    // backoff (0..250ms + 0..500ms + 0..1000ms worst case ≈ 1.75s). We
    // monkey-patch the backoff calculation by stubbing setTimeout to
    // resolve immediately so the test doesn't have to wait the full
    // window. The actual retry logic is what we care about here.
    const realSetTimeout = globalThis.setTimeout
    const setTimeoutStub = ((cb: (...a: unknown[]) => void, _ms?: number, ...rest: unknown[]) =>
      realSetTimeout(cb, 0, ...rest)) as unknown as typeof setTimeout
    vi.stubGlobal('setTimeout', setTimeoutStub)
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      notifyFileSaved('/tmp/foo.md', { size: 12 })
      // The wrapper awaits fireCallback then pushes to DLQ. With backoff
      // shimmed to 0 ms, the whole chain resolves within tens of ms.
      await new Promise((r) => realSetTimeout(r, 100))
    } finally {
      vi.unstubAllGlobals()
    }
    const listed = listDeadLetters()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.url).toBe('https://hook.test/dead')
    expect(listed[0]!.reason).toBe('max_attempts')
    expect(listed[0]!.attempts).toBeGreaterThanOrEqual(1)
  })

  it('does NOT drop a successful delivery', async () => {
    saveCallback({
      fileId: 'bar.md',
      url: 'https://hook.test/ok',
      events: ['file.saved'],
    })
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    notifyFileSaved('/tmp/bar.md', {})
    await new Promise((r) => setTimeout(r, 250))
    expect(listDeadLetters()).toHaveLength(0)
  })

  it('drops a non-retryable 4xx (caller-fault, reason=non_retryable_4xx)', async () => {
    saveCallback({
      fileId: 'baz.md',
      url: 'https://hook.test/badreq',
      events: ['file.saved'],
    })
    const fetchMock = vi.fn(async () => new Response('nope', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    notifyFileSaved('/tmp/baz.md', {})
    await new Promise((r) => setTimeout(r, 30))
    // 400 is non-retryable: fireCallback does not retry but the entry is
    // still persisted so the operator can see caller-fault 4xx (bad
    // URL / auth / payload) instead of silently dropping it.
    const listed = listDeadLetters()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.reason).toBe('non_retryable_4xx')
    expect(listed[0]!.lastStatus).toBe(400)
  })
})

describe('v1 endpoint /api/v1/webhooks/dlq (sdk1.md §11.33)', () => {
  let token: string
  beforeEach(() => {
    token = mintToken(['webhooks:manage'])
  })

  it('GET /api/v1/webhooks/dlq with no entries returns empty list', async () => {
    const { ctx, status, body: getBody } = makeCtx('/api/v1/webhooks/dlq', 'GET', { authorization: `Bearer ${token}` })
    const handled = await handleApiV1(ctx)
    expect(handled).toBe(true)
    expect(status.code).toBe(200)
    const body = JSON.parse(getBody()) as { count: number; entries: Array<{ url: string }>; limit: number }
    expect(body.count).toBe(0)
  })

  it('GET /api/v1/webhooks/dlq returns DLQ entries', async () => {
    pushDeadLetter({
      url: 'https://h/x', event: 'file.saved', fileId: 'x', body: '{}', attempts: 3,
      lastStatus: 500, lastError: null, reason: 'max_attempts',
    })
    const { ctx, status, body: getBody } = makeCtx('/api/v1/webhooks/dlq', 'GET', { authorization: `Bearer ${token}` })
    const handled = await handleApiV1(ctx)
    expect(handled).toBe(true)
    expect(status.code).toBe(200)
    const body = JSON.parse(getBody())
    expect(body.count).toBe(1)
    expect(body.entries[0].url).toBe('https://h/x')
  })

  it('rejects request without Bearer token (401)', async () => {
    const { ctx, status } = makeCtx('/api/v1/webhooks/dlq', 'GET')
    await handleApiV1(ctx)
    expect(status.code).toBe(401)
  })

  it('rejects request with wrong scope (403)', async () => {
    const noManage = mintToken(['files:read'])
    const { ctx, status } = makeCtx('/api/v1/webhooks/dlq', 'GET', { authorization: `Bearer ${noManage}` })
    await handleApiV1(ctx)
    expect(status.code).toBe(403)
  })

  it('GET /api/v1/webhooks/dlq/:id returns single entry', async () => {
    const id = pushDeadLetter({
      url: 'https://h/single', event: 'file.saved', fileId: 's', body: '{}', attempts: 3,
      lastStatus: 500, lastError: 'prev', reason: 'max_attempts',
    })
    const { ctx, status, body: getBody } = makeCtx(`/api/v1/webhooks/dlq/${id}`, 'GET', { authorization: `Bearer ${token}` })
    await handleApiV1(ctx)
    expect(status.code).toBe(200)
    const body = JSON.parse(getBody())
    expect(body.id).toBe(id)
    expect(body.url).toBe('https://h/single')
  })

  it('GET /api/v1/webhooks/dlq/:id with unknown id → 404', async () => {
    const { ctx, status } = makeCtx('/api/v1/webhooks/dlq/missing', 'GET', { authorization: `Bearer ${token}` })
    await handleApiV1(ctx)
    expect(status.code).toBe(404)
  })

  it('DELETE /api/v1/webhooks/dlq/:id removes the entry', async () => {
    const id = pushDeadLetter({
      url: 'https://h/del', event: 'file.saved', fileId: 'd', body: '{}', attempts: 3,
      lastStatus: 500, lastError: null, reason: 'max_attempts',
    })
    const { ctx, status, body: getBody } = makeCtx(`/api/v1/webhooks/dlq/${id}`, 'DELETE', { authorization: `Bearer ${token}` })
    await handleApiV1(ctx)
    expect(status.code).toBe(200)
    expect(JSON.parse(getBody())).toEqual({ deleted: true, id })
    expect(getDeadLetter(id)).toBeNull()
  })

  it('POST /api/v1/webhooks/dlq/:id/replay re-delivers and removes on 2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const id = pushDeadLetter({
      url: 'https://hook.test/replay', event: 'file.saved', fileId: 'f', body: '{}', attempts: 3,
      lastStatus: 500, lastError: null, reason: 'max_attempts',
    })
    const { ctx, status, body: getBody } = makeCtx(`/api/v1/webhooks/dlq/${id}/replay`, 'POST', { authorization: `Bearer ${token}` })
    await handleApiV1(ctx)
    // replayDeadLetter is async inside the endpoint; wait for fetch to fire.
    await new Promise((r) => setTimeout(r, 250))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getDeadLetter(id)).toBeNull()
    expect(status.code).toBe(200)
    const body = JSON.parse(getBody())
    expect(body.delivered).toBe(true)
    expect(body.removed).toBe(true)
  })

  it('rejects malformed limit (400)', async () => {
    const { ctx, status } = makeCtx('/api/v1/webhooks/dlq?limit=abc', 'GET', { authorization: `Bearer ${token}` })
    await handleApiV1(ctx)
    expect(status.code).toBe(400)
  })

  it('caps limit at 200 even if client requests more', async () => {
    for (let i = 0; i < 5; i++) {
      pushDeadLetter({
        url: `https://h/${i}`, event: 'file.saved', fileId: `f${i}`, body: '{}', attempts: 3,
        lastStatus: 500, lastError: null, reason: 'max_attempts',
      })
    }
    const { ctx, status, body: getBody } = makeCtx('/api/v1/webhooks/dlq?limit=9999', 'GET', { authorization: `Bearer ${token}` })
    await handleApiV1(ctx)
    expect(status.code).toBe(200)
    const body = JSON.parse(getBody())
    expect(body.limit).toBe(200)
    expect(body.entries).toHaveLength(5)
  })
})


describe('getDeadLetterMetrics (sdk1.md §11.35)', () => {
  it('reports size, totals, byReason breakdown', () => {
    _resetDeadLetterForTests()
    pushDeadLetter({
      url: 'a', event: 'file.saved', fileId: '1', body: '{}', attempts: 3,
      lastStatus: 503, lastError: null, reason: 'max_attempts',
    })
    pushDeadLetter({
      url: 'b', event: 'file.saved', fileId: '2', body: '{}', attempts: 1,
      lastStatus: 400, lastError: null, reason: 'non_retryable_4xx',
    })
    pushDeadLetter({
      url: 'c', event: 'file.saved', fileId: '3', body: '{}', attempts: 3,
      lastStatus: 502, lastError: null, reason: 'max_attempts',
    })
    const m = getDeadLetterMetrics()
    expect(m.size).toBe(3)
    expect(m.totalDropped).toBe(3)
    expect(m.totalReplayed).toBe(0)
    expect(m.byReason).toEqual({ max_attempts: 2, non_retryable_4xx: 1 })
    expect(typeof m.oldestDroppedAt).toBe('number')
    expect(typeof m.newestDroppedAt).toBe('number')
    expect(m.newestDroppedAt!).toBeGreaterThanOrEqual(m.oldestDroppedAt!)
  })

  it('reports oldestDroppedAt/newestDroppedAt as null when empty', () => {
    _resetDeadLetterForTests()
    const m = getDeadLetterMetrics()
    expect(m.size).toBe(0)
    expect(m.totalDropped).toBe(0)
    expect(m.oldestDroppedAt).toBeNull()
    expect(m.newestDroppedAt).toBeNull()
  })

  it('totalReplayed increments only on successful replay', async () => {
    _resetDeadLetterForTests()
    const fetchOk = vi.fn(async () => new Response('ok', { status: 200 }))
    const fetchFail = vi.fn(async () => new Response('boom', { status: 503 }))
    vi.stubGlobal('fetch', fetchOk)
    const id1 = pushDeadLetter({
      url: 'https://h/ok', event: 'file.saved', fileId: 'f', body: '{}', attempts: 3,
      lastStatus: 503, lastError: null, reason: 'max_attempts',
    })
    await replayDeadLetter(id1)
    expect(getDeadLetterMetrics().totalReplayed).toBe(1)

    vi.stubGlobal('fetch', fetchFail)
    const id2 = pushDeadLetter({
      url: 'https://h/fail', event: 'file.saved', fileId: 'f', body: '{}', attempts: 3,
      lastStatus: 503, lastError: null, reason: 'max_attempts',
    })
    await replayDeadLetter(id2)
    // Still 1 — failed replay does NOT bump totalReplayed.
    expect(getDeadLetterMetrics().totalReplayed).toBe(1)
    vi.unstubAllGlobals()
  })

  it('totalDropped does NOT decrement on delete (monotonic)', () => {
    _resetDeadLetterForTests()
    const id = pushDeadLetter({
      url: 'https://h', event: 'file.saved', fileId: 'f', body: '{}', attempts: 3,
      lastStatus: 500, lastError: null, reason: 'max_attempts',
    })
    expect(getDeadLetterMetrics().totalDropped).toBe(1)
    deleteDeadLetter(id)
    expect(getDeadLetterMetrics().totalDropped).toBe(1)
    expect(getDeadLetterMetrics().size).toBe(0)
  })

  it('LRU eviction decrements size but NOT totalDropped', () => {
    _resetDeadLetterForTests()
    const ids: string[] = []
    for (let i = 0; i < 1025; i++) {
      ids.push(pushDeadLetter({
        url: `https://h/${i}`, event: 'file.saved', fileId: `f${i}`, body: '{}', attempts: 3,
        lastStatus: 500, lastError: null, reason: 'max_attempts',
      }))
    }
    const m = getDeadLetterMetrics()
    expect(m.size).toBe(1024)
    expect(m.totalDropped).toBe(1025)
  })
})

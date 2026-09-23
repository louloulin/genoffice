/**
 * Webhook DELETE purges DLQ entries for that URL (sdk1.md §11.33.4).
 *
 * Closes the §11.33.4 backlog item: when a webhook subscription is
 * removed via DELETE /api/v1/webhooks, every DLQ entry whose target
 * matched that webhook URL becomes a stale dead letter with no valid
 * receiver. Replays would hit a now-defunct URL; leaving them around
 * just fills the ring buffer with entries the host can never act on.
 *
 * The DELETE endpoint now:
 *   1. captures the URL of the user-wide subscription before deletion
 *   2. removes the subscription via `deleteCallbackForUser`
 *   3. calls `purgeDeadLettersForUrl(url)` to drop every DLQ entry
 *      whose `url` matches
 *   4. surfaces the purge count in the response (`dlqPurged`)
 *
 * Behaviour pinned:
 *   - matching URL → all entries purged, ids returned
 *   - non-matching URLs → untouched
 *   - idempotent: second DELETE on same sub returns `removed: false,
 *     dlqPurged: { removed: 0, ids: [] }` (no double-purge)
 *   - unit: `purgeDeadLettersForUrl('') → { removed: 0, ids: [] }`
 *     (defensive — empty url is a no-op, not a "purge everything")
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'webhook-delete-purges-dlq-'))
  vi.stubEnv('GENOFFICE_JWT_SECRET', 'webhook-delete-purges-dlq-secret')
  vi.stubEnv('GENOFFICE_TEST_DATA_DIR', TMP)
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadDlq() {
  return await import('../src/common/webhooks-dlq')
}
async function loadStore() {
  return await import('../src/common/webhooks-store')
}
async function loadApi() {
  return await import('../src/api/v1/index')
}
async function loadAuth() {
  return await import('../src/api/v1/auth')
}

describe('purgeDeadLettersForUrl (sdk1.md §11.33.4)', () => {
  it('drops every entry whose url matches, returns removed count and ids', async () => {
    const { pushDeadLetter, purgeDeadLettersForUrl, listDeadLetters } = await loadDlq()
    const a1 = pushDeadLetter({
      url: 'https://hook.test/x',
      event: 'file.saved',
      fileId: 'a',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    const a2 = pushDeadLetter({
      url: 'https://hook.test/x',
      event: 'file.saved',
      fileId: 'b',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    // Different URL — must not be touched.
    pushDeadLetter({
      url: 'https://hook.test/y',
      event: 'file.saved',
      fileId: 'c',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    expect(listDeadLetters()).toHaveLength(3)
    const result = purgeDeadLettersForUrl('https://hook.test/x')
    expect(result.removed).toBe(2)
    expect(result.ids.sort()).toEqual([a1, a2].sort())
    const remaining = listDeadLetters()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.url).toBe('https://hook.test/y')
  })

  it('empty url is a defensive no-op (does NOT purge everything)', async () => {
    const { pushDeadLetter, purgeDeadLettersForUrl, listDeadLetters } = await loadDlq()
    pushDeadLetter({
      url: 'https://hook.test/x',
      event: 'file.saved',
      fileId: 'a',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    pushDeadLetter({
      url: 'https://hook.test/y',
      event: 'file.saved',
      fileId: 'b',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    const result = purgeDeadLettersForUrl('')
    expect(result).toEqual({ removed: 0, ids: [] })
    expect(listDeadLetters()).toHaveLength(2)
  })

  it('unknown url returns { removed: 0, ids: [] } and leaves DLQ untouched', async () => {
    const { pushDeadLetter, purgeDeadLettersForUrl, listDeadLetters } = await loadDlq()
    pushDeadLetter({
      url: 'https://hook.test/x',
      event: 'file.saved',
      fileId: 'a',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    const result = purgeDeadLettersForUrl('https://hook.test/none')
    expect(result).toEqual({ removed: 0, ids: [] })
    expect(listDeadLetters()).toHaveLength(1)
  })

  it('match is exact-string on url (path / query / case sensitive)', async () => {
    const { pushDeadLetter, purgeDeadLettersForUrl } = await loadDlq()
    pushDeadLetter({
      url: 'https://hook.test/x',
      event: 'file.saved',
      fileId: 'a',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    // Trailing slash is NOT a match — we refuse to guess URL canonicalization
    // rules; the host owns the URL it registered with.
    expect(purgeDeadLettersForUrl('https://hook.test/x/')).toEqual({ removed: 0, ids: [] })
    expect(purgeDeadLettersForUrl('HTTPS://hook.test/x')).toEqual({ removed: 0, ids: [] })
    expect(purgeDeadLettersForUrl('https://hook.test/x?foo=1')).toEqual({ removed: 0, ids: [] })
    expect(purgeDeadLettersForUrl('https://hook.test/x')).toEqual({ removed: 1, ids: expect.any(Array) })
  })
})

describe('DELETE /api/v1/webhooks purges DLQ entries for that URL (sdk1.md §11.33.4)', () => {
  function makeCtx(url: string, method: string, headers: Record<string, string> = {}): {
    ctx: Awaited<ReturnType<typeof import('../src/api/v1/index')>['handleApiV1']> extends (c: infer C) => unknown ? C : never
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
      writeHead: (code: number) => {
        status.code = code
        return response
      },
      on: () => response,
      once: () => response,
      emit: () => true,
    } as unknown as import('node:http').ServerResponse
    const request = {
      method,
      url,
      headers: { host: 'localhost', ...headers },
      on: () => request,
      once: () => request,
      emit: () => true,
    } as unknown as import('node:http').IncomingMessage
    return {
      ctx: {
        request,
        response,
        pathname: new URL(url, 'http://localhost').pathname,
        method,
      },
      body: () => body,
      status,
    }
  }

  async function mintToken(scope: string[]): Promise<string> {
    const { signJwt } = await loadAuth()
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

  it('returns dlqPurged.removed > 0 when DLQ entries exist for that URL', async () => {
    const { handleApiV1 } = await loadApi()
    const { saveCallbackForUser } = await loadStore()
    const { pushDeadLetter, listDeadLetters } = await loadDlq()
    saveCallbackForUser('tester', {
      url: 'https://hook.test/alice',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    pushDeadLetter({
      url: 'https://hook.test/alice',
      event: 'file.saved',
      fileId: 'doc-1',
      body: '{"v":"1.0","event":"file.saved"}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    pushDeadLetter({
      url: 'https://hook.test/alice',
      event: 'file.saved',
      fileId: 'doc-2',
      body: '{"v":"1.0","event":"file.saved"}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    expect(listDeadLetters()).toHaveLength(2)
    const token = await mintToken(['webhooks:manage'])
    const { ctx, status, body } = makeCtx('/api/v1/webhooks', 'DELETE', {
      authorization: `Bearer ${token}`,
    })
    await handleApiV1(ctx)
    expect(status.code).toBe(200)
    const payload = JSON.parse(body()) as {
      ok: boolean
      removed: boolean
      dlqPurged: { removed: number; ids: string[] }
    }
    expect(payload.ok).toBe(true)
    expect(payload.removed).toBe(true)
    expect(payload.dlqPurged.removed).toBe(2)
    expect(payload.dlqPurged.ids).toHaveLength(2)
    expect(listDeadLetters()).toHaveLength(0)
  })

  it('returns dlqPurged.removed = 0 when DLQ has no entries for that URL', async () => {
    const { handleApiV1 } = await loadApi()
    const { saveCallbackForUser } = await loadStore()
    const { pushDeadLetter, listDeadLetters } = await loadDlq()
    saveCallbackForUser('tester', {
      url: 'https://hook.test/alice',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    // DLQ has entries for a DIFFERENT URL — must be preserved.
    pushDeadLetter({
      url: 'https://hook.test/other',
      event: 'file.saved',
      fileId: 'doc-x',
      body: '{"v":"1.0"}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    const token = await mintToken(['webhooks:manage'])
    const { ctx, status, body } = makeCtx('/api/v1/webhooks', 'DELETE', {
      authorization: `Bearer ${token}`,
    })
    await handleApiV1(ctx)
    expect(status.code).toBe(200)
    const payload = JSON.parse(body()) as {
      removed: boolean
      dlqPurged: { removed: number; ids: string[] }
    }
    expect(payload.removed).toBe(true)
    expect(payload.dlqPurged).toEqual({ removed: 0, ids: [] })
    expect(listDeadLetters()).toHaveLength(1)
  })

  it('second DELETE on the same user is a no-op (no double-purge)', async () => {
    const { handleApiV1 } = await loadApi()
    const { saveCallbackForUser } = await loadStore()
    const { pushDeadLetter, listDeadLetters } = await loadDlq()
    saveCallbackForUser('tester', {
      url: 'https://hook.test/alice',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    pushDeadLetter({
      url: 'https://hook.test/alice',
      event: 'file.saved',
      fileId: 'doc',
      body: '{}',
      attempts: 3,
      lastStatus: 500,
      lastError: null,
      reason: 'max_attempts',
    })
    const token = await mintToken(['webhooks:manage'])
    // First DELETE — removes subscription + purges DLQ.
    const first = makeCtx('/api/v1/webhooks', 'DELETE', {
      authorization: `Bearer ${token}`,
    })
    await handleApiV1(first.ctx)
    expect(JSON.parse(first.body()).dlqPurged.removed).toBe(1)
    expect(listDeadLetters()).toHaveLength(0)
    // Re-register so the second DELETE has something to "remove" — and the
    // purge still must report 0 because the DLQ is already empty.
    saveCallbackForUser('tester', {
      url: 'https://hook.test/alice',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    const second = makeCtx('/api/v1/webhooks', 'DELETE', {
      authorization: `Bearer ${token}`,
    })
    await handleApiV1(second.ctx)
    const payload = JSON.parse(second.body()) as {
      removed: boolean
      dlqPurged: { removed: number; ids: string[] }
    }
    expect(payload.removed).toBe(true)
    expect(payload.dlqPurged.removed).toBe(0)
  })

  it('DELETE on a non-existent subscription returns removed:false, dlqPurged 0', async () => {
    const { handleApiV1 } = await loadApi()
    const token = await mintToken(['webhooks:manage'])
    const { ctx, status, body } = makeCtx('/api/v1/webhooks', 'DELETE', {
      authorization: `Bearer ${token}`,
    })
    await handleApiV1(ctx)
    expect(status.code).toBe(200)
    const payload = JSON.parse(body()) as {
      removed: boolean
      dlqPurged: { removed: number; ids: string[] }
    }
    expect(payload.removed).toBe(false)
    expect(payload.dlqPurged).toEqual({ removed: 0, ids: [] })
  })
})

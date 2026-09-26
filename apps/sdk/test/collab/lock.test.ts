/**
 * CollabLockClient — acquire / release / inspect the editor lock for a doc.
 *
 * Lock-acquire is conflict-aware: if another user already holds the lock,
 * the server returns { ok: false, error: 'already locked by …' } with HTTP
 * 409. The SDK surfaces that as `RequestError { code: 'CONFLICT' }` so
 * callers can render a "Bob is editing — try again" hint.
 */
import { describe, expect, it } from 'vitest'
import { CollabLockClient } from '../../src/collab/lock'
import { ipcResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

describe('CollabLockClient constructor', () => {
  it('rejects missing baseUrl', () => {
    expect(() => new CollabLockClient({ baseUrl: '' })).toThrow(TypeError)
  })
})

describe('CollabLockClient.acquire', () => {
  it('POSTs to /api/ipc/collab:lock-acquire and returns status payload', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      ipcResponse({ ok: true, lockKey: 'doc-1:document', acquiredAt: 1700000000 }),
    )
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.acquire({ docId: 'doc-1', userId: 'u1' })
    expect(r).toMatchObject({ ok: true, lockKey: 'doc-1:document', acquiredAt: 1700000000 })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/ipc/collab:lock-acquire')
    expect(JSON.parse(calls[0].body!)).toEqual({
      args: [{ docId: 'doc-1', userId: 'u1' }],
    })
  })

  it('forwards optional sectionId', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      ipcResponse({ ok: true, lockKey: 'doc-1:header', acquiredAt: 1700000000 }),
    )
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await c.acquire({ docId: 'doc-1', userId: 'u1', sectionId: 'header' })
    expect(JSON.parse(calls[0].body!)).toEqual({
      args: [{ docId: 'doc-1', userId: 'u1', sectionId: 'header' }],
    })
  })

  it('a held section surfaces as RequestError code CONFLICT', async () => {
    // The dispatcher answers 200; the conflict lives in the handler's
    // return value as `{ ok: false, error, lockedBy, lockedUntil }`.
    const { fetchImpl, calls } = makeMockFetch(() =>
      ipcResponse({
        ok: false,
        error: 'Section is locked',
        lockedBy: 'u2',
        lockedUntil: 1700000030,
      }),
    )
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.acquire({ docId: 'doc-1', userId: 'u1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'Section is locked',
    })
    expect(calls).toHaveLength(1)
  })

  it('an unknown doc surfaces as NOT_FOUND', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse({ ok: false, error: 'Session not found' }),
    )
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.acquire({ docId: 'missing', userId: 'u1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.acquire({ docId: '', userId: 'u1' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects missing userId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.acquire({ docId: 'd', userId: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('CollabLockClient.release', () => {
  it('POSTs to /api/ipc/collab:lock-release and returns { ok: true }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({ ok: true }))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.release({ docId: 'doc-1', userId: 'u1' })
    expect(r).toEqual({ ok: true })
    expect(calls[0].url).toBe('https://x.test/api/ipc/collab:lock-release')
    expect(JSON.parse(calls[0].body!)).toEqual({
      args: [{ docId: 'doc-1', userId: 'u1' }],
    })
  })

  it('NOT_FOUND when the session does not exist', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse({ ok: false, error: 'Session not found' }),
    )
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.release({ docId: 'doc-1', userId: 'u1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.release({ docId: '', userId: 'u1' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('CollabLockClient.status', () => {
  it('POSTs to /api/ipc/collab:lock-status and returns holder info', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      ipcResponse({
        locks: [
          { sectionId: 'document', userId: 'u2', timestamp: 1700000000, expired: false },
        ],
      }),
    )
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.status('doc-1')
    expect(r.locks).toHaveLength(1)
    expect(r.locks[0]).toMatchObject({ sectionId: 'document', userId: 'u2', expired: false })
    expect(calls[0].url).toBe('https://x.test/api/ipc/collab:lock-status')
    expect(JSON.parse(calls[0].body!)).toEqual({
      args: [{ docId: 'doc-1', sectionId: undefined }],
    })
  })

  it('returns empty locks array when doc is unlocked', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse({ locks: [] }))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.status('doc-1')
    expect(r.locks).toEqual([])
  })

  it('returns empty array when the result carries no locks', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.status('doc-1')
    expect(r.locks).toEqual([])
  })

  it('reads locks out of result, not the envelope (regression)', async () => {
    // Pre-fix, the client looked for `raw.locks` on the envelope, which never
    // has one — so a busy document always reported "unlocked".
    const busy = { sectionId: 'document', userId: 'u2', timestamp: 1700000000, expired: false }
    const { fetchImpl } = makeMockFetch(() => ipcResponse({ locks: [busy] }))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.status('doc-1')).resolves.toEqual({ locks: [busy] })
  })

  it('throws when the envelope is missing rather than reporting "unlocked"', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ locks: [] }))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.status('doc-1')).rejects.toMatchObject({
      code: 'UNKNOWN',
      channel: 'collab:lock-status',
    })
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabLockClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.status('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})
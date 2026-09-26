/**
 * CollabPresenceClient — who's currently in the document.
 *
 * Mirrors cursor's poll-then-emit pattern. Presence lists return one entry
 * per (docId, userId) with a `lastSeen` ms timestamp that the server prunes
 * when it falls past 60s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollabPresenceClient } from '../../src/collab/presence'
import { ipcResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

const PRES_A = {
  userId: 'u1',
  userName: 'Alice',
  status: 'active',
  lastSeen: 1700000000,
  color: '#ff0000',
}
const PRES_B = {
  userId: 'u2',
  userName: 'Bob',
  status: 'idle',
  lastSeen: 1700000050,
  color: '#00ff00',
}

describe('CollabPresenceClient constructor', () => {
  it('rejects missing baseUrl', () => {
    expect(() => new CollabPresenceClient({ baseUrl: '' })).toThrow(TypeError)
  })
})

describe('CollabPresenceClient.update', () => {
  it('POSTs input to /api/ipc/collab:presence-update and returns { ok: true }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({ ok: true }))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.update({
      docId: 'doc-1',
      userId: 'u1',
      status: 'active',
    })
    expect(r).toEqual({ ok: true })
    expect(calls[0].url).toBe('https://x.test/api/ipc/collab:presence-update')
    expect(JSON.parse(calls[0].body!)).toEqual({
      args: [{ docId: 'doc-1', userId: 'u1', status: 'active' }],
    })
  })

  it('rejects empty input at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(c.update(null)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects missing userId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(
      c.update({ docId: 'doc-1', userId: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('maps non-OK response to RequestError', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse({ ok: false }))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(
      c.update({ docId: 'doc-1', userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN' })
  })
})

describe('CollabPresenceClient.list', () => {
  it('returns parsed entries', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([PRES_A, PRES_B]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.list('doc-1')
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ userId: 'u1', userName: 'Alice' })
    expect(calls[0].url).toBe('https://x.test/api/ipc/collab:presence-list')
    expect(JSON.parse(calls[0].body!)).toEqual({ args: [{ docId: 'doc-1' }] })
  })

  it('returns [] on non-array body', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse(null))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).resolves.toEqual([])
  })

  it('filters malformed entries', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse([PRES_A, { userId: 123 }, null, PRES_B]),
    )
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.list('doc-1')
    expect(r.map((e) => e.userId)).toEqual(['u1', 'u2'])
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('reads entries out of result, not the envelope (regression)', async () => {
    // Pre-fix, `list()` checked `Array.isArray` on the envelope, which never
    // is an array — so presence always came back empty against a live server.
    const { fetchImpl } = makeMockFetch(() => ipcResponse([PRES_A]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).resolves.toEqual([PRES_A])
  })

  it('throws when the envelope is missing rather than reporting nobody present', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse([PRES_A]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).rejects.toMatchObject({
      code: 'UNKNOWN',
      channel: 'collab:presence-list',
    })
  })
})

describe('CollabPresenceClient.subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the first snapshot immediately', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([PRES_A]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const events: unknown[] = []
    const sub = c.subscribe(
      'doc-1',
      { next: (v) => events.push(v) },
      { intervalMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toHaveLength(1)
    sub.unsubscribe()
  })

  it('dedupes identical snapshots', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([PRES_A]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const events: unknown[] = []
    const sub = c.subscribe(
      'doc-1',
      { next: (v) => events.push(v) },
      { intervalMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(events).toHaveLength(1)
    sub.unsubscribe()
  })

  it('stops polling after unsubscribe', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([PRES_A]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const sub = c.subscribe(
      'doc-1',
      { next: () => undefined },
      { intervalMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(500)
    const callsAtUnsub = calls.length
    sub.unsubscribe()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.length).toBe(callsAtUnsub)
  })

  it('floors intervalMs at 50ms', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([PRES_A]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const sub = c.subscribe(
      'doc-1',
      { next: () => undefined },
      { intervalMs: 0 },
    )
    await vi.advanceTimersByTimeAsync(60)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    sub.unsubscribe()
  })

  it('aborts via AbortSignal', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([PRES_A]))
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const ctrl = new AbortController()
    const sub = c.subscribe(
      'doc-1',
      { next: () => undefined },
      { intervalMs: 1000, signal: ctrl.signal },
    )
    ctrl.abort()
    expect(sub.closed).toBe(true)
  })

  it('reports fetch errors to observer.error', async () => {
    const { fetchImpl } = makeMockFetch(() => {
      throw new TypeError('boom')
    })
    const c = new CollabPresenceClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const errors: unknown[] = []
    const sub = c.subscribe(
      'doc-1',
      { error: (e) => errors.push(e) },
      { intervalMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(errors.length).toBeGreaterThan(0)
    sub.unsubscribe()
  })
})
/**
 * CollabCursorClient — broadcast and watch remote cursors.
 *
 * Cursor events come back from `POST /api/ipc/collab:cursor-list` as an array
 * snapshot. `subscribe()` polls that endpoint on a fixed cadence and dedupes
 * identical snapshots so subscribers don't wake on every tick when nothing
 * has changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollabCursorClient } from '../../src/collab/cursor'
import { ipcResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

const CURSOR_A = {
  userId: 'u1',
  position: { x: 10, y: 20, offset: 5 },
  color: '#ff0000',
}
const CURSOR_B = {
  userId: 'u2',
  position: { x: 30, y: 40, offset: 12 },
  color: '#00ff00',
}

describe('CollabCursorClient constructor', () => {
  it('rejects missing baseUrl', () => {
    expect(() => new CollabCursorClient({ baseUrl: '' })).toThrow(TypeError)
  })
})

describe('CollabCursorClient.update', () => {
  it('POSTs input to /api/ipc/collab:cursor-update and returns { ok: true }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({ ok: true }))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.update({
      docId: 'doc-1',
      userId: 'u1',
      position: { x: 1, y: 2, offset: 3 },
    })
    expect(r).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/ipc/collab:cursor-update')
    expect(JSON.parse(calls[0].body!)).toEqual({
      args: [
        {
          docId: 'doc-1',
          userId: 'u1',
          position: { x: 1, y: 2, offset: 3 },
        },
      ],
    })
  })

  it('rejects empty input at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(c.update(null)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(
      c.update({ docId: '', userId: 'u', position: { x: 0, y: 0, offset: 0 } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects missing position.x/y/offset at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(
      c.update({ docId: 'd', userId: 'u', position: { x: 0, y: 0 } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('CollabCursorClient.list', () => {
  it('returns parsed array', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([CURSOR_A, CURSOR_B]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.list('doc-1')
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ userId: 'u1' })
    expect(calls[0].url).toBe('https://x.test/api/ipc/collab:cursor-list')
    expect(JSON.parse(calls[0].body!)).toEqual({ args: [{ docId: 'doc-1' }] })
  })

  it('returns [] when server returns a non-array', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).resolves.toEqual([])
  })

  it('filters out malformed entries', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse([
        CURSOR_A,
        { userId: 123 }, // bad
        null,
        'string',
        CURSOR_B,
      ]),
    )
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.list('doc-1')
    expect(r).toHaveLength(2)
    expect(r.map((e) => e.userId)).toEqual(['u1', 'u2'])
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('reads cursors out of result, not the envelope (regression)', async () => {
    // Pre-fix, `list()` looked for an array at the top level of a body the
    // dispatcher always wraps in `{ ok, result }`, so it returned [] against
    // a live server while every mocked test passed.
    const { fetchImpl } = makeMockFetch(() => ipcResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).resolves.toEqual([CURSOR_A])
  })

  it('throws when the envelope is missing rather than reporting no cursors', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).rejects.toMatchObject({
      code: 'UNKNOWN',
      channel: 'collab:cursor-list',
    })
  })
})

describe('CollabCursorClient.subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires the observer immediately with the first snapshot', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const events: unknown[] = []
    const sub = c.subscribe(
      'doc-1',
      { next: (v) => events.push(v) },
      { intervalMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toHaveLength(1)
    sub.unsubscribe()
  })

  it('dedupes identical snapshots across ticks', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
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

  it('emits a fresh event when the snapshot changes', async () => {
    let n = 1
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse(n++ === 1 ? [CURSOR_A] : [CURSOR_A, CURSOR_B]),
    )
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const events: unknown[] = []
    const sub = c.subscribe(
      'doc-1',
      { next: (v) => events.push(v) },
      { intervalMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(2500)
    expect(events).toHaveLength(2)
    sub.unsubscribe()
  })

  it('stops polling after unsubscribe()', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const sub = c.subscribe(
      'doc-1',
      { next: () => undefined },
      { intervalMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(500)
    sub.unsubscribe()
    expect(sub.closed).toBe(true)
    const callsAtUnsub = calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.length).toBe(callsAtUnsub)
  })

  it('stops when the timeoutMs elapses', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const completed: boolean[] = []
    const sub = c.subscribe(
      'doc-1',
      { next: () => undefined, complete: () => completed.push(true) },
      { intervalMs: 1000, timeoutMs: 2000 },
    )
    await vi.advanceTimersByTimeAsync(2500)
    expect(sub.closed).toBe(true)
    expect(completed).toEqual([true])
  })

  it('floors intervalMs at 50ms', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const sub = c.subscribe(
      'doc-1',
      { next: () => undefined },
      { intervalMs: 1 },
    )
    // initial fire + first tick after 50ms (floored)
    await vi.advanceTimersByTimeAsync(60)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    sub.unsubscribe()
  })

  it('aborts via AbortSignal', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([CURSOR_A]))
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
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
    const c = new CollabCursorClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
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
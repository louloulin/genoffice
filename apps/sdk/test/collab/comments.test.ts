/**
 * CollabCommentsClient — per-document comment threads.
 *
 * Threads are flat: every comment has a `replies[]` array. The SDK never
 * normalises to a tree — `comments.list()` returns whatever the server
 * returned, validated to the `DocComment` shape. add/reply/resolve/delete
 * each round-trip through their IPC channel and surface `RequestError` on
 * failure.
 */
import { describe, expect, it } from 'vitest'
import { CollabCommentsClient } from '../../src/collab/comments'
import { ipcResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

const COMMENT = {
  id: 'c1',
  userId: 'u1',
  userName: 'Alice',
  content: 'looks good',
  timestamp: 1700000000,
  resolved: false,
  replies: [
    {
      id: 'r1',
      userId: 'u2',
      userName: 'Bob',
      content: '+1',
      timestamp: 1700000050,
    },
  ],
  selection: { start: 0, end: 5, text: 'hello' },
}

describe('CollabCommentsClient constructor', () => {
  it('rejects missing baseUrl', () => {
    expect(() => new CollabCommentsClient({ baseUrl: '' })).toThrow(TypeError)
  })
})

describe('CollabCommentsClient.list', () => {
  it('returns parsed DocComment array', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([COMMENT]))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.list('doc-1')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      id: 'c1',
      userName: 'Alice',
      replies: [{ id: 'r1', userName: 'Bob' }],
      selection: { start: 0, end: 5, text: 'hello' },
    })
    expect(calls[0].url).toBe('https://x.test/api/ipc/comments:list')
    expect(JSON.parse(calls[0].body!)).toEqual({ args: [{ docId: 'doc-1' }] })
  })

  it('returns [] on non-array body', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).resolves.toEqual([])
  })

  it('filters malformed entries', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse([
        COMMENT,
        { id: 'broken' },
        null,
        {
          id: 'c2',
          userId: 'u3',
          userName: 'Cara',
          content: 'fine',
          timestamp: 1,
          resolved: false,
          replies: [{ bad: 'reply' }],
        },
      ]),
    )
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.list('doc-1')
    expect(r.map((e) => e.id)).toEqual(['c1', 'c2'])
    expect(r[1].replies).toEqual([])
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse([]))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('CollabCommentsClient.add', () => {
  it('POSTs to /api/ipc/comments:add and returns { commentId }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      ipcResponse({ ok: true, commentId: 'c-new' }),
    )
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.add({
      docId: 'doc-1',
      userId: 'u1',
      userName: 'Alice',
      content: 'looks good',
    })
    expect(r).toEqual({ ok: true, commentId: 'c-new' })
    expect(calls[0].url).toBe('https://x.test/api/ipc/comments:add')
    expect(JSON.parse(calls[0].body!)).toEqual({
      args: [{ docId: 'doc-1', userId: 'u1', userName: 'Alice', content: 'looks good' }],
    })
  })

  it('rejects empty content at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(
      c.add({ docId: 'd', userId: 'u', userName: 'n', content: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('CollabCommentsClient.reply', () => {
  it('POSTs to /api/ipc/comments:reply and returns { replyId }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      ipcResponse({ ok: true, replyId: 'r-new' }),
    )
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.reply({
      docId: 'doc-1',
      commentId: 'c1',
      userId: 'u2',
      userName: 'Bob',
      content: '+1',
    })
    expect(r).toEqual({ ok: true, replyId: 'r-new' })
    expect(calls[0].url).toBe('https://x.test/api/ipc/comments:reply')
  })

  it('rejects missing commentId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(
      c.reply({ docId: 'd', commentId: '', userId: 'u', userName: 'n', content: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('CollabCommentsClient.resolve / delete', () => {
  it('resolve POSTs to /api/ipc/comments:resolve and returns { ok: true }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({ ok: true }))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.resolve('doc-1', 'c1')
    expect(r).toEqual({ ok: true })
    expect(calls[0].url).toBe('https://x.test/api/ipc/comments:resolve')
    expect(JSON.parse(calls[0].body!)).toEqual({ args: [{ docId: 'doc-1', commentId: 'c1' }] })
  })

  it('resolve reports the handler failure as NOT_FOUND', async () => {
    // The dispatcher answers HTTP 200 with the handler's own verdict nested
    // in `result` — a missing comment is not a transport-level 404.
    const { fetchImpl, calls } = makeMockFetch(() =>
      ipcResponse({ ok: false, error: 'Comment not found' }),
    )
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.resolve('doc-1', 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
    expect(calls[0]!.url).toBe('https://x.test/api/ipc/comments:resolve')
  })

  it('delete POSTs to /api/ipc/comments:delete and returns { ok: true }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({ ok: true }))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const r = await c.delete('doc-1', 'c1')
    expect(r).toEqual({ ok: true })
    expect(calls[0].url).toBe('https://x.test/api/ipc/comments:delete')
  })

  it('delete reports the handler failure as NOT_FOUND', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse({ ok: false, error: 'Comment not found' }),
    )
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.delete('doc-1', 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
  })

  it('rejects missing docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ipcResponse({}))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.resolve('', 'c1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(c.delete('', 'c1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('CollabCommentsClient IPC envelope', () => {
  // Regression guard. The dispatcher always wraps handler returns in
  // `{ ok, result }`; the clients originally read the payload off the top
  // level, so `list()` returned [] forever and `add()` threw against a live
  // server even though every mocked test passed. These pin the real shape.
  it('reads the payload out of result, not the envelope', async () => {
    const { fetchImpl } = makeMockFetch(() => ipcResponse([COMMENT]))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).resolves.toHaveLength(1)
  })

  it('throws when the envelope is missing rather than reporting an empty list', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse([COMMENT]))
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.list('doc-1')).rejects.toMatchObject({
      code: 'UNKNOWN',
      channel: 'comments:list',
    })
  })

  it('add surfaces a handler failure instead of a phantom commentId', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse({ ok: false, error: 'Document not found' }),
    )
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(
      c.add({ docId: 'd', userId: 'u', userName: 'n', content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reply surfaces a handler failure instead of a phantom replyId', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      ipcResponse({ ok: false, error: 'Comment not found' }),
    )
    const c = new CollabCommentsClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(
      c.reply({ docId: 'd', commentId: 'c1', userId: 'u', userName: 'n', content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
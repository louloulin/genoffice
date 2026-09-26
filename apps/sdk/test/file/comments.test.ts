/**
 * CommentsClient — generic comments / annotations capability.
 */
import { describe, expect, it } from 'vitest'
import { CommentsClient } from '../../src/file/comments'
import { emptyResponse, errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

const COMMENT = {
  id: 'c1',
  fileId: 'doc-1',
  author: 'user-1',
  text: 'hello',
  anchor: { range: { start: 0, end: 5 } },
  resolved: false,
  createdAt: 1700000000,
  updatedAt: 1700000000,
}

describe('CommentsClient.list', () => {
  it('GET /api/v1/files/:id/comments returns list', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ fileId: 'doc-1', count: 1, comments: [COMMENT] }),
    )
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.list({ fileId: 'doc-1' })
    expect(r.count).toBe(1)
    expect(r.comments[0]).toMatchObject({ id: 'c1' })
    expect(calls[0].url).toBe('https://x.test/api/v1/files/doc-1/comments')
  })

  it('appends ?resolved=true|false when filter supplied', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ fileId: 'doc-1', count: 0, comments: [] }),
    )
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.list({ fileId: 'doc-1', resolved: true })
    expect(calls[0].url).toBe('https://x.test/api/v1/files/doc-1/comments?resolved=true')
  })

  it('omits query when resolved is undefined', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ fileId: 'doc-1', count: 0, comments: [] }),
    )
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.list({ fileId: 'doc-1' })
    expect(calls[0].url).not.toContain('?')
  })
})

describe('CommentsClient.add', () => {
  it('POST /api/v1/files/:id/comments with { anchor, text, parentId? }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ comment: COMMENT }, 201),
    )
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.add({
      fileId: 'doc-1',
      anchor: { range: { start: 0, end: 5 } },
      text: 'hello',
    })
    expect(r).toMatchObject({ id: 'c1' })
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(calls[0].body!)).toEqual({
      anchor: { range: { start: 0, end: 5 } },
      text: 'hello',
    })
  })

  it('includes parentId when supplied', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ comment: COMMENT }, 201),
    )
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.add({
      fileId: 'doc-1',
      anchor: { cell: 'A1' },
      text: 'reply',
      parentId: 'c0',
    })
    expect(JSON.parse(calls[0].body!)).toEqual({
      anchor: { cell: 'A1' },
      text: 'reply',
      parentId: 'c0',
    })
  })

  it('rejects array anchor at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(
      c.add({ fileId: 'doc', anchor: [1, 2, 3], text: 't' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects empty text at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      c.add({ fileId: 'doc', anchor: {}, text: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects text > 16 KB at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      c.add({ fileId: 'doc', anchor: {}, text: 'x'.repeat(16_001) }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects empty parentId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      c.add({ fileId: 'doc', anchor: {}, text: 't', parentId: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('CommentsClient.patch', () => {
  it('PATCH /api/v1/files/:id/comments/:cid with { resolved: boolean }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ comment: { ...COMMENT, resolved: true } }),
    )
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.patch({ fileId: 'doc-1', commentId: 'c1', resolved: true })
    expect(r.resolved).toBe(true)
    expect(calls[0].method).toBe('PATCH')
    expect(JSON.parse(calls[0].body!)).toEqual({ resolved: true })
  })

  it('rejects non-boolean resolved', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(c.patch({ fileId: 'doc', commentId: 'c', resolved: 'yes' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('CommentsClient.delete', () => {
  it('DELETE returns 204', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => emptyResponse(204))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.delete({ fileId: 'doc-1', commentId: 'c1' })
    expect(r).toEqual({ ok: true, fileId: 'doc-1', commentId: 'c1' })
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/doc-1/comments/c1')
  })

  it('404 → NOT_FOUND', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(404, 'NOT_FOUND', 'no', 'files:comments:delete'))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.delete({ fileId: 'doc', commentId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('CommentsClient.get', () => {
  it('GET single comment by id', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ comment: COMMENT }))
    const c = new CommentsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.get('doc-1', 'c1')
    expect(r.id).toBe('c1')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/doc-1/comments/c1')
  })
})

/**
 * AgentClient — wraps POST /api/v1/ai/chat and /api/v1/ai/skill/:name.
 */
import { describe, expect, it } from 'vitest'
import { AgentClient } from '../../src/ai/agent'
import { errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

describe('AgentClient.invoke — chat', () => {
  it('POST /api/v1/ai/chat with messages and emits single response event', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ ok: true, reply: 'Hello, world!', model: 'gpt-x' }),
    )
    const c = new AgentClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const events: unknown[] = []
    let completed = false
    const stream = c.invoke({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
    })
    await new Promise<void>((resolve, reject) => {
      stream.subscribe({
        next: (e) => events.push(e),
        error: reject,
        complete: () => {
          completed = true
          resolve()
        },
      })
    })
    expect(completed).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'response',
      message: { role: 'assistant', content: 'Hello, world!', model: 'gpt-x' },
    })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/v1/ai/chat')
    expect(JSON.parse(calls[0].body!)).toMatchObject({
      stream: true,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
    })
  })

  it('accepts IPC-shape input directly', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ reply: 'hi' }))
    const c = new AgentClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await new Promise<void>((resolve, reject) => {
      c.invoke({ user: 'hi', system: 'sys' }).subscribe({
        next: () => undefined,
        error: reject,
        complete: resolve,
      })
    })
    expect(JSON.parse(calls[0].body!)).toMatchObject({
      user: 'hi',
      system: 'sys',
      stream: true,
    })
  })

  it('rejects empty messages + empty user at the call site', () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({}))
    const c = new AgentClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    expect(() => c.invoke({})).toThrow(/messages.*user/)
    expect(() => c.invoke({ messages: [] })).toThrow(/messages.*user/)
  })

  it('falls back to `message` / `content` / `output` keys for the reply', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ message: 'via message key' }))
    const c = new AgentClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const events: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      c.invoke({ user: 'hi' }).subscribe({
        next: (e) => events.push(e),
        error: reject,
        complete: resolve,
      })
    })
    expect((events[0] as { message: { content: string } }).message.content).toBe('via message key')
  })

  it('401 → UNAUTHENTICATED', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(401, 'UNAUTHENTICATED', 'no', 'ai:agent'))
    const c = new AgentClient({ baseUrl: 'https://x.test', bearer: 'bad', fetch: fetchImpl })
    await new Promise<void>((resolve, reject) => {
      c.invoke({ user: 'hi' }).subscribe({
        next: () => undefined,
        error: (err) => {
          expect((err as { code: string }).code).toBe('UNAUTHENTICATED')
          resolve()
        },
        complete: () => reject(new Error('expected error')),
      })
    })
  })
})

describe('AgentClient.invoke — skill', () => {
  it('POST /api/v1/ai/skill/:name when skill supplied', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ reply: 'skill-output' }))
    const c = new AgentClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await new Promise<void>((resolve, reject) => {
      c.invoke({ user: 'q', skill: 'doc-skill' }).subscribe({
        next: () => undefined,
        error: reject,
        complete: resolve,
      })
    })
    expect(calls[0].url).toBe('https://x.test/api/v1/ai/skill/doc-skill')
  })

  it('encodes skill name with special chars', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ reply: 'ok' }))
    const c = new AgentClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await new Promise<void>((resolve, reject) => {
      c.invoke({ user: 'q', skill: 'foo bar/baz' }).subscribe({
        next: () => undefined,
        error: reject,
        complete: resolve,
      })
    })
    expect(calls[0].url).toBe('https://x.test/api/v1/ai/skill/foo%20bar%2Fbaz')
  })
})

describe('AgentClient — constructor', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new AgentClient({ baseUrl: '' })).toThrow(/baseUrl is required/)
  })
})
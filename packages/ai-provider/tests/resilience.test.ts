import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '../src/agent-protocol'
import type { AiUsage } from '../src/types'
import { AiCreditsError, streamForProvider } from '../src/stream'
import { classifyProviderError } from '../src/retry'
import { AiTimeoutError } from '../src/watchdog'
import { errorResponse, okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** keep the exponential-backoff sleeps at ~0ms so the suite runs instantly */
const FAST_RETRY = { retry: { baseDelayMs: 1 } }

function collector() {
  const deltas: string[] = []
  const toolCalls: AgentToolCall[] = []
  const stopReasons: string[] = []
  const usage: AiUsage[] = []
  return {
    deltas,
    toolCalls,
    stopReasons,
    usage,
    cb: {
      signal: new AbortController().signal,
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => toolCalls.push(call),
      onStopReason: (reason: string) => stopReasons.push(reason),
      onUsage: (u: AiUsage) => usage.push(u),
    },
  }
}

/** a complete OpenAI-compatible turn: one text delta plus a normal stop reason */
function openAiTurn(text = 'hi'): Response {
  return okResponse(
    sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}`,
    ]),
  )
}

/** a complete Anthropic turn: one text delta (sufficient for a non-empty stream) */
function anthropicTurn(text = 'ok'): Response {
  return okResponse(
    sseStream([
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })}`,
    ]),
  )
}

const OPENAI = { apiKey: 'k', model: 'gpt-4.1-mini' } as const

describe('classifyProviderError', () => {
  it('maps the shared error taxonomy onto retryable / non-retryable classes', () => {
    expect(classifyProviderError(new AiTimeoutError(1))).toBe('timeout')
    expect(classifyProviderError(new Error('fetch failed: cause=ECONNRESET'))).toBe('network')
    expect(classifyProviderError(new Error('Claude HTTP 503: engine overloaded'))).toBe('overloaded')
    expect(classifyProviderError(new Error('HTTP 429: rate limit exceeded'))).toBe('overloaded')
    expect(classifyProviderError(new AiCreditsError('Your credits have been exhausted'))).toBe('credits')
    expect(classifyProviderError(new Error('HTTP 402: Insufficient Balance'))).toBe('credits')
    expect(classifyProviderError(new Error('HTTP 401: invalid api key'))).toBe('other')
    expect(classifyProviderError(new Error('HTTP 400: content policy violation'))).toBe('other')
  })

  it('honours an explicit errorCode carried on a thrown error', () => {
    expect(classifyProviderError(Object.assign(new Error('x'), { errorCode: 'timeout' }))).toBe(
      'timeout',
    )
    expect(classifyProviderError(Object.assign(new Error('x'), { errorCode: 'credits' }))).toBe(
      'credits',
    )
  })
})

describe('per-request retry (A15 / A56)', () => {
  it('retries a timeout, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new AiTimeoutError(1000))
      .mockResolvedValue(openAiTurn('recovered'))
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()

    await streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, FAST_RETRY)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(deltas.join('')).toBe('recovered')
  })

  it('retries a network failure, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed: cause=ECONNRESET'))
      .mockResolvedValue(openAiTurn('recovered'))
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()

    await streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, FAST_RETRY)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(deltas.join('')).toBe('recovered')
  })

  it('retries an overloaded (503) failure, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, 'engine overloaded'))
      .mockResolvedValue(openAiTurn('recovered'))
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()

    await streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, FAST_RETRY)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(deltas.join('')).toBe('recovered')
  })

  it('retries by default when the caller passes no options', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, 'engine overloaded'))
      .mockResolvedValue(openAiTurn('default-retry'))
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()

    await streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(deltas.join('')).toBe('default-retry')
  })

  it('caps retries at 3 and gives up on a permanently failing request', async () => {
    // fresh Response per call: a Response body is single-use, so a reused mock
    // would fail with "Body is unusable" instead of exercising the retry cap.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(503, 'engine overloaded')))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()

    await expect(
      streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, FAST_RETRY),
    ).rejects.toThrow(/HTTP 503/)

    // 1 initial attempt + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('honours a custom maxRetries', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(503, 'engine overloaded')))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()

    await expect(
      streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, {
        retry: { maxRetries: 1, baseDelayMs: 1 },
      }),
    ).rejects.toThrow(/HTTP 503/)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry once a delta has already been delivered', async () => {
    const body = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}`,
      `data: ${JSON.stringify({ error: { message: 'engine overloaded' } })}`,
    ])
    const fetchMock = vi.fn().mockResolvedValue(okResponse(body))
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()

    // the in-band error is retryable, but the caller already saw "partial"
    await expect(
      streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, FAST_RETRY),
    ).rejects.toThrow()

    expect(deltas.join('')).toBe('partial')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['auth 401', () => errorResponse(401, 'invalid api key')],
    ['credits exhaustion', () => errorResponse(402, 'Insufficient Balance')],
  ])('does not retry a non-retryable %s failure', async (_label, makeResponse) => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()

    await expect(
      streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, FAST_RETRY),
    ).rejects.toThrow()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('registry failover (A16 / A57)', () => {
  it('switches to the next provider after the primary is exhausted, and reports the switch', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('api.openai.com')) return Promise.resolve(errorResponse(503, 'engine overloaded'))
      return Promise.resolve(anthropicTurn('from-fallback'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()
    const onProviderSwitch = vi.fn()

    await streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, {
      retry: { maxRetries: 3, baseDelayMs: 1 },
      fallbackProviders: ['anthropic'],
      resolveConfig: (id) => ({
        apiKey: 'k',
        model: id === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4.1-mini',
      }),
      onProviderSwitch,
    })

    expect(deltas.join('')).toBe('from-fallback')
    expect(onProviderSwitch).toHaveBeenCalledTimes(1)
    expect(onProviderSwitch).toHaveBeenCalledWith({
      from: 'openai',
      to: 'anthropic',
      attempt: 1,
      reason: 'overloaded',
    })
    // 1 initial + 3 retries on the primary, then 1 attempt on the fallback
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('walks an ordered fallback sequence until one provider completes', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('api.openai.com')) return Promise.resolve(errorResponse(503, 'overloaded'))
      if (url.includes('api.deepseek.com')) return Promise.resolve(errorResponse(503, 'overloaded'))
      return Promise.resolve(anthropicTurn('third-time'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()
    const switches: unknown[] = []

    await streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, {
      retry: { maxRetries: 0, baseDelayMs: 1 },
      fallbackProviders: ['deepseek', 'anthropic'],
      resolveConfig: (id) => ({
        apiKey: 'k',
        model: id === 'deepseek' ? 'deepseek-chat' : 'claude-sonnet-5',
      }),
      onProviderSwitch: (info) => switches.push(info),
    })

    expect(deltas.join('')).toBe('third-time')
    expect(switches).toEqual([
      { from: 'openai', to: 'deepseek', attempt: 1, reason: 'overloaded' },
      { from: 'deepseek', to: 'anthropic', attempt: 2, reason: 'overloaded' },
    ])
  })

  it('does not fail over once a delta has been delivered', async () => {
    const body = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}`,
      `data: ${JSON.stringify({ error: { message: 'engine overloaded' } })}`,
    ])
    const fetchMock = vi.fn().mockResolvedValue(okResponse(body))
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, cb } = collector()
    const onProviderSwitch = vi.fn()

    await expect(
      streamForProvider('openai', OPENAI, 'sys', [], [], 100, cb, {
        retry: { baseDelayMs: 1 },
        fallbackProviders: ['anthropic'],
        resolveConfig: () => ({ apiKey: 'k', model: 'claude-sonnet-5' }),
        onProviderSwitch,
      }),
    ).rejects.toThrow()

    expect(deltas.join('')).toBe('partial')
    expect(onProviderSwitch).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

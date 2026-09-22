/**
 * /api/v1/metrics — Prometheus-format metrics endpoint (sdk1.md §11.35).
 *
 * The endpoint exposes webhook DLQ counters + IPC channel count + uptime
 * in Prometheus text-exposition format. We assert:
 *
 *   - 200 status + correct Content-Type (`text/plain; version=0.0.4`)
 *   - the 8 documented metric lines are all present (HELP/TYPE/value)
 *   - public (no Bearer required — Prometheus convention)
 *   - counters move when the underlying store mutates
 *   - NaN sentinel is emitted when the queue is empty (oldest/newest)
 *   - ipc_channels_implemented tracks handlerCount()
 *
 * Counters are reset between cases via `_resetDeadLetterForTests()`
 * (which now also clears `totals`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetDeadLetterForTests,
  pushDeadLetter,
  replayDeadLetter,
} from '../src/common/webhooks-dlq'
import { handleMetrics } from '../src/api/v1/meta'
import { handlerCount } from '../src/common'

interface CapturedResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function mockRes() {
  let status = 200
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
    writeHead(s: number, h?: Record<string, string>) {
      status = s
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v
    },
    end(payload?: string) {
      if (payload) body = payload
    },
  }
  return {
    res: res as unknown as CapturedResponse,
    read: () => ({ status, headers: { ...headers }, body }),
  }
}

function mockReq(): unknown {
  return {} as unknown
}

beforeEach(() => {
  _resetDeadLetterForTests()
})

afterEach(() => {
  _resetDeadLetterForTests()
})

describe('GET /api/v1/metrics (sdk1.md §11.35)', () => {
  it('returns 200 with Prometheus Content-Type', () => {
    const { res, read } = mockRes()
    const handled = handleMetrics({ req: mockReq() as never, response: res as never })
    expect(handled).toBe(true)
    const r = read()
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8')
  })

  it('exposes all 8 documented metric lines (HELP + TYPE + sample)', () => {
    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    const expectedNames = [
      'genoffice_dlq_size',
      'genoffice_dlq_total_dropped',
      'genoffice_dlq_total_replayed',
      'genoffice_dlq_dropped_by_reason',
      'genoffice_dlq_oldest_dropped_at_ms',
      'genoffice_dlq_newest_dropped_at_ms',
      'genoffice_ipc_channels_implemented',
      'genoffice_uptime_seconds',
    ]
    for (const name of expectedNames) {
      expect(body, `missing HELP for ${name}`).toContain(`# HELP ${name}`)
      expect(body, `missing TYPE for ${name}`).toContain(`# TYPE ${name} `)
    }
  })

  it('reports zero counters and NaN epoch when the DLQ is empty', () => {
    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    expect(body).toMatch(/^genoffice_dlq_size 0$/m)
    expect(body).toMatch(/^genoffice_dlq_total_dropped 0$/m)
    expect(body).toMatch(/^genoffice_dlq_total_replayed 0$/m)
    expect(body).toMatch(/^genoffice_dlq_dropped_by_reason\{reason="max_attempts"\} 0$/m)
    expect(body).toMatch(/^genoffice_dlq_dropped_by_reason\{reason="non_retryable_4xx"\} 0$/m)
    // Empty queue → oldest/newest emit NaN sentinel so Prometheus rate()
    // does not see a stale value.
    expect(body).toMatch(/^genoffice_dlq_oldest_dropped_at_ms NaN$/m)
    expect(body).toMatch(/^genoffice_dlq_newest_dropped_at_ms NaN$/m)
  })

  it('counters move after pushDeadLetter / replayDeadLetter', async () => {
    const id1 = pushDeadLetter({
      url: 'https://h/ok', event: 'file.saved', fileId: 'f1', body: '{}',
      attempts: 3, lastStatus: 500, lastError: null, reason: 'max_attempts',
    })
    pushDeadLetter({
      url: 'https://h/bad', event: 'file.saved', fileId: 'f2', body: '{}',
      attempts: 1, lastStatus: 404, lastError: null, reason: 'non_retryable_4xx',
    })

    // Successful replay bumps total_replayed only.
    const fetchOk = vi_fetchOk()
    vi.stubGlobal('fetch', fetchOk)
    await replayDeadLetter(id1)
    vi.unstubAllGlobals()

    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    // id1 was successfully replayed and removed; entry 2 still sits
    // in the DLQ because we only stubbed fetch for the replay call.
    expect(body).toMatch(/^genoffice_dlq_size 1$/m)
    expect(body).toMatch(/^genoffice_dlq_total_dropped 2$/m)
    expect(body).toMatch(/^genoffice_dlq_total_replayed 1$/m)
    expect(body).toMatch(/^genoffice_dlq_dropped_by_reason\{reason="max_attempts"\} 1$/m)
    expect(body).toMatch(/^genoffice_dlq_dropped_by_reason\{reason="non_retryable_4xx"\} 1$/m)
    expect(body).toMatch(/^genoffice_dlq_oldest_dropped_at_ms \d+$/m)
    expect(body).toMatch(/^genoffice_dlq_newest_dropped_at_ms \d+$/m)
  })

  it('ipc_channels_implemented matches the registered handler count', () => {
    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    const expected = handlerCount()
    expect(body).toMatch(new RegExp(`^genoffice_ipc_channels_implemented ${expected}$`, 'm'))
  })

  it('is public — no Authorization header required', () => {
    // Public-by-design (Prometheus scrapers don't carry Bearer). The
    // handler must not call `requireAuth`; the dispatcher in api/v1/
    // routes the URL before the auth gate.
    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    expect(read().status).toBe(200)
  })

  it('body ends with a trailing newline (Prometheus text format)', () => {
    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    expect(read().body.endsWith('\n')).toBe(true)
  })
})

function vi_fetchOk(): (input: unknown) => Promise<Response> {
  return async () => new Response('ok', { status: 200 })
}

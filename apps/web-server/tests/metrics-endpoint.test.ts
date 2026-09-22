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
 *
 * The audit-log metric block (`genoffice_audit_log_*`) is exercised in
 * its own describe below so a failure points at the right subsystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetDeadLetterForTests,
  pushDeadLetter,
  replayDeadLetter,
} from '../src/common/webhooks-dlq'
import { handleMetrics } from '../src/api/v1/meta'
import {
  handlerCount,
  recordAudit,
  _resetAuditLogForTests,
  _setAuditMaxRecordsForTests,
} from '../src/common'

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
  _resetAuditLogForTests()
  _setAuditMaxRecordsForTests(10_000)
})

afterEach(() => {
  _resetDeadLetterForTests()
  _resetAuditLogForTests()
  _setAuditMaxRecordsForTests(10_000)
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

  it('exposes all DLQ + SDK metric lines (HELP + TYPE + sample)', () => {
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
      'genoffice_sdk_usage_samples_total',
      'genoffice_sdk_usage_instances',
      'genoffice_sdk_doc_bytes_written_total',
      'genoffice_sdk_ai_calls_total',
      'genoffice_sdk_ai_prompt_chars_total',
      'genoffice_sdk_ai_response_chars_total',
      'genoffice_sdk_session_ms_total',
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

describe('SDK usage metrics (sdk1.md §11.36)', () => {
  it('starts at zero and moves after reportUsage commands', async () => {
    const { _resetUsageForTests, dispatchSdkCommand } = await import('../src/embed/sdk-commands')
    _resetUsageForTests()
    const { res: res1, read: read1 } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res1 as never })
    const before = read1().body
    expect(before).toMatch(/^genoffice_sdk_usage_samples_total 0$/m)
    expect(before).toMatch(/^genoffice_sdk_doc_bytes_written_total 0$/m)

    dispatchSdkCommand({
      name: 'reportUsage',
      docId: 'metrics.docx',
      args: {
        instanceId: 'inst-metrics',
        docBytesWritten: 256,
        aiCalls: 3,
        aiTokensIn: 40,
        aiTokensOut: 80,
        sessionDurationMs: 1234,
      },
    })

    const { res: res2, read: read2 } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res2 as never })
    const after = read2().body
    expect(after).toMatch(/^genoffice_sdk_usage_samples_total 1$/m)
    expect(after).toMatch(/^genoffice_sdk_usage_instances 1$/m)
    expect(after).toMatch(/^genoffice_sdk_doc_bytes_written_total 256$/m)
    expect(after).toMatch(/^genoffice_sdk_ai_calls_total 3$/m)
    expect(after).toMatch(/^genoffice_sdk_ai_prompt_chars_total 40$/m)
    expect(after).toMatch(/^genoffice_sdk_ai_response_chars_total 80$/m)
    expect(after).toMatch(/^genoffice_sdk_session_ms_total 1234$/m)
    _resetUsageForTests()
  })
})

function vi_fetchOk(): (input: unknown) => Promise<Response> {
  return async () => new Response('ok', { status: 200 })
}

describe('GET /api/v1/metrics — audit log block (sdk1 §A.5 retention backlog)', () => {
  it('exposes the four audit-log metric lines (HELP + TYPE + sample)', () => {
    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    for (const name of [
      'genoffice_audit_log_records',
      'genoffice_audit_log_persisted_bytes',
      'genoffice_audit_log_recorded_total',
      'genoffice_audit_log_dropped_total',
    ]) {
      expect(body, `missing HELP for ${name}`).toContain(`# HELP ${name}`)
      expect(body, `missing TYPE for ${name}`).toContain(`# TYPE ${name} `)
    }
  })

  it('records=0, recorded_total=0, dropped_total=0, persisted_bytes=NaN on a cold start', () => {
    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    expect(body).toMatch(/^genoffice_audit_log_records 0$/m)
    expect(body).toMatch(/^genoffice_audit_log_recorded_total 0$/m)
    expect(body).toMatch(/^genoffice_audit_log_dropped_total 0$/m)
    // persisted_bytes is either NaN (file does not exist — first ever
    // scrape with no records recorded yet) or 0 (file was just truncated
    // by _resetAuditLogForTests in beforeEach). Both are valid cold-start
    // states; we accept either so a prior test's residual file doesn't
    // turn this case red.
    expect(body).toMatch(/^genoffice_audit_log_persisted_bytes (?:NaN|0)$/m)
  })

  it('records + recorded_total move up after recordAudit calls', () => {
    recordAudit({
      tenantId: 't1', userId: 'u1', action: 'file.saved',
      resource: 'doc', resourceId: 'd1',
      details: { sha: 'abc' }, ip: '127.0.0.1', userAgent: 'jest',
    })
    recordAudit({
      tenantId: 't1', userId: 'u2', action: 'file.opened',
      resource: 'doc', resourceId: 'd2',
      details: {}, ip: '127.0.0.1', userAgent: 'jest',
    })
    recordAudit({
      tenantId: 't1', userId: 'u1', action: 'file.saved',
      resource: 'sheet', resourceId: 's1',
      details: {}, ip: '127.0.0.1', userAgent: 'jest',
    })

    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    expect(body).toMatch(/^genoffice_audit_log_records 3$/m)
    expect(body).toMatch(/^genoffice_audit_log_recorded_total 3$/m)
    expect(body).toMatch(/^genoffice_audit_log_dropped_total 0$/m)
    // At least 3 records ⇒ JSONL has at least 3 lines on disk; we don't
    // pin the byte count because newline length depends on payload shape.
    expect(body).toMatch(/^genoffice_audit_log_persisted_bytes [1-9]\d*$/m)
  })

  it('dropped_total ticks up once the in-memory ring overflows the cap', () => {
    // Shrink the cap so we can overflow without recording 10 001 events
    // (Array.unshift is O(n); 10 001 calls is O(n²) — too slow for a
    // unit test, but the production code path is identical).
    _setAuditMaxRecordsForTests(3)

    for (let i = 0; i < 5; i++) {
      recordAudit({
        tenantId: 't', userId: 'u', action: 'noise',
        resource: 'doc', resourceId: `r${i}`,
        details: { i }, ip: '127.0.0.1', userAgent: 'jest',
      })
    }

    const { res, read } = mockRes()
    handleMetrics({ req: mockReq() as never, response: res as never })
    const body = read().body
    expect(body).toMatch(/^genoffice_audit_log_records 3$/m)
    expect(body).toMatch(/^genoffice_audit_log_recorded_total 5$/m)
    // 5 events, cap 3 → 2 dropped.
    expect(body).toMatch(/^genoffice_audit_log_dropped_total 2$/m)
  })
})

/**
 * /api/v1/* unknown route returns 404 instead of falling through to the
 * SPA static fallback (sdk1.md follow-up).
 *
 * Bug: prior to this fix, GET /api/v1/webhooks (a known v1 path that only
 * accepts POST/DELETE) returned 200 with the shell SPA's index.html,
 * because `handleApiV1` returned `false` (no handler matched) and the
 * outer dispatcher then served the static fallback. API clients then
 * tried to JSON.parse HTML and crashed.
 *
 * Fix: when the request path starts with `/api/v1/` and `handleApiV1`
 * did not handle it, return 404 with the standard OAuth-style error
 * envelope. Mirrors what `/api/v1/webhooks` would do for an
 * UNSUPPORTED method (also a 4xx envelope), so API clients have one
 * consistent error shape regardless of why the route failed.
 *
 * This test exercises the dispatcher directly with a mocked server
 * response object; it does not need a spawned bundle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'api-v1-unknown-404-'))
  vi.stubEnv('GENOFFICE_JWT_SECRET', 'api-v1-unknown-404-secret')
  vi.stubEnv('GENOFFICE_TEST_DATA_DIR', TMP)
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function makeCtx(url: string, method: string, headers: Record<string, string> = {}): {
  ctx: Parameters<typeof import('../src/api/v1/index')['handleApiV1']>[0]
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
  } as unknown as ServerResponse
  const request = {
    method,
    url,
    headers: { host: 'localhost', ...headers },
    on: () => request,
    once: () => request,
    emit: () => true,
  } as unknown as IncomingMessage
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

describe('handleApiV1 unknown route returns false (so the outer dispatcher returns 404)', () => {
  it('GET /api/v1/webhooks returns false (POST/DELETE are the only allowed methods)', async () => {
    const { handleApiV1 } = await import('../src/api/v1/index')
    const { ctx, status } = makeCtx('/api/v1/webhooks', 'GET', {})
    const handled = await handleApiV1(ctx)
    // handleApiV1 itself does NOT 404; it returns false. The 404 is
    // produced by the outer dispatcher (src/index.ts). This pins the
    // contract so the outer dispatcher doesn't accidentally start
    // claiming it.
    expect(handled).toBe(false)
    expect(status.code).toBe(0) // handleApiV1 did not write
  })

  it('GET /api/v1/this-route-does-not-exist returns false (404 is up to the outer dispatcher)', async () => {
    const { handleApiV1 } = await import('../src/api/v1/index')
    const { ctx } = makeCtx('/api/v1/this-route-does-not-exist', 'GET', {})
    const handled = await handleApiV1(ctx)
    expect(handled).toBe(false)
  })

  it('PUT /api/v1/health returns false (only GET is allowed)', async () => {
    const { handleApiV1 } = await import('../src/api/v1/index')
    const { ctx } = makeCtx('/api/v1/health', 'PUT', {})
    const handled = await handleApiV1(ctx)
    expect(handled).toBe(false)
  })

  it('PATCH /api/v1/files returns false (only GET/POST allowed)', async () => {
    const { handleApiV1 } = await import('../src/api/v1/index')
    const { ctx } = makeCtx('/api/v1/files', 'PATCH', {})
    const handled = await handleApiV1(ctx)
    expect(handled).toBe(false)
  })
})

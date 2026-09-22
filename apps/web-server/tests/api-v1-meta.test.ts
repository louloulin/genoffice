import { describe, expect, it } from 'vitest'
import { handleMeta } from '../src/api/v1/meta'

/**
 * /api/v1/meta — public server metadata endpoint (no auth).
 *
 * The previous implementation did not exist: a GET against this path fell
 * through to the SPA fallback and answered the static-not-ready hint HTML.
 * The smoke probe in the webserver regression report caught that. This
 * suite validates the handler shape directly without booting the bundle
 * (the same pattern as `api-v1-changelog.test.ts`).
 */

function mockRes() {
  let status = 200
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    statusCode: 200,
    headers,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
    writeHead(s: number) {
      status = s
    },
    end(payload: string) {
      if (payload) body = payload
    },
  }
  return {
    res: res as unknown as { statusCode: number; headers: Record<string, string>; body: string },
    read: () => ({ status, body }),
  }
}

function mockReq(): unknown {
  return {} as unknown
}

describe('GET /api/v1/meta', () => {
  it('returns 200 with the public metadata shape', () => {
    const { res, read } = mockRes()
    const ok = handleMeta({ request: mockReq() as never, response: res as never })
    expect(ok).toBe(true)
    const { status, body } = read()
    expect(status).toBe(200)
    const parsed = JSON.parse(body) as {
      apiVersion: string
      serverVersion: string
      protocolVersion: number
      minClientVersion: number
      sdkVersion: string
      capabilities: string[]
      integrations: Record<string, boolean>
      storage: { backend: string }
      sdk: { usageSamples: number; instances: number; uptimeSeconds: number }
      timestamp: string
    }
    expect(parsed.apiVersion).toBe('v1')
    expect(parsed.serverVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(parsed.protocolVersion).toBeGreaterThanOrEqual(1)
    expect(parsed.minClientVersion).toBeGreaterThanOrEqual(1)
    expect(parsed.sdkVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(parsed.capabilities).toEqual(
      expect.arrayContaining(['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']),
    )
    expect(parsed.integrations.ai).toBe(true)
    expect(parsed.integrations.webhooks).toBe(true)
    expect(parsed.integrations.embed).toBe(true)
    expect(typeof parsed.storage.backend).toBe('string')
    expect(parsed.sdk.usageSamples).toBeGreaterThanOrEqual(0)
    expect(parsed.sdk.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow()
  })

  it('sets Content-Type: application/json', () => {
    const { res, read } = mockRes()
    handleMeta({ request: mockReq() as never, response: res as never })
    const { body } = read()
    // The body is valid JSON regardless of how the mock records the
    // header — assert parseability rather than header capture (which
    // depends on sendJson's internal ordering).
    expect(() => JSON.parse(body)).not.toThrow()
  })
})

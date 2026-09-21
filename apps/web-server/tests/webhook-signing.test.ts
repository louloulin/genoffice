import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'

// Set DATA_DIR before importing the module so it picks up our temp dir.
const TMP = mkdtempSync(join(tmpdir(), 'webhook-sign-'))
process.env.GENOFFICE_TEST_DATA_DIR = TMP
process.env.DATA_DIR = TMP
vi.stubEnv('DATA_DIR', TMP)

import { signWebhookBody, saveCallback, fireCallback } from '../src/common/webhooks-store'

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('webhook HMAC signing (sdk1.md Appendix B.2)', () => {
  it('produces a sha256= prefix and matches an independent HMAC computation', () => {
    const secret = 'shhh'
    const body = '{"hello":"world"}'
    const sig = signWebhookBody(secret, body)
    expect(sig.startsWith('sha256=')).toBe(true)
    const expected = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
    expect(sig).toBe(expected)
  })

  it('produces a different signature for a different body', () => {
    const secret = 'shhh'
    const a = signWebhookBody(secret, 'a')
    const b = signWebhookBody(secret, 'b')
    expect(a).not.toBe(b)
  })

  it('produces a different signature for a different secret', () => {
    const body = '{"x":1}'
    const a = signWebhookBody('one', body)
    const b = signWebhookBody('two', body)
    expect(a).not.toBe(b)
  })

  it('fireCallback attaches X-GenOffice-Signature when the webhook has a secret', async () => {
    const secret = 'topsecret'
    saveCallback({
      fileId: 'secret-doc.docx',
      url: 'https://example.test/hook',
      events: ['file.saved'],
      createdAt: Date.now(),
      secret,
    })
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''
    const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      capturedHeaders = init.headers
      capturedBody = init.body
      return new Response('ok', { status: 200 })
    })
    // @ts-expect-error — minimal mock for the global fetch
    globalThis.fetch = fetchMock

    await fireCallback('file.saved', 'secret-doc.docx', { path: '/x.docx' })
    expect(capturedHeaders['X-GenOffice-Signature']).toBeDefined()
    expect(capturedHeaders['X-GenOffice-Signature']).toBe(signWebhookBody(secret, capturedBody))
  })

  it('fireCallback omits the signature header when no secret is set', async () => {
    saveCallback({
      fileId: 'plain-doc.docx',
      url: 'https://example.test/hook',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      capturedHeaders = init.headers
      return new Response('ok', { status: 200 })
    })
    // @ts-expect-error — minimal mock
    globalThis.fetch = fetchMock

    await fireCallback('file.saved', 'plain-doc.docx', { path: '/x.docx' })
    expect(capturedHeaders['X-GenOffice-Signature']).toBeUndefined()
  })
})

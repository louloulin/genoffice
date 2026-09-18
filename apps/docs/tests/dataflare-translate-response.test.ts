/**
 * Regression test for the embedded translation response envelope.
 *
 * `/office-engine/api/ai/translate`（GenOffice web-server）返回
 * `{ ok, units, quality }`；旧 Dataflare 端点返回 `{ code, data: { units } }`。
 * 嵌入分支曾只解析旧信封，导致 translatedText 丢失、翻译恒失败。
 *
 * Run with: `vitest run tests/dataflare-translate-response.test.ts`
 */
import { describe, expect, it } from 'vitest'

import { parseDataflareTranslateResponse } from '../src/shared/dataflare-translate-response'

describe('parseDataflareTranslateResponse', () => {
  it('parses the GenOffice web-server payload (no code/data envelope)', () => {
    const parsed = parseDataflareTranslateResponse({
      ok: true,
      units: [
        {
          unitId: 'u1',
          sourceText: 'Hello',
          status: 'translated',
          warnings: [],
          translatedText: '你好',
        },
      ],
      quality: { overallScore: 1, warnings: [] },
    })

    expect(parsed.ok).toBe(true)
    expect(parsed.units).toHaveLength(1)
    expect(parsed.units[0].translatedText).toBe('你好')
    expect(parsed.units[0].status).toBe('translated')
    expect(parsed.quality?.overallScore).toBe(1)
  })

  it('still parses the legacy Dataflare envelope', () => {
    const parsed = parseDataflareTranslateResponse({
      code: 0,
      data: {
        requestId: 'r1',
        units: [{ unitId: 'u1', sourceText: 'Hello', translatedText: '你好' }],
        quality: { overallScore: 0.9 },
      },
    })

    expect(parsed.ok).toBe(true)
    expect(parsed.units[0].translatedText).toBe('你好')
    expect(parsed.quality?.overallScore).toBe(0.9)
    expect(parsed.requestId).toBe('r1')
  })

  it('treats a non-zero legacy code as failure and keeps the message', () => {
    const parsed = parseDataflareTranslateResponse({ code: 500, msg: 'provider unavailable' })

    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('provider unavailable')
  })

  it('reports failure when the provider returns an error unit', () => {
    const parsed = parseDataflareTranslateResponse({
      ok: true,
      units: [{ unitId: 'u1', sourceText: 'Hello', status: 'failed', errorMessage: 'rate limited' }],
    })

    expect(parsed.ok).toBe(true)
    expect(parsed.units[0].translatedText).toBeUndefined()
    expect(parsed.units[0].errorMessage).toBe('rate limited')
  })

  it('surfaces the GenOffice error envelope instead of a bare status', () => {
    // The web-server answers failures with `{ error: { message, code } }`.
    // Reading only a string `error` made every 4xx/5xx degrade to
    // "Dataflare translation failed (400)" and hid the actionable reason.
    const parsed = parseDataflareTranslateResponse({
      error: { message: 'AI provider "openai" not configured', code: 'PROVIDER_NOT_CONFIGURED' },
    })

    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('AI provider "openai" not configured')
  })

  it('still accepts a bare string error', () => {
    const parsed = parseDataflareTranslateResponse({ error: 'provider unavailable' })
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('provider unavailable')
  })

  it('is defensive about malformed bodies', () => {
    expect(parseDataflareTranslateResponse(null).ok).toBe(false)
    expect(parseDataflareTranslateResponse('nope').ok).toBe(false)
    expect(parseDataflareTranslateResponse({ ok: true }).units).toEqual([])
    expect(parseDataflareTranslateResponse({ units: 'nope' }).ok).toBe(false)
  })
})

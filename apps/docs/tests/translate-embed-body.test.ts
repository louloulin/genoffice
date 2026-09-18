/**
 * Body builder for the embedded (Dataflare-hosted) translation branches.
 *
 * The three embedded call sites in `web-bridge.ts` used to hard-code
 * `memoryEnabled: true` / `qualityCheck: true` and never send the glossary
 * scope. The web-server endpoint accepts all four fields
 * (`apps/web-server/src/ai/translate-http.ts`), so an embedded user who turned
 * memory off still paid for memory lookups, turned quality off and still got
 * warnings, and a customer-scoped document was translated with every
 * customer's glossary in the prompt.
 */
import { describe, expect, it } from 'vitest'

import { buildEmbedTranslateBody } from '../src/shared/translate-embed-body'

const unit = { unitId: 'u1', kind: 'paragraph', sourceText: 'Fabric weight spec', order: 0 }

describe('buildEmbedTranslateBody', () => {
  it('defaults the two toggles to on when the caller says nothing', () => {
    const body = buildEmbedTranslateBody({ requestId: 'r1', targetLanguage: 'zh-CN' }, [unit])
    expect(body.memoryEnabled).toBe(true)
    expect(body.qualityCheck).toBe(true)
    expect(body.preserveFormatting).toBe(true)
    expect(body.sourceLanguage).toBe('auto')
  })

  it('forwards an explicit false instead of coercing it back to true', () => {
    const body = buildEmbedTranslateBody(
      {
        requestId: 'r1',
        targetLanguage: 'zh-CN',
        memoryEnabled: false,
        qualityCheck: false,
        preserveFormatting: false,
      },
      [unit],
    )
    expect(body.memoryEnabled).toBe(false)
    expect(body.qualityCheck).toBe(false)
    expect(body.preserveFormatting).toBe(false)
  })

  it('forwards the glossary / customer scope the KB resolver keys on', () => {
    const body = buildEmbedTranslateBody(
      {
        requestId: 'r1',
        targetLanguage: 'zh-CN',
        glossaryCategory: 'KERRITS',
        customerName: 'KERRITS',
      },
      [unit],
    )
    expect(body.glossaryCategory).toBe('KERRITS')
    expect(body.customerName).toBe('KERRITS')
  })

  it('omits the scope fields when they are empty, so the server keeps its default', () => {
    const body = buildEmbedTranslateBody(
      { requestId: 'r1', targetLanguage: 'zh-CN', glossaryCategory: '', customerName: undefined },
      [unit],
    )
    expect(Object.hasOwn(body, 'glossaryCategory')).toBe(false)
    expect(Object.hasOwn(body, 'customerName')).toBe(false)
  })

  it('carries the range through unit metadata, merged with existing metadata', () => {
    const body = buildEmbedTranslateBody({ requestId: 'r1', targetLanguage: 'zh-CN' }, [
      {
        ...unit,
        metadata: { path: 'body/p[0]' },
        range: { from: 3, to: 9, scope: 'paragraph' },
      },
    ])
    const [sent] = body.units as Array<Record<string, unknown>>
    expect(sent.metadata).toEqual({
      path: 'body/p[0]',
      range: { from: 3, to: 9, scope: 'paragraph' },
    })
  })

  it('leaves metadata undefined for a bare unit rather than sending an empty object', () => {
    const body = buildEmbedTranslateBody({ requestId: 'r1', targetLanguage: 'zh-CN' }, [unit])
    const [sent] = body.units as Array<Record<string, unknown>>
    expect(sent.metadata).toBeUndefined()
  })

  it('reuses the requestId as the idempotency key', () => {
    const body = buildEmbedTranslateBody({ requestId: 'batch-7', targetLanguage: 'zh-CN' }, [unit])
    expect(body.idempotencyKey).toBe('batch-7')
  })
})

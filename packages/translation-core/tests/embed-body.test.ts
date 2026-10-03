import { describe, expect, it } from 'vitest'
import {
  buildEmbedTranslateBody,
  createEmbedTranslateBatchAccumulator,
  narrowUnitStatus,
  parseEmbedTranslateStreamEvent,
} from '../src/embed-body'

const unit = { unitId: 'u1', kind: 'table-cell', sourceText: 'Fabric weight', order: 0 }

describe('buildEmbedTranslateBody', () => {
  it('forwards an explicit false for memory / quality', () => {
    // The whole point of the fields: a caller who turned memory off must not
    // silently get memory lookups because the builder hard-coded `true`.
    const body = buildEmbedTranslateBody(
      { requestId: 'r1', targetLanguage: 'zh-CN', memoryEnabled: false, qualityCheck: false },
      [unit],
    )
    expect(body.memoryEnabled).toBe(false)
    expect(body.qualityCheck).toBe(false)
  })

  it('defaults memory / quality on only when the caller is silent', () => {
    const body = buildEmbedTranslateBody({ requestId: 'r1', targetLanguage: 'zh-CN' }, [unit])
    expect(body.memoryEnabled).toBe(true)
    expect(body.qualityCheck).toBe(true)
  })

  it('forwards glossaryCategory and customerName', () => {
    const body = buildEmbedTranslateBody(
      { requestId: 'r1', targetLanguage: 'zh-CN', glossaryCategory: 'legal', customerName: 'Acme' },
      [unit],
    )
    expect(body.glossaryCategory).toBe('legal')
    expect(body.customerName).toBe('Acme')
  })

  it('keeps the unit range inside metadata so the host can echo it back', () => {
    const body = buildEmbedTranslateBody({ requestId: 'r1', targetLanguage: 'zh-CN' }, [
      { ...unit, range: { from: 1, to: 2, scope: 'selection' } },
    ])
    expect((body.units as Array<{ metadata: unknown }>)[0]?.metadata).toEqual({
      range: { from: 1, to: 2, scope: 'selection' },
    })
  })
})

describe('narrowUnitStatus', () => {
  it('drops an unknown status instead of leaking it as string', () => {
    expect(narrowUnitStatus('translated')).toBe('translated')
    expect(narrowUnitStatus('memory-hit')).toBe('memory-hit')
    expect(narrowUnitStatus('failed')).toBe('failed')
    expect(narrowUnitStatus('ok')).toBeUndefined()
    expect(narrowUnitStatus(undefined)).toBeUndefined()
  })
})

describe('parseEmbedTranslateStreamEvent', () => {
  it('parses a JSON payload', () => {
    expect(parseEmbedTranslateStreamEvent('{"type":"unit"}')).toEqual({ type: 'unit' })
  })

  it('returns null for a keep-alive / non-JSON line', () => {
    expect(parseEmbedTranslateStreamEvent(': ping')).toBeNull()
    expect(parseEmbedTranslateStreamEvent('')).toBeNull()
  })

  it('returns null rather than throwing on malformed JSON', () => {
    // A truncated frame is normal on an aborted stream; throwing here would
    // turn a user cancel into a crash.
    expect(parseEmbedTranslateStreamEvent('{"type":"uni')).toBeNull()
  })
})

describe('createEmbedTranslateBatchAccumulator', () => {
  it('collects units and reports ok when every unit translated', () => {
    const acc = createEmbedTranslateBatchAccumulator()
    const first = acc.push({
      type: 'unit',
      unit: { unitId: 'u1', sourceText: 'a', translatedText: 'A', status: 'translated' },
    })
    acc.push({ type: 'unit', unit: { unitId: 'u2', sourceText: 'b', translatedText: 'B', status: 'memory-hit' } })
    acc.push({ type: 'quality', quality: { overallScore: 0.9 } })
    acc.push({ type: 'complete', status: 'completed' })
    expect(first?.unitId).toBe('u1')
    expect(acc.settled).toBe(true)
    const result = acc.result()
    expect(result.ok).toBe(true)
    expect(result.units).toHaveLength(2)
    expect(result.quality?.overallScore).toBe(0.9)
  })

  it('reports ok:false when a unit failed even if the feed closed cleanly', () => {
    // The "says done but half the cells are untranslated" trap.
    const acc = createEmbedTranslateBatchAccumulator()
    acc.push({ type: 'unit', unit: { unitId: 'u1', sourceText: 'a', translatedText: 'A', status: 'translated' } })
    acc.push({ type: 'unit', unit: { unitId: 'u2', sourceText: 'b', status: 'failed', errorMessage: 'boom' } })
    acc.push({ type: 'complete', status: 'completed' })
    const result = acc.result()
    expect(result.ok).toBe(false)
    expect(result.units.find((u) => u.unitId === 'u2')?.errorMessage).toBe('boom')
  })

  it('surfaces an error event with its own message', () => {
    const acc = createEmbedTranslateBatchAccumulator()
    acc.push({ type: 'error', error: '额度不足' })
    expect(acc.settled).toBe(true)
    expect(acc.result().error).toBe('额度不足')
    expect(acc.result().ok).toBe(false)
  })

  it('never invents a reason for an error event that carried none', () => {
    const acc = createEmbedTranslateBatchAccumulator()
    acc.push({ type: 'error' })
    expect(acc.result().error).toBeTruthy()
  })

  it('narrows an unknown unit status to undefined rather than trusting it', () => {
    const acc = createEmbedTranslateBatchAccumulator()
    acc.push({ type: 'unit', unit: { unitId: 'u1', sourceText: 'a', translatedText: 'A', status: 'weird' } })
    expect(acc.result().units[0]?.status).toBeUndefined()
  })

  it('treats a non-completed terminal status as a failure', () => {
    const acc = createEmbedTranslateBatchAccumulator()
    acc.push({ type: 'complete', status: 'failed' })
    expect(acc.result().ok).toBe(false)
    expect(acc.result().error).toContain('failed')
  })

  it('accepts partial as a non-failure terminal status', () => {
    const acc = createEmbedTranslateBatchAccumulator()
    acc.push({ type: 'unit', unit: { unitId: 'u1', sourceText: 'a', translatedText: 'A', status: 'translated' } })
    acc.push({ type: 'complete', status: 'partial' })
    expect(acc.result().ok).toBe(true)
  })
})

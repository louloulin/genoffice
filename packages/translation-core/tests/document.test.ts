import { describe, expect, it, vi } from 'vitest'

import {
  planTranslateBatches,
  translateDocument,
  type TranslateBatchFn,
  type TranslateProgress,
  type TranslatedUnit,
} from '../src/document'
import type {
  TranslateBatchRequest,
  TranslateBatchUnitResult,
  TranslationUnit,
} from '../src/types'

function units(count: number, prefix = 'P'): TranslationUnit[] {
  return Array.from({ length: count }, (_, index) => ({
    unitId: `${prefix}${index}`,
    kind: 'paragraph' as const,
    sourceText: `Source ${index}`,
    order: index,
    range: { from: index * 10, to: index * 10 + 8, scope: 'document' as const },
  }))
}

interface FakeOpts {
  ok?: boolean
  error?: string
  throwWith?: Error
  /** 每个 unit 都回空白译文（模拟「什么都没译出来」）。 */
  blank?: boolean
  quality?: { overallScore?: number; warnings?: string[] }
}

function fakeTransport(opts: FakeOpts = {}) {
  const calls: TranslateBatchRequest[] = []
  const signals: (AbortSignal | undefined)[] = []
  const fn: TranslateBatchFn = async (request, signal, onUnit) => {
    calls.push(request)
    signals.push(signal)
    if (opts.throwWith) throw opts.throwWith
    if (opts.ok === false) return { ok: false, error: opts.error }
    if (opts.blank) {
      return {
        ok: true,
        units: request.units.map((unit) => ({
          unitId: unit.unitId,
          sourceText: unit.sourceText,
          translatedText: '   ',
          status: 'translated' as const,
        })),
      }
    }
    const settled = []
    for (let index = 0; index < request.units.length; index += 1) {
      const unit = request.units[index]!
      const result = {
        unitId: unit.unitId,
        sourceText: unit.sourceText,
        translatedText: `译文-${unit.unitId}`,
        status: 'translated' as const,
        range: unit.range ?? null,
      }
      settled.push(result)
      if (onUnit) await onUnit(result)
    }
    return { ok: true, units: settled, quality: opts.quality ?? { overallScore: 0.9, warnings: [] } }
  }
  return { fn, calls, signals }
}

describe('planTranslateBatches', () => {
  it('keeps a small document in one batch and preserves order', () => {
    const batches = planTranslateBatches(units(5))
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((unit) => unit.unitId)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4'])
  })

  it('splits on the unit cap without losing or reordering units', () => {
    const batches = planTranslateBatches(units(7), 3)
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1])
    expect(batches.flat().map((unit) => unit.unitId)).toEqual(units(7).map((unit) => unit.unitId))
  })

  it('splits on the character cap before the unit cap', () => {
    const batches = planTranslateBatches(units(4), 100, 10)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toHaveLength(4)
  })

  it('returns no batches for an empty document', () => {
    expect(planTranslateBatches([])).toEqual([])
  })
})

describe('translateDocument', () => {
  it('translates every unit, applies once in extraction order, and completes', async () => {
    const { fn } = fakeTransport()
    const applied: Array<{ units: TranslatedUnit[]; mode: string }> = []
    const progress: TranslateProgress[] = []
    const result = await translateDocument(
      { units: units(3), targetLang: 'zh-CN', qualityCheck: false },
      { translateBatch: fn, apply: (c) => void applied.push({ units: c.units, mode: c.mode }), onProgress: (e) => void progress.push(e) },
    )

    expect(result.status).toBe('completed')
    expect(result.applied).toBe(true)
    expect(result.mode).toBe('replace')
    expect(result.units.map((u) => u.unitId)).toEqual(['P0', 'P1', 'P2'])
    expect(applied).toHaveLength(1)
    expect(applied[0]!.mode).toBe('replace')
    expect(progress[0]!.status).toBe('started')
    expect(progress.at(-1)!.status).toBe('completed')
    expect(progress.at(-1)!.progress).toBe(1)
    expect(progress.at(-1)!.totalUnits).toBe(3)
  })

  it('forwards the caller options to the transport verbatim', async () => {
    const { fn, calls } = fakeTransport()
    await translateDocument(
      {
        units: units(2),
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        scene: 'drive-doc',
        memoryEnabled: true,
        qualityCheck: false,
        glossaryCategory: 'legal',
        cacheScope: 'space-42',
      },
      { translateBatch: fn, apply: () => {} },
    )
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.sourceLang).toBe('en-US')
    expect(call.targetLang).toBe('zh-CN')
    expect(call.scene).toBe('drive-doc')
    expect(call.memoryEnabled).toBe(true)
    expect(call.qualityCheck).toBe(false)
    expect(call.glossaryCategory).toBe('legal')
    // cacheScope 是多租户下的隔离键，必须原样透传而不是被默认值覆盖。
    expect(call.cacheScope).toBe('space-42')
    expect(call.preserveFormat).toBe(true)
  })

  it('passes the abort signal through to the transport', async () => {
    const { fn, signals } = fakeTransport()
    const controller = new AbortController()
    await translateDocument(
      { units: units(2), targetLang: 'zh-CN' },
      { translateBatch: fn, apply: () => {}, signal: controller.signal },
    )
    expect(signals[0]).toBe(controller.signal)
  })

  it('hands the bilingual mode through to the host apply strategy', async () => {
    const { fn } = fakeTransport()
    let seenMode: string | undefined
    const result = await translateDocument(
      { units: units(2), targetLang: 'zh-CN', applyMode: 'bilingual' },
      { translateBatch: fn, apply: (c) => void (seenMode = c.mode) },
    )
    expect(seenMode).toBe('bilingual')
    expect(result.mode).toBe('bilingual')
  })

  it('emits a per-unit running event so the host can preview live', async () => {
    const { fn } = fakeTransport()
    const progress: TranslateProgress[] = []
    await translateDocument(
      { units: units(3), targetLang: 'zh-CN' },
      { translateBatch: fn, apply: () => {}, onProgress: (e) => void progress.push(e) },
    )
    const withUnit = progress.filter((p) => p.unit)
    expect(withUnit).toHaveLength(3)
    expect(withUnit.map((p) => p.unit!.unitId)).toEqual(['P0', 'P1', 'P2'])
  })

  it('splits a large document into several transport calls and aggregates quality', async () => {
    const { fn, calls } = fakeTransport({ quality: { overallScore: 0.8, warnings: ['q'] } })
    const result = await translateDocument(
      { units: units(7), targetLang: 'zh-CN' },
      { translateBatch: fn, apply: () => {}, maxUnitsPerBatch: 3 },
    )
    expect(calls).toHaveLength(3)
    expect(result.status).toBe('completed')
    expect(result.units).toHaveLength(7)
    expect(result.quality?.overallScore).toBeCloseTo(0.8)
    expect(result.quality?.warnings).toEqual(['q'])
  })

  it('advances progress by units reported, not by units that survived', async () => {
    // A failed unit is reported by the transport but never lands in `settled`.
    // Counting `settled` would pin the bar at 0% for the whole run and only jump
    // at the end, which reads as "hung" on a document with a few bad segments.
    const mixed: TranslateBatchFn = async (request, _signal, onUnit) => {
      const results = request.units.map((unit, index) => ({
        unitId: unit.unitId,
        sourceText: unit.sourceText,
        translatedText: index === 1 ? '' : `译文-${unit.unitId}`,
        status: (index === 1 ? 'failed' : 'translated') as 'failed' | 'translated',
        errorMessage: index === 1 ? 'upstream refused' : undefined,
      }))
      for (let index = 0; index < results.length; index += 1) {
        if (onUnit) await onUnit(results[index]!)
      }
      return { ok: true, units: results }
    }
    const progress: TranslateProgress[] = []
    const result = await translateDocument(
      { units: units(4), targetLang: 'zh-CN' },
      { translateBatch: mixed, apply: () => {}, onProgress: (e) => void progress.push(e) },
    )
    expect(result.units).toHaveLength(3)
    const streamed = progress.filter((p) => p.unit)
    expect(streamed).toHaveLength(4)
    expect(streamed.at(-1)!.completedUnits).toBe(4)
    expect(streamed.at(-1)!.progress).toBe(1)
    expect(progress.at(-1)!.completedUnits).toBe(4)
  })

  it('applies the units in extraction order even when the transport answers out of order', async () => {
    const shuffled: TranslateBatchFn = async (request) => ({
      ok: true,
      units: [...request.units]
        .reverse()
        .map((u) => ({ unitId: u.unitId, sourceText: u.sourceText, translatedText: `t-${u.unitId}`, status: 'translated' as const })),
    })
    const seen: string[] = []
    await translateDocument(
      { units: units(4), targetLang: 'zh-CN' },
      { translateBatch: shuffled, apply: (c) => void seen.push(...c.units.map((u) => u.unitId)) },
    )
    // 双语插入会顶掉后面所有位置；乱序应用会写坏文档。
    expect(seen).toEqual(['P0', 'P1', 'P2', 'P3'])
  })

  it('reports a transport failure as failed and applies nothing', async () => {
    const { fn } = fakeTransport({ ok: false, error: 'provider exploded' })
    const apply = vi.fn()
    const progress: TranslateProgress[] = []
    const result = await translateDocument(
      { units: units(2), targetLang: 'zh-CN' },
      { translateBatch: fn, apply, onProgress: (e) => void progress.push(e) },
    )
    expect(result.status).toBe('failed')
    expect(result.applied).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    // provider 的原话必须透出：静默失败正是这条管线要防的。
    expect(progress.at(-1)!.status).toBe('failed')
    expect(progress.at(-1)!.error).toBe('provider exploded')
  })

  it('reports a throwing transport as failed rather than rejecting', async () => {
    const { fn } = fakeTransport({ throwWith: new Error('socket hang up') })
    const result = await translateDocument(
      { units: units(1), targetLang: 'zh-CN' },
      { translateBatch: fn, apply: () => {} },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/socket hang up/)
  })

  it('reports a cancel as cancelled and applies nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fn } = fakeTransport()
    const apply = vi.fn()
    const progress: TranslateProgress[] = []
    const result = await translateDocument(
      { units: units(3), targetLang: 'zh-CN' },
      { translateBatch: fn, apply, signal: controller.signal, onProgress: (e) => void progress.push(e) },
    )
    expect(result.status).toBe('cancelled')
    expect(apply).not.toHaveBeenCalled()
    // 用户按停止是正常结局，不是故障：终态必须是 cancelled，不能是 failed。
    expect(progress.at(-1)!.status).toBe('cancelled')
  })

  it('rejects an empty target language before calling the transport', async () => {
    const { fn, calls } = fakeTransport()
    const apply = vi.fn()
    const result = await translateDocument({ units: units(1), targetLang: '' }, { translateBatch: fn, apply })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/targetLang/)
    expect(apply).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('completes an empty document without calling the transport', async () => {
    const { fn, calls } = fakeTransport()
    const apply = vi.fn()
    const result = await translateDocument({ units: [], targetLang: 'zh-CN' }, { translateBatch: fn, apply })
    expect(result.status).toBe('completed')
    expect(result.applied).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('fails when every unit comes back blank instead of applying an empty document', async () => {
    const { fn } = fakeTransport({ blank: true })
    const apply = vi.fn()
    const result = await translateDocument(
      { units: units(2), targetLang: 'zh-CN' },
      { translateBatch: fn, apply },
    )
    expect(result.status).toBe('failed')
    expect(apply).not.toHaveBeenCalled()
  })

  it('fails when the host apply strategy throws', async () => {
    const { fn } = fakeTransport()
    const result = await translateDocument(
      { units: units(2), targetLang: 'zh-CN' },
      {
        translateBatch: fn,
        apply: () => {
          throw new Error('document is locked')
        },
      },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/locked/)
    expect(result.applied).toBe(false)
  })

  it('fails when the host verify step rejects the written-back content', async () => {
    const { fn } = fakeTransport()
    const result = await translateDocument(
      { units: units(1), targetLang: 'zh-CN' },
      { translateBatch: fn, apply: () => {}, verify: () => false },
    )
    expect(result.status).toBe('failed')
    expect(result.applied).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A8 / A45 / A46 / A47 / A49 — per-unit retry, failure reporting, checkpoint
// ---------------------------------------------------------------------------

describe('translateDocument — per-unit retry (A8)', () => {
  it('retries only the transient failure and never re-sends a success', async () => {
    const seen: string[][] = []
    let p1Attempts = 0
    const fn: TranslateBatchFn = async (request) => {
      seen.push(request.units.map((u) => u.unitId))
      return {
        ok: false,
        units: request.units.map((unit) =>
          unit.unitId === 'P1' && p1Attempts++ === 0
            ? {
                unitId: 'P1',
                sourceText: unit.sourceText,
                status: 'failed' as const,
                errorMessage: 'AI service is busy — please retry shortly.',
                errorCode: 'overloaded' as const,
              }
            : {
                unitId: unit.unitId,
                sourceText: unit.sourceText,
                translatedText: `t-${unit.unitId}`,
                status: 'translated' as const,
              },
        ),
      }
    }
    let sleeps = 0
    const result = await translateDocument(
      { units: units(3), targetLang: 'zh-CN', qualityCheck: false },
      {
        translateBatch: fn,
        apply: () => {},
        retry: { jitter: 0, sleep: async () => void (sleeps += 1) },
      },
    )

    // The first pass sends all three; the retry pass carries only P1. Re-sending
    // P0/P2 would be duplicate provider calls and duplicate billing.
    expect(seen).toEqual([['P0', 'P1', 'P2'], ['P1']])
    expect(sleeps).toBe(1)
    expect(result.status).toBe('completed')
    expect(result.units.map((u) => u.unitId).sort()).toEqual(['P0', 'P1', 'P2'])
  })

  it('stops retrying a permanently-failing unit at the budget and reports it', async () => {
    const passes: number[] = []
    const fn: TranslateBatchFn = async (request) => {
      passes.push(request.units.length)
      return {
        ok: false,
        units: request.units.map((unit) => ({
          unitId: unit.unitId,
          sourceText: unit.sourceText,
          status: 'failed' as const,
          errorMessage: 'gateway timeout',
          errorCode: 'timeout' as const,
        })),
      }
    }
    const result = await translateDocument(
      { units: units(1), targetLang: 'zh-CN', qualityCheck: false },
      {
        translateBatch: fn,
        apply: () => {},
        retry: { maxRetries: 2, jitter: 0, sleep: async () => {} },
      },
    )

    // initial + 2 retries
    expect(passes).toHaveLength(3)
    expect(result.status).toBe('failed')
    expect(result.failures).toEqual([
      { unitId: 'P0', reason: 'gateway timeout', errorCode: 'timeout', attempts: 3 },
    ])
  })

  it('does not retry a permanent failure', async () => {
    let calls = 0
    const fn: TranslateBatchFn = async (request) => {
      calls += 1
      return {
        ok: false,
        units: request.units.map((unit) => ({
          unitId: unit.unitId,
          sourceText: unit.sourceText,
          status: 'failed' as const,
          errorMessage: 'credit balance is too low',
          errorCode: 'credits' as const,
        })),
      }
    }
    const sleeps = vi.fn(async () => {})
    await translateDocument(
      { units: units(1), targetLang: 'zh-CN', qualityCheck: false },
      { translateBatch: fn, apply: () => {}, retry: { sleep: sleeps } },
    )

    expect(calls).toBe(1)
    expect(sleeps).not.toHaveBeenCalled()
  })
})

describe('translateDocument — partial failure reporting (A45)', () => {
  it('completes with failures, still applies the good units, and lists the bad one', async () => {
    const fn: TranslateBatchFn = async (request) => ({
      ok: false,
      units: request.units.map((unit) =>
        unit.unitId === 'P1'
          ? {
              unitId: 'P1',
              sourceText: unit.sourceText,
              status: 'failed' as const,
              errorMessage: 'credit balance is too low',
              errorCode: 'credits' as const,
            }
          : {
              unitId: unit.unitId,
              sourceText: unit.sourceText,
              translatedText: `t-${unit.unitId}`,
              status: 'translated' as const,
            },
      ),
    })
    const applied = vi.fn()
    const progress: TranslateProgress[] = []
    const result = await translateDocument(
      { units: units(3), targetLang: 'zh-CN', qualityCheck: false },
      {
        translateBatch: fn,
        apply: applied,
        onProgress: (e) => void progress.push(e),
      },
    )

    // Two of three units translated: the document must still be written (the
    // user asked for a translation, not an all-or-nothing gamble) — but the run
    // is not a clean `completed`, and the failure is named.
    expect(result.status).toBe('completed-with-failures')
    expect(result.applied).toBe(true)
    expect(applied).toHaveBeenCalledTimes(1)
    expect(result.units.map((u) => u.unitId)).toEqual(['P0', 'P2'])
    expect(result.failures).toEqual([
      { unitId: 'P1', reason: 'credit balance is too low', errorCode: 'credits', attempts: 1 },
    ])
    expect(progress.at(-1)!.status).toBe('completed-with-failures')
  })
})

describe('translateDocument — checkpoint resume (A46/A47/A49)', () => {
  it('reuses checkpointed units and never asks the provider for them again', async () => {
    const { fn, calls } = fakeTransport()
    const saved = new Map<string, TranslateBatchUnitResult>()
    const progress: TranslateProgress[] = []
    const result = await translateDocument(
      { units: units(3), targetLang: 'zh-CN', qualityCheck: false },
      {
        translateBatch: fn,
        apply: () => {},
        onProgress: (e) => void progress.push(e),
        checkpoint: {
          load: (unitId) =>
            unitId === 'P0'
              ? {
                  unitId: 'P0',
                  sourceText: 'Source 0',
                  translatedText: '缓存译文',
                  status: 'translated',
                }
              : null,
          save: (unitId, r) => void saved.set(unitId, r),
        },
      },
    )

    // P0 came from the checkpoint — the provider only sees the other two.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.units.map((u) => u.unitId)).toEqual(['P1', 'P2'])
    expect(result.units.map((u) => u.unitId)).toEqual(['P0', 'P1', 'P2'])
    // The resumed unit is visible to the host before any provider call (after
    // the initial `started` event).
    const resumed = progress.find((p) => p.status === 'running')
    expect(resumed?.completedUnits).toBe(1)
    // Freshly translated units are persisted for the next resume.
    expect(saved.has('P1')).toBe(true)
    expect(saved.has('P2')).toBe(true)
  })

  it('a cancel mid-run keeps the checkpoint but writes nothing to the document', async () => {
    const controller = new AbortController()
    const saved = new Map<string, TranslateBatchUnitResult>()
    let batch = 0
    const fn: TranslateBatchFn = async (request) => {
      batch += 1
      // The user hits stop right after the first batch lands.
      if (batch === 1) controller.abort()
      return {
        ok: true,
        units: request.units.map((unit) => ({
          unitId: unit.unitId,
          sourceText: unit.sourceText,
          translatedText: `t-${unit.unitId}`,
          status: 'translated' as const,
        })),
      }
    }
    const apply = vi.fn()
    const result = await translateDocument(
      { units: units(3), targetLang: 'zh-CN', qualityCheck: false },
      {
        translateBatch: fn,
        apply,
        signal: controller.signal,
        maxUnitsPerBatch: 1,
        checkpoint: { load: () => null, save: (unitId, r) => void saved.set(unitId, r) },
      },
    )

    expect(result.status).toBe('cancelled')
    expect(apply).not.toHaveBeenCalled()
    // Cancelling is not losing work: the batch that already succeeded is on the
    // checkpoint and the next run resumes from it.
    expect([...saved.keys()]).toEqual(['P0'])
  })
})

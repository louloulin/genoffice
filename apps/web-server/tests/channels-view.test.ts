/**
 * `GET /api/channels` query params + payload cap (sdk1 §B.10).
 *
 * The endpoint is public, so its response size is attacker-adjacent: any
 * client can call it. These tests pin the narrowing (`?prefix=`), the
 * histogram (`?includeCounts=true`), and the 32 KB ceiling that keeps the
 * endpoint proportional as the registry grows.
 *
 * The view logic is a pure function in `src/common/channels-view.ts`, so
 * these run in-process — no server spawn.
 */
import { describe, expect, it } from 'vitest'
import { buildChannelsView, CHANNELS_MAX_BYTES } from '../src/common/channels-view'

const SAMPLE = ['ai:chat', 'ai:translate', 'ai:agent', 'collab:join', 'collab:leave', 'files:list', 'health']

interface ChannelsBody {
  protocolVersion: number
  minClientVersion: number
  channels: string[]
  prefix?: string
  counts?: Record<string, number>
  total?: number
  error?: { code: string; channel: string; bytes: number; maxBytes: number }
}

function parse(body: string): ChannelsBody {
  return JSON.parse(body) as ChannelsBody
}

describe('buildChannelsView', () => {
  it('returns every channel with the protocol envelope when no prefix is given', () => {
    const view = buildChannelsView(SAMPLE)
    expect(view.status).toBe(200)
    const body = parse(view.body)
    expect(body.protocolVersion).toBe(1)
    expect(body.minClientVersion).toBe(1)
    expect(body.channels).toEqual(SAMPLE)
    // No prefix echoed, no counts unless asked for.
    expect(body.prefix).toBeUndefined()
    expect(body.counts).toBeUndefined()
    expect(body.total).toBeUndefined()
  })

  it('filters to channels starting with the prefix and echoes the prefix back', () => {
    const view = buildChannelsView(SAMPLE, { prefix: 'ai:' })
    const body = parse(view.body)
    expect(view.status).toBe(200)
    expect(body.channels).toEqual(['ai:chat', 'ai:translate', 'ai:agent'])
    expect(body.prefix).toBe('ai:')
  })

  it('returns 200 with an empty list for a prefix that matches nothing', () => {
    const view = buildChannelsView(SAMPLE, { prefix: 'nope:' })
    const body = parse(view.body)
    expect(view.status).toBe(200)
    expect(body.channels).toEqual([])
    expect(body.error).toBeUndefined()
  })

  it('does not mutate the caller-supplied channel list', () => {
    const input = [...SAMPLE]
    buildChannelsView(input).body
    expect(input).toEqual(SAMPLE)
  })

  it('attaches a per-namespace histogram and total when includeCounts is set', () => {
    const view = buildChannelsView(SAMPLE, { includeCounts: true })
    const body = parse(view.body)
    expect(body.counts).toEqual({ ai: 3, collab: 2, files: 1, '': 1 })
    expect(body.total).toBe(SAMPLE.length)
  })

  it('histograms only the filtered subset when prefix and includeCounts are combined', () => {
    const view = buildChannelsView(SAMPLE, { prefix: 'collab:', includeCounts: true })
    const body = parse(view.body)
    expect(body.counts).toEqual({ collab: 2 })
    expect(body.total).toBe(2)
  })

  it('buckets channels without a namespace separator under the empty string', () => {
    const view = buildChannelsView(['health', 'ready', 'ai:chat'], { includeCounts: true })
    const body = parse(view.body)
    expect(body.counts).toEqual({ '': 2, ai: 1 })
  })

  it('answers 413 RESPONSE_TOO_LARGE when the serialized list exceeds the cap', () => {
    // Build a list guaranteed to blow past 32 KB: 2000 channels of ~60
    // chars each ≈ 120 KB of names alone.
    const huge = Array.from({ length: 2000 }, (_, i) => `ns${i}:channel-with-a-fairly-long-name-${i.toString().padStart(6, '0')}`)
    const view = buildChannelsView(huge)
    expect(view.status).toBe(413)
    const body = parse(view.body)
    expect(body.channels).toBeUndefined()
    expect(body.error?.code).toBe('RESPONSE_TOO_LARGE')
    expect(body.error?.channel).toBe('/api/channels')
    expect(body.error?.bytes).toBeGreaterThan(CHANNELS_MAX_BYTES)
    expect(body.error?.maxBytes).toBe(CHANNELS_MAX_BYTES)
  })

  it('a narrow prefix rescues a list that would otherwise exceed the cap', () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `ns${i}:channel-with-a-fairly-long-name-${i.toString().padStart(6, '0')}`)
    expect(buildChannelsView(huge).status).toBe(413)
    const narrowed = buildChannelsView(huge, { prefix: 'ns7:' })
    expect(narrowed.status).toBe(200)
    expect(parse(narrowed.body).channels.length).toBe(1)
  })

  it('measures the cap in bytes, not UTF-16 code units', () => {
    // Multi-byte names must count for their UTF-8 length. 1000 channels of
    // 20 CJK chars are ~27 000 UTF-16 code units (under a naive `.length`
    // cap of 32 KB) but ~66 000 UTF-8 bytes, which must trip the cap.
    const cjk = Array.from({ length: 1000 }, (_, i) => `n${i}:${'文'.repeat(20)}`)
    const raw = JSON.stringify({ protocolVersion: 1, minClientVersion: 1, channels: cjk })
    expect(raw.length).toBeLessThan(CHANNELS_MAX_BYTES) // naive check would pass
    expect(Buffer.byteLength(raw)).toBeGreaterThan(CHANNELS_MAX_BYTES)
    expect(buildChannelsView(cjk).status).toBe(413)
  })
})

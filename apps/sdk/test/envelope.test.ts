import { describe, expect, it } from 'vitest'
import { ENVELOPE_VERSION, isEnvelope, makeCommand, makeCommandResult, makeEvent } from '../src/envelope'

describe('envelope', () => {
  it('makeEvent stamps v=1.0 and host→editor dir', () => {
    const env = makeEvent('host.theme', { theme: 'dark' })
    expect(env.v).toBe(ENVELOPE_VERSION)
    expect(env.dir).toBe('host→editor')
    expect(env.kind).toBe('event')
  })

  it('makeCommand carries a correlationId', () => {
    const env = makeCommand('setTheme', { theme: 'dark' }, 'cmd-1')
    expect(env.correlationId).toBe('cmd-1')
    expect(env.payload).toEqual({ name: 'setTheme', args: { theme: 'dark' } })
  })

  it('makeCommandResult omits undefined error and result fields', () => {
    const env = makeCommandResult('cmd-1', true, { ok: 1 })
    expect(env.correlationId).toBe('cmd-1')
    expect(env.payload).toEqual({ ok: true, result: { ok: 1 } })
  })

  it('isEnvelope accepts valid envelopes', () => {
    expect(isEnvelope({ v: '1.0', dir: 'editor→host', kind: 'event', payload: {} })).toBe(true)
    expect(isEnvelope({ v: '1.0', dir: 'host→editor', kind: 'command', correlationId: 'x', payload: {} })).toBe(true)
    expect(isEnvelope({ v: '1.0', dir: 'host→editor', kind: 'command-result', correlationId: 'x', payload: { ok: true } })).toBe(true)
  })

  it('isEnvelope rejects malformed messages', () => {
    expect(isEnvelope(null)).toBe(false)
    expect(isEnvelope({})).toBe(false)
    expect(isEnvelope({ v: '2.0', dir: 'editor→host', kind: 'event', payload: {} })).toBe(false)
    expect(isEnvelope({ v: '1.0', dir: 'wrong', kind: 'event', payload: {} })).toBe(false)
    expect(isEnvelope({ v: '1.0', dir: 'editor→host', kind: 'nope', payload: {} })).toBe(false)
  })
})

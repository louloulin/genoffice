import { describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolError,
  validateAgentRequest,
  type AgentRequest,
  type AgentRunner,
} from '../src/agent-protocol'

describe('AGENT_PROTOCOL_VERSION', () => {
  it('is "genoffice.agent.v1"', () => {
    expect(AGENT_PROTOCOL_VERSION).toBe('genoffice.agent.v1')
  })
})

describe('validateAgentRequest', () => {
  const base: AgentRequest = {
    v: 'genoffice.agent.v1',
    goal: 'find every KPI in Q3.xlsx',
    maxSteps: 8,
  }

  it('round-trips a minimal request', () => {
    expect(validateAgentRequest(base)).toEqual(base)
  })

  it('preserves context, signal, callbacks when present', () => {
    const ac = new AbortController()
    const req: AgentRequest = {
      ...base,
      context: { locale: 'zh-CN', skills: ['genoffice.skill.doc-format'] },
      signal: ac.signal,
      onToken: () => {},
      onStep: () => {},
    }
    expect(validateAgentRequest(req)).toEqual(req)
  })

  it('rejects wrong version', () => {
    expect(() => validateAgentRequest({ ...base, v: 'genoffice.agent.v2' as never })).toThrow(/unsupported protocol version/)
  })

  it('rejects empty goal', () => {
    expect(() => validateAgentRequest({ ...base, goal: '' })).toThrow(/goal is required/)
  })

  it('rejects out-of-range maxSteps', () => {
    expect(() => validateAgentRequest({ ...base, maxSteps: 0 })).toThrow(/maxSteps/)
    expect(() => validateAgentRequest({ ...base, maxSteps: 9999 })).toThrow(/maxSteps/)
  })
})

describe('AgentProtocolError', () => {
  it('has the expected name', () => {
    expect(new AgentProtocolError('x').name).toBe('AgentProtocolError')
    expect(new AgentProtocolError('x')).toBeInstanceOf(Error)
  })
})

describe('AgentRunner shape', () => {
  it('accepts an implementation that returns a stub AgentResult', async () => {
    const runner: AgentRunner = {
      id: 'stub',
      label: 'Stub Runner',
      run: async () => ({
        v: 'genoffice.agent.v1',
        finalMessage: { role: 'assistant', text: 'done' },
        steps: [],
        stopReason: 'completed',
        durationMs: 0,
      }),
    }
    const result = await runner.run(validateAgentRequest({ v: 'genoffice.agent.v1', goal: 'x', maxSteps: 1 }))
    expect(result.stopReason).toBe('completed')
  })
})

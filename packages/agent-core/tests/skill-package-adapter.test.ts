import { describe, expect, it, vi } from 'vitest'
import type { SkillContext, SkillPackage } from '@genoffice/agent-skills/skill-protocol'
import {
  AgentLoop,
  adaptSkillPackage,
  defaultSkillToolName,
  skillDefinitionToTool,
  skillInputsToJsonSchema,
  type AgentMessage,
  type AgentSkill,
  type AgentStreamCallbacks,
  type AgentToolCall,
  type AgentTransport,
} from '../src'

/**
 * End-to-end coverage for the marketplace SkillPackage -> AgentLoop adapter.
 *
 * The official `@genoffice/skill-text-summarize` package lives in this
 * monorepo (`packages/skill-text-summarize`), but it cannot be imported here:
 * its `dist/` is gitignored (so the built entry is absent on a clean checkout)
 * and importing its source drags the whole `@genoffice/agent-skills` tree —
 * and with it `agent-runtime`'s JSX and `file-parse`'s pdfjs types — into this
 * package's `tsc` program, turning `typecheck` red for reasons unrelated to the
 * adapter. The fixture below is therefore a faithful construction of that
 * package's `SkillPackage` (same id, same input slots, same declared outputs).
 * Typing it as `SkillPackage` is a compile-time guarantee that it matches the
 * published protocol — a mismatch fails `npm run typecheck`.
 */

/** transport scripted turn by turn; exposes the requests for assertions */
function scriptedTransport(
  script: Array<(cb: AgentStreamCallbacks) => void>,
): AgentTransport & { requests: Array<{ messageCount: number; toolCount: number }> } {
  let turn = 0
  const transport = {
    requests: [] as Array<{ messageCount: number; toolCount: number }>,
    stream(
      request: { system: string; messages: AgentMessage[]; tools: unknown[] },
      cb: AgentStreamCallbacks,
    ) {
      transport.requests.push({ messageCount: request.messages.length, toolCount: request.tools.length })
      const step = script[turn++]
      if (step) queueMicrotask(() => step(cb))
      return { cancel: () => queueMicrotask(() => cb.onDone()) }
    },
  }
  return transport
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function makeSkillContext(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    invocationId: 'inv-1',
    user: { id: 'u1', locale: 'en', permissions: [] },
    workspace: {
      files: [],
      open: async (id) => ({ id, name: id, mimeType: 'text/plain' }),
    },
    llm: {
      chat: async () => ({ content: 'A SHORT SUMMARY' }),
      streamChat: async function* () {
        yield { delta: 'A SHORT SUMMARY', type: 'done' as const }
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => false,
      has: async () => false,
      clear: async () => {},
    },
    emitProgress: () => {},
    cancel: () => {},
    cancelled: false,
    ...overrides,
  }
}

/** Faithful `genoffice.skill.text-summarize` package (see docs/skills/official/text-summarize.md). */
const TEXT_SUMMARIZE_PKG: SkillPackage = {
  skill: {
    id: 'genoffice.skill.text-summarize',
    version: '1.0.0',
    name: { en: 'Text Summarizer', zh: 'Text Summary (zh)' },
    description: { en: 'Generate short/medium/long/bullets summaries.', zh: 'Summary (zh).' },
    triggers: ['summarize', 'tldr', 'summary'],
    inputs: [
      {
        name: 'text',
        schema: {
          type: 'string',
          description: { en: 'Source text to summarize.', zh: 'Source text (zh).' },
        },
        required: true,
      },
      {
        name: 'length',
        schema: {
          type: 'enum',
          description: { en: 'Summary length.' },
          default: 'short',
          values: [
            { value: 'short' },
            { value: 'medium' },
            { value: 'long' },
            { value: 'bullets' },
          ],
        },
      },
      {
        name: 'maxWords',
        schema: { type: 'number', integer: true, description: { en: 'Optional hard cap.' } },
      },
    ],
    outputs: [
      { name: 'summary', schema: { type: 'string' } },
      { name: 'tokensUsed', schema: { type: 'number', integer: true } },
    ],
    execute: async (ctx, inputs) => {
      const text = String(inputs.text ?? '')
      const length = String(inputs.length ?? 'short')
      const { content } = await ctx.llm.chat([
        { role: 'user', text: `Summarize (${length}): ${text}` },
      ])
      return { summary: content, tokensUsed: content.length }
    },
  },
}

const adapterOptions = () => ({ createContext: () => makeSkillContext() })

describe('defaultSkillToolName', () => {
  it('takes the last dot-segment and sanitizes it', () => {
    expect(defaultSkillToolName('genoffice.skill.text-summarize')).toBe('text_summarize')
    expect(defaultSkillToolName('plain')).toBe('plain')
    expect(defaultSkillToolName('a.b.c d/e')).toBe('c_d_e')
  })
})

describe('skillInputsToJsonSchema', () => {
  it('maps each input slot onto JSON Schema with required + enum + integer', () => {
    const schema = skillInputsToJsonSchema(TEXT_SUMMARIZE_PKG.skill.inputs)
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Source text to summarize.' },
        length: { type: 'string', enum: ['short', 'medium', 'long', 'bullets'], default: 'short' },
        maxWords: { type: 'integer' },
      },
    })
  })
})

describe('skillDefinitionToTool', () => {
  it('maps name / description / schema from the skill definition', () => {
    const { tool } = skillDefinitionToTool(TEXT_SUMMARIZE_PKG.skill, adapterOptions())
    expect(tool.name).toBe('text_summarize')
    expect(tool.description).toContain('Text Summarizer')
    expect(tool.description).toContain('summarize')
    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['text'] })
  })

  it('resolves i18n labels for the host locale and honours a tool name override', () => {
    const { tool } = skillDefinitionToTool(TEXT_SUMMARIZE_PKG.skill, {
      ...adapterOptions(),
      locale: 'zh-Hans',
      toolName: 'summarize_text',
    })
    expect(tool.name).toBe('summarize_text')
    expect(tool.description).toContain('Text Summary (zh)')
    expect(
      (tool.inputSchema.properties as Record<string, { description?: string }>).text?.description,
    ).toBe('Source text (zh).')
  })

  it('executes the skill and serializes its declared output', async () => {
    const { executeTool } = skillDefinitionToTool(TEXT_SUMMARIZE_PKG.skill, adapterOptions())
    const execution = await executeTool({
      id: 't1',
      name: 'text_summarize',
      input: { text: 'A long article', length: 'short' },
    })
    expect(execution.isError).toBeFalsy()
    expect(execution.summary).toBe('Text Summarizer')
    expect(execution.output).toBe('A SHORT SUMMARY')
  })

  it('maps a thrown skill error to an isError result instead of throwing', async () => {
    const failing = {
      ...TEXT_SUMMARIZE_PKG.skill,
      execute: async () => {
        throw new Error('PROVIDER_FAILURE: model unavailable')
      },
    }
    const { executeTool } = skillDefinitionToTool(failing, adapterOptions())
    const execution = await executeTool({ id: 't1', name: 'text_summarize', input: { text: 'x' } })
    expect(execution.isError).toBe(true)
    expect(execution.output).toContain('PROVIDER_FAILURE')
  })

  it('refuses to start when the run is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { executeTool } = skillDefinitionToTool(TEXT_SUMMARIZE_PKG.skill, adapterOptions())
    const execution = await executeTool(
      { id: 't1', name: 'text_summarize', input: { text: 'x' } },
      controller.signal,
    )
    expect(execution.isError).toBe(true)
    expect(execution.output).toMatch(/cancelled/)
  })
})

describe('adaptSkillPackage', () => {
  it('produces an AgentSkill whose prompt names and targets the tool', () => {
    const skill: AgentSkill = adaptSkillPackage(TEXT_SUMMARIZE_PKG, adapterOptions())
    expect(skill.id).toBe('genoffice.skill.text-summarize')
    expect(skill.tools).toHaveLength(1)
    expect(skill.tools[0]!.name).toBe('text_summarize')
    expect(skill.systemPrompt).toContain('Text Summarizer')
    expect(skill.systemPrompt).toContain('`text_summarize`')
  })

  it('drives the adapted skill through the AgentLoop tool-execution path end to end', async () => {
    const transport = scriptedTransport([
      (cb) => {
        cb.onDelta('Calling the summarizer')
        cb.onToolCall({
          id: 't1',
          name: 'text_summarize',
          input: { text: 'A long article about widgets', length: 'short' },
        })
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('Done')
        cb.onDone()
      },
    ])
    const contexts: AgentToolCall[] = []
    const skill = adaptSkillPackage(TEXT_SUMMARIZE_PKG, {
      createContext: (call) => {
        contexts.push(call)
        return makeSkillContext()
      },
    })
    const onToolExecuted = vi.fn()
    const loop = new AgentLoop({ transport, skill, events: { onToolExecuted } })
    loop.run('summarize this document')
    await flush()

    // the model received exactly the adapted tool
    expect(transport.requests[0]!.toolCount).toBe(1)
    // the skill executed once, with the model-supplied inputs
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.input).toEqual({ text: 'A long article about widgets', length: 'short' })
    // the tool outcome was surfaced to the loop's events with the summary text
    expect(onToolExecuted).toHaveBeenCalledTimes(1)
    const event = onToolExecuted.mock.calls[0]![0] as { call: AgentToolCall; execution: { output: string; isError?: boolean } }
    expect(event.call.name).toBe('text_summarize')
    expect(event.execution.isError).toBeFalsy()
    expect(event.execution.output).toBe('A SHORT SUMMARY')
    // the run finished after feeding the result back to the model
    expect(loop.busy).toBe(false)
    expect(loop.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Done' })
  })

  it('marks executions as mutating when the host opts in', async () => {
    const skill = adaptSkillPackage(TEXT_SUMMARIZE_PKG, {
      ...adapterOptions(),
      mutated: true,
    })
    const execution = await skill.executeTool({
      id: 't1',
      name: 'text_summarize',
      input: { text: 'x' },
    })
    expect(execution.mutated).toBe(true)
  })
})

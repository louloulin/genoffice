# Agent Protocol v1

`genoffice.agent.v1` is a JSON envelope that any third-party Agent
runner can speak to interoperate with the GenOffice runtime. The
runtime implements a ReAct loop; alternative runners (LangChain,
AutoGPT, hand-rolled) can plug in via `AgentRunner`.

## Request envelope

```ts
import type { AgentRequest } from '@genoffice/agent-core'

const req: AgentRequest = {
  v: 'genoffice.agent.v1',
  goal: 'Find every KPI in Q3.xlsx and rank by growth',
  context: {
    files: [{ id: 'f1', name: 'Q3.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    skills: ['genoffice.skill.doc-format'],
    locale: 'zh-CN',
  },
  maxSteps: 8,
  onToken: (t) => process.stdout.write(t),
  onStep: (s) => console.log(`step ${s.index}`, s.tool),
  signal: controller.signal,
}
```

## Step shape

```ts
interface AgentStep {
  index: number
  thought: string             // the agent's reasoning
  tool: string | 'final'      // which tool was invoked
  input: Record<string, unknown>
  output: unknown
  durationMs: number
  error?: { code: string; message: string }
  ts: number
}
```

## Result

```ts
interface AgentResult {
  v: 'genoffice.agent.v1'
  finalMessage: AgentMessage
  steps: AgentStep[]
  stopReason: 'completed' | 'max-steps' | 'cancelled' | 'error' | 'no-tool'
  durationMs: number
  tokensUsed?: number
}
```

## Runner interface

```ts
import type { AgentRunner } from '@genoffice/agent-core'

const myRunner: AgentRunner = {
  id: 'my-loop',
  label: 'My Agent Loop',
  run: async (req) => { /* … */ return result },
}
```

The GenOffice runtime discovers runners via the same provider-plugin
registry as LLMs (`packages/ai-provider/src/provider-plugin.ts`).

## Validation

`validateAgentRequest(input)` rejects requests with the wrong version,
empty goals, or out-of-range `maxSteps` (must be 1..1000). Use this in
your runner's entry point to fail fast.

## Versioning

- `genoffice.agent.v1` is the stable contract.
- Optional fields may be added; required fields cannot be renamed or
  removed until v2.

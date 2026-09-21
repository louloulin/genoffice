# Agent 协议 v1

`genoffice.agent.v1` 是一个 JSON 信封，任何第三方 Agent runner 都可以用它来和 GenOffice 运行时互通。运行时实现 ReAct 循环；其他 runner（LangChain、AutoGPT、自研）可以通过 `AgentRunner` 接入。

## 请求信封

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

## Step 形态

```ts
interface AgentStep {
  index: number
  thought: string             // agent 的推理
  tool: string | 'final'      // 调用的工具
  input: Record<string, unknown>
  output: unknown
  durationMs: number
  error?: { code: string; message: string }
  ts: number
}
```

## 结果

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

## Runner 接口

```ts
import type { AgentRunner } from '@genoffice/agent-core'

const myRunner: AgentRunner = {
  id: 'my-loop',
  label: 'My Agent Loop',
  run: async (req) => { /* … */ return result },
}
```

GenOffice 运行时通过与 LLM 相同的 provider-plugin registry 发现 runner（`packages/ai-provider/src/provider-plugin.ts`）。

## 校验

`validateAgentRequest(input)` 会拒绝版本不匹配、目标为空、或 `maxSteps` 越界（必须是 1..1000）。建议在 runner 入口先调用以快速失败。

## 版本策略

- `genoffice.agent.v1` 是稳定契约。
- 可以新增可选字段；必填字段在 v2 之前不能重命名或删除。

# AI Skills 协议

Skill 是一个自包含的 AI 能⼒——格式化报告、翻译合同、从幻灯片生成测验等。`@genoffice/agent-skills` 里的 Skill 协议定义了可移植的形态，可工作于 monorepo 内，也可作为独立 npm 包发布。

## SkillDefinition

```ts
// packages/agent-skills/src/skill-protocol.ts
export interface SkillDefinition {
  id: string                       // reverse-DNS，例如 'genoffice.skill.doc-format'
  version: string                  // semver
  name: I18nString                 // { 'en-US': …, 'zh-CN': … }
  description: I18nString
  triggers: string[]               // 触发短语
  inputs: SkillInputSlot[]         // 类型化输入
  outputs: SkillOutput[]           // 类型化输出
  tools?: string[]                 // 本 Skill 用到的其他 skill / tool id
  requiredPermissions?: string[]
  tags?: string[]
  readme?: string                  // 市场卡片的 markdown 正文
  execute: (ctx: SkillContext, inputs: Record<string, unknown>) => Promise<Record<string, unknown>>
}
```

## SkillContext（宿主桥）

```ts
export interface SkillContext {
  invocationId: string
  user: { id: string; locale: string; permissions: string[] }
  workspace: { files: FileRef[]; currentFile?: FileRef; open(id: string): Promise<FileRef> }
  llm: { chat(messages, opts): Promise<{content: string}>; streamChat(messages, opts): AsyncIterable<{delta, type}> }
  storage: SkillKVStore            // 草稿状态，跨调用持久化
  emitProgress: (event: ProgressEvent) => void
  cancel(): void
  readonly cancelled: boolean
}
```

## 编写

1. 用 JSON-schema 风格的类型（`string`、`number`、`boolean`、`array`、`object`、`file`、`enum`）定义输入输出。
2. 实现 `execute(ctx, inputs)`。抛 `SkillError(code, message)` 会以结构化错误反馈给调用方。
3. 在启动时注册，或发布为 `@genoffice/skill-<name>`，默认导出 `SkillPackage`。

## 市场

官方 Skill 见 [官方 Skills](/zh/skills/official)。第三方 Skill 可通过 PR 投稿到 `docs/skills/community.md`。

## 错误

```ts
export class SkillError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'PERMISSION_DENIED' | 'NOT_FOUND' |
                 'TIMEOUT' | 'CANCELLED' | 'PROVIDER_FAILURE' | 'INTERNAL'
  readonly details?: Record<string, unknown>
}
```

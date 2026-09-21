# AI Skills Protocol

A Skill is a self-contained AI capability — formatting a report,
translating a contract, generating quizzes from a deck, etc. The
Skill Protocol in `@genoffice/agent-skills` defines a portable shape
that works in-repo or as a standalone npm package.

## SkillDefinition

```ts
// packages/agent-skills/src/skill-protocol.ts
export interface SkillDefinition {
  id: string                       // reverse-DNS, e.g. 'genoffice.skill.doc-format'
  version: string                  // semver
  name: I18nString                 // { 'en-US': …, 'zh-CN': … }
  description: I18nString
  triggers: string[]               // match phrases
  inputs: SkillInputSlot[]         // typed inputs
  outputs: SkillOutput[]           // typed outputs
  tools?: string[]                 // other skill / tool ids this skill uses
  requiredPermissions?: string[]
  tags?: string[]
  readme?: string                  // markdown marketplace card body
  execute: (ctx: SkillContext, inputs: Record<string, unknown>) => Promise<Record<string, unknown>>
}
```

## SkillContext (the host bridge)

```ts
export interface SkillContext {
  invocationId: string
  user: { id: string; locale: string; permissions: string[] }
  workspace: { files: FileRef[]; currentFile?: FileRef; open(id: string): Promise<FileRef> }
  llm: { chat(messages, opts): Promise<{content: string}>; streamChat(messages, opts): AsyncIterable<{delta, type}> }
  storage: SkillKVStore            // scratch state, persisted between calls
  emitProgress: (event: ProgressEvent) => void
  cancel(): void
  readonly cancelled: boolean
}
```

## Authoring

1. Define inputs / outputs with the JSON-schema-ish types
   (`string`, `number`, `boolean`, `array`, `object`, `file`, `enum`).
2. Implement `execute(ctx, inputs)`. Throwing `SkillError(code, message)`
   surfaces structured failures to the caller.
3. Register at boot or publish as `@genoffice/skill-<name>` with a
   default export of `SkillPackage`.

## Marketplace

Official Skills are listed under
[Official Skills](/skills/official). Third-party Skills can be
submitted via PR to `docs/skills/community.md`.

## Errors

```ts
export class SkillError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'PERMISSION_DENIED' | 'NOT_FOUND' |
                 'TIMEOUT' | 'CANCELLED' | 'PROVIDER_FAILURE' | 'INTERNAL'
  readonly details?: Record<string, unknown>
}
```

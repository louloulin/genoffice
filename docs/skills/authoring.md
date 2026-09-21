# Authoring a Skill

Skills are the unit of AI extension in GenOffice. Each Skill is a single
typed capability — summarise text, translate a document, validate YAML, etc.
Skills live in two places:

1. **Bundled** — under `packages/agent-skills/src/extensions/` (the legacy
   pi-runtime extensions, in-repo only).
2. **Marketplace** — standalone npm packages that implement
   `SkillPackage` from `@genoffice/agent-skills`. Hosts load them at boot
   via `genoffice.skills.json`.

This guide covers the marketplace path.

## The `SkillDefinition` contract

```ts
import type { SkillContext, SkillDefinition, SkillPackage } from '@genoffice/agent-skills'

const skill: SkillDefinition = {
  id: 'genoffice.skill.my-skill',
  version: '0.1.0',
  name: { 'en-US': 'My Skill', 'zh-CN': '我的技能' },
  description: { 'en-US': '…', 'zh-CN': '…' },
  triggers: ['do thing', '做某事'],
  inputs: [
    { name: 'text', schema: { type: 'string', required: true }, required: true },
  ],
  outputs: [
    { name: 'result', schema: { type: 'string' } },
  ],
  execute: async (ctx, inputs) => {
    const text = inputs.text as string
    const res = await ctx.llm.chat([{ role: 'user', text }])
    return { result: res.content ?? '' }
  },
}

const pkg: SkillPackage = { skill }
export default pkg
```

`execute` receives a `SkillContext` with:

- `ctx.llm.chat(messages, opts)` — one-shot chat completion
- `ctx.llm.streamChat(messages, opts)` — token stream
- `ctx.storage` — KV store scoped to this invocation
- `ctx.workspace` — file references the user has granted
- `ctx.user.permissions` — capability strings granted to the user
- `ctx.emitProgress(event)` — surface progress to the UI
- `ctx.cancel()` — abort the in-flight invocation

## `SkillError` for structured failures

Throw `SkillError(code, message, details?)` for any failure. The web-server
maps these to structured REST errors:

```ts
throw new SkillError('INVALID_ARGUMENT', 'text must be non-empty')
throw new SkillError('PROVIDER_FAILURE', 'openai rate-limited')
```

Codes: `INVALID_ARGUMENT` / `PERMISSION_DENIED` / `NOT_FOUND` / `TIMEOUT` /
`CANCELLED` / `PROVIDER_FAILURE` / `INTERNAL`.

## Package layout

```
my-skill/
├── package.json          # peerDeps: { "@genoffice/agent-skills": "*" }
├── tsconfig.json
├── vitest.config.ts
├── scripts/build.mjs     # tsc + esbuild
├── README.md
├── src/
│   └── index.ts          # exports SkillPackage
└── tests/
    └── skill.test.ts
```

Build with `tsc && node scripts/build.mjs`. The package ships ESM + CJS
+ `.d.ts` so it works under Node, browser bundlers, and TS projects.

## Loading via the marketplace

Drop a `genoffice.skills.json` file in your project root, `$DATA_DIR`, or
set `GENOFFICE_SKILLS_CONFIG=/path/to/config.json`:

```json
{
  "skills": [
    { "name": "@genoffice/skill-markdown-format" },
    { "name": "@scope/my-private-skill", "version": "^1.0.0" }
  ]
}
```

The web-server resolves each entry at boot, dynamically `import()`s the
module, and registers the default export's `skill` property into the
`SkillRegistry` exposed at `POST /api/v1/ai/skill/:name`. Failed imports
are logged but never block boot.

## Loading programmatically

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as markdownFormat } from '@genoffice/skill-markdown-format'

const registry = createSkillRegistry()
registry.register(markdownFormat)
```

## Testing Skills

The SkillContext is easy to mock — see the test suites in
`packages/skill-*/tests/` for the canonical pattern.

## See also

- [Protocol reference](/api/ai-skills-protocol)
- [Official Skills marketplace](/skills/official)
- [Authoring example](https://github.com/genspark-ai/genoffice/tree/main/examples/custom-skill)

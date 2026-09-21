# `@genoffice/skill-doc-word-counter` — third-party skill template

Worked example of shipping a `SkillPackage` as an npm package.

## Build

```sh
pnpm install
pnpm run build       # → dist/{index.js,index.mjs,index.cjs,index.d.ts}
```

## Install

Add to your web-server's `genoffice.skills.json`:

```json
{
  "skills": [
    { "name": "@genoffice/skill-doc-word-counter", "version": "^0.1.0" }
  ]
}
```

On boot the marketplace loader dynamically imports the package, registers
the default export into `getDefaultSkillRegistry()`, and the skill becomes
available in the renderer.

## What's inside

`src/index.ts` implements `SkillPackage` with:

- `skill.id` / `version` / `name` / `description` — UI metadata (i18n).
- `triggers` — natural-language phrases that invoke the skill.
- `inputs` / `outputs` — typed I/O schema (JSON Schema-like).
- `requiredPermissions` — RBAC scopes the operator must grant.
- `execute(ctx, inputs)` — the skill body; receive `ctx.workspace`,
  `ctx.llm`, `ctx.storage`, `ctx.emitProgress`, and emit a typed result.

The example counts words in a `.docx` and returns per-paragraph counts.

## Test

The package is plain TypeScript. Write a vitest suite that constructs a
fake `ctx` and asserts on the output shape:

```ts
const ctx = {
  workspace: { open: async () => ({ bytes: new TextEncoder().encode('hello world\n\nfoo bar baz') }) },
  emitProgress: () => {},
}
const { count, byParagraph } = await skill.execute(ctx, { file: 'any.docx' })
expect(count).toBe(5)
```

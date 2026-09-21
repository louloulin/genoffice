# `genoffice.skill.markdown-format` — Markdown Formatter

> Normalise Markdown (headings, bullets, code fences, links, whitespace).

**npm**: [`@genoffice/skill-markdown-format`](https://www.npmjs.com/package/@genoffice/skill-markdown-format)
**Source**: [`packages/skill-markdown-format/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-markdown-format)
**Tests**: 7 / 7 passing

## Triggers

| Phrase | Locale |
|---|---|
| `format markdown` | en |
| `clean up markdown` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | Raw Markdown text. |
| `rules` | `array` | no | Subset of `heading-case`, `bullet-spacing`, `code-fence`, `link-normalize`, `trailing-newline`. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `text` | `string` | Normalized Markdown text. |
| `appliedRules` | `array<string>` | Which rules actually fired. |

## Install

```sh
npm install @genoffice/skill-markdown-format @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as markdownformat } from '@genoffice/skill-markdown-format'

const registry = createSkillRegistry()
registry.register(markdownformat)

const result = await registry.invoke('genoffice.skill.markdown-format', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Pre-commit Markdown cleanup, README normalisation, doc-site pre-processing.

## When not to use

- Heavy restructuring (use text-summarize first).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

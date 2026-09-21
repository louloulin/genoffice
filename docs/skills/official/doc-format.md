# `genoffice.skill.doc-format` — Document Formatter

> Applies consistent headings, lists, and code-block styling to a `.docx`.

**npm**: [`@genoffice/skill-doc-format`](https://www.npmjs.com/package/@genoffice/skill-doc-format)
**Source**: [`packages/skill-doc-format/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-doc-format)
**Tests**: 10 / 10 passing

## Triggers

| Phrase | Locale |
|---|---|
| `format document` | en |
| `clean up document` | en |
| `文档排版` | zh |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | Raw document text (Markdown or plain prose). |
| `style` | enum | no | One of `report` (default), `memo`, `article`. |
| `locale` | enum | no | One of `en-US` (default), `zh-CN`. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `text` | string | Reformatted document text. |
| `appliedRules` | array<string> | Which formatting rules fired (e.g. `heading-case`, `bullet-spacing`). |

## Install

```sh
npm install @genoffice/skill-doc-format @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as docFormat } from '@genoffice/skill-doc-format'

const registry = createSkillRegistry()
registry.register(docFormat)

const result = await registry.invoke('genoffice.skill.doc-format', {
  text: 'INTRODUCTION\n\nthis is a sample document. it has inconsistent capitalization and bullet style.\n',
  style: 'report',
  locale: 'en-US',
})
console.log(result.text)
console.log(result.appliedRules)
```

## When to use

- Cleaning up a draft someone pasted from email or chat.
- Normalising a Markdown-heavy file before opening in the docs editor.
- Bulk-applying house style across many user-uploaded files.

## When not to use

- Heavy restructuring (use `genoffice.skill.text-summarize` first).
- Locale-specific translation (use `genoffice.skill.text-translate`).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

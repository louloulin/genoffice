# `genoffice.skill.text-diff` — Text Diff

> Compute a unified-diff style change list between two plain-text inputs (Myers LCS, configurable context).

**npm**: [`@genoffice/skill-text-diff`](https://www.npmjs.com/package/@genoffice/skill-text-diff)
**Source**: [`packages/skill-text-diff/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-diff)
**Tests**: 8 / 8 passing

## Triggers

| Phrase | Locale |
|---|---|
| `diff text` | en |
| `compare text` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `oldText` | `string` | yes | Original text. |
| `newText` | `string` | yes | New text. |
| `options` | `object` | no | `{ context?: number }`. Default context = 3. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `hunks` | `array` | Array of `DiffHunk { oldStart, oldLines, newStart, newLines, lines }`. |
| `unified` | `string` | Pre-rendered unified-diff string. |

## Install

```sh
npm install @genoffice/skill-text-diff @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as textdiff } from '@genoffice/skill-text-diff'

const registry = createSkillRegistry()
registry.register(textdiff)

const result = await registry.invoke('genoffice.skill.text-diff', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Document versioning, contract redline, two-track proposal comparison, git-style review tooling.

## When not to use

- Semantic similarity (use text-summarize for that).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

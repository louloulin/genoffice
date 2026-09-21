# `genoffice.skill.text-summarize` — Text Summarizer

> Generate `short` / `medium` / `long` / `bullets` summaries via the host LLM.

**npm**: [`@genoffice/skill-text-summarize`](https://www.npmjs.com/package/@genoffice/skill-text-summarize)
**Source**: [`packages/skill-text-summarize/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-summarize)
**Tests**: 5 / 5 passing

## Triggers

| Phrase | Locale |
|---|---|
| `summarize` | en |
| `tldr` | en |
| `summary` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | Source text to summarize. |
| `length` | `enum` | no | One of `short` (default), `medium`, `long`, `bullets`. |
| `maxWords` | `integer` | no | Optional hard cap on output word count. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `summary` | `string` | The summarized text. |
| `tokensUsed` | `integer` | Tokens consumed by the LLM call. |

## Install

```sh
npm install @genoffice/skill-text-summarize @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as textsummarize } from '@genoffice/skill-text-summarize'

const registry = createSkillRegistry()
registry.register(textsummarize)

const result = await registry.invoke('genoffice.skill.text-summarize', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Condensing long documents, meeting notes, or support tickets into scannable digests.

## When not to use

- Translating content (use text-translate).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

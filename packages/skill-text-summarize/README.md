# @genoffice/skill-text-summarize

A standalone GenOffice Skill that summarises a long piece of text using the
host's LLM (`SkillContext.llm`). Supports `short` / `medium` / `long` /
`bullets` output shapes.

## Install

```sh
npm install @genoffice/skill-text-summarize
```

## Usage

```ts
import { skill } from '@genoffice/skill-text-summarize'
import { createSkillRegistry } from '@genoffice/agent-skills'

const registry = createSkillRegistry()
registry.register(skill)
```

## Inputs

| Name | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | Source text (any length) |
| `length` | enum: `short` / `medium` / `long` / `bullets` | no | Default `medium` |
| `maxWords` | number | no | Soft cap on summary length |
| `language` | string | no | BCP-47 tag; default `auto-detect` |

## Outputs

| Name | Type | Notes |
|---|---|---|
| `summary` | string | The summary text |
| `ratio` | number | summary length / source length |

## License

Apache-2.0

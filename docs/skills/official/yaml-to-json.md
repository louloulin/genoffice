# `genoffice.skill.yaml-to-json` — YAML ↔ JSON Converter

> Convert text between YAML and JSON.

**npm**: [`@genoffice/skill-yaml-to-json`](https://www.npmjs.com/package/@genoffice/skill-yaml-to-json)
**Source**: [`packages/skill-yaml-to-json/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-yaml-to-json)
**Tests**: 5 / 5 passing

## Triggers

| Phrase | Locale |
|---|---|
| `yaml to json` | en |
| `json to yaml` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | Source text (YAML or JSON, auto-detected). |
| `target` | `enum` | no | `json` (default) or `yaml`. |
| `indent` | `integer` | no | JSON indentation width (default 2). |

## Outputs

| Name | Type | Description |
|---|---|---|
| `text` | `string` | Converted text. |
| `detectedFormat` | `enum` | `yaml` or `json` (whichever was detected on input). |

## Install

```sh
npm install @genoffice/skill-yaml-to-json @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as yamltojson } from '@genoffice/skill-yaml-to-json'

const registry = createSkillRegistry()
registry.register(yamltojson)

const result = await registry.invoke('genoffice.skill.yaml-to-json', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Round-tripping between devops manifests and config APIs, normalising editor inputs.

## When not to use

- Validating against a schema (use json-validate or yaml-validate).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

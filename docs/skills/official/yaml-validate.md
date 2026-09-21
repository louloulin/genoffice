# `genoffice.skill.yaml-validate` — YAML Validator

> Validate YAML against a small JSON-schema-style rule set.

**npm**: [`@genoffice/skill-yaml-validate`](https://www.npmjs.com/package/@genoffice/skill-yaml-validate)
**Source**: [`packages/skill-yaml-validate/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-yaml-validate)
**Tests**: 9 / 9 passing

## Triggers

| Phrase | Locale |
|---|---|
| `validate yaml` | en |
| `check yaml` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | YAML text to validate. |
| `schema` | `object` | no | Optional schema (subset of JSON Schema Draft 7, applied post-parse). |

## Outputs

| Name | Type | Description |
|---|---|---|
| `ok` | `boolean` | `true` if valid, `false` otherwise. |
| `errors` | `array<{ path, message }>` | Parse errors + validation errors. |

## Install

```sh
npm install @genoffice/skill-yaml-validate @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as yamlvalidate } from '@genoffice/skill-yaml-validate'

const registry = createSkillRegistry()
registry.register(yamlvalidate)

const result = await registry.invoke('genoffice.skill.yaml-validate', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Validating Kubernetes manifests, GitHub Actions workflows, docker-compose files.

## When not to use

- JSON validation (use json-validate).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

# `genoffice.skill.json-validate` — JSON Validator

> Validate JSON against a small JSON-schema-style rule set.

**npm**: [`@genoffice/skill-json-validate`](https://www.npmjs.com/package/@genoffice/skill-json-validate)
**Source**: [`packages/skill-json-validate/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-json-validate)
**Tests**: 6 / 6 passing

## Triggers

| Phrase | Locale |
|---|---|
| `validate json` | en |
| `check json` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | JSON text to validate. |
| `schema` | `object` | no | Optional schema (subset of JSON Schema Draft 7). |

## Outputs

| Name | Type | Description |
|---|---|---|
| `ok` | `boolean` | `true` if valid, `false` otherwise. |
| `errors` | `array<{ path, message }>` | Validation errors (empty when `ok: true`). |

## Install

```sh
npm install @genoffice/skill-json-validate @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as jsonvalidate } from '@genoffice/skill-json-validate'

const registry = createSkillRegistry()
registry.register(jsonvalidate)

const result = await registry.invoke('genoffice.skill.json-validate', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Pre-ingest validation of JSON payloads, form-data sanity checks, editor-time lint.

## When not to use

- YAML validation (use yaml-validate).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

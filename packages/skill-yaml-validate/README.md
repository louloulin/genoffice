# @genoffice/skill-yaml-validate

A standalone GenOffice Skill that validates YAML text.

The validator ships with a small built-in YAML parser (no external runtime
dependencies), and a JSON-schema-style rule set that lets you assert:

- `type` — `object` / `array` / `string` / `number` / `boolean` / `null`
- `required` — list of required keys for objects
- `properties` — per-key sub-rules
- `items` — per-element rule for arrays
- `enum` — allowed scalar values
- `minLength` / `maxLength` for strings
- `minimum` / `maximum` for numbers

Errors are returned as a structured list (`{ path, code, message }`).

## Install

```sh
npm install @genoffice/skill-yaml-validate
```

## Usage

```ts
import { skill } from '@genoffice/skill-yaml-validate'
import { createSkillRegistry } from '@genoffice/agent-skills'

const registry = createSkillRegistry()
registry.register(skill)

const out = await skill.execute({}, {
  yaml: 'name: Alice\nage: 30\n',
  schema: {
    type: 'object',
    required: ['name', 'age'],
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'number', minimum: 0, maximum: 150 },
    },
  },
})
// → { ok: true, errors: [] }
```

## License

Apache-2.0

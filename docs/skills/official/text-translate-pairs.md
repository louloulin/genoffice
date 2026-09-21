# `genoffice.skill.text-translate-pairs` — TMX Pair Translator

> Translate TMX-style parallel pairs between BCP-47 languages; preserves placeholders.

**npm**: [`@genoffice/skill-text-translate-pairs`](https://www.npmjs.com/package/@genoffice/skill-text-translate-pairs)
**Source**: [`packages/skill-text-translate-pairs/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-translate-pairs)
**Tests**: 5 / 5 passing

## Triggers

| Phrase | Locale |
|---|---|
| `translate pairs` | en |
| `tmx` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `pairs` | `array` | yes | Array of `{ src, tgt?, domain?, tags? }` objects. |
| `source` | `string` | no | BCP-47 source language code. |
| `target` | `string` | yes | BCP-47 target language code. |
| `placeholderPolicy` | `enum` | no | One of `preserve` (default), `drop`, `translate`. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `pairs` | `array` | Translated pairs with `src` + `tgt` fields populated. |
| `untranslatedCount` | `integer` | Number of pairs that failed translation. |

## Install

```sh
npm install @genoffice/skill-text-translate-pairs @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as texttranslatepairs } from '@genoffice/skill-text-translate-pairs'

const registry = createSkillRegistry()
registry.register(texttranslatepairs)

const result = await registry.invoke('genoffice.skill.text-translate-pairs', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Building translation memory (`.gentm`) archives, batch-translating existing TMX, migrating KB glossaries.

## When not to use

- Single-document translation (use text-translate).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

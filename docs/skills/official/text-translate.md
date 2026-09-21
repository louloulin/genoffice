# `genoffice.skill.text-translate` — Text Translator

> Translate text between BCP-47 languages with optional domain hint.

**npm**: [`@genoffice/skill-text-translate`](https://www.npmjs.com/package/@genoffice/skill-text-translate)
**Source**: [`packages/skill-text-translate/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-translate)
**Tests**: 6 / 6 passing

## Triggers

| Phrase | Locale |
|---|---|
| `translate` | en |
| `翻译` | en |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | Source text. |
| `source` | `string` | no | BCP-47 source language code (e.g. `en-US`). Auto-detected if absent. |
| `target` | `string` | yes | BCP-47 target language code (e.g. `zh-CN`). |
| `domain` | `enum` | no | One of `general` (default), `legal`, `medical`, `financial`, `technical`. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `text` | `string` | Translated text. |
| `detectedSource` | `string` | BCP-47 code if source was auto-detected. |
| `confidence` | `number` | Provider-side confidence score (0..1). |

## Install

```sh
npm install @genoffice/skill-text-translate @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as texttranslate } from '@genoffice/skill-text-translate'

const registry = createSkillRegistry()
registry.register(texttranslate)

const result = await registry.invoke('genoffice.skill.text-translate', {
  // example inputs — see Inputs table above
})
console.log(result)
```

## When to use

- Cross-language content migration, document translation, multilingual UI string generation.

## When not to use

- Translating TMX-style parallel pairs (use text-translate-pairs).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

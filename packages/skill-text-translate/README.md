# @genoffice/skill-text-translate

A standalone GenOffice Skill that translates text between BCP-47 languages
using the host's LLM. Optional `domain` hint biases terminology (legal /
medical / software / general).

## Install

```sh
npm install @genoffice/skill-text-translate
```

## Usage

```ts
import { skill } from '@genoffice/skill-text-translate'
import { createSkillRegistry } from '@genoffice/agent-skills'

const registry = createSkillRegistry()
registry.register(skill)
```

## Inputs

| Name | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | Source text |
| `target` | string (BCP-47) | yes | e.g. `en-US`, `zh-CN`, `ja-JP` |
| `source` | string (BCP-47) | no | Default `auto-detect` |
| `domain` | enum | no | `general` / `legal` / `medical` / `software` |
| `preserveFormatting` | boolean | no | Default `false` |

## Outputs

| Name | Type | Notes |
|---|---|---|
| `translation` | string | The translated text |
| `detectedSource` | string | BCP-47 code the LLM identified |

## License

Apache-2.0

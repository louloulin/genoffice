# @genoffice/skill-markdown-format

A standalone GenOffice Skill that formats Markdown text.

Normalises:

- ATX heading style (`#` → `##` etc.) with consistent spacing
- Bullet list markers (default `-`)
- Code fence language hints (defaults to `text` when missing)
- Link style (inline → reference when shared across multiple uses)
- Trailing whitespace + 2-newline paragraph separator
- Removes orphan bold/italic markers

## Install

```sh
npm install @genoffice/skill-markdown-format
```

## Usage

```ts
import { skill } from '@genoffice/skill-markdown-format'
import { createSkillRegistry } from '@genoffice/agent-skills'

const registry = createSkillRegistry()
registry.register(skill)
```

## Inputs

| Name | Type | Required | Notes |
|---|---|---|---|
| `markdown` | string | yes | The source Markdown to format |
| `bulletMarker` | `'-'` \| `'*'` \| `'+'` | no | Default `-` |
| `maxHeadingLevel` | number | no | Default 6 |

## Outputs

| Name | Type | Notes |
|---|---|---|
| `markdown` | string | The formatted Markdown |
| `changes` | number | How many transforms were applied |

## License

Apache-2.0

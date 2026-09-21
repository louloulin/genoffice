# Official Skills

Skills shipped by the GenOffice team as standalone npm packages under the
`@genoffice/skill-*` namespace. Each one implements the
[`SkillDefinition` / `SkillPackage`](/api/ai-skills-protocol) contract from
`@genoffice/agent-skills` and can be registered with
`createSkillRegistry()` or loaded by the web-server's skill market at boot.

| Skill | npm package | What it does | Status |
|---|---|---|---|
| `genoffice.skill.markdown-format` | `@genoffice/skill-markdown-format` | Normalise Markdown (headings, bullets, code fences, links, whitespace). | ✅ shipped |
| `genoffice.skill.text-summarize` | `@genoffice/skill-text-summarize` | Summarise text via host LLM (`short` / `medium` / `long` / `bullets`). | ✅ shipped |
| `genoffice.skill.text-translate` | `@genoffice/skill-text-translate` | Translate text between BCP-47 languages with optional domain hint. | ✅ shipped |
| `genoffice.skill.json-validate` | `@genoffice/skill-json-validate` | Validate JSON against a small JSON-schema-style rule set. | ✅ shipped |
| `genoffice.skill.yaml-validate` | `@genoffice/skill-yaml-validate` | Validate YAML against a small JSON-schema-style rule set. | ✅ shipped |
| `genoffice.skill.yaml-to-json` | `@genoffice/skill-yaml-to-json` | Convert text between YAML and JSON. | ✅ shipped |
| `genoffice.skill.text-translate-pairs` | `@genoffice/skill-text-translate-pairs` | Translate TMX-style parallel pairs between BCP-47 languages; preserves placeholders. | ✅ shipped |
| `genoffice.skill.doc-format` | `@genoffice/docx-engine` (in-repo) | Apply consistent headings, lists, and code-block styling to a `.docx`. | 🟡 bundled (in-repo extension) |
| `genoffice.skill.doc-summary` | `@genoffice/agent-skills` (in-repo) | Generate a 1-paragraph + bullet summary of a `.docx`. | 🟡 bundled (in-repo extension) |
| `genoffice.skill.sheet-formula` | `@genoffice/agent-skills` (in-repo) | Add / explain formulas in a `.xlsx`. | 🟡 bundled (in-repo extension) |
| `genoffice.skill.translate-doc` | `@genoffice/agent-skills` (in-repo) | Translate a `.docx` while preserving layout. | 🟡 bundled (in-repo extension) |
| `genoffice.skill.ocr` | `@genoffice/agent-skills` (in-repo) | Run Tesseract OCR on an image or scanned PDF. | 🟡 bundled (in-repo extension) |
| `genoffice.skill.web-search` | `@genoffice/agent-skills` (in-repo) | Search the public web via DuckDuckGo (no API key). | 🟡 bundled (in-repo extension) |

> **Roadmap.** Bundled in-repo Skills are being extracted to standalone npm
> packages one PR at a time. The target shape is identical to the four
> shipped packages above — see [Authoring Guide](/skills/authoring) for the
> protocol.



## Per-skill deep dives

Each flagship Skill has a dedicated page with full input / output schemas, usage examples, and "when to use" guidance:

- [`genoffice.skill.doc-format` →](/skills/official/doc-format)
- [`genoffice.skill.sheet-formula` →](/skills/official/sheet-formula)
- [`genoffice.skill.slides-outline` →](/skills/official/slides-outline)

The remaining 8 Skills share the same `SkillDefinition` contract; refer to the [Authoring Guide](/skills/authoring) for the full schema and use the marketplace loader (`genoffice.skills.json`) to bring all 11 in at boot.

## Installation

```sh
# Install individual Skills (npm tag `beta` during the open beta)
npm install @genoffice/skill-markdown-format
npm install @genoffice/skill-text-summarize
npm install @genoffice/skill-text-translate
npm install @genoffice/skill-text-translate-pairs
npm install @genoffice/skill-json-validate
npm install @genoffice/skill-yaml-validate
npm install @genoffice/skill-yaml-to-json
```

## Registration

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as markdownFormat } from '@genoffice/skill-markdown-format'
import { skill as textSummarize } from '@genoffice/skill-text-summarize'
import { skill as textTranslate } from '@genoffice/skill-text-translate'
import { skill as textTranslatePairs } from '@genoffice/skill-text-translate-pairs'
import { skill as jsonValidate } from '@genoffice/skill-json-validate'
import { skill as yamlValidate } from '@genoffice/skill-yaml-validate'
import { skill as yamlToJson } from '@genoffice/skill-yaml-to-json'

const registry = createSkillRegistry()
registry.register(markdownFormat)
registry.register(textSummarize)
registry.register(textTranslate)
registry.register(textTranslatePairs)
registry.register(jsonValidate)
registry.register(yamlValidate)
registry.register(yamlToJson)
```

## Invocation via REST API

The web-server exposes every registered Skill via
`POST /api/v1/ai/skill/:name` — see
[REST API v1](/api/rest-api#post-apiv1aiskillname).

## Authoring a third-party Skill

See [Authoring Guide](/skills/authoring) — the contract is fully open and
the web-server will auto-load Skills listed in `genoffice.skills.json` at
boot.

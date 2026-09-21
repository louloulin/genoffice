# Skill Marketplace

Browse the 11 standalone Skills shipped by the GenOffice team, grouped
by category. Each entry links to its npm package, source location, and
documentation.

> For the full per-Skill reference (manifest, triggers, inputs,
> outputs), see [Official Skills](/skills/official). For the contract
> used to author your own, see [Authoring Guide](/skills/authoring).
> To submit a community Skill, see [Community Skills](/skills/community).

## Categories

### 📄 Document (文档) — 7 Skills

| Skill | npm | Use case |
|---|---|---|
| `genoffice.skill.markdown-format` | `@genoffice/skill-markdown-format` | Normalise Markdown (headings, bullets, code fences, links, whitespace). |
| `genoffice.skill.doc-format` | `@genoffice/skill-doc-format` | Apply consistent headings, lists, and code-block styling to a `.docx`. |
| `genoffice.skill.text-summarize` | `@genoffice/skill-text-summarize` | Generate `short` / `medium` / `long` / `bullets` summaries via host LLM. |
| `genoffice.skill.text-diff` | `@genoffice/skill-text-diff` | Compute unified-diff style change list between two texts (Myers LCS). |
| `genoffice.skill.json-validate` | `@genoffice/skill-json-validate` | Validate JSON against a small JSON-schema-style rule set. |
| `genoffice.skill.yaml-validate` | `@genoffice/skill-yaml-validate` | Validate YAML against a small JSON-schema-style rule set. |
| `genoffice.skill.yaml-to-json` | `@genoffice/skill-yaml-to-json` | Convert between YAML and JSON. |

### 📊 Sheet (表格) — 1 Skill

| Skill | npm | Use case |
|---|---|---|
| `genoffice.skill.sheet-formula` | `@genoffice/skill-sheet-formula` | Add / explain formulas in a `.xlsx` (token-by-token explainer with operand type inference). |

### 🎬 Slides (演示) — 1 Skill

| Skill | npm | Use case |
|---|---|---|
| `genoffice.skill.slides-outline` | `@genoffice/skill-slides-outline` | Generate a slide outline from a prompt + optional context. |

### 🌐 Translation (翻译) — 2 Skills

| Skill | npm | Use case |
|---|---|---|
| `genoffice.skill.text-translate` | `@genoffice/skill-text-translate` | Translate text between BCP-47 languages with optional domain hint. |
| `genoffice.skill.text-translate-pairs` | `@genoffice/skill-text-translate-pairs` | Translate TMX-style parallel pairs; preserves placeholders. |

### 🏢 Industry (行业) — reserved

The Industry category is reserved for third-party Skills that target a
specific vertical (legal, healthcare, finance, education, …). To submit
the first one, follow the [Community Skills](/skills/community) guide.

## Search by trigger

Each Skill declares a list of trigger phrases. To find a Skill at
runtime, the Agent Loop matches user input against these triggers.

| Trigger phrase | Skill |
|---|---|
| `format markdown`, `clean up markdown` | `genoffice.skill.markdown-format` |
| `format document`, `clean up document` | `genoffice.skill.doc-format` |
| `summarize`, `tldr`, `summary` | `genoffice.skill.text-summarize` |
| `diff text`, `compare text`, `文本对比` | `genoffice.skill.text-diff` |
| `validate json`, `check json` | `genoffice.skill.json-validate` |
| `validate yaml`, `check yaml` | `genoffice.skill.yaml-validate` |
| `yaml to json`, `json to yaml` | `genoffice.skill.yaml-to-json` |
| `explain formula`, `check formula` | `genoffice.skill.sheet-formula` |
| `slide outline`, `presentation outline` | `genoffice.skill.slides-outline` |
| `translate`, `翻译` | `genoffice.skill.text-translate` |
| `translate pairs`, `tmx` | `genoffice.skill.text-translate-pairs` |

## Install all

```sh
npm install \
  @genoffice/skill-markdown-format \
  @genoffice/skill-doc-format \
  @genoffice/skill-text-summarize \
  @genoffice/skill-text-diff \
  @genoffice/skill-json-validate \
  @genoffice/skill-yaml-validate \
  @genoffice/skill-yaml-to-json \
  @genoffice/skill-sheet-formula \
  @genoffice/skill-slides-outline \
  @genoffice/skill-text-translate \
  @genoffice/skill-text-translate-pairs
```

## Bootstrap from the marketplace

The web-server auto-loads Skills listed in `genoffice.skills.json`:

```json
{
  "skills": [
    { "name": "@genoffice/skill-markdown-format" },
    { "name": "@genoffice/skill-text-translate" },
    { "name": "@genoffice/skill-doc-format" }
  ]
}
```

Boot log on success:

```
[marketplace] loaded 3 skill(s):
  - genoffice.skill.markdown-format
  - genoffice.skill.text-translate
  - genoffice.skill.doc-format
```

## Roadmap

The Industry category will fill out as community submissions land via
the [Community Skills](/skills/community) flow.

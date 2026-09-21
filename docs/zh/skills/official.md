# 官方 Skills

由 GenOffice 团队以独立 npm 包形式发布的 Skill，统一在 `@genoffice/skill-*` 命名空间下。每个都实现了 [`SkillDefinition` / `SkillPackage`](/zh/api/ai-skills-protocol) 契约（定义在 `@genoffice/agent-skills` 中），可以通过 `createSkillRegistry()` 注册，或由 web-server 的 skill 市场在启动时加载。

| Skill | npm 包 | 用途 | 状态 |
|---|---|---|---|
| `genoffice.skill.markdown-format` | `@genoffice/skill-markdown-format` | 规范化 Markdown（标题、列表、代码块、链接、空白）。 | ✅ 已发布 |
| `genoffice.skill.text-summarize` | `@genoffice/skill-text-summarize` | 调用宿主 LLM 生成摘要（`short` / `medium` / `long` / `bullets`）。 | ✅ 已发布 |
| `genoffice/skill.text-translate` | `@genoffice/skill-text-translate` | 在 BCP-47 语言之间翻译文本，支持可选领域提示。 | ✅ 已发布 |
| `genoffice.skill.json-validate` | `@genoffice/skill-json-validate` | 用小型 JSON-schema 风格规则集校验 JSON。 | ✅ 已发布 |
| `genoffice.skill.yaml-validate` | `@genoffice/skill-yaml-validate` | 用小型 JSON-schema 风格规则集校验 YAML。 | ✅ 已发布 |
| `genoffice.skill.yaml-to-json` | `@genoffice/skill-yaml-to-json` | 在 YAML 与 JSON 之间互转。 | ✅ 已发布 |
| `genoffice.skill.text-translate-pairs` | `@genoffice/skill-text-translate-pairs` | 在 BCP-47 语言之间翻译 TMX 风格平行句对，保留占位符。 | ✅ 已发布 |
| `genoffice.skill.doc-format` | `@genoffice/skill-doc-format` | 对 `.docx` 应用统一的标题、列表、代码块样式。 | ✅ 已发布（v1 期间发布）|
| `genoffice.skill.sheet-formula` | `@genoffice/skill-sheet-formula` | 在 `.xlsx` 中新增 / 解释公式。 | ✅ 已发布（v1 期间发布）|
| `genoffice.skill.slides-outline` | `@genoffice/skill-slides-outline` | 基于 prompt + 可选上下文生成幻灯片大纲。 | ✅ 已发布（v1 期间发布）|
| `genoffice.skill.text-diff` | `@genoffice/skill-text-diff` | 计算两段文本之间的 unified-diff 风格变更列表（Myers LCS + 可配 context）。 | ✅ 已发布（v1 期间发布）|

> **路线图。** 上述所有 11 个 Skill 都已作为独立 npm 包发布（`@genoffice/skill-*`），与首方 provider 的发布模式一致。



## 单 Skill 详解

每个官方 Skill 都有独立页面，含完整输入 / 输出 schema、使用示例与"适用场景"说明：

- [`genoffice.skill.doc-format` →](/zh/skills/official/doc-format)
- [`genoffice.skill.json-validate` →](/zh/skills/official/json-validate)
- [`genoffice.skill.markdown-format` →](/zh/skills/official/markdown-format)
- [`genoffice.skill.sheet-formula` →](/zh/skills/official/sheet-formula)
- [`genoffice.skill.slides-outline` →](/zh/skills/official/slides-outline)
- [`genoffice.skill.text-diff` →](/zh/skills/official/text-diff)
- [`genoffice.skill.text-summarize` →](/zh/skills/official/text-summarize)
- [`genoffice.skill.text-translate` →](/zh/skills/official/text-translate)
- [`genoffice.skill.text-translate-pairs` →](/zh/skills/official/text-translate-pairs)
- [`genoffice.skill.yaml-to-json` →](/zh/skills/official/yaml-to-json)
- [`genoffice.skill.yaml-validate` →](/zh/skills/official/yaml-validate)

全部 11 个 Skill 共享同一 `SkillDefinition` 契约；完整 schema 见 [Skill 编写指南](/zh/skills/authoring)，通过市场加载器（`genoffice.skills.json`）在启动时一键拉起全部 11 个。

## 安装

```sh
# 单独安装 Skill（开放公测期间使用 npm `beta` tag）
npm install @genoffice/skill-markdown-format
npm install @genoffice/skill-text-summarize
npm install @genoffice/skill-text-translate
npm install @genoffice/skill-text-translate-pairs
npm install @genoffice/skill-json-validate
npm install @genoffice/skill-yaml-validate
npm install @genoffice/skill-yaml-to-json
npm install @genoffice/skill-doc-format
npm install @genoffice/skill-sheet-formula
npm install @genoffice/skill-slides-outline
npm install @genoffice/skill-text-diff
```

## 注册

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as markdownFormat } from '@genoffice/skill-markdown-format'
import { skill as textSummarize } from '@genoffice/skill-text-summarize'
import { skill as textTranslate } from '@genoffice/skill-text-translate'
import { skill as textTranslatePairs } from '@genoffice/skill-text-translate-pairs'
import { skill as jsonValidate } from '@genoffice/skill-json-validate'
import { skill as yamlValidate } from '@genoffice/skill-yaml-validate'
import { skill as yamlToJson } from '@genoffice/skill-yaml-to-json'
import { skill as docFormat } from '@genoffice/skill-doc-format'
import { skill as sheetFormula } from '@genoffice/skill-sheet-formula'
import { skill as slidesOutline } from '@genoffice/skill-slides-outline'
import { skill as textDiff } from '@genoffice/skill-text-diff'

const registry = createSkillRegistry()
registry.register(markdownFormat)
registry.register(textSummarize)
registry.register(textTranslate)
registry.register(textTranslatePairs)
registry.register(jsonValidate)
registry.register(yamlValidate)
registry.register(yamlToJson)
registry.register(docFormat)
registry.register(sheetFormula)
registry.register(slidesOutline)
registry.register(textDiff)
```

## 通过 REST API 调用

web-server 通过 `POST /api/v1/ai/skill/:name` 暴露所有已注册的 Skill —— 见 [REST API v1](/zh/api/rest-api#post-apiv1aiskillname)。

## 编写第三方 Skill

见 [Skill 编写指南](/zh/skills/authoring) —— 契约完全开放，web-server 会在启动时自动加载 `genoffice.skills.json` 中列出的 Skill。

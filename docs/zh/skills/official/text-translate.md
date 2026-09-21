# `genoffice.skill.text-translate` — 文本翻译

> 在 BCP-47 语言之间翻译文本，支持可选领域提示。

**npm**：[`@genoffice/skill-text-translate`](https://www.npmjs.com/package/@genoffice/skill-text-translate)
**源码**：[`packages/skill-text-translate/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-translate)
**测试**：6 / 6 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `translate` | en |
| `翻译` | en |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | `string` | 是 | 源文本。 |
| `source` | `string` | 否 | BCP-47 源语言代码（如 `en-US`），缺省时自动检测。 |
| `target` | `string` | 是 | BCP-47 目标语言代码（如 `zh-CN`）。 |
| `domain` | `enum` | 否 | `general`（默认）/`legal`/`medical`/`financial`/`technical` 之一。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `text` | `string` | 翻译后的文本。 |
| `detectedSource` | `string` | 若 source 自动检测，给出 BCP-47 代码。 |
| `confidence` | `number` | provider 端的置信度（0..1）。 |

## 安装

```sh
npm install @genoffice/skill-text-translate @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as texttranslate } from '@genoffice/skill-text-translate'

const registry = createSkillRegistry()
registry.register(texttranslate)

const result = await registry.invoke('genoffice.skill.text-translate', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- 跨语言内容迁移、文档翻译、多语言 UI 文案生成。

## 不适用场景

- 翻译 TMX 风格平行句对（用 text-translate-pairs）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

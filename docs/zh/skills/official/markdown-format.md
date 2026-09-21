# `genoffice.skill.markdown-format` — Markdown 规范化

> 规范化 Markdown（标题、列表、代码块、链接、空白）。

**npm**：[`@genoffice/skill-markdown-format`](https://www.npmjs.com/package/@genoffice/skill-markdown-format)
**源码**：[`packages/skill-markdown-format/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-markdown-format)
**测试**：7 / 7 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `format markdown` | en |
| `clean up markdown` | en |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | `string` | 是 | 原始 Markdown 文本。 |
| `rules` | `array` | 否 | `heading-case` / `bullet-spacing` / `code-fence` / `link-normalize` / `trailing-newline` 的子集。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `text` | `string` | 规范化后的 Markdown 文本。 |
| `appliedRules` | `array<string>` | 实际触发的规则列表。 |

## 安装

```sh
npm install @genoffice/skill-markdown-format @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as markdownformat } from '@genoffice/skill-markdown-format'

const registry = createSkillRegistry()
registry.register(markdownformat)

const result = await registry.invoke('genoffice.skill.markdown-format', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- pre-commit Markdown 清理、README 规范化、文档站预处理。

## 不适用场景

- 大幅重写结构（先用 text-summarize）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

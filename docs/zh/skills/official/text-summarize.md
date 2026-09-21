# `genoffice.skill.text-summarize` — 文本摘要

> 通过宿主 LLM 生成 `short` / `medium` / `long` / `bullets` 四种粒度的摘要。

**npm**：[`@genoffice/skill-text-summarize`](https://www.npmjs.com/package/@genoffice/skill-text-summarize)
**源码**：[`packages/skill-text-summarize/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-summarize)
**测试**：5 / 5 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `summarize` | en |
| `tldr` | en |
| `summary` | en |
| `摘要` | zh |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | `string` | 是 | 待摘要的源文本。 |
| `length` | `enum` | 否 | `short`（默认）/`medium`/`long`/`bullets` 之一。 |
| `maxWords` | `integer` | 否 | 可选的输出字数硬上限。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `summary` | `string` | 摘要文本。 |
| `tokensUsed` | `integer` | 本次 LLM 调用消耗的 token 数。 |

## 安装

```sh
npm install @genoffice/skill-text-summarize @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as textsummarize } from '@genoffice/skill-text-summarize'

const registry = createSkillRegistry()
registry.register(textsummarize)

const result = await registry.invoke('genoffice.skill.text-summarize', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- 把长文档 / 会议纪要 / 工单压缩成可快速浏览的摘要。

## 不适用场景

- 翻译内容（用 text-translate）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

# `genoffice.skill.text-translate-pairs` — 句对翻译

> 在 BCP-47 语言之间翻译 TMX 风格平行句对；保留占位符。

**npm**：[`@genoffice/skill-text-translate-pairs`](https://www.npmjs.com/package/@genoffice/skill-text-translate-pairs)
**源码**：[`packages/skill-text-translate-pairs/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-translate-pairs)
**测试**：5 / 5 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `translate pairs` | en |
| `tmx` | en |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pairs` | `array` | 是 | `{ src, tgt?, domain?, tags? }` 对象数组。 |
| `source` | `string` | 否 | BCP-47 源语言代码。 |
| `target` | `string` | 是 | BCP-47 目标语言代码。 |
| `placeholderPolicy` | `enum` | 否 | `preserve`（默认）/`drop`/`translate` 之一。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `pairs` | `array` | 翻译后的句对，`src` + `tgt` 字段都已填好。 |
| `untranslatedCount` | `integer` | 翻译失败的句对数。 |

## 安装

```sh
npm install @genoffice/skill-text-translate-pairs @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as texttranslatepairs } from '@genoffice/skill-text-translate-pairs'

const registry = createSkillRegistry()
registry.register(texttranslatepairs)

const result = await registry.invoke('genoffice.skill.text-translate-pairs', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- 构建翻译记忆（`.gentm`）归档、批量翻译已有 TMX、迁移 KB 术语表。

## 不适用场景

- 单文档翻译（用 text-translate）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

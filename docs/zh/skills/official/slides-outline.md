# `genoffice.skill.slides-outline` — 幻灯片大纲生成

> 基于 prompt + 可选上下文（受众 / 时长 / 语气）生成幻灯片大纲。

**npm**：[`@genoffice/skill-slides-outline`](https://www.npmjs.com/package/@genoffice/skill-slides-outline)
**源码**：[`packages/skill-slides-outline/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-slides-outline)
**测试**：10 / 10 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `slide outline` | en |
| `presentation outline` | en |
| `幻灯片大纲` | zh |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | 是 | 演示文稿主题。 |
| `audience` | string | 否 | 例如 `executives`、`engineering team`、`customers`。 |
| `duration` | string | 否 | 例如 `15min`、`1h`。 |
| `tone` | enum | 否 | `formal`（默认）/`casual`/`persuasive`。 |
| `slideCount` | integer | 否 | 目标幻灯片数（1..30），默认按 `duration` 推断。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `title` | string | 建议的演示标题。 |
| `slides` | array<{ index, title, bullets, notes }> | 逐张幻灯片大纲：标题 + 要点 + 演讲者备注。 |
| `totalSlides` | integer | 大纲中的幻灯片总数。 |

## 安装

```sh
npm install @genoffice/skill-slides-outline @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as slidesOutline } from '@genoffice/skill-slides-outline'

const registry = createSkillRegistry()
registry.register(slidesOutline)

const result = await registry.invoke('genoffice.skill.slides-outline', {
  prompt: '新仪表盘发布的季度产品复盘',
  audience: '高管',
  duration: '20min',
  tone: 'formal',
})
console.log(result.title)
for (const slide of result.slides) {
  console.log(`#${slide.index} ${slide.title}`)
  for (const b of slide.bullets) console.log(`  - ${b}`)
}
```

## 适用场景

- 用一句话简介快速生成新 deck 的骨架。
- 在动手做正式幻灯片前先产出结构化 agenda。
- 把 deck 计划先拿出来评审，再投入设计。

## 不适用场景

- 生成实际的幻灯片正文（把大纲手动落到 slides 编辑器里）。
- 字字对应的演讲稿（可与 `genoffice.skill.text-summarize` 联用）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

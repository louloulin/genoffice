# `genoffice.skill.text-diff` — 文本对比

> 计算两段纯文本之间的 unified-diff 风格变更列表（Myers LCS + 可配上下文）。

**npm**：[`@genoffice/skill-text-diff`](https://www.npmjs.com/package/@genoffice/skill-text-diff)
**源码**：[`packages/skill-text-diff/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-text-diff)
**测试**：8 / 8 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `diff text` | en |
| `compare text` | en |
| `文本对比` | zh |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `oldText` | `string` | 是 | 原文。 |
| `newText` | `string` | 是 | 新文。 |
| `options` | `object` | 否 | `{ context?: number }`。默认 context = 3。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `hunks` | `array` | `DiffHunk { oldStart, oldLines, newStart, newLines, lines }` 数组。 |
| `unified` | `string` | 预渲染的 unified-diff 字符串。 |

## 安装

```sh
npm install @genoffice/skill-text-diff @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as textdiff } from '@genoffice/skill-text-diff'

const registry = createSkillRegistry()
registry.register(textdiff)

const result = await registry.invoke('genoffice.skill.text-diff', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- 文档版本对比、合同红头批注、双轨提案对比、git 风格审阅工具。

## 不适用场景

- 语义相似度（那种用途用 text-summarize）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

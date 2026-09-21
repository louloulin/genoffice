# `genoffice.skill.doc-format` — 文档排版

> 对 `.docx` 应用统一的标题、列表、代码块样式。

**npm**：[`@genoffice/skill-doc-format`](https://www.npmjs.com/package/@genoffice/skill-doc-format)
**源码**：[`packages/skill-doc-format/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-doc-format)
**测试**：10 / 10 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `format document` | en |
| `clean up document` | en |
| `文档排版` | zh |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 原始文档文本（Markdown 或纯散文）。 |
| `style` | enum | 否 | `report`（默认）/`memo`/`article`。 |
| `locale` | enum | 否 | `en-US`（默认）/`zh-CN`。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `text` | string | 重新排版后的文档文本。 |
| `appliedRules` | array<string> | 触发的排版规则（如 `heading-case`、`bullet-spacing`）。 |

## 安装

```sh
npm install @genoffice/skill-doc-format @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as docFormat } from '@genoffice/skill-doc-format'

const registry = createSkillRegistry()
registry.register(docFormat)

const result = await registry.invoke('genoffice.skill.doc-format', {
  text: '引言\n\n这是一份样例文档。它的标题大小写和列表样式都不一致。\n',
  style: 'report',
  locale: 'zh-CN',
})
console.log(result.text)
console.log(result.appliedRules)
```

## 适用场景

- 清理从邮件或聊天复制来的草稿。
- 把 Markdown 风格重的文件规范化后再在 docs 编辑器中打开。
- 批量对用户上传的文件套用统一的内部样式。

## 不适用场景

- 大幅重写结构（先用 `genoffice.skill.text-summarize`）。
- 本地化翻译（用 `genoffice.skill.text-translate`）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

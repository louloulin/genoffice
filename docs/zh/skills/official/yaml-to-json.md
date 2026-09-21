# `genoffice/skill.yaml-to-json` — YAML ↔ JSON 互转

> 在 YAML 与 JSON 之间互转。

**npm**：[`@genoffice/skill-yaml-to-json`](https://www.npmjs.com/package/@genoffice/skill-yaml-to-json)
**源码**：[`packages/skill-yaml-to-json/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-yaml-to-json)
**测试**：5 / 5 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `yaml to json` | en |
| `json to yaml` | en |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | `string` | 是 | 源文本（YAML 或 JSON，自动检测）。 |
| `target` | `enum` | 否 | `json`（默认）或 `yaml`。 |
| `indent` | `integer` | 否 | JSON 缩进宽度（默认 2）。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `text` | `string` | 转换后的文本。 |
| `detectedFormat` | `enum` | `yaml` 或 `json`（输入侧自动检测到的格式）。 |

## 安装

```sh
npm install @genoffice/skill-yaml-to-json @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as yamltojson } from '@genoffice/skill-yaml-to-json'

const registry = createSkillRegistry()
registry.register(yamltojson)

const result = await registry.invoke('genoffice.skill.yaml-to-json', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- devops manifest 与 config API 互转、编辑器输入规范化。

## 不适用场景

- 按 schema 校验（用 json-validate 或 yaml-validate）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

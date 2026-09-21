# `genoffice.skill.json-validate` — JSON 校验

> 用小型 JSON-schema 风格规则集校验 JSON。

**npm**：[`@genoffice/skill-json-validate`](https://www.npmjs.com/package/@genoffice/skill-json-validate)
**源码**：[`packages/skill-json-validate/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-json-validate)
**测试**：6 / 6 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `validate json` | en |
| `check json` | en |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | `string` | 是 | 待校验的 JSON 文本。 |
| `schema` | `object` | 否 | 可选 schema（JSON Schema Draft 7 的子集）。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `ok` | `boolean` | 合法为 `true`，否则 `false`。 |
| `errors` | `array<{ path, message }>` | 校验错误列表（`ok: true` 时为空）。 |

## 安装

```sh
npm install @genoffice/skill-json-validate @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as jsonvalidate } from '@genoffice/skill-json-validate'

const registry = createSkillRegistry()
registry.register(jsonvalidate)

const result = await registry.invoke('genoffice.skill.json-validate', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- JSON 负载入库前校验、表单数据健全性检查、编辑时 lint。

## 不适用场景

- YAML 校验（用 yaml-validate）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

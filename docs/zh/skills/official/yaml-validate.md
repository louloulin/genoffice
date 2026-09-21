# `genoffice.skill.yaml-validate` — YAML 校验

> 用小型 JSON-schema 风格规则集校验 YAML。

**npm**：[`@genoffice/skill-yaml-validate`](https://www.npmjs.com/package/@genoffice/skill-yaml-validate)
**源码**：[`packages/skill-yaml-validate/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-yaml-validate)
**测试**：9 / 9 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `validate yaml` | en |
| `check yaml` | en |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | `string` | 是 | 待校验的 YAML 文本。 |
| `schema` | `object` | 否 | 可选 schema（JSON Schema Draft 7 的子集，解析后应用）。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `ok` | `boolean` | 合法为 `true`，否则 `false`。 |
| `errors` | `array<{ path, message }>` | 解析错误 + 校验错误。 |

## 安装

```sh
npm install @genoffice/skill-yaml-validate @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as yamlvalidate } from '@genoffice/skill-yaml-validate'

const registry = createSkillRegistry()
registry.register(yamlvalidate)

const result = await registry.invoke('genoffice.skill.yaml-validate', {
  // 示例输入，详见上表
})
console.log(result)
```

## 适用场景

- 校验 Kubernetes manifest、GitHub Actions workflow、docker-compose 文件。

## 不适用场景

- JSON 校验（用 json-validate）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

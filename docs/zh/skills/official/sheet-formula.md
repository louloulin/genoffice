# `genoffice.skill.sheet-formula` — 表格公式解释

> 在 `.xlsx` 中新增 / 解释公式 —— token 级分解，带操作数类型推断。

**npm**：[`@genoffice/skill-sheet-formula`](https://www.npmjs.com/package/@genoffice/skill-sheet-formula)
**源码**：[`packages/skill-sheet-formula/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-sheet-formula)
**测试**：13 / 13 通过

## 触发短语

| 短语 | 语言 |
|---|---|
| `explain formula` | en |
| `check formula` | en |
| `解释公式` | zh |

## 输入

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `formula` | string | 是 | 公式文本（不带前导 `=`）。 |
| `context` | object | 否 | 示例单元格引用及其取值；用于类型推断。 |

## 输出

| 名称 | 类型 | 说明 |
|---|---|---|
| `explanation` | string | 公式的可读说明。 |
| `tokens` | array | token 分解：`{ kind, text, role, operandType }`。 |
| `evaluation` | string | 可选：当 `context` 提供足够单元格取值时，给出求值结果。 |

## 安装

```sh
npm install @genoffice/skill-sheet-formula @genoffice/agent-skills
```

## 注册 + 调用

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as sheetFormula } from '@genoffice/skill-sheet-formula'

const registry = createSkillRegistry()
registry.register(sheetFormula)

const result = await registry.invoke('genoffice.skill.sheet-formula', {
  formula: 'SUMIF(A1:A10, ">100", B1:B10)',
  context: {
    ranges: {
      'A1:A10': [50, 120, 200, 80, 150, 90, 110, 130, 75, 105],
      'B1:B10': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
  },
})
console.log(result.explanation)
// "SUMIF 遍历 A1:A10，挑出大于 100 的格子（A2 / A3 / A5 / A7 / A8 / A10），对 B 列同位置求和（2+3+5+7+8+10 = 35）"
console.log(result.tokens)
console.log(result.evaluation) // "35"
```

## 适用场景

- 审计遗留 `.xlsx` 文件中陌生的公式。
- 给表格使用者讲解 `IF` / `VLOOKUP` / `SUMIFS` 链路。
- 在保存工作簿前校验公式引用范围是否合法。

## 不适用场景

- 工作簿中的实时公式编辑（renderer 原生支持）。
- 翻译单元格标签（用 `genoffice.skill.text-translate`）。

## 延伸阅读

- [官方 Skills](/zh/skills/official) — 11 个独立 Skill 完整列表
- [Skill 编写指南](/zh/skills/authoring) — 用同一契约编写自己的 Skill
- [市场](/zh/skills/marketplace) — 按类别浏览

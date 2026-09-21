# `genoffice.skill.sheet-formula` — Sheet Formula Explainer

> Add / explain formulas in a `.xlsx` — token-by-token explainer with operand type inference.

**npm**: [`@genoffice/skill-sheet-formula`](https://www.npmjs.com/package/@genoffice/skill-sheet-formula)
**Source**: [`packages/skill-sheet-formula/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-sheet-formula)
**Tests**: 13 / 13 passing

## Triggers

| Phrase | Locale |
|---|---|
| `explain formula` | en |
| `check formula` | en |
| `解释公式` | zh |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `formula` | string | yes | The formula text (without the leading `=`). |
| `context` | object | no | Sample cell references and their values; used for type inference. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `explanation` | string | Human-readable walkthrough of the formula. |
| `tokens` | array | Token-by-token breakdown: `{ kind, text, role, operandType }`. |
| `evaluation` | string | Optional: computed result if `context` provides enough cell values. |

## Install

```sh
npm install @genoffice/skill-sheet-formula @genoffice/agent-skills
```

## Register + invoke

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
// "SUMIF iterates A1:A10, picks cells >100 (A2, A3, A5, A7, A8, A10), sums the matching B values (2+3+5+7+8+10 = 35)"
console.log(result.tokens)
console.log(result.evaluation) // "35"
```

## When to use

- Auditing unfamiliar formulas in legacy `.xlsx` files.
- Teaching spreadsheet users how `IF` / `VLOOKUP` / `SUMIFS` chain together.
- Validating that a formula references valid ranges before committing to a workbook save.

## When not to use

- Live formula editing in a workbook (the renderer handles that natively).
- Translating cell labels (use `genoffice.skill.text-translate`).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

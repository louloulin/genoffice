# `genoffice.skill.slides-outline` — Slide Outline Generator

> Generate a slide outline from a prompt + optional context (target audience, duration, tone).

**npm**: [`@genoffice/skill-slides-outline`](https://www.npmjs.com/package/@genoffice/skill-slides-outline)
**Source**: [`packages/skill-slides-outline/`](https://github.com/genspark-ai/genoffice/tree/main/packages/skill-slides-outline)
**Tests**: 10 / 10 passing

## Triggers

| Phrase | Locale |
|---|---|
| `slide outline` | en |
| `presentation outline` | en |
| `幻灯片大纲` | zh |

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | What the deck is about. |
| `audience` | string | no | e.g. `executives`, `engineering team`, `customers`. |
| `duration` | string | no | e.g. `15min`, `1h`. |
| `tone` | enum | no | One of `formal` (default), `casual`, `persuasive`. |
| `slideCount` | integer | no | Target slide count (1..30). Default derived from `duration`. |

## Outputs

| Name | Type | Description |
|---|---|---|
| `title` | string | Suggested deck title. |
| `slides` | array<{ index, title, bullets, notes }> | Per-slide outline: title + bullet points + speaker notes. |
| `totalSlides` | integer | Number of slides in the outline. |

## Install

```sh
npm install @genoffice/skill-slides-outline @genoffice/agent-skills
```

## Register + invoke

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as slidesOutline } from '@genoffice/skill-slides-outline'

const registry = createSkillRegistry()
registry.register(slidesOutline)

const result = await registry.invoke('genoffice.skill.slides-outline', {
  prompt: 'Quarterly product review covering the new dashboard release',
  audience: 'executives',
  duration: '20min',
  tone: 'formal',
})
console.log(result.title)
for (const slide of result.slides) {
  console.log(`#${slide.index} ${slide.title}`)
  for (const b of slide.bullets) console.log(`  - ${b}`)
}
```

## When to use

- Bootstrapping a new deck from a single-sentence brief.
- Producing a structured agenda before drafting the actual slides.
- Sharing a deck plan for review before committing to design.

## When not to use

- Generating the actual slide content (build the outline into the slides editor by hand).
- Producing speaker scripts word-for-word (combine with `genoffice.skill.text-summarize`).

## See also

- [Official Skills](/skills/official) — full list of 11 standalone Skills
- [Authoring Guide](/skills/authoring) — write your own Skill against the same contract
- [Marketplace](/skills/marketplace) — categorized browse

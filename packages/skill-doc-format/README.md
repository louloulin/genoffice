# `@genoffice/skill-doc-format`

Standalone GenOffice Skill — normalises whitespace, line endings, and quote
characters in a plain-text document. Implements the `SkillPackage`
contract from `@genoffice/agent-skills`.

## Operations

Each operation is gated by a flag in `options`. Defaults are sensible for
English / Chinese mixed text.

| Option | Default | Effect |
|---|---|---|
| `collapseSpaces` | `true` | Collapse runs of ≥ 2 spaces / tabs into a single space. |
| `trimTrailing` | `true` | Strip trailing whitespace from each line. |
| `normaliseLineEndings` | `true` | Replace `\r\n` and `\r` with `\n`. |
| `smartQuotes` | `true` | Convert straight `"` and `'` to smart `“ ” ‘ ’. |
| `maxBlankLines` | `2` | Cap runs of blank lines at this count. |

## Build

```sh
pnpm install
pnpm run build       # → dist/{index.mjs,index.cjs}
pnpm test
```

## Install

Add to your web-server's `genoffice.skills.json`:

```json
{
  "skills": [
    { "name": "@genoffice/skill-doc-format", "version": "^0.1.0" }
  ]
}
```

The marketplace loader registers it into `getDefaultSkillRegistry()` at
boot. Renderer triggers: "format document", "clean up document", "整理文档",
"排版".

## API

```ts
import { formatDoc } from '@genoffice/skill-doc-format'

const result = formatDoc('hello    world\n\n\n\n\n!')
// → { text: 'hello world\n\n!', changed: true,
//     stats: { collapsedSpaces: 3, ..., blankLinesCollapsed: 3 } }
```

The Skill manifest (with `execute()`) is at the default export — load
`@genoffice/agent-skills`'s `getDefaultSkillRegistry()` and the marketplace
loader will find it via `pnpm`-linked install.

# AI Chat / ChatInput upgrade plan (aligned with WorkBuddy)

> Goal: reusing as much existing code as possible, turn the AI chat composer shared by all six apps
> (`packages/ui/src/AiComposer.tsx`) into an extensible **ChatComposer**: working modes
> (Ask / Craft / Plan), a `/` command palette for skill invocation, a richer toolbar, and visible
> model / skill context. High cohesion, low coupling: the component knows nothing about any
> concrete skill — each app injects its own command table.

## 1. Current state (evidence)

| Layer             | Location                                                     | Notes                                                                                               |
| ----------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Composer          | `packages/ui/src/AiComposer.tsx` (156 lines)                 | textarea + footer (`footerStart` + hint + send/stop); shared by 6 apps                              |
| Agent loop        | `packages/agent-core/src/loop.ts` `AgentLoop`                | `run(instruction, images)`; `systemSuffix?(): string` injects a dynamic prompt each turn            |
| Skill model       | `packages/agent-core/src/skill.ts` `AgentSkill`              | `{id, systemPrompt, tools, buildContext, executeTool, verifyResponse}`; `composeSkills` merges them |
| App wiring        | docs / sheets / slides / pdf / markdown / html `AiPanel.tsx` | each does `new AgentLoop({ skill: composeSkills(...), systemSuffix: aiLangDirective })`             |
| Selection toolbar | `packages/ui/src/AiInlineLauncher.tsx`                       | floating chips after a text selection (polish / expand / shorten / summarise / translate)           |
| Quick prompts     | inlined in each app's `AiPanel.tsx`                          | the same four `.ai-quick-action` buttons copy-pasted six times                                      |
| Dormant types     | `packages/ui/src/chat/types.ts`                              | `ChatCommand` / `ChatCommandPaletteProps` are defined but unused                                    |
| Slash menu        | `apps/markdown/src/renderer/editor/slashCommand.ts` only     | TipTap editor `/` menu; the AI composer has none                                                    |

**Gaps**: no working modes, no `/` palette, no skill picker; the toolbar only has attach +
revision tracking; quick prompts are duplicated across six apps.

## 2. What to borrow from WorkBuddy (sources: AlephAITech/WorkBuddyGuide, infometa/workbuddyskills)

1. **Three working modes**: Ask (read-only Q&A) / Craft (direct edits, default) / Plan (propose a plan first, execute after confirmation).
2. **`/` invokes a skill**: typing `/` opens the installed skills; picking one loads its rules into this turn.
3. **Progressive disclosure**: skills expose name + description by default; only a hit loads `SKILL.md`, and references/scripts are read on demand.
4. **Six elements of a task brief**: goal / input / actions / constraints / output / acceptance — a good insertable prompt template.
5. **Skill vs. expert vs. connector**: skill = capability, expert = persona + method, connector = external system.

## 3. Design (high cohesion, low coupling)

### 3.1 Pure logic layer (no React, unit-testable)

- `packages/ui/src/chat/composer-commands.ts`
  - `ComposerCommand` type (id / trigger / label / description / kind / keywords / insert / disabled / group / hint)
  - `activeSlashQuery(value, caret, composing)` -> `{query, start, end} | null`: detects a `/command` fragment at the caret (only at the start of the value or right after whitespace, so URLs and paths never trigger it)
  - `filterComposerCommands(commands, query)`: ranked matches (trigger prefix > trigger substring > label / description / keywords)
  - `applyComposerCommand(value, at, cmd)`: replaces the `/query` fragment and returns the new caret
  - `groupComposerCommands` / `nextEnabledIndex` / `firstEnabledIndex`: menu grouping and keyboard navigation
- `packages/ui/src/chat/modes.ts`
  - `ChatMode = 'ask' | 'craft' | 'plan'`, `CHAT_MODE_SPECS` (labelKey / hintKey / directive)
  - `chatModeDirective(mode)`: the English paragraph appended to the system prompt
  - `composeSystemSuffix(...parts)`: safely joins `aiLangDirective` + mode directive + skill note (the low-coupling keystone)
  - `skillDirective({name, description, instructions})`: the turn-scoped note for an explicitly picked skill

### 3.2 UI layer

- `packages/ui/src/AiComposerMenu.tsx`: generic anchored popover (reusing the `.gs-dd-pop` visual language from `dropdown.css` plus `popover-dismiss`), keyboard accessible (up/down / Enter / Esc / Home / End), grouped rendering (skills / actions / templates).
- `packages/ui/src/AiComposer.tsx` extension (**every new prop optional, fully backward compatible**):
  - `commands?` / `onCommandPick?` / `commandMenuLabel?`
  - `modes?` / `mode?` / `onModeChange?`
  - `toolbar?` (right-hand tool slot) / `leading?` (left-hand slot)
  - built in: typing `/` opens the panel; up/down/Enter/Esc are intercepted; `/command` is highlighted
- `packages/ui/src/ai-composer.css`: mode switch, menu, `/` highlight, toolbar slots; token variables only (the repo has a `check:theme-colors` gate), exported through `packages/ui/package.json` and imported from each app's `main.tsx`.

### 3.3 App wiring (thin adapters)

Each `AiPanel.tsx` gains a small adapter:

- skill commands come from that app's own tool/skill table (docs -> document tools, sheets -> spreadsheet tools)
- action commands (summarise / polish / translate / tidy) are lifted out of the existing `aiQuickActions` into one data table
- `systemSuffix` goes from `aiLangDirective` to `() => composeSystemSuffix(aiLangDirective(), chatModeDirective(mode), skillNote)`

**Do docs first as the reference implementation, then copy to the other five apps.**

## 4. Steps

1. This plan document.
2. Pure logic: `composer-commands.ts` + `modes.ts` + unit tests. (done)
3. UI: `AiComposerMenu.tsx` + `AiComposer` extension + `ai-composer.css` + exports.
4. docs wiring (mode switch + `/` panel + toolbar consolidation + systemSuffix).
5. Remaining apps.
6. i18n: new keys in zh/en, other languages fall back to en.
7. Verification: `tsc --noEmit`, `vitest`, `npm run build:all`, real browser end-to-end.

## 5. Acceptance criteria

- [ ] Every new `AiComposer` prop is optional: without them the rendered output is byte-identical to before (covered by a test)
- [ ] `/` opens the panel at the start of the value or after whitespace, and never inside a URL or path (covered by tests)
- [ ] The mode reaches the system prompt, and Ask mode forbids writing tools (covered by tests)
- [ ] The menu is keyboard accessible; Esc closes it without clearing the typed text
- [ ] All six apps compile and run with no behavioural regression
- [ ] A real browser completes "switch mode -> pick a skill with `/` -> send" end to end

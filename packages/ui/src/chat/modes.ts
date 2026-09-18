/**
 * Working modes for the AI panel, modelled on WorkBuddy's Ask / Craft / Plan
 * split. A mode is a *behaviour contract* the panel enforces in two places:
 *
 *  1. the system prompt (a directive appended via `AgentLoop.systemSuffix`),
 *     which is what actually changes how the model behaves;
 *  2. the UI (the composer's mode switch + a visual affordance), so the user
 *     can see which contract is active before sending.
 *
 * Pure data + string helpers only: no React, no app imports. Apps decide which
 * modes they expose (`modes` prop on the composer) and how to render the pill.
 */

export const CHAT_MODES = ['ask', 'craft', 'plan'] as const

/** Ask = read-only Q&A · Craft = direct edits (default) · Plan = propose first. */
export type ChatMode = (typeof CHAT_MODES)[number]

export const DEFAULT_CHAT_MODE: ChatMode = 'craft'

export interface ChatModeSpec {
  readonly id: ChatMode
  /** i18n key suffix the apps resolve; the UI layer never hard-codes copy. */
  readonly labelKey: string
  readonly hintKey: string
  /** Appended to the system prompt. English — the model's instruction channel. */
  readonly directive: string
}

/**
 * Directives are deliberately explicit about the *tool* consequence, not just
 * the tone: "answer, don't edit" is only reliable when it also says which
 * tools are off-limits, because the panel still advertises them.
 */
export const CHAT_MODE_SPECS: Readonly<Record<ChatMode, ChatModeSpec>> = Object.freeze({
  ask: {
    id: 'ask',
    labelKey: 'aiModeAsk',
    hintKey: 'aiModeAskHint',
    directive: [
      '# Working mode: Ask (read-only)',
      '- Answer the question from the document context and read-only tools. Do NOT modify the document.',
      '- Never call a tool that writes, inserts, replaces, formats, deletes, renames or creates content, even if the user phrasing sounds like a request to change something.',
      '- When the user clearly wants a change, say what you would change and suggest switching to Craft or Plan mode — one sentence, then stop.',
      '- Reading tools, web_search and image_search are allowed so your answer is grounded.',
    ].join('\n'),
  },
  craft: {
    id: 'craft',
    labelKey: 'aiModeCraft',
    hintKey: 'aiModeCraftHint',
    directive: [
      '# Working mode: Craft (direct editing)',
      '- Carry out the request end to end: call the tools, then summarise what changed in one or two sentences.',
      '- Lead with the action, not a plan. Only ask a question when a required value is genuinely missing.',
    ].join('\n'),
  },
  plan: {
    id: 'plan',
    labelKey: 'aiModePlan',
    hintKey: 'aiModePlanHint',
    directive: [
      '# Working mode: Plan (propose, then execute)',
      '- First reply with a short numbered plan: the concrete steps, which tools each step uses, and anything you need from the user. Do not call a single writing tool in that turn.',
      '- The plan stays in the conversation. The user replies "go" / "continue" / an amended plan; only then execute it step by step.',
      '- If the user amends the plan, restate the changed steps briefly before executing.',
      '- Reading tools are allowed while planning so the plan reflects the real document.',
    ].join('\n'),
  },
})

/** Human-facing spec for a mode; unknown values fall back to the default. */
export function chatModeSpec(mode: ChatMode | undefined): ChatModeSpec {
  return CHAT_MODE_SPECS[mode ?? DEFAULT_CHAT_MODE] ?? CHAT_MODE_SPECS[DEFAULT_CHAT_MODE]
}

/** The English directive appended to the system prompt for this mode. */
export function chatModeDirective(mode: ChatMode | undefined): string {
  return chatModeSpec(mode).directive
}

export function isChatMode(value: unknown): value is ChatMode {
  return typeof value === 'string' && (CHAT_MODES as readonly string[]).includes(value)
}

/** Normalise persisted / IPC-supplied values. */
export function normalizeChatMode(value: unknown): ChatMode {
  return isChatMode(value) ? value : DEFAULT_CHAT_MODE
}

/** True when the mode must not be allowed to mutate the document. */
export function isReadOnlyMode(mode: ChatMode | undefined): boolean {
  return (mode ?? DEFAULT_CHAT_MODE) === 'ask'
}

/**
 * Join the parts of a per-turn system suffix, dropping the empties.
 *
 * Every app's panel used to pass `systemSuffix: aiLangDirective` directly;
 * adding mode + skill notes by string concatenation at six call sites is how
 * duplicated whitespace bugs start. One helper, one separator.
 */
export function composeSystemSuffix(...parts: Array<string | undefined | null | false>): string {
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join('\n\n')
}

/**
 * Directive for an explicitly picked skill. Mirrors WorkBuddy's "the picked
 * skill is authoritative for this turn" rule without the composer having to
 * understand SKILL.md: the app resolves the skill and hands us its blurb.
 */
export function skillDirective(skill: {
  name: string
  description?: string | undefined
  instructions?: string | undefined
}): string {
  const lines = [
    `# Active skill: ${skill.name}`,
    skill.description ? `Purpose: ${skill.description}` : '',
    'Treat this skill as the authoritative method for this request; follow its workflow and output format over your own defaults.',
    skill.instructions ? `\n${skill.instructions}` : '',
  ]
  return lines.filter((l) => l.length > 0).join('\n')
}

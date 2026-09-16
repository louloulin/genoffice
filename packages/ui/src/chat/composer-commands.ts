/**
 * Slash-command model for the shared AI composer.
 *
 * Pure functions only — no React, no DOM. The composer feeds them the current
 * textarea value + caret offset and gets back both "is a `/query` being typed
 * right now" and the filtered command list. Keeping this out of the component
 * makes the trigger rules (leading-slash only, never mid-URL) unit-testable and
 * lets every app build its own command table without the composer knowing what
 * a "skill" or a "template" is.
 *
 * Wire shape each app supplies:
 *
 *   { id, trigger, label, description?, kind, keywords?, disabled?, group? }
 *
 * `trigger` is the text typed after `/` (no slash), so a docs panel that wants
 * `/sum` registers `trigger: 'sum'`. Matching is prefix-first on the trigger,
 * then substring on trigger/label/description/keywords.
 */

/** What a picked command does — pure data so the composer stays app-agnostic. */
export type ComposerCommandKind =
  /** Appends / replaces the `/query` with `insert` and leaves the caret after it */
  | 'insert'
  /** Runs `onCommandPick` immediately; the composer clears the `/query` */
  | 'run'

export interface ComposerCommand {
  /** Stable id; also the React key. Must be unique within a command list. */
  readonly id: string
  /** Text typed after `/`. Lower-cased, no whitespace. */
  readonly trigger: string
  /** Primary label in the menu. */
  readonly label: string
  /** One-line explanation under the label. */
  readonly description?: string | undefined
  /** Section header the menu groups by (e.g. 'Skills', 'Actions', 'Templates'). */
  readonly group?: string | undefined
  readonly kind: ComposerCommandKind
  /** Extra match terms (English + Chinese aliases, tool names, …). */
  readonly keywords?: readonly string[] | undefined
  /** Text inserted at the caret when kind === 'insert'. Ignored for 'run'. */
  readonly insert?: string | undefined
  /** Rendered but not pickable (e.g. a skill that needs a provider that's off). */
  readonly disabled?: boolean | undefined
  /** Short right-aligned hint in the menu row (e.g. the owning skill id). */
  readonly hint?: string | undefined
}

export interface SlashQuery {
  /** Text after the `/`, may be '' right after the slash is typed. */
  readonly query: string
  /** Index of the `/` character in the value. */
  readonly start: number
  /** Caret offset that ended the query (exclusive). */
  readonly end: number
}

/**
 * The character immediately before which a `/` may start a command.
 * Anything else means the slash belongs to a URL (`https://`), a path
 * (`/usr/bin`), a ratio (`3/4`), or a date — never a command.
 */
function isCommandBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '' || /\s/.test(ch)
}

/**
 * Detect a `/command` fragment ending at `caret`.
 *
 * Rules (mirrors the markdown editor's slash menu so the two feel identical):
 *  - the `/` sits at the very start of the value or right after whitespace
 *  - no whitespace between the `/` and the caret
 *  - the menu is suppressed while an IME composition is active (callers pass
 *    `composing` from the textarea's composition state)
 *
 * Returns null when no command is being typed.
 */
export function activeSlashQuery(
  value: string,
  caret: number,
  composing = false,
): SlashQuery | null {
  if (composing) return null
  if (caret < 0 || caret > value.length) return null
  // walk back from the caret to the nearest whitespace (or the start)
  let i = caret
  while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--
  const chunk = value.slice(i, caret)
  if (!chunk.startsWith('/')) return null
  // a second slash inside the chunk means this is a path, not a command
  if (chunk.indexOf('/', 1) !== -1) return null
  if (!isCommandBoundary(value[i - 1])) return null
  const query = chunk.slice(1)
  // allow a-z 0-9 _ - and CJK; reject punctuation that means "this is a path"
  if (query !== '' && !/^[\w\-\u4e00-\u9fff]+$/.test(query)) return null
  return { query, start: i, end: caret }
}

/**
 * Score one command against a query. Higher is better; 0 means "no match".
 * Prefix on the trigger beats prefix on any other field, which beats a plain
 * substring hit — so typing `/tran` puts `translate` above a skill that merely
 * mentions "translation" in its description.
 */
function matchScore(cmd: ComposerCommand, q: string): number {
  if (q === '') return 1
  const trigger = cmd.trigger.toLowerCase()
  if (trigger.startsWith(q)) return 100 - trigger.length
  const fields = [cmd.label, cmd.description ?? '', ...(cmd.keywords ?? [])]
  let best = 0
  for (const field of fields) {
    const f = field.toLowerCase()
    if (!f) continue
    if (f.startsWith(q)) best = Math.max(best, 60)
    else if (f.includes(q)) best = Math.max(best, 40)
  }
  if (trigger.includes(q)) best = Math.max(best, 50)
  return best
}

/**
 * Filter + rank commands for the menu. Stable within equal scores (input
 * order wins), so an app can control tie-breaks by ordering its table.
 */
export function filterComposerCommands(
  commands: readonly ComposerCommand[],
  query: string,
): ComposerCommand[] {
  const q = query.trim().toLowerCase()
  const scored: Array<{ cmd: ComposerCommand; score: number; index: number }> = []
  commands.forEach((cmd, index) => {
    const score = matchScore(cmd, q)
    if (score > 0) scored.push({ cmd, score, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((s) => s.cmd)
}

/**
 * Replace the `/query` fragment with the command's insert text and compute the
 * new caret. For `kind: 'run'` the fragment is removed outright (the app's
 * handler supplies whatever ends up in the box).
 *
 * A trailing space is appended to an insert so the user keeps typing the
 * actual instruction right after the template without hand-adding one.
 */
export function applyComposerCommand(
  value: string,
  at: SlashQuery,
  cmd: ComposerCommand,
): { value: string; caret: number } {
  const before = value.slice(0, at.start)
  const after = value.slice(at.end)
  if (cmd.kind === 'run') {
    const next = before + after
    return { value: next, caret: before.length }
  }
  const insert = cmd.insert ?? cmd.trigger
  // A separator is only needed when the insert does not already end with
  // whitespace AND the text we are inserting in front of does not already
  // start with it — otherwise `/sum tail` would produce a double space.
  const needsSpace =
    insert.length > 0 && !/\s$/.test(insert) && (after === '' || !/^\s/.test(after))
  const text = insert + (needsSpace ? ' ' : '')
  const next = before + text + after
  return { value: next, caret: before.length + text.length }
}

/**
 * Group commands for rendering, preserving the order groups first appear in
 * the (already ranked) list. Commands without a group land under `fallback`.
 */
export function groupComposerCommands(
  commands: readonly ComposerCommand[],
  fallback = '',
): Array<{ group: string; commands: ComposerCommand[] }> {
  const out: Array<{ group: string; commands: ComposerCommand[] }> = []
  const byName = new Map<string, ComposerCommand[]>()
  for (const cmd of commands) {
    const name = cmd.group ?? fallback
    let bucket = byName.get(name)
    if (!bucket) {
      bucket = []
      byName.set(name, bucket)
      out.push({ group: name, commands: bucket })
    }
    bucket.push(cmd)
  }
  return out
}

/**
 * Next enabled index when arrow-keying through the menu. Skips `disabled`
 * rows and wraps. Returns the starting index when nothing is selectable.
 */
export function nextEnabledIndex(
  commands: readonly ComposerCommand[],
  current: number,
  delta: 1 | -1,
): number {
  const n = commands.length
  if (n === 0) return -1
  let i = current
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n
    if (!commands[i]?.disabled) return i
  }
  return current
}

/** First selectable index, or -1 when every row is disabled. */
export function firstEnabledIndex(commands: readonly ComposerCommand[]): number {
  return commands.findIndex((c) => !c.disabled)
}

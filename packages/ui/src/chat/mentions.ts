/**
 * @-mention model for the shared AI composer.
 *
 * Mirrors `composer-commands.ts` so the two palettes share the same shape and
 * the same detection rules — only the trigger char (`@` vs `/`) and the
 * matched entries differ. Cursor-style: typing `@` opens a fuzzy picker above
 * the caret with whatever the host app wants to advertise (files, blocks,
 * sheets, agents, web references).
 *
 * Pure functions only — no React, no DOM. The composer feeds them the current
 * textarea value + caret offset and gets back:
 *   - `activeMentionQuery` — is an `@query` being typed right now?
 *   - `filterMentionEntries` — which entries match and in what order
 *   - `applyMentionPick`    — what the value+caret become after a pick
 *
 * Wire shape each app supplies:
 *
 *   { id, trigger, label, description?, group?, kind, icon?, disabled? }
 *
 * `trigger` is the text typed after `@` (no `@`), so an entry that wants
 * `@summary` registers `trigger: 'summary'`. Matching is prefix-first on the
 * trigger, then substring on trigger/label/description.
 */

/** Coarse category — used by the renderer to pick an icon and a row colour. */
export type MentionKind =
  | 'file'
  | 'folder'
  | 'block'
  | 'page'
  | 'sheet'
  | 'range'
  | 'agent'
  | 'skill'
  | 'web'
  | 'image'
  | 'doc'
  | 'other'

/** A single entry in the mention palette. Pure data so the menu stays generic. */
export interface MentionEntry {
  /** Stable id; also the React key. Must be unique within a mention list. */
  readonly id: string
  /** Text typed after `@`. Lower-cased, no whitespace. */
  readonly trigger: string
  /** Primary label in the menu. */
  readonly label: string
  /** One-line explanation under the label (file path, sheet name, …). */
  readonly description?: string | undefined
  /** Section header the menu groups by (e.g. 'Files', 'Blocks', 'Skills'). */
  readonly group?: string | undefined
  readonly kind: MentionKind
  /** Extra match terms (English + Chinese aliases, file extensions, …). */
  readonly keywords?: readonly string[] | undefined
  /** Rendered but not pickable (e.g. an offline file). */
  readonly disabled?: boolean | undefined
  /** Short right-aligned hint in the menu row (file extension, skill id, …). */
  readonly hint?: string | undefined
}

export interface MentionQuery {
  /** Text after the `@`, may be '' right after the at-sign is typed. */
  readonly query: string
  /** Index of the `@` character in the value. */
  readonly start: number
  /** Caret offset that ended the query (exclusive). */
  readonly end: number
}

/** A mention picked from the palette. Hosts resolve this into a prompt token. */
export interface MentionPick {
  readonly entry: MentionEntry
  /** The text inserted at the caret — defaults to `@label`. */
  readonly insert: string
  readonly value: string
  readonly caret: number
  readonly query: string
}

/**
 * The character immediately before which a `@` may start a mention.
 * Mirrors the slash rule: mid-word `@` is part of an email address and must
 * never open the palette.
 */
function isMentionBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '' || /\s/.test(ch)
}

/**
 * Detect an `@mention` fragment ending at `caret`.
 *
 * Rules:
 *  - the `@` sits at the very start of the value or right after whitespace
 *  - no whitespace between the `@` and the caret
 *  - the palette is suppressed while an IME composition is active
 *  - the `@` must NOT be preceded by an alphanumeric char (would be an email)
 *  - a second `@` inside the chunk means this is a notification fragment, not a mention
 *
 * Returns null when no mention is being typed.
 */
export function activeMentionQuery(
  value: string,
  caret: number,
  composing = false,
): MentionQuery | null {
  if (composing) return null
  if (caret < 1 || caret > value.length) return null
  // walk back from the caret to the nearest whitespace (or the start)
  let i = caret
  while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--
  const chunk = value.slice(i, caret)
  if (!chunk.startsWith('@')) return null
  // two at-signs in the same chunk => this is a quoted reply, not a mention
  if (chunk.indexOf('@', 1) !== -1) return null
  if (!isMentionBoundary(value[i - 1])) return null
  const query = chunk.slice(1)
  // allow a-z 0-9 _ - / . and CJK; reject punctuation that means "this is not a mention"
  if (query !== '' && !/^[\w\-/. \u4e00-\u9fff]+$/.test(query)) return null
  return { query, start: i, end: caret }
}

/** Score one entry against a query. Higher is better; 0 means "no match". */
function scoreEntry(entry: MentionEntry, q: string): number {
  if (q === '') return 1
  const trig = entry.trigger.toLowerCase()
  const label = entry.label.toLowerCase()
  const desc = entry.description?.toLowerCase() ?? ''
  if (trig === q) return 1000
  if (trig.startsWith(q)) return 500
  if (label.startsWith(q)) return 300
  if (trig.includes(q)) return 100
  if (label.includes(q)) return 60
  if (desc.includes(q)) return 30
  for (const kw of entry.keywords ?? []) {
    const k = kw.toLowerCase()
    if (k.startsWith(q)) return 200
    if (k.includes(q)) return 40
  }
  return 0
}

export interface MentionGroup {
  readonly group: string
  readonly entries: readonly MentionEntry[]
}

export interface MentionFilterResult {
  readonly query: string
  readonly groups: readonly MentionGroup[]
  /** Index of the first enabled entry in the flattened order. */
  readonly firstEnabledIndex: number
}

/**
 * Filter and group a mention list by a query. Entries with score 0 are
 * dropped; the rest are sorted by score (descending) inside their group,
 * then grouped in the original declaration order — same shape the slash
 * palette uses so the menu renderer is one component.
 */
export function filterMentionEntries(
  entries: readonly MentionEntry[],
  query: string,
): MentionFilterResult {
  const q = query.toLowerCase().trim()
  const scored = entries
    .map((e) => ({ entry: e, s: scoreEntry(e, q) }))
    .filter((x) => x.s > 0)
  const groupOrder: string[] = []
  const groupMap = new Map<string, MentionEntry[]>()
  for (const { entry } of scored) {
    const g = entry.group ?? ''
    if (!groupMap.has(g)) {
      groupMap.set(g, [])
      groupOrder.push(g)
    }
    const bucket = groupMap.get(g)!
    bucket.push(entry)
    bucket.sort((a, b) => scoreEntry(b, q) - scoreEntry(a, q))
  }
  // preserve the order of `groupOrder` against the input list to keep
  // "Files" before "Blocks" when both exist.
  const groups: MentionGroup[] = []
  for (const g of groupOrder) {
    const list = groupMap.get(g) ?? []
    if (list.length === 0) continue
    groups.push({ group: g, entries: list })
  }
  const firstEnabledIndex = groups
    .flatMap((g) => g.entries)
    .findIndex((e) => !e.disabled)
  return { query: q, groups, firstEnabledIndex: firstEnabledIndex < 0 ? 0 : firstEnabledIndex }
}

/** Flatten grouped mentions to a single index space the renderer can walk. */
export function flattenMentionGroups(groups: readonly MentionGroup[]): readonly MentionEntry[] {
  return groups.flatMap((g) => g.entries)
}

/** Locate the index of an entry inside the flattened order (used by Enter / arrow keys). */
export function indexOfMention(
  groups: readonly MentionGroup[],
  entryId: string,
): number {
  return flattenMentionGroups(groups).findIndex((e) => e.id === entryId)
}

/**
 * Compute the new value + caret after a mention pick.
 * Removes the typed `@query` and inserts `insert` (defaults to `@label`) at
 * the same position, then leaves the caret immediately after.
 */
export function applyMentionPick(
  value: string,
  query: MentionQuery,
  entry: MentionEntry,
): { value: string; caret: number } {
  const insertText = (entry.label || entry.trigger).trim()
  const insert = `@${insertText} `
  const next = value.slice(0, query.start) + insert + value.slice(query.end)
  return { value: next, caret: query.start + insert.length }
}

/** What the picker inserts into the textarea when no `insert` override is given. */
export function mentionInsertText(entry: MentionEntry): string {
  const base = (entry.label || entry.trigger).trim()
  return `@${base} `
}

/**
 * Resolve the next highlight index, skipping disabled rows.
 * Mirrors the slash palette so the keyboard feel is identical.
 */
export function nextEnabledMentionIndex(
  flat: readonly MentionEntry[],
  current: number,
  direction: 1 | -1,
): number {
  if (flat.length === 0) return -1
  let next = current
  for (let i = 0; i < flat.length; i++) {
    next = (next + direction + flat.length) % flat.length
    if (!flat[next]?.disabled) return next
  }
  return current
}

/** Decode the `@token` boundaries inside an inserted value — used by the host to
 *  resolve mentions to file paths / sheet refs before sending the prompt. */
export interface MentionToken {
  readonly id: string
  readonly label: string
  readonly start: number
  readonly end: number
  readonly kind: MentionKind
}
export function parseMentionTokens(value: string, known: readonly MentionEntry[]): MentionToken[] {
  const tokens: MentionToken[] = []
  // simple regex: `@<word-or-CJK-or-dash>` — stops at whitespace/punctuation
  const re = /@([\w\-.\u4e00-\u9fff]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const label = m[1] ?? ''
    if (label.length === 0) continue
    const entry = known.find(
      (e) => e.trigger.toLowerCase() === label.toLowerCase() || e.label.toLowerCase() === label.toLowerCase(),
    )
    if (!entry) continue
    tokens.push({ id: entry.id, label, start, end, kind: entry.kind })
  }
  return tokens
}

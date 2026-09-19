/**
 * The docs AI panel's @-mention table.
 *
 * Cursor-style: typing `@` opens a fuzzy picker that advertises the things
 * the user can attach to the prompt — currently uploaded attachments plus
 * the same skills the `/` palette exposes. The composer only knows the
 * data shape; the docs panel resolves picks into prompt tokens.
 *
 * The list is rebuilt every render so attachment removals show up
 * immediately. Disabled rows are kept visible (the user can see the file
 * exists but is currently unreadable) instead of being hidden, so the
 * palette still teaches what is on offer.
 */
import type { MentionEntry } from '@genoffice/ui'
import type { AttachmentMeta } from '../../shared/ipc'

/** A file the user can `@`-mention. May be the active upload or a recent one. */
export interface DocsMentionFile {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly kind: 'file'
  readonly disabled?: boolean
  readonly ext?: string
}

/**
 * Build the file portion of the mention palette.
 * Attachments come first (most likely target), then the most recent historic
 * files so the user can re-attach without scrolling up the chat.
 */
export function docsMentionFiles(input: {
  attachments: readonly AttachmentMeta[]
  recent: readonly AttachmentMeta[]
  max?: number
}): readonly MentionEntry[] {
  const max = input.max ?? 8
  const seen = new Set<string>()
  const out: MentionEntry[] = []
  const push = (a: AttachmentMeta): void => {
    if (out.length >= max) return
    if (seen.has(a.path)) return
    seen.add(a.path)
    const label = a.name
    const trigger = label
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^\w\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '') || label
    out.push({
      id: `file-${a.path}`,
      trigger: trigger.slice(0, 16),
      label,
      description: a.path,
      group: 'Files',
      kind: 'file',
      hint: a.ext ? `.${a.ext}` : undefined,
      disabled: false,
    })
  }
  for (const a of input.attachments) push(a)
  for (const a of input.recent) push(a)
  return out
}

/**
 * Skill mentions — same skills as the slash palette but addressed by `@`.
 * The host resolves i18n keys (labelKey / descriptionKey) before passing
 * the entry to the picker; this helper only re-shapes the data.
 */
export interface DocsMentionSkillEntry {
  readonly id: string
  readonly trigger: string
  readonly label: string
  readonly description: string
  readonly available: boolean
}

export function docsMentionSkills(
  skills: readonly DocsMentionSkillEntry[],
): readonly MentionEntry[] {
  return skills.map((skill) => ({
    id: `skill-${skill.id}`,
    trigger: skill.trigger,
    label: skill.label,
    description: skill.description,
    group: 'Skills',
    kind: 'skill',
    disabled: !skill.available,
    hint: skill.id,
  }))
}

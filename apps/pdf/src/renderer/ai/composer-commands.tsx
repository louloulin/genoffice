/**
 * The PDF AI panel's slash-command table.
 *
 * Two groups: Skills (PDF read/write + selection-scope tools) and Actions
 * (the same one-click buttons that used to live as hand-written chips). The
 * mention table lives next to it so the two palettes share the same data
 * shape and stay in sync.
 */
import React from 'react'
import type { ComposerCommand, MentionEntry } from '@genoffice/ui'
import type { StringKey } from '../i18n/locale'

export interface PdfQuickAction {
  readonly id: string
  readonly trigger: string
  readonly labelKey: StringKey
  readonly promptKey: StringKey
  /** tooltip key (i18n); AiPanel falls back to action.id when omitted */
  readonly tipKey?: StringKey
  readonly icon: React.ReactNode
}

export interface PdfSkillOption {
  readonly id: string
  readonly trigger: string
  readonly labelKey: StringKey
  readonly descriptionKey: StringKey
  readonly available: boolean
}

const SKILL_PREFIX = 'skill.'
const ACTION_PREFIX = 'action.'

export function pdfSkillCommandId(id: string): string {
  return `${SKILL_PREFIX}${id}`
}

export function pdfActionCommandId(id: string): string {
  return `${ACTION_PREFIX}${id}`
}

export function pdfSkillIdOfCommand(commandId: string): string | null {
  return commandId.startsWith(SKILL_PREFIX) ? commandId.slice(SKILL_PREFIX.length) : null
}

/** The three one-click prompts above the composer. */
export const PDF_QUICK_ACTIONS: readonly PdfQuickAction[] = [
  {
    id: 'summary',
    trigger: 'sum',
    labelKey: 'aiQuickSummary',
    promptKey: 'aiQuickSummaryPrompt',
    tipKey: 'aiQuickTipSummary',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path d="M3 3h7M3 6h10M3 9h8M3 12h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'keypoints',
    trigger: 'key',
    labelKey: 'aiQuickKeyPoints',
    promptKey: 'aiQuickKeyPointsPrompt',
    tipKey: 'aiQuickTipKeyPoints',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.5 8l1.8 1.8L10.5 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'translate',
    trigger: 'tran',
    labelKey: 'aiChipTranslate',
    promptKey: 'aiChipTranslate',
    tipKey: 'aiQuickTipTranslate',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path d="M2 3h6M5 3v1.5C5 7 3.5 8.5 2 9M6 5.5C5.5 7 4.5 8 3 8.5M9 13l2-5 2 5M9.7 11.5h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
]

/**
 * Skills the PDF loop actually composes. The PDF panel's tools mostly live
 * inside the single `createPdfSkill`; the agents-team / web / image skills
 * come from `composeSkills` upstream.
 */
export function pdfSkillOptions(): readonly PdfSkillOption[] {
  return [
    {
      id: 'pdf',
      trigger: 'pdf',
      labelKey: 'aiSkillPdf',
      descriptionKey: 'aiSkillPdfDesc',
      available: true,
    },
  ]
}

export function buildPdfComposerCommands(input: {
  t: (key: StringKey) => string
  skills: readonly PdfSkillOption[]
  quickActions: readonly PdfQuickAction[]
}): ComposerCommand[] {
  const { t, skills, quickActions } = input
  const groupSkills = t('aiCmdGroupSkills')
  const groupActions = t('aiCmdGroupActions')
  const groupTemplates = t('aiCmdGroupTemplates')

  return [
    ...skills.map<ComposerCommand>((skill) => ({
      id: pdfSkillCommandId(skill.id),
      trigger: skill.trigger,
      label: t(skill.labelKey),
      description: t(skill.descriptionKey),
      group: groupSkills,
      kind: 'run',
      disabled: !skill.available,
      hint: skill.id,
    })),
    ...quickActions.map<ComposerCommand>((action) => ({
      id: pdfActionCommandId(action.id),
      trigger: action.trigger,
      label: t(action.labelKey),
      group: groupActions,
      kind: 'insert',
      insert: t(action.promptKey),
      hint: action.id,
    })),
    {
      id: 'tpl.brief',
      trigger: 'brief',
      label: t('aiCmdTplBrief'),
      description: t('aiCmdTplBriefDesc'),
      group: groupTemplates,
      kind: 'insert',
      insert: t('aiCmdTplBriefInsert'),
      keywords: ['template', 'brief', '任务', '模板', 'goal'],
    },
  ]
}

/** @-mention table — PDFs are single-file so this is just the open document. */
export function pdfMentionEntries(input: {
  fileName: string
  pageCount: number
  skills: ReadonlyArray<{ id: string; trigger: string; labelKey: StringKey; descriptionKey: StringKey; available: boolean }>
  t: (key: StringKey) => string
}): readonly MentionEntry[] {
  const { fileName, pageCount, skills, t } = input
  return [
    {
      id: 'file-current',
      trigger: 'doc',
      label: fileName,
      description: `${pageCount} 页`,
      group: 'Files',
      kind: 'file',
      hint: '.pdf',
    },
    ...skills.map((s) => ({
      id: `skill-${s.id}`,
      trigger: s.trigger,
      label: t(s.labelKey),
      description: t(s.descriptionKey),
      group: 'Skills',
      kind: 'skill' as const,
      disabled: !s.available,
      hint: s.id,
    })),
  ]
}

/**
 * The sheets AI panel's slash-command table.
 *
 * Mirrors docs/src/renderer/ai/composer-commands.tsx — one data source feeds
 * both the quick-action chips and the `/` palette. Picking a skill loads its
 * rules for the following turns (workbuddy-style `/skill` semantics); picking
 * a quick action drops a prompt into the textarea.
 */
import React from 'react'
import type { ComposerCommand } from '@genoffice/ui'
import type { StringKey } from '../i18n/locale'

export interface SheetsQuickAction {
  readonly id: string
  readonly trigger: string
  readonly labelKey: StringKey
  readonly promptKey: StringKey
  readonly icon: React.ReactNode
}

export interface SheetsSkillOption {
  readonly id: string
  readonly trigger: string
  readonly labelKey: StringKey
  readonly descriptionKey: StringKey
  readonly available: boolean
}

const SKILL_PREFIX = 'skill.'
const ACTION_PREFIX = 'action.'

export function skillCommandId(id: string): string {
  return `${SKILL_PREFIX}${id}`
}

export function actionCommandId(id: string): string {
  return `${ACTION_PREFIX}${id}`
}

export function skillIdOfCommand(commandId: string): string | null {
  return commandId.startsWith(SKILL_PREFIX) ? commandId.slice(SKILL_PREFIX.length) : null
}

export const TEMPLATE_BRIEF_ID = 'tpl.brief'

/** Quick-action chips that appear above the composer. */
export const SHEETS_QUICK_ACTIONS: readonly SheetsQuickAction[] = [
  {
    id: 'check',
    trigger: 'check',
    labelKey: 'aiCheckBtn',
    promptKey: 'aiCheckPrompt',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path d="M3 7l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'analyze',
    trigger: 'anal',
    labelKey: 'aiAnalyzeBtn',
    promptKey: 'aiAnalyzePrompt',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path d="M2 13h12M3 11l2-4 3 3 4-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'translate',
    trigger: 'tran',
    labelKey: 'aiTranslateBtn',
    promptKey: 'aiTranslatePrompt',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path d="M2 3h6M5 3v1.5C5 7 3.5 8.5 2 9M6 5.5C5.5 7 4.5 8 3 8.5M9 13l2-5 2 5M9.7 11.5h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
]

/**
 * Skill palette options. `available` flips the palette row to disabled when
 * the underlying capability is genuinely off — image generation without a
 * provider, for example — instead of hiding the row, so the user still
 * discovers the capability exists.
 */
export function sheetsSkillOptions(input: { imageGenAvailable: boolean }): readonly SheetsSkillOption[] {
  return [
    {
      id: 'workbook',
      trigger: 'work',
      labelKey: 'aiSkillWorkbook',
      descriptionKey: 'aiSkillWorkbookDesc',
      available: true,
    },
    {
      id: 'files',
      trigger: 'fi',
      labelKey: 'aiSkillFiles',
      descriptionKey: 'aiSkillFilesDesc',
      available: true,
    },
    {
      id: 'search',
      trigger: 'sea',
      labelKey: 'aiSkillSearch',
      descriptionKey: 'aiSkillSearchDesc',
      available: true,
    },
    {
      id: 'image',
      trigger: 'img',
      labelKey: 'aiSkillImage',
      descriptionKey: 'aiSkillImageDesc',
      available: input.imageGenAvailable,
    },
    {
      id: 'merge',
      trigger: 'mer',
      labelKey: 'aiSkillMerge',
      descriptionKey: 'aiSkillMergeDesc',
      available: true,
    },
  ]
}

export function buildSheetsComposerCommands(input: {
  t: (key: StringKey) => string
  skills: readonly SheetsSkillOption[]
  quickActions: readonly SheetsQuickAction[]
}): ComposerCommand[] {
  const { t, skills, quickActions } = input
  const groupSkills = t('aiCmdGroupSkills')
  const groupActions = t('aiCmdGroupActions')
  const groupTemplates = t('aiCmdGroupTemplates')

  return [
    ...skills.map<ComposerCommand>((skill) => ({
      id: skillCommandId(skill.id),
      trigger: skill.trigger,
      label: t(skill.labelKey),
      description: t(skill.descriptionKey),
      group: groupSkills,
      kind: 'run',
      disabled: !skill.available,
      hint: skill.id,
    })),
    ...quickActions.map<ComposerCommand>((action) => ({
      id: actionCommandId(action.id),
      trigger: action.trigger,
      label: t(action.labelKey),
      group: groupActions,
      kind: 'insert',
      insert: t(action.promptKey),
      hint: action.id,
    })),
    {
      id: TEMPLATE_BRIEF_ID,
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

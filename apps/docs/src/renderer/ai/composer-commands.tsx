/**
 * The docs AI panel's slash-command table.
 *
 * One data source feeds both the quick-action chips above the composer and the
 * `/` palette, so the two can never drift (they used to be four hand-written
 * buttons duplicated in every app).
 *
 * The `skills` group is the honest capability list of this panel: it mirrors
 * what the agent loop actually composes for docs — `createDocsSkill` (the
 * document tools) and `createFilesSkill` (attachments) — plus the network and
 * media tools in `AGENT_TOOLS`. A skill that is genuinely unavailable (image
 * generation without a provider) is rendered disabled rather than hidden, so
 * the palette still teaches the capability exists.
 *
 * Picking a skill loads its rules for the following turns through
 * `skillDirective()` (see `chat/modes.ts`), which is WorkBuddy's `/skill`
 * semantic; picking an action just drops a prompt into the box.
 */
import React from 'react'
import type { ComposerCommand } from '@genoffice/ui'
import type { StringKey } from '../i18n/locale'

export interface DocsQuickAction {
  readonly id: string
  readonly trigger: string
  readonly labelKey: StringKey
  readonly promptKey: StringKey
  readonly icon: React.ReactNode
}

/**
 * The four one-click prompts. Order is the chip order in the UI; the palette
 * keeps the same order inside its Actions group.
 */
export const DOCS_QUICK_ACTIONS: readonly DocsQuickAction[] = [
  {
    id: 'summarize',
    trigger: 'sum',
    labelKey: 'aiSummarizeBtn',
    promptKey: 'aiSummarizePrompt',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path
          d="M3 3h7M3 6h10M3 9h8M3 12h6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'polish',
    trigger: 'polish',
    labelKey: 'aiPolishBtn',
    promptKey: 'aiPolishPrompt',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path
          d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
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
        <path
          d="M2 3h6M5 3v1.5C5 7 3.5 8.5 2 9M6 5.5C5.5 7 4.5 8 3 8.5M9 13l2-5 2 5M9.7 11.5h2.6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: 'tidy',
    trigger: 'tidy',
    labelKey: 'aiTidyBtn',
    promptKey: 'aiTidyPrompt',
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path
          d="M3 4h10M3 8h7M3 12h5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
]

/** A skill the docs agent can be told to follow, with its live availability. */
export interface DocsSkillOption {
  /** AgentSkill id — the same id the loop composes, so the two stay linked. */
  readonly id: string
  readonly trigger: string
  readonly labelKey: StringKey
  readonly descriptionKey: StringKey
  /** false renders the row disabled (the capability exists but is unusable now) */
  readonly available: boolean
  readonly keywords: readonly string[]
  /** system-prompt note handed to `skillDirective()` when picked */
  readonly instructions: string
}

/**
 * The skills this panel really has. Keep in sync with the `composeSkills(...)`
 * call in AiPanel: `docx` is `createDocsSkill`, `files` is
 * `createFilesSkill`, and `web` / `image` / `draw` are the network and media
 * tools inside `AGENT_TOOLS`.
 */
export function docsSkillOptions(flags: {
  /** generate_image is filtered out of AGENT_TOOLS when no provider is set */
  imageGenAvailable: boolean
}): readonly DocsSkillOption[] {
  return [
    {
      id: 'docx',
      trigger: 'doc',
      labelKey: 'aiCmdSkillDocs',
      descriptionKey: 'aiCmdSkillDocsDesc',
      available: true,
      keywords: ['document', 'word', 'docx', '文档', '编辑', '写作', '排版', 'format', 'write'],
      instructions:
        'Work through the document tools: read the current state before editing, address blocks by index, and keep the existing formatting unless asked to change it.',
    },
    {
      id: 'files',
      trigger: 'file',
      labelKey: 'aiCmdSkillFiles',
      descriptionKey: 'aiCmdSkillFilesDesc',
      available: true,
      keywords: ['attachment', 'upload', 'file', '附件', '文件', 'pdf'],
      instructions:
        'Ground the answer in the uploaded attachments: read them before answering and cite which attachment each claim comes from.',
    },
    {
      id: 'web',
      trigger: 'web',
      labelKey: 'aiCmdSkillWeb',
      descriptionKey: 'aiCmdSkillWebDesc',
      available: true,
      keywords: ['search', 'internet', '联网', '搜索', '网页'],
      instructions:
        'Use web search to ground the answer in current sources, and mention the source in the reply.',
    },
    {
      id: 'image',
      trigger: 'img',
      labelKey: 'aiCmdSkillImage',
      descriptionKey: 'aiCmdSkillImageDesc',
      available: true,
      keywords: ['image', 'picture', 'photo', '图片', '配图', '插图'],
      instructions: 'Look for a suitable existing image first and insert it into the document.',
    },
    {
      id: 'draw',
      trigger: 'draw',
      labelKey: 'aiCmdSkillDraw',
      descriptionKey: 'aiCmdSkillDrawDesc',
      available: flags.imageGenAvailable,
      keywords: ['generate', 'illustration', 'draw', '生成', '画图', '配图'],
      instructions:
        'Generate an illustration that matches the description and insert it at the relevant place in the document.',
    },
  ]
}

/** `skill.<id>` for skills, `action.<id>` for the prompt chips, `tpl.*` for templates. */
const SKILL_PREFIX = 'skill.'
const ACTION_PREFIX = 'action.'

export function skillCommandId(id: string): string {
  return `${SKILL_PREFIX}${id}`
}

export function actionCommandId(id: string): string {
  return `${ACTION_PREFIX}${id}`
}

/**
 * Inverse of `skillCommandId`: the skill a picked command activates, or null
 * when the command is an action / template. Keeps callers from slicing the
 * prefix by hand and drifting when the id scheme changes.
 */
export function skillIdOfCommand(commandId: string): string | null {
  return commandId.startsWith(SKILL_PREFIX) ? commandId.slice(SKILL_PREFIX.length) : null
}

export const TEMPLATE_BRIEF_ID = 'tpl.brief'

export function buildDocsComposerCommands(input: {
  t: (key: StringKey) => string
  skills: readonly DocsSkillOption[]
  quickActions: readonly DocsQuickAction[]
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
      keywords: skill.keywords,
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

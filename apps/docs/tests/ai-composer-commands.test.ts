/**
 * The docs slash-command table.
 *
 * These are the invariants the palette relies on: ids are unique and stable
 * (the composer keys rows and the panel parses skill ids out of them), the
 * skill rows mirror the loop's real capabilities, and picking a skill is
 * distinguishable from picking a prompt.
 */
import { describe, expect, it } from 'vitest'
import { setModuleLang, t as translate } from '../src/renderer/i18n/locale'
import {
  DOCS_QUICK_ACTIONS,
  buildDocsComposerCommands,
  docsSkillOptions,
  skillIdOfCommand,
} from '../src/renderer/ai/composer-commands'

// the table never renders copy itself; it asks the panel's i18n for it
function build(imageGenAvailable = true, t = translate) {
  return buildDocsComposerCommands({
    t,
    skills: docsSkillOptions({ imageGenAvailable }),
    quickActions: DOCS_QUICK_ACTIONS,
  })
}

describe('buildDocsComposerCommands', () => {
  it('produces unique ids and triggers', () => {
    const commands = build()
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length)
    expect(new Set(commands.map((c) => c.trigger)).size).toBe(commands.length)
  })

  it('lists the skills the docs loop actually composes', () => {
    const skills = build().filter((c) => c.id.startsWith('skill.'))
    // createDocsSkill + createFilesSkill + the network/media tools in AGENT_TOOLS
    expect(skills.map((c) => c.id)).toEqual([
      'skill.docx',
      'skill.files',
      'skill.web',
      'skill.image',
      'skill.draw',
    ])
    expect(skills.every((c) => c.kind === 'run')).toBe(true)
  })

  it('renders image generation as disabled instead of hiding it when unavailable', () => {
    const off = build(false).find((c) => c.id === 'skill.draw')
    expect(off?.disabled).toBe(true)
    // and enabled when a provider is configured
    expect(build(true).find((c) => c.id === 'skill.draw')?.disabled).toBe(false)
  })

  it('keeps the quick actions as insert commands carrying their prompt', () => {
    const actions = build().filter((c) => c.id.startsWith('action.'))
    expect(actions.map((c) => c.id)).toEqual([
      'action.summarize',
      'action.polish',
      'action.translate',
      'action.tidy',
    ])
    expect(actions.every((c) => c.kind === 'insert' && (c.insert ?? '').length > 0)).toBe(true)
    // the trigger is what the user types, the prompt is what lands in the box
    expect(actions.find((c) => c.id === 'action.summarize')?.insert).toBe(
      translate('aiSummarizePrompt'),
    )
  })

  it('groups rows so the palette shows three sections', () => {
    // every row is grouped, so the palette always renders titled sections
    const groups = build().map((c) => c.group ?? '')
    expect([...new Set(groups)]).toEqual([
      translate('aiCmdGroupSkills'),
      translate('aiCmdGroupActions'),
      translate('aiCmdGroupTemplates'),
    ])
    // the sections are real copy, never leaked i18n keys
    expect(groups.every((g) => g !== '' && !/^ai[A-Z]/.test(g))).toBe(true)
  })

  it('inserts the six-element brief as a multi-line template', () => {
    const brief = build().find((c) => c.id === 'tpl.brief')
    expect(brief?.kind).toBe('insert')
    expect(brief?.insert).toBe(translate('aiCmdTplBriefInsert'))
    // six labelled lines, so the model gets an unambiguous brief
    expect(brief?.insert?.split('\n')).toHaveLength(6)
  })
})

describe('skillIdOfCommand', () => {
  it('extracts the skill id from a skill command', () => {
    expect(skillIdOfCommand('skill.docx')).toBe('docx')
  })

  it('returns null for actions and templates', () => {
    expect(skillIdOfCommand('action.summarize')).toBeNull()
    expect(skillIdOfCommand('tpl.brief')).toBeNull()
  })
})

describe('localised copy', () => {
  it('resolves every key the table asks for, in zh and in en', () => {
    setModuleLang('zh')
    const zh = build()
    expect(zh.every((c) => !/^ai[A-Z]/.test(c.label) && !/^ai[A-Z]/.test(c.description ?? ''))).toBe(
      true,
    )
    expect(zh.find((c) => c.id === 'skill.docx')?.label).toBe('文档编辑')
    expect(zh.find((c) => c.id === 'tpl.brief')?.insert).toContain('验收标准')

    setModuleLang('en')
    const en = build()
    expect(en.every((c) => !/^ai[A-Z]/.test(c.label) && !/^ai[A-Z]/.test(c.description ?? ''))).toBe(
      true,
    )
    expect(en.find((c) => c.id === 'skill.docx')?.label).toBe('Document editing')
    expect(en.find((c) => c.id === 'tpl.brief')?.insert).toContain('Acceptance')

    setModuleLang('zh')
  })

  it('renders the three working modes in the active language', () => {
    setModuleLang('zh')
    expect(translate('aiModeAsk')).toBe('问一问')
    expect(translate('aiModePlanHint')).toContain('确认')
    setModuleLang('en')
    expect(translate('aiModeAsk')).toBe('Ask')
    expect(translate('aiModeCraftHint')).toContain('default')
    setModuleLang('zh')
  })
})

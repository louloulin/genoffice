/**
 * Worked example of a third-party Skill.
 *
 * Counts the words in a `.docx` and returns per-paragraph counts.
 * Implements the `SkillPackage` contract from
 * `@genoffice/agent-skills`.
 */

import type { SkillDefinition, SkillPackage } from '@genoffice/agent-skills'

const skill: SkillDefinition = {
  id: 'genoffice.skill.doc.word-counter',
  version: '1.0.0',
  name: { 'en-US': 'Word Counter', 'zh-CN': '字数统计' },
  description: {
    'en-US': 'Counts the words in a .docx file.',
    'zh-CN': '统计一个 .docx 文件的字数。',
  },
  triggers: ['count words', '统计字数'],
  inputs: [
    {
      name: 'file',
      schema: {
        type: 'file',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        required: true,
      },
    },
  ],
  outputs: [
    { name: 'count', schema: { type: 'number' } },
    {
      name: 'byParagraph',
      schema: {
        type: 'array',
        // SkillArraySchema requires `items` describing the element shape.
        // The renderer uses this for preview / auto-fill hints.
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            count: { type: 'number' },
          },
        },
      },
    },
  ],
  requiredPermissions: ['files:read'],
  tags: ['document', 'utility'],
  readme: '# Word Counter\n\nReturns the total word count of a `.docx` plus per-paragraph counts.',

  async execute(ctx, inputs) {
    ctx.emitProgress({ phase: 'started', progress: 0, message: 'Loading document…' })
    const file = await ctx.workspace.open(String(inputs.file))
    const text = new TextDecoder('utf-8').decode(file.bytes ?? new Uint8Array())

    ctx.emitProgress({ phase: 'progress', progress: 0.5, message: 'Counting words…' })
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    const byParagraph = paragraphs.map((p) => ({ text: p.trim(), count: p.trim().split(/\s+/).filter(Boolean).length }))
    const count = byParagraph.reduce((sum, p) => sum + p.count, 0)

    ctx.emitProgress({ phase: 'completed', progress: 1, message: `${count} words` })
    return { count, byParagraph }
  },
}

const pkg: SkillPackage = { skill }

export default pkg

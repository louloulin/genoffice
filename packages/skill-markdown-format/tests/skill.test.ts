import { describe, expect, it } from 'vitest'
import { skill } from '../src/index'

describe('@genoffice/skill-markdown-format', () => {
  it('declares a stable id and at least one trigger', () => {
    expect(skill.id).toMatch(/^genoffice\.skill\./)
    expect(skill.triggers.length).toBeGreaterThan(0)
  })

  it('rejects non-string markdown input', async () => {
    await expect(skill.execute({} as never, { markdown: 123 })).rejects.toThrow(/markdown/)
  })

  it('normalises heading levels and clamps to maxHeadingLevel', async () => {
    const out = await skill.execute({} as never, {
      markdown: '####### Too deep\n##  Title  ###\n',
      maxHeadingLevel: 3,
    })
    const m = out.markdown as string
    // 7 hashes get clamped to 3; trailing #'s stripped; double spaces removed
    expect(m).toMatch(/^### Too deep\n## Title\n$/)
    expect(out.changes as number).toBeGreaterThan(0)
  })

  it('switches bullet markers', async () => {
    const out = await skill.execute({} as never, {
      markdown: '* one\n* two\n',
      bulletMarker: '+',
    })
    expect(out.markdown as string).toMatch(/^\+ one\n\+ two\n$/)
  })

  it('fills code fence language hint', async () => {
    const out = await skill.execute({} as never, {
      markdown: '```\nhello\n```\n',
    })
    expect(out.markdown as string).toContain('```text\nhello\n```')
  })

  it('collapses 3+ blank lines into 2', async () => {
    const out = await skill.execute({} as never, {
      markdown: 'a\n\n\n\n\nb\n',
    })
    expect(out.markdown as string).toBe('a\n\nb\n')
  })

  it('strips orphan bold markers', async () => {
    const out = await skill.execute({} as never, {
      markdown: 'a **b c d e f g\n',
    })
    expect(out.markdown as string).not.toMatch(/\*\*/)
  })
})

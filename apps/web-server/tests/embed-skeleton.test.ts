/**
 * Embed entry skeleton (brief A19 / spec inline-CSS skeleton).
 *
 * `/embed/` HTML must paint an editor outline before the renderer bundle
 * executes and keep it visible with JavaScript disabled. The skeleton markup
 * lives inside <div id="root"> so React's first mount clears it, and its CSS
 * references semantic tokens — no raw chrome colors.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/common/index', () => ({ APPS: ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'] }))

const { buildEmbedHtml } = await import('../src/embed/index')

function fakeIndex(): string {
  const dir = mkdtempSync(join(tmpdir(), 'go-skel-'))
  const path = join(dir, 'index.html')
  writeFileSync(
    path,
    '<html lang="zh-CN"><head><title>GenOffice Docs</title></head><body><div id="root"></div></body></html>',
    'utf-8',
  )
  return path
}

const baseQuery = {
  token: 't',
  app: 'docs',
  mode: 'edit',
  lang: 'zh-CN',
  toolbar: 'full',
} as const

describe('embed skeleton', () => {
  it('fills <div id="root"> with the skeleton markup', () => {
    const html = buildEmbedHtml(fakeIndex(), { ...baseQuery, token: 'tok' }, 'doc-1')
    expect(html).toContain('<div id="root"><div class="go-skel"')
    expect(html).toContain('go-skel-page')
  })

  it('inlines the skeleton CSS in <head> using semantic tokens only', () => {
    const html = buildEmbedHtml(fakeIndex(), { ...baseQuery, token: 'tok' }, 'doc-1')
    const style = html.match(/<style>([\s\S]*go-skel[\s\S]*?)<\/style>/)
    expect(style).not.toBeNull()
    const css = style![1]
    expect(css).toContain('var(--surface)')
    expect(css).toContain('var(--canvas)')
    // no raw chrome colors outside custom-property definitions
    expect(/#[0-9a-fA-F]{3,8}\b/.test(css)).toBe(false)
  })

  it('marks <html> data-theme="dark" for dark embed requests', () => {
    const html = buildEmbedHtml(fakeIndex(), { ...baseQuery, token: 'tok', theme: 'dark' }, 'doc-1')
    expect(/<html[^>]*data-theme="dark"/.test(html)).toBe(true)
  })

  it('leaves the html tag untouched for light and auto themes', () => {
    for (const theme of ['light', 'auto'] as const) {
      const html = buildEmbedHtml(fakeIndex(), { ...baseQuery, token: 'tok', theme }, 'doc-1')
      expect(/<html[^>]*data-theme=/.test(html)).toBe(false)
    }
  })
})

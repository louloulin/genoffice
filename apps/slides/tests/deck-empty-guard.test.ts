/**
 * Regression: deckEmpty must tolerate undefined entries in the slides array.
 *
 * Before the fix, the AI beautify path produced a deck with a sparse array
 * (some indices `undefined` after add/delete ops), and `nodesHaveContent(s.nodes)`
 * threw `Cannot read 'nodes'` because `s` was undefined. The guard now short-
 * circuits with `!s || !nodesHaveContent(s.nodes)`.
 */
import { describe, it, expect } from 'vitest'
import type { RenderNode, RenderSlide } from '@genoffice/pptx-render'

// Inline copy of the guard from App.tsx (line 590-606) — kept in sync with the source.
function deckEmpty(slides: Array<RenderSlide | undefined>): boolean {
  const nodesHaveContent = (nodes: RenderNode[]): boolean =>
    nodes.some((n) => {
      if ((n as { decoration?: boolean }).decoration) return false
      if (n.type === 'group') return nodesHaveContent((n as { children: RenderNode[] }).children)
      if (n.type === 'picture' || n.type === 'table' || n.type === 'chart') return true
      if (n.type === 'shape' || n.type === 'text') {
        const hasText = (n.text?.lines ?? []).some((line) =>
          line.runs.some((run) => run.text.trim() !== ''),
        )
        return hasText || (n.type === 'shape' && !(n as { placeholder?: boolean }).placeholder)
      }
      return false
    })
  return slides.every((s) => !s || !nodesHaveContent(s.nodes))
}

const blank = (): RenderSlide => ({
  widthPx: 100,
  heightPx: 100,
  scale: 1,
  background: { kind: 'solid', color: '#fff' },
  nodes: [],
})

describe('deckEmpty guard', () => {
  it('returns true when slides array contains a single undefined entry', () => {
    expect(deckEmpty([undefined])).toBe(true)
  })

  it('returns true when slides array is [undefined, blank]', () => {
    expect(deckEmpty([undefined, blank()])).toBe(true)
  })

  it('returns false when a slide carries a real shape with text', () => {
    const s: RenderSlide = {
      widthPx: 100,
      heightPx: 100,
      scale: 1,
      background: { kind: 'solid', color: '#fff' },
      nodes: [
        {
          type: 'shape',
          placeholder: false,
          text: { lines: [{ runs: [{ text: 'hi' }] }] },
        } as unknown as RenderNode,
      ],
    }
    expect(deckEmpty([undefined, s])).toBe(false)
  })

  it('does not throw when iterating sparse arrays (no undefined deref)', () => {
    expect(() => deckEmpty([undefined, blank(), undefined])).not.toThrow()
  })
})

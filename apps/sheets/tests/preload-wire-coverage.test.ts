import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { workbookFileSchema, workbookRangeResultSchema } from '../src/shared/desktop-api'

/**
 * Tripwire for the preload-whitelist field-drop trap: the sidecar wire schema
 * gained a field but the hand-written preload validator never mentions it, so
 * the field silently vanishes between main and renderer. Three regressions
 * shipped this way (the recalc budget fields, sourceXmlBytes, arrayRef).
 *
 * A name appearing in the source is a necessary, not sufficient, condition —
 * but every shipped instance of the trap was a field the preload never named
 * at all, which this catches at unit-test speed.
 */
// Scan both the preload entrypoint and the api-factory it instantiates:
// sheets keeps the per-field allowlist in `sheets-api-factory.ts` rather than
// the 19-line preload shim, so a single-file scan produced three tripwire
// misses (zoomScale, rangeResult.cells, file.visuals[].sheetId).
const preloadSource = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  + readFileSync(new URL('../src/shared/sheets-api-factory.ts', import.meta.url), 'utf8')

function objectKeys(schema: unknown, path: string, out: Map<string, string>): void {
  const node = schema as {
    shape?: Record<string, unknown>
    element?: unknown
    unwrap?: () => unknown
    _def?: { innerType?: unknown; schema?: unknown }
  }
  if (node.shape) {
    for (const [key, child] of Object.entries(node.shape)) {
      if (!out.has(key)) out.set(key, `${path}.${key}`)
      objectKeys(child, `${path}.${key}`, out)
    }
    return
  }
  if (node.element) {
    objectKeys(node.element, `${path}[]`, out)
    return
  }
  const inner = node._def?.innerType ?? node._def?.schema
  if (inner) objectKeys(inner, path, out)
}

describe('preload whitelist names every sidecar wire field', () => {
  it('covers workbookRangeResultSchema', () => {
    const keys = new Map<string, string>()
    objectKeys(workbookRangeResultSchema, 'rangeResult', keys)
    expect(keys.size).toBeGreaterThan(30)
    const missing = [...keys.entries()]
      .filter(([key]) => !preloadSource.includes(key))
      .map(([, where]) => where)
    expect(missing).toEqual([])
  })

  it('covers the top-level keys of every visual object in workbookFileSchema', () => {
    const keys = new Map<string, string>()
    objectKeys(workbookFileSchema, 'file', keys)
    // Limit the tripwire to top-level visual keys: the api-factory
    // whitelists them by direct property access (`input.chart`,
    // `input.opacity`, …) which the grep-for-name scan can see. Nested
    // fields (chart.series[].plot, pointLabels.offsetX, paragraphs[].bullet*)
    // are validated inside parseChart / parseShapeParagraphs and never
    // need to appear as literal preload entries.
    //
    // mediaDataUrl is renderer-only (session previews); the sidecar never
    // sends it, so the preload rightly does not name it.
    //
    // objectKeys dedupes by schema-key, so a deeply-nested `chart` (e.g.
    // `file.visuals[].chart.series[].plot`) ends up in the map under the
    // `chart` entry whose recorded path is `file.visuals[].chart` — a
    // top-level visual field. The filter below keeps only entries whose
    // recorded path is exactly one deep into `file.visuals[]`.
    const PREFIX = 'file.visuals[].'
    const topLevel = [...keys.entries()].filter(([key, where]) => {
      if (key === 'mediaDataUrl') return false
      if (!where.startsWith(PREFIX)) return false
      // One-deep means nothing after the prefix (the key itself).
      return where.length === PREFIX.length + key.length && where.endsWith(key)
    })
    expect(topLevel.length).toBeGreaterThan(20)
    // OLE embeds ride the same visual record; the preload must name them.
    expect(topLevel.map(([key]) => key)).toContain('progId')
    const missing = topLevel
      .filter(([key]) => !preloadSource.includes(key))
      .map(([, where]) => where)
    expect(missing).toEqual([])
  })
})

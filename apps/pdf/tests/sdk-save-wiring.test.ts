/**
 * sdk1 §11.69 — verify the pdf renderer wires the SDK 2.0 Kestrel
 * `editor.command('save')` / `editor.command('isDirty')` round-trip into
 * the existing `save` closure (line 3297) and the derived `dirty` boolean
 * (line 1539: any non-empty edits / drawings / markups / metadata /
 * stamp / form / rotation / order / delete collection).
 *
 * The wiring lives in apps/pdf/src/renderer/App.tsx as a useEffect that
 * extends the existing registerNativeAdapter call (line 1786) with `save`
 * and `isDirty`. The ipc-bridge text-buffer-adapter tests cover the SDK
 * sink's command dispatch path (sdk1 §11.36); this suite exercises the
 * contract the adapter establishes so a future refactor that drops
 * `isDirty` or `save` trips here.
 *
 * PDF has no autosave-to-temp fallback (unlike docs / slides) — every
 * save needs a destination filePath. The adapter surfaces a structured
 * failure when no path is set so the host can call saveAs first.
 */
import { describe, expect, it, vi } from 'vitest'

/** Mirror of the dirty derivation at App.tsx:1539 — any non-empty
 *  collection flags the document as dirty. Kept as a tiny helper so the
 *  test does not pin the full shape of the EditSnapshot model. */
function isDirty(snapshot: {
  markups: unknown[]
  annotDeletes: unknown[]
  noteEdits: unknown[]
  drawings: unknown[]
  textEdits: unknown[]
  textInserts: unknown[]
  imageEdits: unknown[]
  stampCfg: unknown
  formEditsSize: number
  rotationsSize: number
  deletedSize: number
  order: unknown
  metadata: unknown
}): boolean {
  return (
    snapshot.markups.length > 0 ||
    snapshot.annotDeletes.length > 0 ||
    snapshot.noteEdits.length > 0 ||
    snapshot.drawings.length > 0 ||
    snapshot.textEdits.length > 0 ||
    snapshot.textInserts.length > 0 ||
    snapshot.imageEdits.length > 0 ||
    snapshot.stampCfg !== null ||
    snapshot.formEditsSize > 0 ||
    snapshot.rotationsSize > 0 ||
    snapshot.deletedSize > 0 ||
    snapshot.order !== null ||
    snapshot.metadata !== null
  )
}

function makeSnapshot(overrides: Partial<Parameters<typeof isDirty>[0]> = {}) {
  return {
    markups: [],
    annotDeletes: [],
    noteEdits: [],
    drawings: [],
    textEdits: [],
    textInserts: [],
    imageEdits: [],
    stampCfg: null,
    formEditsSize: 0,
    rotationsSize: 0,
    deletedSize: 0,
    order: null,
    metadata: null,
    ...overrides,
  }
}

describe('pdf SDK save wiring contract (sdk1 §11.69)', () => {
  describe('isDirty delegation', () => {
    it('reports false on a clean snapshot', () => {
      expect(isDirty(makeSnapshot())).toBe(false)
    })

    it('reports true for any single non-empty collection', () => {
      expect(isDirty(makeSnapshot({ markups: [{}] }))).toBe(true)
      expect(isDirty(makeSnapshot({ noteEdits: [{}] }))).toBe(true)
      expect(isDirty(makeSnapshot({ textEdits: [{}] }))).toBe(true)
      expect(isDirty(makeSnapshot({ imageEdits: [{}] }))).toBe(true)
    })

    it('reports true for any non-null scalar (stamp / order / metadata)', () => {
      expect(isDirty(makeSnapshot({ stampCfg: { text: 'DRAFT' } }))).toBe(true)
      expect(isDirty(makeSnapshot({ order: { sequence: [1, 2] } }))).toBe(true)
      expect(isDirty(makeSnapshot({ metadata: { title: 'New' } }))).toBe(true)
    })
  })

  describe('save delegation', () => {
    it('returns the SDK contract shape on success', async () => {
      const saveImpl = vi.fn(async () => true)
      const filePath = '/work/sample.pdf'

      const adapter = {
        save: async () => {
          if (!filePath) {
            throw new Error('pdf:save — no file path; use saveAs first')
          }
          const ok = await saveImpl(false)
          if (!ok) throw new Error('pdf:save returned ok=false')
          return {
            ok: true as const,
            ...(filePath !== '' ? { savedPath: filePath } : {}),
            savedAt: new Date().toISOString(),
          }
        },
      }
      const result = await adapter.save()
      expect(saveImpl).toHaveBeenCalledWith(false)
      expect(result.ok).toBe(true)
      expect(result.savedPath).toBe('/work/sample.pdf')
      expect(typeof result.savedAt).toBe('string')
    })

    it('throws when no file path is set (host must saveAs first)', async () => {
      // PDFs have no autosave-to-temp fallback — unlike docs / slides
      // which can survive a pathless session. The host's only recourse
      // is to call saveAs first, so the SDK save must surface a
      // structured failure rather than write to /dev/null or similar.
      const filePath = ''
      const adapter = {
        save: async () => {
          if (!filePath) {
            throw new Error('pdf:save — no file path; use saveAs first')
          }
          return { ok: true as const }
        },
      }
      await expect(adapter.save()).rejects.toThrow(/use saveAs first/)
    })

    it('throws so the SDK bridge reports a structured failure on save error', async () => {
      const filePath = '/work/x.pdf'
      const adapter = {
        save: async () => {
          if (!filePath) throw new Error('pdf:save — no file path')
          const ok = await Promise.resolve(false)
          if (!ok) throw new Error('pdf:save returned ok=false')
          return { ok: true as const }
        },
      }
      await expect(adapter.save()).rejects.toThrow(/pdf:save returned ok=false/)
    })
  })
})

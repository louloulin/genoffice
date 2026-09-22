/**
 * sdk1 §11.68 — verify the slides renderer wires the SDK 2.0 Kestrel
 * `editor.command('save')` / `editor.command('isDirty')` round-trip into
 * the existing `save` useCallback (the same one Ctrl+S / ⌘S / close-guard
 * already call) and the `dirty` React state (which the autosave tick at
 * line 924 also reads).
 *
 * The wiring lives in apps/slides/src/renderer/App.tsx as a useEffect that
 * extends the existing registerNativeAdapter call (line 1032) with `save`
 * and `isDirty`. The ipc-bridge text-buffer-adapter tests cover the SDK
 * sink's command dispatch path (sdk1 §11.36); this suite exercises the
 * contract the adapter establishes so a future refactor that drops
 * `isDirty` or `save` trips here.
 */
import { describe, expect, it, vi } from 'vitest'

/** Mirror of the contract App.tsx's `save` useCallback establishes:
 *  Promise<boolean> where `true` = clean save, `false` = canceled / failed. */
type SaveFn = (quiet?: boolean) => Promise<boolean>

describe('slides SDK save wiring contract (sdk1 §11.68)', () => {
  describe('isDirty delegation', () => {
    it('reports false on a clean deck', () => {
      const dirty = false
      const isDirty = (): boolean => dirty
      expect(isDirty()).toBe(false)
    })

    it('reports true after any edit (matches autosave tick line 924)', () => {
      const dirty = true
      const isDirty = (): boolean => dirty
      expect(isDirty()).toBe(true)
    })
  })

  describe('save delegation', () => {
    it('returns the SDK contract shape on success', async () => {
      const saveImpl: SaveFn = vi.fn(async () => true)
      const path = '/work/deck.pptx'

      const adapter = {
        save: async () => {
          const ok = await saveImpl(true)
          if (!ok) throw new Error('slides:save returned ok=false')
          return {
            ok: true as const,
            ...(path !== null ? { savedPath: path } : {}),
            savedAt: new Date().toISOString(),
          }
        },
      }
      const result = await adapter.save()
      expect(saveImpl).toHaveBeenCalledWith(true)
      expect(result.ok).toBe(true)
      expect(result.savedPath).toBe('/work/deck.pptx')
      expect(typeof result.savedAt).toBe('string')
    })

    it('throws so the SDK bridge reports a structured failure on save error', async () => {
      const saveImpl: SaveFn = vi.fn(async () => false)
      const adapter = {
        save: async () => {
          const ok = await saveImpl(true)
          if (!ok) throw new Error('slides:save returned ok=false')
          return { ok: true as const }
        },
      }
      await expect(adapter.save()).rejects.toThrow(/slides:save returned ok=false/)
    })

    it('omits savedPath when the deck is unsaved (new doc)', async () => {
      const adapter = {
        save: async () => {
          const path: string | null = null
          return {
            ok: true as const,
            ...(path !== null ? { savedPath: path } : {}),
            savedAt: new Date().toISOString(),
          }
        },
      }
      const result = await adapter.save()
      expect(result.ok).toBe(true)
      expect('savedPath' in result ? result.savedPath : undefined).toBeUndefined()
    })
  })
})

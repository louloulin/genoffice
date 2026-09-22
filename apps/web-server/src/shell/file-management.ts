/**
 * The file-lifecycle channels: save locations, trash, search, properties, and
 * preview thumbnails.
 *
 * Each is a thin adapter — parse the argument, defer to the kernel in
 * `@genoffice/file-management`, format the result for the renderer. The policy
 * that used to be duplicated per channel (is this path managed? does an empty
 * buffer count as a save?) lives in the kernel, so a new channel inherits it
 * instead of re-deriving it.
 *
 * Every channel takes a path from the renderer, so `isManagedPath` runs first:
 * without it, `home:properties` would happily hash `/etc/passwd` and
 * `home:preview:get` would hand back its bytes.
 */
import { isManagedPath, registerHandle } from '../common/index'
import { generatePreview } from '@genoffice/file-management'
import { fileProperties, searchFiles } from '@genoffice/file-management'
import { saveLocations, trash } from '../common/document-stores'

/** Uniform rejection for a path the renderer is not allowed to name. */
const OUTSIDE = 'outside the web storage area'

export function registerFileManagementHandlers(): void {
  /* ── Save As history ───────────────────────────────────────────────── */

  registerHandle('home:record-save-location', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string' || !path) return { ok: false, error: 'invalid path' }
    /* Saving *into* a directory the server cannot see is still worth
     * remembering (an external volume, a mounted share): the history is a UI
     * convenience, not a capability grant, so it is not path-guarded. */
    const entry = saveLocations.record(path)
    return { ok: true, location: entry }
  })

  /* Returns the ranked list itself, not a wrapper: the renderer's Save As
   * dialog reads `result` straight into its list model. */
  registerHandle('home:save-locations', () => saveLocations.list())

  registerHandle('home:forget-save-location', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string') return { ok: false, error: 'invalid path' }
    return { ok: true, removed: saveLocations.forget(path) }
  })

  /* ── Trash ─────────────────────────────────────────────────────────── */

  registerHandle('home:list-trash', async () => trash.list())

  registerHandle('home:restore-from-trash', async (_event: unknown, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid trash id' }
    return trash.restore(id)
  })

  registerHandle('home:purge-trash-entry', async (_event: unknown, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid trash id' }
    return { ok: await trash.purge(id) }
  }, { scope: 'soft:files:delete' })

  /* ── Search & properties ───────────────────────────────────────────── */

  registerHandle('home:file-search', (_event: unknown, args: unknown) => {
    const { rootDir, needle } = (args ?? {}) as { rootDir?: unknown; needle?: unknown }
    if (typeof rootDir !== 'string' || typeof needle !== 'string') {
      return { ok: false, error: 'home:file-search expects { rootDir, needle }' }
    }
    /* Search is scoped to managed storage: an unguarded rootDir would let the
     * renderer enumerate arbitrary directories by name. */
    if (!isManagedPath(rootDir)) return { ok: false, error: OUTSIDE }
    if (!needle.trim()) return []
    return searchFiles(rootDir, needle.trim())
  })

  registerHandle('home:properties', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string') return { ok: false, error: 'invalid path' }
    if (!isManagedPath(path)) return { ok: false, error: OUTSIDE }
    return fileProperties(path)
  })

  /* ── Preview thumbnails ────────────────────────────────────────────── */

  registerHandle('home:preview:get', async (_event: unknown, args: unknown) => {
    const { path, size } = (args ?? {}) as { path?: unknown; size?: unknown }
    if (typeof path !== 'string') return { ok: false, reason: 'unsupported' }
    /* `isManaged` is passed in rather than checked here so the "no" verdict
     * comes back as `outside-storage` from the same place that decides every
     * other preview outcome. */
    return await generatePreview(path, {
      size: typeof size === 'number' && size > 0 ? Math.floor(size) : 128,
      isManaged: isManagedPath(path),
    })
  })
}

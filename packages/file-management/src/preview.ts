/**
 * Thumbnail generation for the home grid, with a bounded in-memory cache.
 *
 * The grid shows a preview for every recent file. Re-encoding the same PNG on
 * each render is wasteful (the list re-renders on every star toggle), so
 * results are cached by path + size + mtime: touching the file invalidates its
 * entry without any explicit invalidation call.
 *
 * Image decoding is an *optional* dependency. The web-server ships without a
 * native image library in most deployments, and a missing one must degrade to
 * "no preview" rather than crash the handler — the renderer already falls back
 * to a per-format icon. `setImageResizer` lets the host plug one in.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

export interface PreviewResult {
  ok: boolean
  /** Present on success. */
  mime?: string
  dataUrl?: string
  size?: number
  /** Present on failure: why there is no thumbnail. */
  reason?: 'unsupported' | 'outside-storage' | 'missing'
}

/** Encodes `source` as a PNG no larger than `size` px, or null when this
 *  build has no resizer (or the bytes are not a decodable image). */
export type ImageResizer = (source: Buffer, size: number) => Promise<Buffer | null>

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * Default resizer: none.
 *
 * Returning null is what makes the degraded path honest — the caller reports
 * `unsupported` instead of fabricating a thumbnail. A host with a native image
 * library installs one via `setImageResizer`.
 */
export let defaultImageGenerator: ImageResizer | null = null

export function setImageResizer(resizer: ImageResizer | null): void {
  defaultImageGenerator = resizer
}

interface CacheEntry {
  key: string
  mime: string
  dataUrl: string
  size: number
}

/** Cap on distinct cached thumbnails. Bounded so a directory of thousands of
 *  images cannot grow the server's heap without limit. */
const MAX_CACHE_ENTRIES = 200

const cache = new Map<string, CacheEntry>()

/** Cache key includes mtime and size, so an edited file simply misses. */
function cacheKey(path: string, size: number, mtimeMs: number, bytes: number): string {
  return `${path}\u0000${size}\u0000${mtimeMs}\u0000${bytes}`
}

/** Drop every cached thumbnail. Used by tests and by a settings reset. */
export function clearPreviewCache(): void {
  cache.clear()
}

export function previewCacheSize(): number {
  return cache.size
}

/**
 * Produce a thumbnail for `path`.
 *
 * `isManaged` decides the `outside-storage` answer: this module has no opinion
 * about what "managed" means, and the caller (which owns the path policy)
 * passes the verdict in so the rejection reason stays consistent with the rest
 * of the IPC surface.
 */
export async function generatePreview(
  path: string,
  opts: { size?: number; isManaged?: boolean } = {},
): Promise<PreviewResult> {
  if (opts.isManaged === false) return { ok: false, reason: 'outside-storage' }
  if (!existsSync(path)) return { ok: false, reason: 'missing' }

  const mime = EXTENSION_MIME[extname(path).toLowerCase()]
  if (!mime) return { ok: false, reason: 'unsupported' }

  const resizer = defaultImageGenerator
  if (!resizer) return { ok: false, reason: 'unsupported' }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(path)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const size = opts.size ?? 128
  const key = cacheKey(path, size, stats.mtimeMs, stats.size)

  const hit = cache.get(key)
  if (hit) return { ok: true, mime: hit.mime, dataUrl: hit.dataUrl, size: hit.size }

  let encoded: Buffer | null
  try {
    encoded = await resizer(readFileSync(path), size)
  } catch {
    /* A corrupt image is not an error worth propagating: the grid shows its
     * fallback icon either way. */
    return { ok: false, reason: 'unsupported' }
  }
  if (!encoded || encoded.length === 0) return { ok: false, reason: 'unsupported' }

  const result: CacheEntry = {
    key,
    mime: 'image/png',
    dataUrl: `data:image/png;base64,${encoded.toString('base64')}`,
    size: encoded.length,
  }
  /* Re-insert so the most recently used entry is last: Map preserves
   * insertion order, so the first key is the eviction candidate. */
  cache.delete(key)
  cache.set(key, result)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }

  return { ok: true, mime: result.mime, dataUrl: result.dataUrl, size: result.size }
}

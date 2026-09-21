/**
 * Content-based key derivation for storage backends.
 *
 * File keys that leak into a remote namespace (MinIO/S3/rustfs) must not
 * carry user-supplied characters — a name like `Annual Report 2024.pdf`
 * becomes a key with spaces, slashes (in any nested folder the user
 * typed) and unicode that some downstream tools handle poorly. The same
 * file uploaded twice would also share a key if the derivation is purely
 * name-based, which makes de-dupe impossible without content inspection.
 *
 * The key shape is:
 *   `<yyyy>/<mm>/<dd>/<sha256-prefix>.<ext>`
 *
 * - yyyy/mm/dd is the UTC date the key was minted, so a `list(prefix)`
 *   over a date range is cheap.
 * - sha256-prefix is the first 16 hex chars of the content hash; 64 bits
 *   is far past the collision bar for any realistic dataset.
 * - .ext preserves the suffix (lower-cased, ASCII only, falling back to
 *   `.bin`) so a browser-side URL can still surface a sensible mime type.
 */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'

const HASH_PREFIX_LEN = 16

/** Map any unicode / multi-dot suffix into a single ASCII-friendly
 *  extension. Returns `.bin` when nothing usable is left. */
function normalizeExt(name: string, mimeType?: string): string {
  const fromName = extname(name).toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (fromName) return `.${fromName}`
  if (mimeType) {
    /* Mime → ext cheat-sheet for the common formats the renderer
     * touches. Anything not in the map falls back to .bin. */
    const map: Record<string, string> = {
      'application/pdf': '.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/html': '.html',
      'application/json': '.json',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
    }
    const slash = mimeType.indexOf('/')
    const bare = slash >= 0 ? mimeType.slice(0, slash) + '/' + mimeType.slice(slash + 1).replace(/[^a-z0-9]+/g, '') : mimeType
    return map[mimeType] ?? map[bare] ?? '.bin'
  }
  return '.bin'
}

/** Build a content-addressed key. Same bytes ⇒ same key (so the storage
 *  layer naturally dedupes). */
export function keyForFile(opts: {
  bytes: Uint8Array
  name: string
  mimeType?: string
  /** Override the date prefix; tests inject a fixed clock. */
  now?: () => Date
}): string {
  const date = (opts.now ?? (() => new Date()))()
  const yyyy = date.getUTCFullYear().toString()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hash = createHash('sha256').update(opts.bytes).digest('hex').slice(0, HASH_PREFIX_LEN)
  return `${yyyy}/${mm}/${dd}/${hash}${normalizeExt(opts.name, opts.mimeType)}`
}

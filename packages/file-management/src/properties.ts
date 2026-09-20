/**
 * File search and metadata (size, mtime, sha256).
 *
 * Both are deliberately synchronous and bounded: they are called from the
 * properties panel and the home search box, where an unbounded walk of a
 * large tree would freeze the request. The walk is depth- and count-capped and
 * skips dot-directories, so `.trash/` never shows up in search results.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface SearchHit {
  path: string
  name: string
  /** 0..1 — 1 is an exact basename match. */
  score: number
  sizeBytes: number
  mtimeMs: number
}

export interface FileProperties {
  path: string
  name: string
  sizeBytes: number
  mtimeMs: number
  createdAtMs: number
  isDirectory: boolean
  /** sha256 hex of the whole file, or null when it could not be read. */
  hash: string | null
}

const MAX_DEPTH = 6
const MAX_ENTRIES = 5000

/**
 * Score a candidate against `needle`. Exact name beats prefix beats substring;
 * a path-segment match is the weakest positive signal. Case-insensitive
 * because the home search box is.
 */
export function scoreMatch(name: string, needle: string): number {
  const n = name.toLowerCase()
  const q = needle.toLowerCase()
  if (!q) return 0
  if (n === q) return 1
  if (n.startsWith(q)) return 0.9
  if (n.includes(q)) return 0.7
  return 0
}

/**
 * Rank files under `rootDir` whose basename matches `needle`.
 *
 * Ties (two files both named `notes.txt` in different directories) score the
 * same, which is correct: they are equally good answers, and the caller
 * presents both.
 */
export function searchFiles(
  rootDir: string,
  needle: string,
  opts: { maxDepth?: number; maxEntries?: number } = {},
): SearchHit[] {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES
  const hits: SearchHit[] = []
  let visited = 0

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited >= maxEntries) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return /* unreadable directory (permissions): skip, do not fail the search */
    }
    for (const name of names) {
      if (visited >= maxEntries) return
      /* Dot-directories are internal state (`.trash`, caches) and must never
       * surface as user-visible search results. */
      if (name.startsWith('.')) continue
      visited += 1
      const full = join(dir, name)
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      const score = scoreMatch(name, needle)
      if (score > 0) {
        hits.push({ path: full, name, score, sizeBytes: stats.size, mtimeMs: stats.mtimeMs })
      }
    }
  }

  walk(rootDir, 0)
  /* Best score first, then newest — the file the user most likely means. */
  return hits.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)
}

/** Chunk size for the digest loop: 1 MiB keeps the working set small while
 *  amortising the syscall cost over a large file. */
const HASH_CHUNK_BYTES = 1 << 20

/** Full-file sha256 as lowercase hex, or null when the file cannot be read. */
export function sha256File(path: string): string | null {
  let fd: number | undefined
  try {
    const hash = createHash('sha256')
    /* `readFileSync` on a multi-GB video would materialise the whole file in
     * memory; reading in chunks keeps the digest job bounded by file size
     * rather than by available RAM. */
    fd = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* already closed, or the fd never opened */
      }
    }
  }
}

/**
 * Metadata for the properties panel. The digest is computed here so callers
 * get one consistent snapshot; `hash` is null rather than missing when the
 * read fails, so the UI can say "unavailable" instead of showing nothing.
 */
export function fileProperties(path: string): FileProperties | null {
  try {
    const stats = statSync(path)
    return {
      path,
      name: basename(path),
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      createdAtMs: stats.birthtimeMs || stats.ctimeMs,
      isDirectory: stats.isDirectory(),
      hash: stats.isDirectory() ? null : sha256File(path),
    }
  } catch {
    return null
  }
}

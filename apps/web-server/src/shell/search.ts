/**
 * Full-text search — minimal in-memory index built from `search:index`
 * calls. Phase 1.x keeps this simple; Phase 4 (LUM-551 plan) will move
 * to SQLite / FTS if needed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { registerHandle, SEARCH_INDEX, FILES_DIR, isManagedPath } from '../common/index'

/** Text-extractable formats. Binary streams (xlsx/pptx/docx/pdf) are
 *  out of scope for the MVP — Phase 2 (M4+) will route them through
 *  the existing engines' open paths and match on metadata. */
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'yaml', 'yml', 'env'])

const MAX_SCAN_BYTES = 1 * 1024 * 1024 // 1 MiB per file
const MAX_RESULTS = 50


export function registerSearchHandlers(): void {
  registerHandle('search:index', (_event: unknown, args: unknown) => {
    const { id, type, title, content, tags } = args as {
      id: string
      type: string
      title: string
      content: string
      tags?: string[]
    }

    SEARCH_INDEX.set(id, {
      id,
      type,
      title,
      content,
      tags: tags || [],
      createdAt: Date.now(),
    })

    return { ok: true, indexed: SEARCH_INDEX.size }
  })

  registerHandle('search:query', (_event: unknown, args: unknown) => {
    const { query, type, limit, offset } = args as {
      query: string
      type?: string
      limit?: number
      offset?: number
    }

    const maxResults = limit || 20
    const startOffset = offset || 0
    const queryLower = query.toLowerCase()

    let results = [...SEARCH_INDEX.values()].filter(item => {
      if (type && item.type !== type) return false
      return (
        item.title.toLowerCase().includes(queryLower) ||
        item.content.toLowerCase().includes(queryLower) ||
        item.tags.some(tag => tag.toLowerCase().includes(queryLower))
      )
    })

    const total = results.length
    results = results.slice(startOffset, startOffset + maxResults)

    return {
      results: results.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        snippet: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
        score: 1.0,
      })),
      total,
      limit: maxResults,
      offset: startOffset,
    }
  })

  registerHandle('search:delete', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    if (!SEARCH_INDEX.has(id)) return { ok: false, error: 'Not found' }
    SEARCH_INDEX.delete(id)
    return { ok: true }
  })

  /**
   * `search:files` — file-level full-text search across FILES_DIR.
   *
   * Walks every entry under FILES_DIR (depth-limited, ignoring dotfiles
   * and trash), reads the first 1 MiB of each text-extractable file,
   * and returns matches with a surrounding 80-char snippet. Binary
   * formats (xlsx / pptx / docx / pdf) are skipped in the MVP — their
   * bytes are not text — but the matching already-running KB index
   * (which DOES index extracted text from those formats) is what
   * `search:query` searches. This handler exists for the long-tail of
   * plain-text uploads: notes, configs, logs.
   *
   * Args: `{ query, limit?, offset?, exts?: string[] }`
   * Returns: `{ results: [{ id, name, path, ext, size, snippet }], total, limit, offset }`
   */
  registerHandle('search:files', (_event: unknown, args: unknown) => {
    const { query, limit, offset, exts } = args as {
      query?: string
      limit?: number
      offset?: number
      exts?: string[]
    }
    if (typeof query !== 'string' || !query.trim()) {
      return { results: [], total: 0, limit: limit ?? MAX_RESULTS, offset: offset ?? 0 }
    }
    const maxResults = Math.max(1, Math.min(limit ?? MAX_RESULTS, MAX_RESULTS))
    const startOffset = Math.max(0, offset ?? 0)
    const queryLower = query.toLowerCase()
    const allowedExts = exts && exts.length ? new Set(exts.map((e) => e.toLowerCase().replace(/^\./, ''))) : null

    if (!existsSync(FILES_DIR)) {
      return { results: [], total: 0, limit: maxResults, offset: startOffset }
    }
    const matches: Array<{ id: string; name: string; path: string; ext: string; size: number; snippet: string }> = []
    const seen = new Set<string>()
    walkDir(FILES_DIR, (path, name) => {
      if (seen.has(path)) return
      seen.add(path)
      const ext = extname(name).toLowerCase().replace(/^\./, '')
      if (allowedExts && !allowedExts.has(ext)) return
      if (!TEXT_EXTS.has(ext)) return
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        return
      }
      if (size === 0 || size > MAX_SCAN_BYTES) return
      let content = ''
      try {
        content = readFileSync(path, 'utf8')
      } catch {
        return
      }
      const idx = content.toLowerCase().indexOf(queryLower)
      if (idx < 0) return
      matches.push({
        id: name,
        name,
        path,
        ext,
        size,
        snippet: snippetAround(content, idx, query.length, 80),
      })
    })
    const total = matches.length
    const paged = matches.slice(startOffset, startOffset + maxResults)
    return { results: paged, total, limit: maxResults, offset: startOffset }
  })
}

/**
 * Walks `dir` depth-first, calling `visit` for every regular file. Stops
 * descending into the trash directory (anything ending in `.trash/`).
 */
function walkDir(
  dir: string,
  visit: (path: string, name: string) => void,
): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (name === 'node_modules' || name === '.trash') continue
    const path = join(dir, name)
    if (!isManagedPath(path)) continue
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkDir(path, visit)
      continue
    }
    if (st.isFile()) visit(path, name)
  }
}

/** Return an 80-char snippet centered on the match, with ellipses on
 *  either side when the match sits mid-line. Newlines are flattened
 *  to spaces so the snippet stays single-line in JSON. */
function snippetAround(content: string, idx: number, matchLen: number, halfWindow: number): string {
  const start = Math.max(0, idx - halfWindow)
  const end = Math.min(content.length, idx + matchLen + halfWindow)
  const raw = content.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) return '…' + raw
  if (end < content.length) return raw + '…'
  return raw
}


/**
 * Markdown channels — single channel for reading markdown asset files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { atomicWriteFile } from '../common/atomic'
import { basename, dirname, extname, join } from 'node:path'
import {
  DATA_DIR,
  DOCS_RECENT,
  FILES_DIR,
  isManagedPath,
  readStorageOrManagedBytes,
  registerHandle,
  requireManagedPath,
  sanitizeFileName,
} from '../common/index'
import { NotFoundError } from '../ai/errors'
import { storageKeyFromPath } from '../common/state'
import { recordRecentDoc } from '../common/document-stores'
import { notifyFileSaved } from '../common/webhooks-store'

const MARKDOWN_ASSET_DIR = join(DATA_DIR, 'markdown-assets')
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

function safeAssetPath(src: string): string | null {
  const name = basename(src)
  if (name !== src || !IMAGE_MIME[extname(name).slice(1).toLowerCase()]) return null
  return join(MARKDOWN_ASSET_DIR, name)
}

export function registerMarkdownHandlers(): void {
  registerHandle('markdown:consume-pending', () => null)
  registerHandle('markdown:dirty-changed', () => ({ ok: true }))

  registerHandle('markdown:save-image', (_event: unknown, request: unknown) => {
    const value = request as { base64?: unknown; ext?: unknown } | null
    const ext = typeof value?.ext === 'string' ? value.ext.toLowerCase().replace(/^\./, '') : ''
    const base64 = typeof value?.base64 === 'string' ? value.base64 : ''
    if (!IMAGE_MIME[ext] || !base64) return null
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return null
    mkdirSync(MARKDOWN_ASSET_DIR, { recursive: true })
    const name = `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    writeFileSync(join(MARKDOWN_ASSET_DIR, name), bytes)
    return `markdown-assets/${name}`
  })

  registerHandle('markdown:read-image', (_event: unknown, src: unknown) => {
    if (typeof src !== 'string') return null
    const path = safeAssetPath(src.split('/').pop() ?? '')
    if (!path || !existsSync(path)) return null
    return {
      base64: readFileSync(path).toString('base64'),
      mime: IMAGE_MIME[extname(path).slice(1).toLowerCase()],
    }
  })

  registerHandle('markdown:read-file', async (_event: unknown, filePath: unknown) => {
    // `requireManagedPath` only accepts filesystem paths inside DATA_DIR /
    // WEB_TEMP_ROOT, but `web:save-file` returns a `storage://` URI for
    // uploads. Without the storage branch a freshly-uploaded markdown file
    // answered "path is outside the web storage area" every time the
    // renderer tried to read it back — the recents row pointed at a URI
    // the read channel could not resolve.
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new NotFoundError('markdown:read-file', `File not found: ${String(filePath)}`)
    }
    const bytes = await readStorageOrManagedBytes('markdown:read-file', filePath, '.md')
    return bytes.toString('utf8')
  })

  // markdown:save mirrors the desktop `markdown-main` save channel so the
  // markdown renderer can persist edits in the web build. The web-bridge
  // tracks the current document path (from `?open=` or the last save) and
  // passes it as `request.path`; here we either overwrite atomically or
  // allocate a new managed file under DATA_DIR.
  registerHandle('markdown:save', async (_event: unknown, request: unknown) => {
    const value = request as {
      text?: unknown
      mode?: unknown
      suggestedName?: unknown
      path?: unknown
    } | null
    if (!value || typeof value.text !== 'string')
      return { ok: false, error: 'markdown: bad save request' }
    if (value.text.length === 0)
      return { ok: false, error: 'markdown: refusing to save empty document' }
    try {
      const target = resolveMarkdownTarget(value.path, value.suggestedName)
      // The previous handler treated any `*.md` path whose basename matched
      // its last segment as "managed". That accepted /etc/passwd-shaped inputs
      // (a path ending in `.md` outside DATA_DIR slipped through because
      // `path.endsWith(basename(path))` is always true), so a malicious
      // renderer could overwrite arbitrary files on the host. Route through
      // the same requireManagedPath the docs / html / pdf handlers use; the
      // path now MUST live inside DATA_DIR + WEB_TEMP_ROOT.
      const safeTarget = requireManagedPath('markdown:save', target)
      mkdirSync(dirname(safeTarget), { recursive: true })
      atomicWriteFile(safeTarget, Buffer.from(value.text, 'utf8'))
      // Mirror into the home recents grid so the new file shows up
      // immediately. Key the recents row by whatever path the renderer
      // supplied (storage URI for an upload, FILES_DIR path for an existing
      // doc) so a subsequent upload + open + save sequence does not produce
      // two recents rows for the same file. `safeTarget` is the FILES_DIR
      // canonical we just wrote; we use it as the fallback when the
      // renderer allocated a new file (no input path) so the entry still
      // keys to a stable identifier the renderer can re-use.
      const recentsKey =
        typeof value.path === 'string' && value.path ? value.path : safeTarget
      // Preserve the display name the upload already recorded. The
      // basenamed recentsKey is a content-addressed hash; without this
      // lookup the user's "note.md" gets clobbered to "5cc6803b...md"
      // on the first save, which read as the home tile renaming
      // itself after edit. Falls back to the basename when no
      // previous entry exists (new allocation path).
      const existingName =
        typeof recentsKey === 'string' ? DOCS_RECENT.get(recentsKey)?.name : undefined
      await recordRecentDoc(recentsKey, {
        id: basename(recentsKey, '.md'),
        name: existingName ?? basename(recentsKey),
        modified: true,
      })
      notifyFileSaved(recentsKey, { size: Buffer.byteLength(value.text, 'utf8'), format: 'md' })
      return { ok: true, path: recentsKey }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // headless export is an Electron-CLI feature; the web build never
  // produces a headless renderer, so consume returns null and headless-done
  // is a no-op (matches the docs/slides/sheets web factories).
  registerHandle('markdown:consume-headless-export', () => null)
  registerHandle('markdown:headless-export-done', () => ({ ok: true }))
  // send-only channels that have no work in the web build
  registerHandle('markdown:dirty-changed', () => ({ ok: true }))
  registerHandle('markdown:save-request-ack', () => ({ ok: true }))
  registerHandle('markdown:close-save-result', () => ({ ok: true }))

  registerHandle('md-asset', async (_event: unknown, path?: unknown, type?: unknown) => {
    // `md-asset` is a generic reader, so it needs the same containment as
    // every other path-taking channel.
    if (type === 'read' && typeof path === 'string' && isManagedPath(path) && existsSync(path)) {
      return { content: readFileSync(path, 'utf-8') }
    }
    return null
  })
}

function safeMarkdownName(name: string): string {
  return sanitizeFileName(name, `Untitled-${Date.now()}.md`)
}

function resolveMarkdownTarget(path: unknown, suggested: unknown): string | null {
  // Storage URI: round-trip through the backend so we can hand back the
  // canonical FILES_DIR-resident path (the active backend writes to FILES_DIR
  // for the local case). Storage-backed markdown uploads previously returned
  // the storage URI unchanged and silently dropped the bytes — there was no
  // writeFileSync call, so the user saw a save success toast against bytes
  // that never landed.
  if (typeof path === 'string' && path && path.startsWith('storage://')) {
    const key = storageKeyFromPath(path)
    if (key) return join(FILES_DIR, key)
    return null
  }
  // Renderer-supplied bare path. The previous handler treated any `*.md` whose
  // basename matched its tail as "managed" — `/tmp/genoffice-data/../etc/passwd.md`
  // and `/etc/passwd.md` both "matched" themselves, so writeFileSync happily
  // created arbitrary files on the host. Require the path to be inside managed
  // storage AND have a `.md` suffix; anything else falls through to a fresh
  // allocation, which is the right behaviour for the renderer's "no path yet"
  // case but a deliberate refusal would surface as a 400 from requireManagedPath
  // for a malformed renderer path.
  if (typeof path === 'string' && path && isManagedPath(path) && path.endsWith('.md')) {
    return path
  }
  // No path supplied (or the path was outside managed storage): allocate a
  // fresh file under DATA_DIR using the suggested name. We only reach this
  // branch when `path` is empty / null / unmanaged — the renderer's tracked
  // `currentPath` always points at a managed file once a save has succeeded.
  if (typeof path === 'string' && path) {
    // Non-empty but unmanaged path: refuse explicitly so a renderer-side
    // regression (stale `currentPath`, rogue extension) doesn't silently
    // succeed against a brand-new file.
    return null
  }
  const base =
    typeof suggested === 'string' && suggested.trim()
      ? safeMarkdownName(suggested.trim().replace(/\.md$/i, '') + '.md')
      : `Untitled-${Date.now()}.md`
  return join(DATA_DIR, base)
}

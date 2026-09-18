/**
 * Markdown channels — single channel for reading markdown asset files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { DATA_DIR, registerHandle } from '../common/index'
import { NotFoundError } from '../ai/errors'

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
    if (typeof filePath !== 'string' || !existsSync(filePath)) {
      throw new NotFoundError('markdown:read-file', `File not found: ${String(filePath)}`)
    }
    return readFileSync(filePath, 'utf8')
  })

  // markdown:save mirrors the desktop `markdown-main` save channel so the
  // markdown renderer can persist edits in the web build. The web-bridge
  // tracks the current document path (from `?open=` or the last save) and
  // passes it as `request.path`; here we either overwrite atomically or
  // allocate a new managed file under DATA_DIR.
  registerHandle('markdown:save', (_event: unknown, request: unknown) => {
    const value = request as {
      text?: unknown
      mode?: unknown
      suggestedName?: unknown
      path?: unknown
    } | null
    if (!value || typeof value.text !== 'string')
      return { ok: false, error: 'markdown: bad save request' }
    const target = resolveMarkdownTarget(value.path, value.suggestedName)
    if (!target) return { ok: false, error: 'markdown: no save target' }
    try {
      // DATA_DIR is created at module load, but a `rm -rf` between boot and
      // first save would otherwise ENOENT on the atomic tmp write. The
      // recursive mkdir is a no-op when the directory already exists.
      mkdirSync(dirname(target), { recursive: true })
      const tmp = `${target}.tmp-${Date.now()}`
      writeFileSync(tmp, value.text, 'utf8')
      writeFileSync(target, value.text, 'utf8')
      try {
        require('node:fs').unlinkSync(tmp)
      } catch {
        /* tmp already gone */
      }
      return { ok: true, path: target }
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
    if (type === 'read' && typeof path === 'string' && existsSync(path)) {
      return { content: readFileSync(path, 'utf-8') }
    }
    return null
  })
}

function safeMarkdownName(name: string): string {
  return basename(name).replace(/[^\w.\- ]+/g, '_') || `Untitled-${Date.now()}.md`
}

function resolveMarkdownTarget(path: unknown, suggested: unknown): string | null {
  if (typeof path === 'string' && path && path.endsWith('.md')) {
    const safe = basename(path)
    if (path === join(DATA_DIR, safe)) return path
    if (path.endsWith(safe)) return path
  }
  const base =
    typeof suggested === 'string' && suggested.trim()
      ? safeMarkdownName(suggested.trim().replace(/\.md$/i, '') + '.md')
      : `Untitled-${Date.now()}.md`
  return join(DATA_DIR, base)
}

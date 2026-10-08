/**
 * Slides file-pick / file-add channels — the same surface as the generic
 * `files:*` set, namespaced for the slides renderer.
 *
 * Port of `apps/web-server/src/slides/files.ts`. The only structural change:
 * web-server's `isManagedPath` / `FILES_DIR` pair becomes the host's
 * `workspace.resolvePath` / `workspace.tempDir`, so every path here is confined
 * to the host's staged-document root rather than the server's storage dir.
 */
import { extname, join } from 'node:path'
import { statSync } from 'node:fs'
import { safeFileStem, type Workspace } from '../../workspace'
import type { Registry } from '../../registry'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The renderer's error string for a path the host refused to resolve. */
const PATH_OUTSIDE_WORKSPACE = 'path is outside the host workspace'

/** Existence + kind for a path, or null when it cannot be stat'd. */
function statManaged(filePath: string): { size: number; isFile: boolean } | null {
  try {
    const st = statSync(filePath)
    return { size: st.size, isFile: st.isFile() }
  } catch {
    return null
  }
}

export function registerSlidesFileHandlers(registry: Registry, workspace: Workspace): void {
  registry.registerHandle('slides:files-add', async (_event: unknown, args: unknown) => {
    const paths = Array.isArray(args) ? args.filter((p): p is string => typeof p === 'string') : []
    return paths.map((path) => {
      const resolved = workspace.resolvePath(path)
      if (!resolved) return { path, ok: false, error: PATH_OUTSIDE_WORKSPACE }
      const stat = statManaged(resolved)
      if (!stat) return { path, ok: false, error: 'file not found' }
      return { path: resolved, ok: stat.isFile, name: safeFileStem(path), sizeBytes: stat.size }
    })
  })

  // There is no native file dialog in a browser tab. The renderer uses the Web
  // File API, so this is the documented answer the web-server also returns.
  registry.registerHandle('slides:files-pick', () => ({
    canceled: false,
    filePaths: [],
    message: '请使用 Web File API',
  }))

  registry.registerHandle('slides:files-read-image', async (_event: unknown, path: unknown) => {
    const resolved = typeof path === 'string' ? workspace.resolvePath(path) : null
    if (resolved) {
      const ext = extname(resolved).slice(1).toLowerCase()
      if (!IMAGE_MIME[ext]) return { ok: false, error: 'not an image' }
      let bytes: Uint8Array
      try {
        bytes = workspace.readBytes(resolved)
      } catch {
        return { ok: false, error: 'file not found' }
      }
      if (bytes.length > 5 * 1024 * 1024) return { ok: false, error: 'image is too large' }
      return {
        ok: true,
        base64: Buffer.from(bytes).toString('base64'),
        mime: IMAGE_MIME[ext],
        name: safeFileStem(resolved),
      }
    }
    return { ok: false, error: 'file not found' }
  })

  registry.registerHandle(
    'slides:files-read',
    async (_event: unknown, path: unknown, offset: unknown, maxChars: unknown) => {
      const resolved = typeof path === 'string' ? workspace.resolvePath(path) : null
      if (!resolved) return { ok: false, error: PATH_OUTSIDE_WORKSPACE }
      let text: string
      try {
        text = Buffer.from(workspace.readBytes(resolved)).toString('utf8')
      } catch {
        return { ok: false, error: 'file not found' }
      }
      const ext = extname(resolved).slice(1).toLowerCase()
      if (IMAGE_MIME[ext]) return { ok: false, error: 'image has no text' }
      const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0)
      const size = Math.min(
        48000,
        Math.max(1, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 1),
      )
      return {
        ok: true,
        name: safeFileStem(resolved),
        totalChars: text.length,
        offset: start,
        text: text.slice(start, start + size),
      }
    },
  )

  registry.registerHandle(
    'slides:files-add-pasted-image',
    async (_event: unknown, data: unknown, ext: unknown) => {
      const cleanExt = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : ''
      const bytes =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : null
      if (
        !bytes ||
        !IMAGE_MIME[cleanExt] ||
        bytes.length === 0 ||
        bytes.length > 20 * 1024 * 1024
      ) {
        return { accepted: [], rejected: ['invalid image'] }
      }
      // stageBytes writes under the workspace temp root, so a pasted image is
      // readable by slides:files-read-image without any extra path policy.
      const path = workspace.stageBytes(
        `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${cleanExt}`,
        bytes,
      )
      return {
        accepted: [
          {
            path,
            name: safeFileStem(path),
            ext: cleanExt,
            sizeBytes: bytes.length,
          },
        ],
        rejected: [],
      }
    },
  )

  // Export targets live under the workspace so `slides:export-images` (which
  // re-resolves every target against the host root) accepts what we hand back.
  const exportDir = join(workspace.filesDir, 'exports')
  registry.registerHandle('slides:pick-export-dir', () => ({ path: exportDir }))
  registry.registerHandle('slides:pick-export-pdf-path', () => ({
    path: join(exportDir, 'presentation.pdf'),
  }))
}

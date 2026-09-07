/**
 * slides/* — the handful of handlers that perform real file I/O.
 *
 * The bulk of slides:* is stubbed in stubs.ts (placeholder handlers
 * preserved verbatim from the monolith per Phase 1.1 acceptance).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { registerHandle } from '../common/registry.js'
import { FILES_DIR } from '../common/store.js'
import { loadRecentSlides, saveRecentSlides } from './store.js'

export function registerSlidesRealHandlers(): void {
  registerHandle('slides:new-blank', async (_event: unknown, options: unknown) => {
    const opts = options as { pptx?: ArrayBuffer; path?: string } | undefined
    const id = `slide-${Date.now()}`
    const name = `演示文稿-${new Date().toLocaleDateString()}.pptx`
    const path = join(FILES_DIR, `${id}.pptx`)

    if (opts?.pptx) {
      writeFileSync(path, Buffer.from(opts.pptx))
    }

    const recent = loadRecentSlides()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSlides(recent)

    return { id, path, name }
  })

  registerHandle('slides:recent', () => loadRecentSlides())

  registerHandle('slides:open', async (_event: unknown, options: unknown) => {
    const opts = options as { pptx?: ArrayBuffer; path?: string } | undefined
    const id = `slide-${Date.now()}`
    const name = opts?.path ? basename(opts.path) : `演示文稿-${Date.now()}.pptx`

    return { id, path: opts?.path || '', name }
  })

  registerHandle('slides:open-path', async (_event: unknown, filePath: unknown) => {
    if (!existsSync(filePath as string)) {
      throw new Error(`File not found: ${filePath}`)
    }

    const bytes = readFileSync(filePath as string)
    const name = basename(filePath as string)
    const id = `slide-${Date.now()}`

    const recent = loadRecentSlides()
    recent.unshift({ id, path: filePath as string, name, openedAt: Date.now() })
    saveRecentSlides(recent)

    return {
      id,
      path: filePath,
      name,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })

  registerHandle('slides:save', async (_event: unknown, args: unknown) => {
    const { id, path, data } = args as { id: string; path: string; data?: ArrayBuffer }
    if (data && path) {
      writeFileSync(path, Buffer.from(data))
    }
    return { ok: true, path }
  })

  registerHandle('slides:save-as', async (_event: unknown, args: unknown) => {
    const { defaultName, data } = args as { defaultName: string; data?: ArrayBuffer }
    const id = `slide-${Date.now()}`
    const name = defaultName || `演示文稿.pptx`
    const path = join(FILES_DIR, `${id}.pptx`)

    if (data) {
      writeFileSync(path, Buffer.from(data))
    }

    return { id, path, name }
  })

  registerHandle('slides:files-add', async (_event: unknown, args: unknown) => {
    const paths = (args as string[]) || []
    return paths.map(p => ({ path: p, ok: true }))
  })

  registerHandle('slides:files-read-image', async (_event: unknown, path: unknown) => {
    if (existsSync(path as string)) {
      const bytes = readFileSync(path as string)
      return { base64: bytes.toString('base64'), name: basename(path as string) }
    }
    return null
  })
}

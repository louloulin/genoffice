/**
 * web/* — Browser file round-trip helpers.
 *
 * These channels are called from the renderer to write temp files (so the
 * main-process shell can open them with the system default app), read
 * bytes back, or save into the project file store.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerHandle } from '../common/registry.js'
import { FILES_DIR, loadProjects, saveProjects } from '../common/store.js'

const WEB_TEMP_ROOT = join(tmpdir(), 'genoffice-web-temp')

export function registerWebHandlers(): void {
  registerHandle('web:write-temp-file', async (_event: unknown, request: unknown) => {
    const record = request as { name?: unknown; bytes?: unknown } | null
    if (!record || typeof record.name !== 'string' || !(record.bytes instanceof ArrayBuffer)) {
      throw new Error('web:write-temp-file expects { name: string, bytes: ArrayBuffer }')
    }
    const safeName = basename(record.name).replace(/[^\w.\- ]+/g, '_') || 'file'
    const dir = mkdtempSync(join(WEB_TEMP_ROOT, 'upload-'))
    const filePath = join(dir, safeName)
    writeFileSync(filePath, Buffer.from(record.bytes))
    return filePath
  })

  registerHandle('web:read-file-bytes', async (_event: unknown, path: unknown) => {
    if (!existsSync(path as string)) {
      throw new Error(`File not found: ${path}`)
    }
    const bytes = readFileSync(path as string)
    return {
      name: basename(path as string),
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })

  registerHandle('web:make-temp-dir', async () => mkdtempSync(join(tmpdir(), 'genoffice-dir-')))

  registerHandle('web:save-file', async (_event: unknown, request: unknown) => {
    const { name, bytes, projectId } = request as { name?: string; bytes?: ArrayBuffer; projectId?: string }
    if (!name || !bytes) throw new Error('web:save-file expects { name, bytes, projectId? }')

    const fileId = `${Date.now()}-${name}`
    const filePath = join(FILES_DIR, fileId)
    writeFileSync(filePath, Buffer.from(bytes))

    if (projectId) {
      const projects = loadProjects()
      const project = projects.find(p => p.id === projectId)
      if (project && !project.files.includes(fileId)) {
        project.files.push(fileId)
        project.updatedAt = Date.now()
        saveProjects(projects)
      }
    }

    return { id: fileId, path: filePath, name }
  })
}

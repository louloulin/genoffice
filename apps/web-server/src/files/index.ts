/**
 * files/* — file picker + raw file CRUD.
 *
 * Files are written into DATA_DIR/files and tracked in the FILES_INDEX map
 * exposed from common/store.ts.
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { registerHandle } from '../common/registry.js'
import { FILES_DIR, FILES_INDEX, MIME_TYPES } from '../common/store.js'

export function registerFilesHandlers(): void {
  registerHandle('files:pick', () => ({
    canceled: false,
    filePaths: [],
    message: '请使用 Web File API 在前端选择文件',
  }))

  registerHandle('files:add', async (_event: unknown, paths: unknown) => {
    const filePaths = (paths as string[]) || []
    const results = []
    for (const originalPath of filePaths) {
      if (existsSync(originalPath)) {
        const stats = statSync(originalPath)
        const fileId = `${Date.now()}-${basename(originalPath)}`
        const destPath = join(FILES_DIR, fileId)
        writeFileSync(destPath, readFileSync(originalPath))
        const fileInfo = {
          id: fileId,
          name: basename(originalPath),
          path: destPath,
          size: stats.size,
          mimeType: MIME_TYPES[extname(originalPath)] || 'application/octet-stream',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        FILES_INDEX.set(fileId, fileInfo)
        results.push(fileInfo)
      }
    }
    return results
  })

  registerHandle('files:read-image', async (_event: unknown, path: unknown) => {
    if (existsSync(path as string)) {
      const bytes = readFileSync(path as string)
      return {
        base64: bytes.toString('base64'),
        mimeType: MIME_TYPES[extname(path as string)] || 'image/png',
        name: basename(path as string),
      }
    }
    return null
  })

  registerHandle('files:create', (_event: unknown, args: unknown) => {
    const { name, content, type, projectId } = (args || {}) as {
      name?: string
      content?: string
      type?: string
      projectId?: string
    }

    const fileId = `file-${Date.now()}`
    const fileName = name || `新建文件${Date.now()}`
    const filePath = join(FILES_DIR, fileId)
    const fileContent = content || ''

    writeFileSync(filePath, fileContent, 'utf-8')
    const stats = statSync(filePath)

    const fileInfo = {
      id: fileId,
      name: fileName,
      path: filePath,
      size: stats.size,
      mimeType: type || MIME_TYPES[extname(fileName)] || 'application/octet-stream',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    FILES_INDEX.set(fileId, fileInfo)

    return fileInfo
  })

  registerHandle('files:read', (_event: unknown, args: unknown) => {
    const { id, path } = (args || {}) as { id?: string; path?: string }

    if (id && FILES_INDEX.has(id)) {
      const fileInfo = FILES_INDEX.get(id)!
      if (existsSync(fileInfo.path)) {
        return {
          ...fileInfo,
          content: readFileSync(fileInfo.path, 'utf-8'),
        }
      }
    }

    if (path && existsSync(path)) {
      const bytes = readFileSync(path)
      return {
        id: `file-${Date.now()}`,
        name: basename(path),
        path,
        size: bytes.length,
        mimeType: MIME_TYPES[extname(path)] || 'application/octet-stream',
        content: bytes.toString('base64'),
        isBase64: true,
      }
    }

    return null
  })

  registerHandle('files:update', async (_event: unknown, args: unknown) => {
    const { id, content, name } = (args || {}) as { id?: string; content?: string; name?: string }

    if (!id || !FILES_INDEX.has(id)) {
      return { ok: false, error: 'File not found' }
    }

    const fileInfo = FILES_INDEX.get(id)!
    if (content !== undefined) {
      writeFileSync(fileInfo.path, content, 'utf-8')
    }
    if (name) {
      fileInfo.name = name
    }
    fileInfo.updatedAt = Date.now()

    return { ok: true, ...fileInfo }
  })

  registerHandle('files:delete', (_event: unknown, args: unknown) => {
    const { id, path } = (args || {}) as { id?: string; path?: string }

    if (id && FILES_INDEX.has(id)) {
      const fileInfo = FILES_INDEX.get(id)!
      if (existsSync(fileInfo.path)) {
        unlinkSync(fileInfo.path)
      }
      FILES_INDEX.delete(id)
      return { ok: true, deleted: id }
    }

    if (path && existsSync(path)) {
      unlinkSync(path)
      return { ok: true, deleted: path }
    }

    return { ok: false, error: 'File not found' }
  })
}

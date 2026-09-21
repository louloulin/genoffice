/**
 * Generic file CRUD — pick/add/read/create/update/delete for the shell's
 * file-picker surface and the renderer-side preview hooks.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname } from 'node:path'
import {
  FILES_INDEX,
  FILES_DIR,
  isManagedPath,
  MIME_TYPES,
  loadProjects,
  PATH_OUTSIDE_STORAGE,
  registerHandle,
  saveProjects,
} from '../common/index'
import type { FileInfo } from '../common/index'
import { getStorageBackend } from '../common/state'
import { StorageNotFoundError } from '@genoffice/file-management'


/** Resolve a stored-file reference — either a synthetic `storage://backend/key`
 *  URI (the new convention) or a managed-path FILES_DIR entry — to a key the
 *  backend can fetch. Returns null when the path doesn't belong to the
 *  storage layer (legacy callers). */
function storageKeyFromPath(filePath: string): string | null {
  if (filePath.startsWith('storage://')) {
    const rest = filePath.slice('storage://'.length)
    const slash = rest.indexOf('/')
    return slash === -1 ? rest : rest.slice(slash + 1)
  }
  if (filePath.startsWith(FILES_DIR + '/')) {
    return filePath.slice(FILES_DIR.length + 1)
  }
  return null
}

async function readBytesFor(filePath: string): Promise<Buffer | null> {
  const key = storageKeyFromPath(filePath)
  if (!key) return null
  try {
    const u8 = await getStorageBackend().get(key)
    return Buffer.from(u8)
  } catch (err) {
    if (err instanceof StorageNotFoundError) return null
    throw err
  }
}

export function registerFilesHandlers(): void {
  registerHandle('files:pick', () => ({
    canceled: false,
    filePaths: [],
    message: '请使用 Web File API 在前端选择文件',
  }))

  registerHandle('files:add', async (_event: unknown, paths: unknown) => {
    const filePaths = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : []
    const results: FileInfo[] = []
    for (const originalPath of filePaths) {
      // Only files inside managed storage are imported: this channel reads the
      // source and copies it into FILES_DIR, so an unguarded path would pull
      // any readable file on the machine into the browser-visible store.
      if (isManagedPath(originalPath) && existsSync(originalPath)) {
        const stats = statSync(originalPath)
        const fileId = `${Date.now()}-${basename(originalPath)}`
        const contentType = MIME_TYPES[extname(originalPath)] || 'application/octet-stream'
        /* Route through the storage backend so a remote backend (mimo/S3) gets
         * the bytes too, instead of silently dropping them onto the local FS
         * that the backend would never look at. */
        await getStorageBackend().put(fileId, new Uint8Array(readFileSync(originalPath)), { contentType })
        const fileInfo: FileInfo = {
          id: fileId,
          name: basename(originalPath),
          path: `storage://${getStorageBackend().id}/${fileId}`,
          size: stats.size,
          mimeType: contentType,
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
    if (typeof path !== 'string' || !isManagedPath(path)) return null
    const bytes = await readBytesFor(path)
    if (bytes) {
      return {
        base64: bytes.toString('base64'),
        mimeType: MIME_TYPES[extname(path)] || 'image/png',
        name: basename(path),
      }
    }
    return null
  })

  registerHandle('files:create', async (_event: unknown, args: unknown) => {
    const { name, content, type, projectId } = (args || {}) as {
      name?: string
      content?: string
      type?: string
      projectId?: string
    }

    const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const fileName = name || `新建文件${Date.now()}`
    const fileContent = content || ''
    const mimeType = type || MIME_TYPES[extname(fileName)] || 'application/octet-stream'
    const bytes = new TextEncoder().encode(fileContent)

    /* Atomic write via the active backend; never call writeFileSync here —
     * a crash mid-write would leave a half-written file the renderer would
     * then try to parse as a real document. */
    await getStorageBackend().put(fileId, bytes, { contentType: mimeType })

    const fileInfo: FileInfo = {
      id: fileId,
      name: fileName,
      path: `storage://${getStorageBackend().id}/${fileId}`,
      size: bytes.byteLength,
      mimeType,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    FILES_INDEX.set(fileId, fileInfo)

    // Attach to the requesting project the same way `web:save-file` does, so a
    // caller that passes `projectId` gets the file listed in that project
    // instead of it being created and then silently orphaned.
    if (projectId) {
      const projects = loadProjects()
      const project = projects.find((p) => p.id === projectId)
      if (project && !project.files.includes(fileId)) {
        project.files.push(fileId)
        project.updatedAt = Date.now()
        saveProjects(projects)
      }
    }

    return fileInfo
  })

  registerHandle('files:read', async (_event: unknown, args: unknown) => {
    const { id, path } = (args || {}) as { id?: string; path?: string }

    /* Ids come from `fileIndexStore`, which is rehydrated from disk at boot,
     * so an id issued before a restart still resolves here. */
    if (id && FILES_INDEX.has(id)) {
      const fileInfo = FILES_INDEX.get(id)!
      const bytes = await readBytesFor(fileInfo.path)
      if (bytes) {
        /* Binary formats (PDF, XLSX, PPTX) are not safe to ship as utf-8; the
         * renderer used to get a corrupted "content" field for those. Encode
         * as base64 with a marker and let the renderer decode. */
        const isText = fileInfo.mimeType.startsWith('text/') ||
          ['application/json', 'application/javascript'].includes(fileInfo.mimeType)
        return {
          ...fileInfo,
          content: isText ? bytes.toString('utf-8') : bytes.toString('base64'),
          isBase64: !isText,
        }
      }
    }

    if (path && isManagedPath(path) && existsSync(path)) {
      /* Path-based reads are only meaningful for the local backend — remote
       * backends have no concept of "the absolute path" the caller supplies.
       * Fall back to the backend lookup by basename so the same call site works
       * regardless of where the bytes live. */
      if (getStorageBackend().id === 'local') {
        const { readFileSync } = require('node:fs') as typeof import('node:fs')
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
      const bytes = typeof content === 'string'
        ? Buffer.from(content, 'utf-8')
        : Buffer.from(content as ArrayBuffer)
      await getStorageBackend().put(fileInfo.id, new Uint8Array(bytes), {
        contentType: fileInfo.mimeType,
      })
      fileInfo.size = bytes.byteLength
    }
    if (name) {
      fileInfo.name = name
    }
    fileInfo.updatedAt = Date.now()

    return { ok: true, ...fileInfo }
  })

  registerHandle('files:delete', async (_event: unknown, args: unknown) => {
    const { id, path } = (args || {}) as { id?: string; path?: string }

    if (id && FILES_INDEX.has(id)) {
      const fileInfo = FILES_INDEX.get(id)!
      await getStorageBackend().delete(fileInfo.id)
      FILES_INDEX.delete(id)
      return { ok: true, deleted: id }
    }

    if (path) {
      // A delete is destructive, so an unmanaged path is refused before the
      // existence check — otherwise this channel unlinks any file on the host.
      if (!isManagedPath(path)) return { ok: false, error: PATH_OUTSIDE_STORAGE }
      const key = storageKeyFromPath(path)
      if (key) {
        await getStorageBackend().delete(key)
        return { ok: true, deleted: path }
      }
      if (existsSync(path)) {
        unlinkSync(path)
        return { ok: true, deleted: path }
      }
    }

    return { ok: false, error: 'File not found' }
  })

  registerHandle('preview:get', async (_event: unknown, args: unknown) => {
    const { filePath } = args as { filePath: string; width?: number; height?: number; format?: 'thumbnail' | 'full' }

    if (typeof filePath !== 'string' || !isManagedPath(filePath)) return null
    const bytes = await readBytesFor(filePath)
    if (!bytes) return null

    const ext = extname(filePath).toLowerCase()

    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      return {
        type: 'image',
        base64: bytes.toString('base64'),
        mimeType: `image/${ext.slice(1)}`,
        width: (args as { width?: number }).width || 800,
        height: (args as { height?: number }).height || 600,
      }
    } else if (ext === '.pdf') {
      return {
        type: 'pdf',
        base64: bytes.toString('base64'),
        pageCount: 1,
      }
    } else if (['.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.ts'].includes(ext)) {
      return {
        type: 'text',
        content: bytes.toString('utf-8').slice(0, 10000),
        truncated: bytes.length > 10000,
      }
    }

    return {
      type: 'unsupported',
      extension: ext,
      message: `不支持预览 ${ext} 文件`,
    }
  })
}

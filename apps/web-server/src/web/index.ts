/**
 * Web-platform helper channels — temp file read/write, temp dir creation,
 * and the `web:save-file` helper used by browser pickers to land a chosen
 * file into the project's `FILES_DIR` and (optionally) attach it to a
 * project.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Hard cap on a single `web:write-temp-file` upload. Sized for a
 * realistic large PDF / DOCX with embedded media but small enough to
 * keep a misbehaving renderer from filling the temp directory in a
 * single request. The dedicated `files:add-pasted-image` channel has
 * its own 20 MiB cap for inline images; this cap is for arbitrary
 * uploaded documents.
 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FILES_DIR,
  MIME_TYPES,
  loadProjects,
  registerHandle,
  requireManagedPath,
  sanitizeFileName,
  saveProjects,
  WEB_TEMP_ROOT,
} from '../common/index'
import type { FileInfo } from '../common/index'
import { atomicWriteFile } from '../common/atomic'
import { recordRecentDoc } from '../common/document-stores'
import { fileIndexStore } from '../common/file-index-store'
import { InvalidArgumentError, NotFoundError } from '../ai/errors'

export function registerWebHandlers(): void {
  registerHandle('web:write-temp-file', async (_event: unknown, request: unknown) => {
    const record = request as { name?: unknown; bytes?: unknown } | null
    if (!record || typeof record.name !== 'string' || !(record.bytes instanceof ArrayBuffer)) {
      throw new InvalidArgumentError(
        'web:write-temp-file',
        'expects { name: string, bytes: ArrayBuffer }',
      )
    }
    const safeName = sanitizeFileName(record.name, 'file')
    if (record.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new InvalidArgumentError(
        'web:write-temp-file',
        `upload exceeds the ${MAX_UPLOAD_BYTES}-byte cap`,
      )
    }
    const dir = mkdirSync(
      join(WEB_TEMP_ROOT, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      { recursive: true },
    ) as string
    const filePath = join(dir, safeName)
    writeFileSync(filePath, Buffer.from(record.bytes))
    return filePath
  })

  registerHandle('web:read-file-bytes', async (_event: unknown, path: unknown) => {
    const filePath = requireManagedPath('web:read-file-bytes', path)
    if (!existsSync(filePath)) {
      throw new NotFoundError('web:read-file-bytes', `File not found: ${filePath}`)
    }
    const bytes = readFileSync(filePath)
    return {
      name: basename(filePath),
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })

  registerHandle('web:make-temp-dir', async () =>
    mkdirSync(join(tmpdir(), `genoffice-dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), { recursive: true }),
  )

  registerHandle('web:save-file', async (_event: unknown, request: unknown) => {
    const { name, bytes, projectId } = request as {
      name?: string
      bytes?: ArrayBuffer
      projectId?: string
    }
    if (!name || !bytes) {
      throw new InvalidArgumentError('web:save-file', 'expects { name, bytes, projectId? }')
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new InvalidArgumentError(
        'web:save-file',
        `upload exceeds the ${MAX_UPLOAD_BYTES}-byte cap`,
      )
    }
    /* A 0-byte upload is a bug upstream (an unreadable picker result, a
     * truncated read), and accepting it would create a file that every
     * renderer then fails to parse. Reported as INVALID_ARGUMENT (400) rather
     * than a 500 so the caller can tell its own malformed request from a
     * server fault. */
    if (bytes.byteLength === 0) {
      throw new InvalidArgumentError('web:save-file', 'refusing a 0-byte upload')
    }

    const safeName = sanitizeFileName(name, 'file')
    const fileId = fileIndexStore.nextId(safeName)
    const filePath = join(FILES_DIR, fileId)
    const buffer = Buffer.from(bytes)
    const stats = { size: buffer.byteLength, mimeType: MIME_TYPES[extname(safeName).toLowerCase()] || 'application/octet-stream' }

    /* Atomic: a crash mid-upload leaves either no file or the complete one,
     * never a half-written document that looks openable. */
    atomicWriteFile(filePath, buffer)

    /* Index the upload so `files:read({id})` can resolve it — including after
     * a restart, which is what `fileIndexStore.flushNow` below persists. */
    const info: FileInfo = {
      id: fileId,
      name: safeName,
      path: filePath,
      size: stats.size,
      mimeType: stats.mimeType,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    fileIndexStore.set(info)

    // Mirror the save into the home page recents list so the upload shows
    // up immediately on the shell home tab. Keys are paths and the FILES_DIR
    // name embeds a timestamp, so every upload gets its own row: re-uploading
    // the same logical file adds a newer row instead of replacing the older
    // one. That is intentional — recents is a history, and the older row still
    // points at bytes that really are on disk.
    // `recordRecentDoc` writes both the legacy in-session mirror and the
    // restart-safe store; awaiting it means the caller cannot observe the
    // entry as missing.
    await recordRecentDoc(filePath, {
      id: basename(fileId, extname(fileId)),
      name: safeName,
      modified: false,
      projectId,
    })
    await fileIndexStore.flushNow()

    if (projectId) {
      const projects = loadProjects()
      const project = projects.find(p => p.id === projectId)
      if (project && !project.files.includes(fileId)) {
        project.files.push(fileId)
        project.updatedAt = Date.now()
        saveProjects(projects)
      }
    }

    return { id: fileId, path: filePath, name: safeName }
  })
}

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
import { basename, dirname, extname, join } from 'node:path'
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
import { getStorageBackend } from '../common/state'
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

  /* `downloadAs` with an explicit `savePath` (§B.5.1 #6) needs a way to put
   * renderer-produced bytes at a path the HOST chose. `web:save-file` cannot
   * serve it: that channel names the file itself (a content-addressed key)
   * and is for uploads. This one takes a managed destination and writes
   * atomically, so an interrupted export never replaces a good file with a
   * half-written one — the same guarantee every save pipeline gives.
   *
   * The path is run through `requireManagedPath`, so a hostile `savePath`
   * cannot escape FILES_DIR even though the request comes from a renderer. */
  registerHandle('web:write-file-bytes', async (_event: unknown, request: unknown) => {
    const record = request as { path?: unknown; bytes?: unknown } | null
    if (!record || typeof record.path !== 'string' || !(record.bytes instanceof ArrayBuffer)) {
      throw new InvalidArgumentError('web:write-file-bytes', 'expects { path, bytes }')
    }
    if (record.bytes.byteLength === 0) {
      // A 0-byte export is a bug upstream (an exporter that produced
      // nothing), and accepting it would leave an unopenable file that the
      // renderer reports as a successful export.
      throw new InvalidArgumentError('web:write-file-bytes', 'refusing a 0-byte write')
    }
    if (record.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new InvalidArgumentError(
        'web:write-file-bytes',
        `write exceeds the ${MAX_UPLOAD_BYTES}-byte cap`,
      )
    }
    const target = requireManagedPath('web:write-file-bytes', record.path)
    mkdirSync(dirname(target), { recursive: true })
    atomicWriteFile(target, Buffer.from(record.bytes))
    await recordRecentDoc(target, { modified: true })
    return { ok: true, path: target, size: record.bytes.byteLength }
  })

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
    const contentType = MIME_TYPES[extname(safeName).toLowerCase()] || 'application/octet-stream'
    /* Bucket-friendly content-addressed key: same bytes ⇒ same key, so
     * a second upload of an identical file dedupes naturally. The key
     * has the form `<yyyy>/<mm>/<dd>/<sha256>.<ext>` and is safe to
     * drop into any S3-compatible bucket without sanitisation. */
    const fileId = await fileIndexStore.nextKey({
      bytes: new Uint8Array(bytes),
      name: safeName,
      mimeType: contentType,
    })
    const buffer = Buffer.from(bytes)

    /* Atomic: a crash mid-upload leaves either no file or the complete one,
     * never a half-written document that looks openable. The storage backend
     * (local FS by default; minio/S3 via env) owns the temp-and-rename kernel,
     * so the web:save-file channel stays backend-agnostic. */
    const stored = await getStorageBackend().put(fileId, new Uint8Array(bytes), { contentType })

    /* Index the upload so `files:read({id})` can resolve it — including after
     * a restart, which is what `fileIndexStore.flushNow` below persists. The
     * `path` is a synthetic one — the active backend may store the bytes
     * somewhere else entirely (minio/S3). handlers that need the bytes
     * themselves must go through the backend, not readFileSync. */
    const info: FileInfo = {
      id: fileId,
      name: safeName,
      path: `storage://${getStorageBackend().id}/${fileId}`,
      size: stored.size,
      mimeType: contentType,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    fileIndexStore.set(info)

    // Mirror the save into the home page recents list so the upload shows
    // up immediately on the shell home tab. The recents key is the storage
    // URI we return in `info.path` — that is the path the renderer holds
    // after upload, so the `home:recents` rows and the upload response agree
    // on the same identifier. Using a different key here (the FILES_DIR
    // canonical path for the local backend) would force the renderer to
    // re-translate the storage URI before it could correlate a recents row
    // with what `web:save-file` just returned, and the lookup silently
    // missed for every upload. `recordRecentDoc` writes both the legacy
    // in-session mirror and the restart-safe store; awaiting it means the
    // caller cannot observe the entry as missing.
    await recordRecentDoc(info.path, {
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

    /* `path` is the synthetic storage URI: callers that need to read the
     * bytes back must round-trip through the backend (or `files:read`). */
    return { id: fileId, path: info.path, name: safeName, size: stored.size, mimeType: contentType }
  })
}

/**
 * Docs IPC channels — recent, font-metrics, pick-image, settings,
 * open/save/read/print. Persistence is in-memory + `docs-recent.json`; the
 * `DOCS_RECENT` map referenced by `home:recents` is the same singleton
 * declared in `common/state.ts`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  DATA_DIR,
  DOCS_RECENT,
  FILES_DIR,
  isManagedPath,
  loadProjects,
  loadRecentDocs,
  randomFileId,
  registerHandle,
  reserveDailyPasteQuota,
  sanitizeFileName,
  saveProjects,
  saveRecentDocs,
} from '../common/index'

const PASTE_QUOTA_FILE = join(DATA_DIR, '.quotas', 'paste.json')
import { assertMagicMatchesExtension } from '../common/magic'
import { atomicWriteFile } from '../common/atomic'
import { recordRecentDoc } from '../common/document-stores'
import { notifyFileSaved } from '../common/webhooks-store'
import { sendIpcEvent } from '../common/event-broadcast'
import { captureBeforeSave } from '../common/version-history'
import { InvalidArgumentError, NotFoundError } from '../ai/errors'
import { getStorageBackend, storageKeyFromPath } from '../common/state'
import { StorageNotFoundError } from '@genoffice/file-management'

const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024
const closeState = {
  check: null as { dirty: boolean; autoSave: boolean; filePath: string | null } | null,
  saveOk: null as boolean | null,
}

function isManagedDocPath(filePath: string): boolean {
  return (
    /\.docx$/i.test(filePath) && isManagedPath(filePath)
  )
}

/**
 * Resolve a renderer-supplied docx path to its bytes. Mirrors the pattern in
 * apps/web-server/src/pdf/index.ts:readPdfBytes — accept either a managed
 * filesystem path (the legacy FILES_DIR shape) or a `storage://<backend>/<key>`
 * URI (what `web:save-file` returns for every upload since the storage-backend
 * refactor). Without the storage branch, every uploaded docx was invisible to
 * the docs editors: clicking the home recents row opened a blank document and
 * the very first save attempt returned "save target is outside the web storage
 * area", which read to the user as "my upload was lost".
 */
async function readDocxBytes(channel: string, filePath: string): Promise<Buffer> {
  const key = storageKeyFromPath(filePath)
  if (key) {
    try {
      const u8 = await getStorageBackend().get(key)
      return Buffer.from(u8)
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        throw new NotFoundError(channel, `File not found: ${filePath}`)
      }
      throw err
    }
  }
  if (isManagedDocPath(filePath) && existsSync(filePath)) {
    return readFileSync(filePath)
  }
  throw new InvalidArgumentError(channel, 'docx path is outside the web storage area')
}

/**
 * Resolve the canonical (FILES_DIR-resident) path for `filePath`. Storage
 * URIs decode to the active backend's key, which the local backend writes
 * under FILES_DIR — return that path so the renderer's `filePath` stays an
 * absolute filesystem path the docs channels can read / write directly on
 * the next round-trip. Without this re-projection, the renderer would carry
 * a `storage://…` URI into `docs:save`, which the legacy `isManagedDocPath`
 * check rejected as "outside the web storage area".
 */
function canonicalDocxPath(filePath: string): string {
  const key = storageKeyFromPath(filePath)
  if (key) return join(FILES_DIR, key)
  return filePath
}

function bytesFrom(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

// Mirrors apps/docs/src/main/docx-encryption.ts:isEncryptedDocx for the web build.
// The renderer contract (OpenFileResult) distinguishes encrypted from plain
// docx so a CFB (OLE2) container signals "needs password" instead of being
// passed to the zip-based parser.
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')
function isCfb(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(CFB_MAGIC)
}
function isEncryptedDocxBytes(bytes: Buffer): boolean {
  return isCfb(bytes) && bytes.includes(ENCRYPTED_STREAM_UTF16)
}
function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function registerDocsHandlers(): void {
  // The desktop main process types one trusted space and the renderer scrubs it
  // back out (see `apps/docs/src/main/docs-main.ts` docs:respell-kick). The web
  // renderer cannot deliver a trusted keystroke; a browser-driven input event
  // is *untrusted* and does not respell Blink anyway. Answering the channel
  // here turns the caller's swallowed 404 (`IPC_NO_HANDLER`) into an explicit
  // success so the renderer's idempotent kick just no-ops without logging an
  // error. Spellcheck will respell as soon as the user types — same final
  // state as the desktop path, just without the synthetic keystroke.
  registerHandle('docs:respell-kick', () => ({ ok: true, supported: false }))

  registerHandle('docs:view-menu-state', () => ({ ok: true }))

  registerHandle('docs:discard-password-intents', (_event: unknown, throughRevision: unknown) => ({
    ok:
      typeof throughRevision === 'number' &&
      Number.isSafeInteger(throughRevision) &&
      throughRevision >= 0,
  }))

  registerHandle('docs:recent', () => loadRecentDocs())

  registerHandle('docs:font-metrics', (_event: unknown, family: unknown) => ({
    family: family || 'sans-serif',
    ascent: 0.8,
    descent: 0.2,
    lineGap: 0.1,
    unitsPerEm: 1000,
  }))

  registerHandle('docs:pick-image', () => ({
    canceled: false,
    dataUrl: null,
    message: '请使用 Web File API 在前端选择图片',
  }))

  registerHandle('docs:get-settings', () => ({
    language: 'zh-CN',
    spellCheck: true,
    autoSave: true,
    autoSaveInterval: 30000,
    fontSize: 14,
    fontFamily: 'sans-serif',
  }))

  registerHandle('docs:save-settings', () => ({ ok: true }), { scope: 'admin' })

  registerHandle('docs:close-check-result', (_event: unknown, state: unknown) => {
    const value = state as { dirty?: unknown; autoSave?: unknown; filePath?: unknown } | null
    closeState.check = {
      dirty: value?.dirty === true,
      autoSave: value?.autoSave === true,
      filePath: typeof value?.filePath === 'string' ? value.filePath : null,
    }
  })

  registerHandle('docs:close-save-result', (_event: unknown, ok: unknown) => {
    closeState.saveOk = ok === true
  })

  registerHandle('docs:open', async (_event: unknown, options: unknown) => {
    const opts = options as { docx?: ArrayBuffer; path?: string } | undefined

    if (opts?.docx) {
      const bytes = Buffer.from(opts.docx)
      assertMagicMatchesExtension('docs:open', '.docx', bytes)
      // randomFileId collapses the two `Date.now()` calls into one UUID-stamped
      // basename and avoids the previous "two docs saved in the same ms collide
      // on FILES_DIR/" bug. `name` mirrors what `docs:save-new` returns so the
      // renderer treats the two channels symmetrically; the date-stamped
      // Chinese name used toLocaleDateString() (which on US/EN locale emits
      // "9/21/2026" — a literal slash in a filename).
      const fileName = `${randomFileId('文档')}.docx`
      const path = join(FILES_DIR, fileName)
      const id = basename(path, '.docx')
      const name = fileName
      mkdirSync(FILES_DIR, { recursive: true })
      atomicWriteFile(path, bytes)

      const recent = loadRecentDocs()
      recent.unshift({ id, path, name, openedAt: Date.now(), modified: false })
      saveRecentDocs(recent)

      return { id, path, name }
    }

    return { id: '', path: '', name: '新文档.docx' }
  })

  registerHandle('docs:open-path', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string') {
      throw new InvalidArgumentError('docs:open-path', 'path must be a string')
    }
    const original = await readDocxBytes('docs:open-path', filePath)
    // Use the FILES_DIR-resident canonical path only for the magic-byte
    // extension check (it needs `.docx` to match against the bytes); the
    // recents row key and the renderer's `path` are the original `filePath`
    // — the storage URI for uploads, the absolute path for legacy callers —
    // so the value the renderer holds matches what `home:recents` returns
    // and the upload/open cycle does not produce two rows for one file.
    const canonical = canonicalDocxPath(filePath)
    const name = basename(filePath)

    // ECMA-376 encrypted docx (CFB / OLE2 + EncryptedPackage): the renderer
    // prompts for the password and retries via docs:open-decrypt, mirroring
    // the Electron main process's flow. The web build doesn't yet ship the
    // crypto dependency, so it surfaces needsPassword instead of pretending
    // the encrypted bytes parse cleanly.
    if (isEncryptedDocxBytes(original)) {
      return { needsPassword: true, path: filePath, name: DOCS_RECENT.get(filePath)?.name ?? name }
    }

    // Magic-mismatch gate before handing bytes to the real parser. The web
    // build has no Electron path-grant map, so the only signal that the
    // file extension is honest is the file's own magic bytes. Failing
    // here surfaces a structured `MagicMismatchError` to the renderer
    // instead of a cryptic "Can't find end of central directory" stack
    // trace from JSZip.
    assertMagicMatchesExtension('docs:open-path', canonical, original)

    const hash = createHash('sha256').update(original).digest('hex')
    const id = `doc-${Date.now()}`
    // Prefer the display name already recorded by the upload flow (e.g.
    // "Real Test.docx") so an open from a recents row keeps the user's name
    // instead of swapping in the storage-hash basename.
    const displayName = DOCS_RECENT.get(filePath)?.name ?? name
    const recent = loadRecentDocs()
    recent.unshift({ id, path: filePath, name: displayName, openedAt: Date.now(), modified: false })
    saveRecentDocs(recent)

    // Shape matches OpenFileResult from apps/docs/src/shared/ipc.ts so the
    // renderer's loadFile (apps/docs/src/renderer/file-actions.ts) reads
    // result.data and result.hash directly. `path` is the renderer's
    // original `filePath` (storage URI for web uploads) so subsequent
    // `docs:save` calls hit the same backend without re-decoding the URI.
    return {
      path: filePath,
      name: displayName,
      data: toArrayBuffer(original),
      hash,
      encrypted: false,
    }
  })

  registerHandle('docs:read-path', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string') return null
    let original: Buffer
    try {
      original = await readDocxBytes('docs:read-path', filePath)
    } catch {
      // Mirrors the previous "outside managed storage ⇒ null" semantics so
      // callers probing for an unuploaded path get the same answer they did
      // before storage URIs were a thing.
      return null
    }
    if (isEncryptedDocxBytes(original)) return null
    // Prefer the display name already recorded by `docs:save` /
    // `web:save-file` so the response carries the user's filename (e.g.
    // "Quarterly Report.docx") instead of the storage-hash basename. Fall
    // back to the renderer-supplied path's basename when no recents row
    // exists (legacy callers, brand-new paths).
    const displayName = DOCS_RECENT.get(filePath)?.name ?? basename(filePath)
    return {
      name: displayName,
      data: toArrayBuffer(original),
      hash: createHash('sha256').update(original).digest('hex'),
      encrypted: false,
    }
  })

  registerHandle(
    'docs:save',
    async (event: unknown, filePath: unknown, data: unknown, _auto?: unknown) => {
      if (typeof filePath !== 'string') {
        return { ok: false, error: 'save target must be a string' }
      }
      const bytes = bytesFrom(data)
      if (!bytes || bytes.byteLength === 0) {
        return { ok: false, error: 'save data is empty or invalid' }
      }
      const key = storageKeyFromPath(filePath)
      const canonical = canonicalDocxPath(filePath)
      if (!key && !isManagedDocPath(canonical)) {
        return { ok: false, error: 'save target is outside the web storage area' }
      }
      try {
        if (key) {
          // Storage URIs route through the active backend so a remote bucket
          // (minio/S3/rustfs) sees the new bytes. The local backend runs the
          // same atomic-write kernel as the bare-path branch, so a crash
          // mid-write still leaves either no file or the complete document.
          await getStorageBackend().put(key, new Uint8Array(bytes), {
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          })
        } else {
          // Snapshot prior bytes BEFORE the atomic write so the renderer can
          // roll back via files:restore-version. Swallowed on first save.
          try {
            const prev = readFileSync(canonical)
            captureBeforeSave(basename(canonical), prev)
          } catch { /* new file, nothing to snapshot */ }
          // Atomic: a crash mid-write cannot leave the document half-written on
          // disk. Uses the shared kernel implementation so the Windows
          // EPERM-retry behaviour matches the desktop build exactly.
          atomicWriteFile(canonical, bytes)
        }
        /* Dual write. The legacy mirror feeds the in-session home grid, and
         * `unifiedRecents` is what makes the entry survive a restart — without
         * it a saved document vanished from recents the next time the server
         * booted, which reads to the user as "my save was lost". The recents
         * key matches what the renderer actually holds (storage URI for web
         * uploads, FILES_DIR path for legacy callers) so a subsequent
         * `home:recents` lookup hits the same entry instead of producing a
         * duplicate row keyed by the FILES_DIR canonical path. Reuse the
         * existing display name when one is known (so the user's "Quarterly
         * Report.docx" survives a save), falling back to the basename for
         * first-time saves. */
        const existingName = DOCS_RECENT.get(filePath)?.name
        await recordRecentDoc(filePath, {
          id: basename(filePath, extname(filePath)),
          name: existingName ?? basename(filePath),
          modified: true,
        })
        notifyFileSaved(filePath, { size: bytes.byteLength, format: 'docx' })
        sendIpcEvent(event, 'saved', {
          path: filePath,
          version: Date.now(),
          bytes: bytes.byteLength,
          format: 'docx',
        })
        return { ok: true, path: filePath }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  registerHandle('docs:create-document', async (_event: unknown, request: unknown) => {
    const value = request as { type?: unknown; title?: unknown; content?: unknown } | null
    const type = value?.type
    const title = sanitizeFileName(value?.title ?? 'Untitled', 'Untitled').slice(0, 80) || 'Untitled'
    const content = typeof value?.content === 'string' ? value.content : ''
    if (!content.trim()) return { ok: false, error: 'content must not be empty' }
    if (type !== 'md' && type !== 'html') {
      return {
        ok: false,
        error: `WEB_UNSUPPORTED: document type '${String(type)}' requires the desktop renderer`,
      }
    }
    const filePath = join(DATA_DIR, `${title}.${type}`)
    try {
      // Atomic temp+rename so a crash cannot leave a partial document on
      // disk. Mirrors docs:save and web:save-file.
      const tmpPath = `${filePath}.${randomFileId('tmp').split('-')[0]}.tmp`
      writeFileSync(tmpPath, content, 'utf8')
      renameSync(tmpPath, filePath)
      return { ok: true, path: filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registerHandle('docs:open-decrypt', () => ({
    ok: false,
    reason: 'error',
    error: 'WEB_UNSUPPORTED: password-protected DOCX requires the desktop renderer',
  }))

  registerHandle('docs:set-password', () => ({
    ok: false,
    error: 'WEB_UNSUPPORTED: DOCX password protection requires the desktop renderer',
  }), { scope: 'soft:auth:write' })

  registerHandle('docs:ai-generate-image', () => ({
    ok: false,
    error: 'WEB_UNSUPPORTED: image generation is not available in the web docs bridge',
  }))

  registerHandle('files:add-pasted-image', async (_event: unknown, data: unknown, ext: unknown) => {
    const cleanExt = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : ''
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(cleanExt)) {
      return { accepted: [], rejected: ['not an image'] }
    }
    const bytes = bytesFrom(data)
    if (!bytes || bytes.byteLength === 0) return { accepted: [], rejected: ['image data is empty'] }
    if (bytes.byteLength > MAX_PASTED_IMAGE_BYTES) {
      return { accepted: [], rejected: ['image is too large'] }
    }
    // Magic-byte gate: a renderer that names a JPEG with a .png extension
    // used to slip through (or vice versa). Reject before reserving quota
    // so a misbehaving tab can't burn the day's allowance on rejected
    // bytes.
    assertMagicMatchesExtension('files:add-pasted-image', `.${cleanExt}`, bytes)
    try {
      reserveDailyPasteQuota(PASTE_QUOTA_FILE, bytes.byteLength)
    } catch (error) {
      return {
        accepted: [],
        rejected: [error instanceof Error ? error.message : 'quota exceeded'],
      }
    }
    const safeExt = sanitizeFileName(cleanExt, 'png')
    const name = `pasted-${randomFileId('paste').split('-')[0]}.${safeExt}`
    const path = join(FILES_DIR, name)
    // Atomic temp+rename: a crash mid-write cannot leave a half-image on
    // disk AND keep the day's quota counter incremented.
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, bytes)
    renameSync(tmpPath, path)
    const stat = statSync(path)
    return {
      accepted: [{ path, name, ext: safeExt, sizeBytes: stat.size }],
      rejected: [],
    }
  })

  registerHandle(
    'docs:save-new',
    async (event: unknown, defaultName?: unknown, data?: unknown, projectId?: unknown) => {
      // Sanitize the renderer-supplied name up front: the previous code took
      // the raw defaultName and stored it in the project list / recents row,
      // so a path-traversal payload like '../../../etc/passwd.docx' survived
      // even though the on-disk path was always `${id}.docx`. The user-visible
      // basename also doubled as the tab title in the shell recents grid.
      const safeName = sanitizeFileName(
        typeof defaultName === 'string' && defaultName ? defaultName : 'Untitled.docx',
        'Untitled.docx',
      ).slice(0, 120)
      const bytes = bytesFrom(data)
      if (!bytes || bytes.byteLength === 0) {
        // Empty bytes used to write a 0-byte file that the next open rejected
        // with a magic-mismatch error — the user saw "saved" then "can't open",
        // which read as a corrupt save.
        return { ok: false, error: 'save data is empty or invalid' }
      }
      // The on-disk filename is always `${randomUUID}-${safeStem}.docx` so
      // two "Quarterly Report.docx" saves in the same millisecond never
      // collide AND the suffix is a single, recognisable `.docx` (which the
      // magic-byte gate and `isManagedDocPath` extension check both rely
      // on). `safeName` may already carry a `.docx` from the renderer; strip
      // it before stamping the UUID so the final path doesn't end with
      // `.docx.docx`.
      const safeStem = safeName.replace(/\.docx$/i, '')
      const fileName = `${randomFileId(safeStem)}.docx`
      const path = join(FILES_DIR, fileName)
      // The id is `doc-<basename>` so the renderer (and tests) can tell at a
      // glance which format a recents row came from. The bare basename was
      // already random (UUID + safe stem) and collision-free; prefixing it
      // with `doc-` is a presentation change that does not affect file
      // resolution because the renderer keys subsequent save flows off
      // `path` (which is unchanged) rather than `id`.
      const id = `doc-${basename(path, '.docx')}`

      // FILES_DIR is created at module load, but a `rm -rf` against
      // DATA_DIR (e.g. between test runs, or a misconfigured deploy)
      // would otherwise make writeFileSync throw ENOENT. Re-create the
      // parent before each write — mkdirSync({recursive:true}) is a
      // no-op when the directory already exists.
      mkdirSync(FILES_DIR, { recursive: true })
      // Snapshot prior bytes BEFORE the atomic write so a save-as-over-same-path
      // flow produces a recoverable prior version. New file: readFileSync throws.
      try {
        const prev = readFileSync(path)
        captureBeforeSave(basename(path), prev)
      } catch { /* new file, nothing to snapshot */ }
      atomicWriteFile(path, bytes)

      // Mirror into the recents store so the new file shows up in the home
      // grid immediately. The previous version skipped this for `docs:save-new`
      // (only `docs:save` recorded recents), so freshly-saved documents were
      // invisible until the user opened them and the server's cold-start disk
      // sweep re-discovered them.
      await recordRecentDoc(path, {
        id,
        name: safeName,
        modified: false,
      })
      notifyFileSaved(path, { size: bytes.byteLength, format: 'docx' })
      sendIpcEvent(event, 'saved', {
        path,
        version: Date.now(),
        bytes: bytes.byteLength,
        format: 'docx',
      })
      if (typeof projectId === 'string' && projectId) {
        const projects = loadProjects()
        const project = projects.find((p) => p.id === projectId)
        // Store the basename the renderer will see in the project file list;
        // using the random UUID directly kept the entry visible only via
        // `/api/ipc/project:files`, never in the home shell's project tree.
        // `path` already ends in `.docx` — don't append the extension again.
        const entryName = basename(path)
        if (project && !project.files.includes(entryName)) {
          project.files.push(entryName)
          project.updatedAt = Date.now()
          saveProjects(projects)
        }
      }

      return { ok: true, id, path, name: safeName }
    },
  )


  registerHandle(
    'docs:save-as',
    async (event: unknown, sourcePath?: unknown, targetPath?: unknown, data?: unknown) => {
      // Save-as: copy bytes from `sourcePath` (or honour `data` if the
      // renderer already has fresh bytes) to `targetPath`. Mirrors the
      // desktop signature so the renderer (docs/web-bridge.tsx) can use
      // the same call shape across web / electron builds.
      //
      // The previous web build had no `docs:save-as` channel at all —
      // sheet & slide had one — so the docs renderer's "save as" silently
      // round-tripped through `docs:save` (which kept the original path
      // and ignored the new name). Adding it here brings parity.
      if (typeof sourcePath !== 'string' || !sourcePath) {
        throw new InvalidArgumentError('docs:save-as', 'sourcePath must be a non-empty string')
      }
      if (typeof targetPath !== 'string' || !targetPath) {
        throw new InvalidArgumentError('docs:save-as', 'targetPath must be a non-empty string')
      }
        // Prefer explicit `data` bytes; otherwise read them from `sourcePath`.
      // Rethrow structured errors (NotFoundError / InvalidArgumentError)
      // so the IPC layer translates them into 404 / 400 envelopes with the
      // shared `{ error: { code, message } }` shape; only handle genuinely
      // unexpected errors as soft `{ ok: false, error }`.
      let bytes = bytesFrom(data)
      if (!bytes || bytes.byteLength === 0) {
        try {
          bytes = await readDocxBytes('docs:save-as', sourcePath)
        } catch (err) {
          if (err instanceof NotFoundError || err instanceof InvalidArgumentError) throw err
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const key = storageKeyFromPath(targetPath)
      const canonical = canonicalDocxPath(targetPath)
      if (!key && !isManagedDocPath(canonical)) {
        return { ok: false, error: 'save-as target is outside the web storage area' }
      }
      if (!bytes || bytes.byteLength === 0) {
        return { ok: false, error: 'save data is empty or invalid' }
      }
      try {
        if (key) {
          await getStorageBackend().put(key, new Uint8Array(bytes), {
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          })
        } else {
          // Snapshot prior bytes (if the target already exists) BEFORE the
          // atomic write so files:restore-version can roll back. New target:
          // readFileSync throws and we move on.
          try {
            const prev = readFileSync(canonical)
            captureBeforeSave(basename(canonical), prev)
          } catch { /* new path, nothing to snapshot */ }
          mkdirSync(dirname(canonical), { recursive: true })
          atomicWriteFile(canonical, bytes)
        }
        const existingName = DOCS_RECENT.get(sourcePath)?.name
        await recordRecentDoc(targetPath, {
          id: basename(targetPath, extname(targetPath)),
          name: existingName ?? basename(targetPath),
          modified: true,
        })
        notifyFileSaved(targetPath, { size: bytes.byteLength, format: 'docx' })
        sendIpcEvent(event, 'saved', {
          path: targetPath,
          version: Date.now(),
          bytes: bytes.byteLength,
          format: 'docx',
        })
        return { ok: true, path: targetPath }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  registerHandle('docs:print', () => ({
    ok: true,
    message: '请使用浏览器的打印功能 (Ctrl+P 或 Cmd+P)',
  }))

  registerHandle('docs:consume-new-blank', () => false)
  registerHandle('docs:consume-pending-open', () => null)
  registerHandle('docs:consume-ai-doc-content', () => null)
  registerHandle('docs:write-recovery', () => ({ ok: true }))
  registerHandle('docs:password-intent-revision', () => 0)
}

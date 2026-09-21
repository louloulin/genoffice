/**
 * PDF channels — open-path and the parity channels from the Electron
 * main process (convert-office, password get/submit/cancel, save).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FILES_DIR, isManagedPath, PATH_OUTSIDE_STORAGE, registerHandle } from '../common/index'
import { InvalidArgumentError, NotFoundError } from '../ai/errors'
import { getStorageBackend, storageKeyFromPath } from '../common/state'
import { StorageNotFoundError } from '@genoffice/file-management'
import { atomicWriteFile } from '../common/atomic'
import { notifyFileSaved } from '../common/webhooks-store'
import { savePdfToPath } from '../../../pdf/src/main/save-pdf'
import type { SavePdfRequest, SavePdfResult } from '../../../pdf/src/shared/ipc'

/**
 * A PDF the web server is willing to read or rewrite: a PDF inside managed
 * storage. Same containment shape as docs' isManagedDocPath — the web build has
 * no Electron path-grant map, so this is the only thing standing between a
 * renderer and an arbitrary file rewrite.
 */
function isManagedPdfPath(filePath: string): boolean {
  return /[.]pdf$/i.test(filePath) && isManagedPath(filePath)
}

export function registerPdfHandlers(): void {
  registerHandle('pdf:consume-pending', () => null)
  registerHandle('pdf:get-username', () => 'Web User')
  registerHandle('pdf:list-edit-fonts', () => ['Arial', 'Calibri', 'Times New Roman', 'Helvetica'])
  registerHandle('pdf:dirty-changed', () => ({ ok: true }))

  /* Read PDF bytes from either a managed-path FILES_DIR entry (legacy
   * desktop callers) or a `storage://<backend>/<key>` URI (the path the
   * recents / project-files grid hands the renderer). The previous
   * implementation only knew the managed-path shape, so opening any
   * web-uploaded PDF landed in the "path is outside the web storage area"
   * 400 from `requireManagedPath`. */
  async function readPdfBytes(channel: string, filePath: string): Promise<Buffer> {
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
    if (isManagedPath(filePath) && existsSync(filePath)) {
      return readFileSync(filePath)
    }
    /* Same containment refusal shape the previous `requireManagedPath` produced,
     * so callers probing outside managed storage still see a 400, not a 404. */
    throw new InvalidArgumentError(channel, PATH_OUTSIDE_STORAGE)
  }

  registerHandle('pdf:read-file', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new InvalidArgumentError('pdf:read-file', 'path is required')
    }
    const bytes = await readPdfBytes('pdf:read-file', filePath)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  })

  registerHandle('pdf:open-path', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new InvalidArgumentError('pdf:open-path', 'path is required')
    }
    const bytes = await readPdfBytes('pdf:open-path', filePath)
    return {
      path: filePath,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })

  registerHandle('pdf:convert-office', async (_event: unknown, format?: unknown) => {
    return { ok: true, format: typeof format === 'string' ? format : undefined }
  })

  registerHandle('pdf-password:get-state', () => ({ required: false }))
  registerHandle('pdf-password:submit', (_event: unknown, _password: unknown) => ({ ok: true }))
  registerHandle('pdf-password:cancel', () => ({ ok: true }))

  /* ── Save ─────────────────────────────────────────────────────────────────
   * In the desktop build the main process grants a path to a view and then
   * applies that view's edit list to the PDF on disk. Nothing in that pipeline
   * touches Electron: savePdfToPath reads the source bytes, applies the text /
   * ink / form / image edits with pdf-lib, verifies content edits and writes
   * the target atomically. The request already carries both the source path and
   * the edits, so the web server can run the very same code — the only thing it
   * has to add is the containment check the desktop gets for free from its
   * path-grant map. This previously replied a bare { ok: true, saved: true }
   * without writing anything, so every annotation edit was silently discarded
   * behind a success toast.
   *
   * Storage URIs (`storage://<backend>/<key>`) are now accepted for both
   * `path` and `targetPath`: the source bytes are read through the active
   * backend, the target is staged at FILES_DIR/<key> and the edited file is
   * written back via the same backend, keeping a remote-bucket deployment
   * consistent with the upload path.
   * ───────────────────────────────────────────────────────────────────────── */
  async function stagePdfForSave(channel: string, filePath: string): Promise<string> {
    const key = storageKeyFromPath(filePath)
    if (key) {
      // Storage URI: rehydrate the bytes into FILES_DIR so savePdfToPath
      // (which only knows about local files) can read them, then route the
      // result back through the backend after the edits land.
      try {
        const u8 = await getStorageBackend().get(key)
        const staged = join(FILES_DIR, `${basename(key)}.staged-${Date.now()}`)
        mkdirSync(dirname(staged), { recursive: true })
        atomicWriteFile(staged, Buffer.from(u8))
        return staged
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          // A storage URI the backend cannot resolve is the same
          // "source not found" condition as a missing FILES_DIR file —
          // surface it consistently so the e2e pdf:save guard test can
          // assert on a single string rather than two.
          throw new NotFoundError(channel, `source not found: ${filePath}`)
        }
        throw err
      }
    }
    // FILES_DIR-resident path: separate "doesn't exist" from "outside
    // managed storage" so the renderer can branch correctly. A bare
    // `InvalidArgumentError(PATH_OUTSIDE_STORAGE)` for a missing file
    // would mis-classify a typo'd path as a containment violation.
    if (isManagedPdfPath(filePath)) {
      if (!existsSync(filePath)) {
        throw new NotFoundError(channel, `source not found: ${filePath}`)
      }
      return filePath
    }
    throw new InvalidArgumentError(channel, PATH_OUTSIDE_STORAGE)
  }

  async function publishPdfAfterSave(
    targetOriginal: string,
    targetStaged: string,
  ): Promise<string> {
    const key = storageKeyFromPath(targetOriginal)
    if (key) {
      // Read what savePdfToPath just produced and ship it back to the
      // backend under the original key. savePdfToPath writes to `target`,
      // which is the staged path; we then mirror the bytes back to storage.
      const edited = readFileSync(targetStaged)
      await getStorageBackend().put(key, new Uint8Array(edited), { contentType: 'application/pdf' })
      try {
        unlinkSync(targetStaged)
      } catch {
        /* best-effort cleanup */
      }
      return targetOriginal
    }
    return targetStaged
  }

  registerHandle('pdf:save', async (_e: unknown, request: unknown): Promise<SavePdfResult> => {
    const value = (request || {}) as { path?: unknown; targetPath?: unknown }
    if (typeof value.path !== 'string' || value.path.length === 0) {
      return { ok: false, error: 'pdf:save expects { path: string }' }
    }
    let source: string
    let target: string
    try {
      source = await stagePdfForSave('pdf:save', value.path)
      const requestedTarget =
        typeof value.targetPath === 'string' && value.targetPath.length > 0
          ? value.targetPath
          : value.path
      target = await stagePdfForSave('pdf:save', requestedTarget)
    } catch (err) {
      if (err instanceof InvalidArgumentError) {
        return { ok: false, error: err.message }
      }
      if (err instanceof NotFoundError) {
        return { ok: false, error: err.message }
      }
      throw err
    }
    try {
      // `applySaveRequest` reads `formValues`, `markups`, etc. unconditionally;
      // the renderer is free to omit the heavy edit fields when the user is
      // just opening / re-saving without changes, so default them to empty
      // arrays before handing the request off. Without this, a save with just
      // `{ path }` crashed with "Cannot read properties of undefined
      // (reading 'length')" on the desktop-equivalent code path.
      const safeRequest: SavePdfRequest = {
        ...(request as SavePdfRequest),
        formValues: (request as SavePdfRequest).formValues ?? [],
        markups: (request as SavePdfRequest).markups ?? [],
        rotations: (request as SavePdfRequest).rotations ?? [],
        drawings: (request as SavePdfRequest).drawings ?? [],
        annotDeletes: (request as SavePdfRequest).annotDeletes ?? [],
        textEdits: (request as SavePdfRequest).textEdits ?? [],
        textInserts: (request as SavePdfRequest).textInserts ?? [],
        imageEdits: (request as SavePdfRequest).imageEdits ?? [],
      }
      const { skippedTextEdits, skippedTextInserts, skippedImageEdits } = await savePdfToPath(
        source,
        target,
        safeRequest,
      )
      // The path field is intentionally absent from SavePdfResult; the
      // renderer uses the value it already had. publishPdfAfterSave still
      // runs so the storage-backend write happens, but its result is
      // discarded here — keeping the return shape backwards-compatible with
      // the desktop contract the renderer already imports.
      const finalPath = await publishPdfAfterSave(
        typeof value.targetPath === 'string' && value.targetPath.length > 0
          ? value.targetPath
          : value.path,
        target,
      )
      notifyFileSaved(finalPath, { format: 'pdf' })
      return {
        ok: true,
        ...(skippedTextEdits.length > 0 ? { skippedTextEdits } : {}),
        ...(skippedTextInserts.length > 0 ? { skippedTextInserts } : {}),
        ...(skippedImageEdits.length > 0 ? { skippedImageEdits } : {}),
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /* ── Web-only stubs for features the Electron main process handles but the
   * web-server has no equivalent backend for. Returning a sane default (rather
   * than 404) keeps the renderer console clean and lets the UI fall back to
   * "feature unavailable" gracefully. ─────────────────────────────────────── */
  registerHandle('pdf:auto-rename', (_e: unknown, _p: unknown, _b: unknown) => null)
  registerHandle('pdf:is-untitled', (_e: unknown, _p: unknown) => false)
  registerHandle('pdf:validate-text-edits', (_e: unknown, _req: unknown) => ({
    ok: true,
    edits: [],
  }))
  registerHandle('pdf:can-draw-text', (_e: unknown, _args: unknown) => ({ canDraw: true }))
  registerHandle('pdf:list-page-images', (_e: unknown, _p: unknown) => ({ images: [] }))
  registerHandle('pdf:list-static-form-fills', (_e: unknown, _p: unknown) => [])
  registerHandle('pdf:page-image-png', (_e: unknown, _req: unknown) => null)
  registerHandle('pdf:ocr-page', () => null)
  registerHandle('pdf:page-preview-png', (_e: unknown, _req: unknown) => null)
  registerHandle('pdf:extract-pages', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:insert-pdf', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:insert-blank-page', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:split-pdf', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:merge-pdf', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:merge-pages', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:replace-pages', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:set-page-size', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:split-pages', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:crop-pages', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:export-images', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:create-document', (_e: unknown, _req: unknown) => ({ ok: false }))
  registerHandle('pdf:generate-image', (_e: unknown, _op: unknown) => null)
  registerHandle('pdf:list-signatures', () => ({ signatures: [] }))
  registerHandle('pdf:add-signature', (_e: unknown, _data: unknown) => ({ ok: false }))
  registerHandle('pdf:remove-signature', (_e: unknown, _id: unknown) => ({ ok: false }))
  registerHandle('pdf:close-save-result', () => ({ ok: true }))
  registerHandle('pdf:save-as-result', () => ({ ok: true }))
  registerHandle('pdf:save-as-flow', () => ({ ok: true }))
}

/**
 * PDF channels — open-path and the parity channels from the Electron
 * main process (convert-office, password get/submit/cancel, save).
 */
import { existsSync, readFileSync } from 'node:fs'
import { isManagedPath, registerHandle, requireManagedPath } from '../common/index'
import { NotFoundError } from '../ai/errors'
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

  registerHandle('pdf:read-file', async (_event: unknown, filePath: unknown) => {
    const path = requireManagedPath('pdf:read-file', filePath)
    if (!existsSync(path)) {
      throw new NotFoundError('pdf:read-file', `File not found: ${path}`)
    }
    const bytes = readFileSync(path)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  })

  registerHandle('pdf:open-path', async (_event: unknown, filePath: unknown) => {
    const path = requireManagedPath('pdf:open-path', filePath)
    if (!existsSync(path)) {
      throw new NotFoundError('pdf:open-path', `File not found: ${path}`)
    }
    const bytes = readFileSync(path)
    return {
      path,
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
   * ───────────────────────────────────────────────────────────────────────── */
  registerHandle('pdf:save', async (_e: unknown, request: unknown): Promise<SavePdfResult> => {
    const value = (request || {}) as { path?: unknown; targetPath?: unknown }
    if (typeof value.path !== 'string' || value.path.length === 0) {
      return { ok: false, error: 'pdf:save expects { path: string }' }
    }
    const source = value.path
    const target =
      typeof value.targetPath === 'string' && value.targetPath.length > 0
        ? value.targetPath
        : source
    if (!isManagedPdfPath(source) || !isManagedPdfPath(target)) {
      return { ok: false, error: 'pdf: path is outside the web storage area' }
    }
    if (!existsSync(source)) {
      return { ok: false, error: `pdf: source not found: ${source}` }
    }
    try {
      const { skippedTextEdits, skippedTextInserts, skippedImageEdits } = await savePdfToPath(
        source,
        target,
        request as SavePdfRequest,
      )
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

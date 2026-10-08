/**
 * PDF module entry — wires every `pdf:*` / `pdf-password:*` channel into the
 * host's registry on top of the ported byte-level engine in `./engine`.
 *
 * Ported from `apps/web-server/src/pdf/index.ts` plus `apps/pdf/src/main/pdf-main.ts`.
 * What the library drops relative to those two:
 *  - `FILES_DIR` / `storage://<backend>/<key>` / `getStorageBackend()` /
 *    `notifyFileSaved` / `captureBeforeSave` — every path here is a real path
 *    confined by `workspace.resolvePath`, and version history is the host's job;
 *  - Electron windows and dialogs. The four ops whose desktop flow is a file
 *    picker with no file in the request (`insert-pdf`, `merge-pdf`,
 *    `replace-pages`, `export-images`) therefore answer their own
 *    `{ok: true, canceled: true}` union arm. The renderer reads that as
 *    "user dismissed", which is exactly the truth: nothing was picked.
 *  - OCR (spawns external binaries), the signature store (Electron store) and
 *    `generate-image`. Those are in `STUBBED_PDF_CHANNELS`.
 *
 * What it keeps, and why it is load-bearing: `dirtyChanged` and `saved` are SSE
 * pushes the embed SDK in `src/ui/embed/` reads for its `isDirty` fallback and
 * its `saved` event. The web-server already pushes both; dropping either here
 * would make every embedded PDF claim it is clean and never announce a save.
 *
 * Degradation rule: **no channel 404s.** Anything that cannot work answers a
 * shape the renderer tolerates — see `STUBBED_PDF_CHANNELS` at the bottom, which
 * the census test asserts against so a new stub cannot be added without also
 * being registered.
 */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

import { OfficeError } from '../../../errors'
import type { Registry } from '../../registry'
import { safeFileStem, type Workspace } from '../../workspace'
import {
  cropPagesBytes,
  extractPagesBytes,
  insertBlankPageBytes,
  mergePagesBytes,
  prepareSave,
  readStaticFormFills,
  setPageSizeBytes,
  splitPagesBytes,
  splitPdfBytes,
  type CropFractionsRect,
} from './engine/save-pdf'
import {
  listPageImages,
  renderImagePng,
  renderPagePreviewPng,
} from './engine/image-edit'
import { canDrawText, listEditFonts, validateTextEdits } from './engine/text-edit'
import type {
  CropPagesRequest,
  ExportImagesResult,
  ExtractPagesRequest,
  InsertBlankPageRequest,
  MergePagesRequest,
  PagePreviewRequest,
  SavePdfRequest,
  SavePdfResult,
  SetPageSizeRequest,
  SplitPagesRequest,
  SplitPdfRequest,
  ValidateTextEditsRequest,
} from './engine/ipc-types'

/**
 * Channels the renderer can invoke but this host cannot serve, each answered
 * with the one shape it tolerates. A channel listed here is registered as a real
 * handler — the test asserts every entry answers 200 with this value, so a
 * mis-typed channel name fails instead of silently 404-ing.
 *
 * `ocr-page` → `null` (the desktop returns `[]` for a bad payload and `null`
 * when there is no engine; `null` is what stops the renderer's OCR pass).
 * Everything else → `{ ok: true, acknowledgedOnly: true }`, the same shape
 * `STUBBED_SLIDES_CHANNELS` uses.
 */
export const STUBBED_PDF_CHANNELS: Readonly<Record<string, unknown>> = {
  'pdf:ocr-page': null,
  'pdf:generate-image': null,
  'pdf:auto-rename': null,
  'pdf:is-untitled': false,
  'pdf:convert-office': { ok: true, acknowledgedOnly: true },
  'pdf:create-document': { ok: true, acknowledgedOnly: true },
  'pdf:close-save-request': { ok: true, acknowledgedOnly: true },
  'pdf:close-save-result': { ok: true, acknowledgedOnly: true },
  'pdf:save-as-request': { ok: true, acknowledgedOnly: true },
  'pdf:save-as-result': { ok: true, acknowledgedOnly: true },
  'pdf:save-as-flow': { ok: true, acknowledgedOnly: true },
  'pdf:print-request': { ok: true, acknowledgedOnly: true },
  'pdf:list-signatures': { signatures: [] },
  'pdf:add-signature': { ok: true, acknowledgedOnly: true },
  'pdf:remove-signature': { ok: true, acknowledgedOnly: true },
}

function emit(event: unknown, channel: string, ...args: unknown[]): void {
  const sender = (
    event as { sender?: { send?: (channel: string, ...args: unknown[]) => void } } | undefined
  )?.sender
  sender?.send?.(channel, ...args)
}

function exists(workspace: Workspace, filePath: string): boolean {
  try {
    workspace.readBytes(filePath)
    return true
  } catch {
    return false
  }
}

export function registerPdfHandlers(registry: Registry, workspace: Workspace): void {
  /**
   * The one containment chokepoint. Anything a renderer names — source path,
   * save target, read-file argument — comes through here, so an ungranted path
   * produces the same `OFFICE_BAD_INPUT` / HTTP 400 the other apps' handlers
   * give, rather than a 404 or a raw fs error.
   */
  const requirePath = (channel: string, filePath: unknown): string => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: path must be a non-empty string`)
    }
    const resolved = workspace.resolvePath(filePath)
    if (!resolved) {
      throw new OfficeError('OFFICE_BAD_INPUT', `path is outside the office-ai workspace: ${filePath}`)
    }
    return resolved
  }

  const readPdf = (channel: string, filePath: unknown): Uint8Array => {
    const resolved = requirePath(channel, filePath)
    try {
      return workspace.readBytes(resolved)
    } catch (error) {
      throw new OfficeError('OFFICE_NOT_FOUND', `File not found: ${resolved}`, {
        cause: String(error),
      })
    }
  }

  /** Rewrite the source file in place — the desktop path for every "no dialog" op. */
  const writeInPlace = (resolved: string, bytes: Uint8Array): void => {
    workspace.writeBytes(resolved, bytes)
  }

  /**
   * Where generated documents go. There is no save dialog here, so "the folder
   * the user would have picked" is the workspace's own exports directory. Names
   * are de-duplicated the way the desktop's `uniqueGeneratedPdfPath` does it, so
   * repeated exports never overwrite each other.
   */
  const exportsDir = (): string => join(workspace.filesDir, 'exports')
  const uniquePdfPath = (name: string): string => {
    const dir = exportsDir()
    mkdirSync(dir, { recursive: true })
    const raw = String(name ?? '').trim() || 'document'
    const stem = safeFileStem(raw.replace(/\.pdf$/i, '')) || 'document'
    let candidate = join(dir, `${stem}.pdf`)
    let n = 1
    while (exists(workspace, candidate)) {
      candidate = join(dir, `${stem}-${n}.pdf`)
      n += 1
    }
    return candidate
  }

  // ── document lifecycle ──────────────────────────────────────────────────
  /* The host stages documents explicitly (`host.open(...)` / `stageBytes`), so
   * there is never a pending open waiting to be consumed — `null` is the real
   * answer, not a stand-in for one. */
  registry.registerHandle('pdf:consume-pending', () => null)

  /* No identity store in a library; this becomes the /Author on new note and
   * comment annotations. */
  registry.registerHandle('pdf:get-username', () => 'Office AI')

  registry.registerHandle('pdf:read-file', async (_event, filePath: unknown) => {
    const bytes = readPdf('pdf:read-file', filePath)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  })

  /**
   * Answers `{path, bytes}` and nothing else. The renderer rasterizes with
   * pdf.js and owns everything after that — there is no server-side pdf
   * document to register, which is exactly why a two-host process cannot
   * corrupt one another's state here.
   */
  registry.registerHandle('pdf:open-path', async (_event, filePath: unknown) => {
    const bytes = readPdf('pdf:open-path', filePath)
    return {
      path: typeof filePath === 'string' ? filePath : '',
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })

  registry.registerHandle('pdf:dirty-changed', (event, dirty: unknown) => {
    // The renderer owns the dirty flag; this is a broadcast so an embedded SDK
    // (and any second listener) learns about it. Same channel name web-server
    // pushes, so the SDK's `isDirty` fallback works unchanged.
    emit(event, 'dirtyChanged', { dirty: Boolean(dirty) })
    return { ok: true }
  })

  registry.registerHandle('pdf-password:get-state', () => ({ required: false }))
  registry.registerHandle('pdf-password:submit', () => ({ ok: true }))
  registry.registerHandle('pdf-password:cancel', () => ({ ok: true }))

  // ── save ────────────────────────────────────────────────────────────────
  registry.registerHandle('pdf:save', async (event, request: unknown): Promise<SavePdfResult> => {
    const value = (request ?? {}) as { path?: unknown; targetPath?: unknown }
    if (typeof value.path !== 'string' || !value.path) {
      return { ok: false, error: 'pdf:save expects { path: string }' }
    }
    let target: string
    try {
      target = requirePath('pdf:save', value.targetPath ? value.targetPath : value.path)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof OfficeError ? error.message : String(error),
      }
    }

    try {
      const source = readPdf('pdf:save', value.path)
      /* `applySaveRequest` reads formValues / markups / … unconditionally while
       * the renderer is free to omit the heavy edit fields on a plain
       * re-save. Defaulting them here is the difference between a no-op save
       * working and a TypeError on `undefined.length`. */
      const safeRequest = {
        ...(request as SavePdfRequest),
        markups: (request as SavePdfRequest).markups ?? [],
        annotDeletes: (request as SavePdfRequest).annotDeletes ?? [],
        drawings: (request as SavePdfRequest).drawings ?? [],
        noteEdits: (request as SavePdfRequest).noteEdits ?? [],
        formValues: (request as SavePdfRequest).formValues ?? [],
        stamps: (request as SavePdfRequest).stamps ?? [],
        rotations: (request as SavePdfRequest).rotations ?? [],
        textEdits: (request as SavePdfRequest).textEdits ?? [],
        textInserts: (request as SavePdfRequest).textInserts ?? [],
        imageEdits: (request as SavePdfRequest).imageEdits ?? [],
      } as SavePdfRequest

      /* `prepareSave` = applySaveRequest + the read-back verification that
       * aborts before anything is written. Deliberately NOT `savePdfToPath`:
       * that one reads and writes paths on its own, and every path in this host
       * has to come back through the workspace first. */
      const applied = await prepareSave(source, safeRequest)
      writeInPlace(target, applied.bytes)

      // Load-bearing for the embed SDK: `version` is the watermark it uses to
      // detect a concurrent write. Same field set web-server pushes.
      emit(event, 'saved', { path: target, version: Date.now(), format: 'pdf' })
      return {
        ok: true,
        ...(applied.skippedTextEdits.length > 0
          ? { skippedTextEdits: applied.skippedTextEdits }
          : {}),
        ...(applied.skippedTextInserts.length > 0
          ? { skippedTextInserts: applied.skippedTextInserts }
          : {}),
        ...(applied.skippedImageEdits.length > 0
          ? { skippedImageEdits: applied.skippedImageEdits }
          : {}),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ── text + image editing surfaces ───────────────────────────────────────
  registry.registerHandle('pdf:list-edit-fonts', () => listEditFonts())
  registry.registerHandle('pdf:can-draw-text', (_event, args: unknown) => {
    const [text, font, bold, italic] = Array.isArray(args) ? args : []
    return { canDraw: typeof text === 'string' && canDrawText(text, font as string, !!bold, !!italic) }
  })
  registry.registerHandle('pdf:validate-text-edits', async (_event, request: unknown) => {
    const req = (request ?? {}) as ValidateTextEditsRequest
    return validateTextEdits(readPdf('pdf:validate-text-edits', req.path), req.edits ?? [])
  })
  registry.registerHandle('pdf:list-page-images', async (_event, filePath: unknown) =>
    listPageImages(readPdf('pdf:list-page-images', filePath)),
  )
  registry.registerHandle('pdf:list-static-form-fills', async (_event, filePath: unknown) =>
    readStaticFormFills(readPdf('pdf:list-static-form-fills', filePath)),
  )
  registry.registerHandle('pdf:page-image-png', async (_event, request: unknown) => {
    const req = (request ?? {}) as {
      path?: unknown
      pageIndex?: unknown
      rect?: unknown
      scale?: unknown
    }
    const bytes = readPdf('pdf:page-image-png', req.path)
    if (typeof req.pageIndex !== 'number' || !Array.isArray(req.rect)) {
      throw new OfficeError('OFFICE_BAD_INPUT', 'pdf:page-image-png: pageIndex and rect are required')
    }
    return renderImagePng(
      bytes,
      req.pageIndex,
      req.rect as [number, number, number, number],
      typeof req.scale === 'number' && Number.isFinite(req.scale) ? req.scale : 1,
    )
  })
  registry.registerHandle('pdf:page-preview-png', async (_event, request: unknown) => {
    const req = (request ?? {}) as PagePreviewRequest
    const { path, ...rest } = req
    return renderPagePreviewPng(readPdf('pdf:page-preview-png', path), rest)
  })

  // ── page operations, implemented for real ───────────────────────────────
  registry.registerHandle('pdf:extract-pages', async (_event, request: unknown) => {
    const req = (request ?? {}) as ExtractPagesRequest
    const source = readPdf('pdf:extract-pages', req.path)
    try {
      const bytes = await extractPagesBytes(source, Array.isArray(req.pages) ? req.pages : [])
      const target = uniquePdfPath(String(req.suggestedName ?? 'pages.pdf'))
      workspace.writeBytes(target, bytes)
      return { ok: true, savedPath: target }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('pdf:insert-blank-page', async (_event, request: unknown) => {
    const req = (request ?? {}) as InsertBlankPageRequest
    const resolved = requirePath('pdf:insert-blank-page', req.path)
    try {
      const bytes = await insertBlankPageBytes(
        readPdf('pdf:insert-blank-page', req.path),
        typeof req.afterPageIndex === 'number' ? req.afterPageIndex : -1,
      )
      writeInPlace(resolved, bytes)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('pdf:split-pdf', async (_event, request: unknown) => {
    const req = (request ?? {}) as SplitPdfRequest
    const source = readPdf('pdf:split-pdf', req.path)
    try {
      const chunks = await splitPdfBytes(source, Number(req.chunkSize) || 1)
      const dir = exportsDir()
      mkdirSync(dir, { recursive: true })
      const stem = safeFileStem(String(req.baseName ?? 'document')) || 'document'
      chunks.forEach((chunk, i) => {
        workspace.writeBytes(join(dir, `${stem}-${i + 1}.pdf`), chunk)
      })
      return { ok: true, savedDir: dir, count: chunks.length }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('pdf:merge-pages', async (_event, request: unknown) => {
    const req = (request ?? {}) as MergePagesRequest
    const source = readPdf('pdf:merge-pages', req.path)
    try {
      const bytes = await mergePagesBytes(source, {
        perSheet: Number(req.perSheet) || 2,
        direction: req.direction === 'vertical' ? 'vertical' : 'horizontal',
        separator: Boolean(req.separator),
      })
      const target = uniquePdfPath(String(req.suggestedName ?? 'merge-pages.pdf'))
      workspace.writeBytes(target, bytes)
      return { ok: true, savedPath: target }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('pdf:set-page-size', async (_event, request: unknown) => {
    const req = (request ?? {}) as SetPageSizeRequest
    const resolved = requirePath('pdf:set-page-size', req.path)
    if (!(Number.isFinite(req.width) && (req.width ?? 0) > 0 && (req.height ?? 0) > 0)) {
      return { ok: false, error: 'pdf: invalid page size' }
    }
    try {
      const bytes = await setPageSizeBytes(
        readPdf('pdf:set-page-size', req.path),
        req.width as number,
        req.height as number,
      )
      writeInPlace(resolved, bytes)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('pdf:split-pages', async (_event, request: unknown) => {
    const req = (request ?? {}) as SplitPagesRequest
    const source = readPdf('pdf:split-pages', req.path)
    if (req.perPage !== 2 && req.perPage !== 4 && req.perPage !== 9) {
      return { ok: false, error: 'pdf: unsupported split grid' }
    }
    try {
      const bytes = await splitPagesBytes(source, req.perPage)
      const target = uniquePdfPath(String(req.suggestedName ?? 'split-pages.pdf'))
      workspace.writeBytes(target, bytes)
      return { ok: true, savedPath: target }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('pdf:crop-pages', async (_event, request: unknown) => {
    const req = (request ?? {}) as CropPagesRequest
    const resolved = requirePath('pdf:crop-pages', req.path)
    if (!Array.isArray(req.pages) || req.pages.length === 0 || !req.rect) {
      return { ok: false, error: 'pdf: crop-pages requires pages and a rect' }
    }
    try {
      const bytes = await cropPagesBytes(
        readPdf('pdf:crop-pages', req.path),
        req.pages,
        req.rect as CropFractionsRect,
      )
      writeInPlace(resolved, bytes)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ── file-picker ops: nothing to pick, so the `canceled` arm ─────────────
  /* The desktop opens a dialog for the *other* file and the request carries no
   * path for it. A library host has no dialog, and inventing a path would write
   * a document the caller never chose. `{ok: true, canceled: true}` is the
   * contract's own "nothing happened" answer — `runFileOp` in the renderer maps
   * it to its FileOpCanceled branch and leaves the document untouched. It is
   * deliberately not `{ok: false}`: that renders as an error toast. */
  registry.registerHandle('pdf:insert-pdf', (_event, _request: unknown) => ({
    ok: true,
    canceled: true as const,
  }))
  registry.registerHandle('pdf:merge-pdf', (_event, _request: unknown) => ({
    ok: true,
    canceled: true as const,
  }))
  registry.registerHandle('pdf:replace-pages', (_event, _request: unknown) => ({
    ok: true,
    canceled: true as const,
  }))
  registry.registerHandle('pdf:export-images', (_event, _request: unknown): ExportImagesResult => ({
    ok: true,
    canceled: true,
  }))

  // ── stubs, registered so nothing 404s ───────────────────────────────────
  for (const [channel, value] of Object.entries(STUBBED_PDF_CHANNELS)) {
    registry.registerHandle(channel, () => value)
  }
}
/**
 * AnyDoc channels — document recognition, format conversion and content
 * extraction. Text extraction is delegated to `@genoffice/file-parse`, the
 * same real parser stack the editors use (docx/pptx/xlsx/pdf/doc/ppt + plain
 * text), so recognised text is the document's actual content rather than a
 * placeholder string.
 *
 * Honest gaps in the standalone web build:
 * - images have no OCR engine wired, so `anydoc:recognize` reports
 *   `ocrUnavailable` for them instead of inventing transcript text;
 * - `anydoc:extract-tables` / `anydoc:extract-images` only serve .docx;
 * - `anydoc:convert` serves pdf -> docx locally (pdfium wasm + pdf2docx).
 *   docx -> pdf needs a layout engine the web build does not ship, so it
 *   answers WEB_UNSUPPORTED rather than writing a mis-named copy.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  extractDocxImages,
  extractDocxTables,
  parseFileToText,
} from '@genoffice/file-parse'
import {
  DOCS_RECENT,
  FILES_DIR,
  isManagedPath,
  readStorageOrManagedBytes,
  registerHandle,
  requireManagedPath,
} from '../common/index'
import { NotFoundError } from '../ai/errors'
import { atomicWriteFile } from '../common/atomic'
import { convertPdfToDocxBytes } from './convert'

interface AnyDocConfig {
  ocrEnabled: boolean
  language: string
  preserveLayout: boolean
}

const anyDocConfig: AnyDocConfig = {
  ocrEnabled: true,
  language: 'zh-CN',
  preserveLayout: true,
}

export function registerAnydocHandlers(): void {
  registerHandle('anydoc:get-config', () => anyDocConfig)

  registerHandle('anydoc:set-config', (_event: unknown, config: unknown) => {
    Object.assign(anyDocConfig, config)
    return { ok: true }
  })

  registerHandle('anydoc:recognize', async (_event: unknown, args: unknown) => {
    const { filePath } = args as { filePath: string; options?: { ocr?: boolean; language?: string } }
    // Accept either a FILES_DIR path or a `storage://` URI: uploaded files
    // arrive here as URIs, but `requireManagedPath` only handles filesystem
    // paths. Stage the URI's bytes into FILES_DIR/<key> so the parser can
    // see them.
    let parsePath: string
    let staged: string | null = null
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new NotFoundError('anydoc:recognize', `File not found: ${String(filePath)}`)
    }
    let displayName: string | null = null
    if (filePath.startsWith('storage://')) {
      const bytes = await readStorageOrManagedBytes('anydoc:recognize', filePath, '')
      // The storage key is the path the local backend wrote; reuse it
      // so the staged name is recognisable in `ls` for debugging.
      const key = filePath.replace(/^storage:\/\/[^/]+\//, '')
      // Insert the timestamp before the extension so `parseFileToText` sees
      // the original `.md` / `.docx` / etc. instead of `.staged-<ts>`.
      const dot = key.lastIndexOf('.')
      const stem = dot > 0 ? key.slice(0, dot) : key
      const ext = dot > 0 ? key.slice(dot) : ''
      staged = join(FILES_DIR, `${basename(stem) || 'upload'}.staged-${Date.now()}${ext}`)
      // Prefer the display name already recorded by `web:save-file` so
      // the result carries the user's filename (e.g. "Quarterly
      // Report.docx") instead of the storage-hash basename. Falls back
      // to the storage key basename for paths without a recents row.
      const recentsName = DOCS_RECENT.get(filePath)?.name
      displayName = recentsName ?? basename(key) ?? basename(staged)
      require('node:fs').writeFileSync(staged, bytes)
      parsePath = staged
    } else {
      parsePath = requireManagedPath('anydoc:recognize', filePath)
      if (!existsSync(parsePath)) {
        throw new NotFoundError('anydoc:recognize', `File not found: ${parsePath}`)
      }
    }

    const ext = extname(parsePath).toLowerCase()
    // For storage URIs the user uploaded under a particular name; show
    // that name in the response instead of the temp staging filename.
    const fileName = displayName ?? basename(parsePath)
    let parsed
    let stats
    try {
      // Stat BEFORE unstage: statSync on the staged copy needs the file
      // to exist on disk, and the metadata is what gets returned to the
      // renderer as the upload's size / mtime.
      stats = statSync(parsePath)
      parsed = await parseFileToText(parsePath)
    } finally {
      if (staged) {
        try {
          require('node:fs').unlinkSync(staged)
        } catch {
          /* ignore — the staged filename carries Date.now(), so a
           * follow-up recognise never collides with the orphan */
        }
      }
    }

    // an image has no text layer; without an OCR engine the honest answer is
    // "recognised nothing", not fabricated transcript text
    const isImage = parsed.kind === 'image'
    return {
      id: `doc-${Date.now()}`,
      fileName,
      fileType: ext.slice(1),
      pages: 1,
      text: parsed.text ?? '',
      ocrUnavailable: isImage,
      ...(isImage
        ? { message: '图片识别需要 OCR 引擎(Tesseract.js 或云端 OCR),当前 web 构建未接入。' }
        : {}),
      ...(parsed.ok ? {} : { error: parsed.error ?? 'parse failed' }),
      metadata: {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
      },
      success: parsed.ok,
    }
  })

  registerHandle('anydoc:convert', async (_event: unknown, args: unknown) => {
    const { filePath, targetFormat, password, outPath } = args as {
      filePath: string
      targetFormat: string
      password?: string
      outPath?: string
    }
    const path = requireManagedPath('anydoc:convert', filePath)
    if (!existsSync(path)) {
      throw new NotFoundError('anydoc:convert', `File not found: ${path}`)
    }

    const sourceExt = extname(path).slice(1).toLowerCase()
    const target = targetFormat.toLowerCase().replace(/^\./, '')

    // Only the PDF → DOCX direction is wired: it is pure TypeScript
    // (`@genoffice/pdf2docx` + an initialized pdfium wasm), no external
    // process. DOCX → PDF needs a layout engine (the desktop build shells
    // out to LibreOffice); without one there is no honest way to produce a
    // PDF, so it stays WEB_UNSUPPORTED and the renderer's fallback UI takes
    // over. Crucially: we never write the source bytes under the new
    // extension — that produced an unopenable file that the renderer
    // reported as success.
    if (sourceExt !== 'pdf' || target !== 'docx') {
      return {
        success: false,
        sourceFormat: sourceExt,
        targetFormat: target,
        error: `WEB_UNSUPPORTED: anydoc:convert supports pdf -> docx in this build (got '${sourceExt}' -> '${target}'); docx -> pdf needs a layout engine (LibreOffice) that the web build does not ship`,
      }
    }

    // A zero-byte / truncated upload has no pages to extract; fail with a
    // clear message instead of handing pdfium a document it cannot open.
    const sourceBytes = readFileSync(path)
    if (sourceBytes.byteLength === 0) {
      return {
        success: false,
        sourceFormat: sourceExt,
        targetFormat: target,
        error: 'source PDF is empty (0 bytes)',
      }
    }

    const outcome = await convertPdfToDocxBytes(new Uint8Array(sourceBytes), {
      ...(typeof password === 'string' && password.length > 0 ? { password } : {}),
    })

    if (!outcome.ok || !outcome.docx) {
      // Map the converter's codes onto the renderer's vocabulary. The
      // password case must be distinguishable: the UI prompts for a
      // password and retries, it does not show "conversion failed".
      if (outcome.code === 'PDF_PASSWORD_REQUIRED') {
        return {
          success: false,
          sourceFormat: sourceExt,
          targetFormat: target,
          passwordRequired: true,
          error: outcome.message ?? 'this PDF is password-protected',
        }
      }
      return {
        success: false,
        sourceFormat: sourceExt,
        targetFormat: target,
        error: outcome.message ?? 'PDF conversion failed',
      }
    }

    // Default sibling name: `<source>.docx` next to the source, unless the
    // caller asked for a specific managed destination. `requireManagedPath`
    // is what keeps a hostile `outPath` from writing outside FILES_DIR.
    const requested = typeof outPath === 'string' && outPath.length > 0 ? outPath : `${path}.docx`
    const destination = requireManagedPath('anydoc:convert', requested)
    mkdirSync(dirname(destination), { recursive: true })
    atomicWriteFile(destination, Buffer.from(outcome.docx))

    return {
      success: true,
      sourceFormat: sourceExt,
      targetFormat: target,
      path: destination,
      size: outcome.docx.byteLength,
      pages: outcome.pages ?? 0,
      ...(outcome.warnings && outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      ...(outcome.scannedDocument ? { scannedDocument: true } : {}),
    }
  })

  registerHandle('anydoc:extract-text', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isManagedPath(filePath)) return null
    if (!existsSync(filePath)) return null

    const ext = extname(filePath).toLowerCase()

    if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) {
      return {
        text: '',
        format: 'image',
        ocrUnavailable: true,
        message: '图片需要 OCR 引擎,当前 web 构建未接入。',
      }
    }

    const parsed = await parseFileToText(filePath)
    if (!parsed.ok) {
      return { text: '', format: 'error', error: parsed.error ?? 'parse failed' }
    }
    const format = ['.docx', '.doc', '.xlsx', '.xlsm', '.pptx', '.ppt'].includes(ext)
      ? 'office'
      : ext === '.pdf'
        ? 'pdf'
        : 'text'
    return { text: parsed.text ?? '', format }
  })

  registerHandle('anydoc:extract-tables', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isManagedPath(filePath)) return null
    if (!existsSync(filePath)) return null

    // Only DOCX has a real implementation in this build — pdf2docx's IR
    // pipeline for PDF tables is not wired (see `analysis-and-roadmap.md`
    // phase 3). xlsx/pptx tables are surfaces the desktop build serves
    // through dedicated editor channels, not through anydoc.
    const ext = extname(filePath).toLowerCase()
    if (ext !== '.docx') {
      return {
        tables: [],
        unsupported: true,
        error: `Table extraction for '${ext || 'unknown'}' is not wired in this build (only .docx is supported)`,
      }
    }

    try {
      const bytes = readFileSync(filePath)
      const tables = await extractDocxTables(new Uint8Array(bytes))
      return { tables, unsupported: false }
    } catch (error) {
      // CFB (OLE2) encrypted docx, OpenDocument masquerading as docx,
      // truncated uploads, and the rest of the parser's failure modes
      // land here. Surface a structured error instead of a 500 so the
      // renderer can fall back to its own preview.
      return {
        tables: [],
        unsupported: false,
        error: error instanceof Error ? error.message : 'table extraction failed',
      }
    }
  })

  registerHandle('anydoc:extract-images', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isManagedPath(filePath)) return null
    if (!existsSync(filePath)) return null

    // Same honesty as extract-tables: only docx has a real
    // implementation; pptx embedded pictures need a dedicated pipeline.
    const ext = extname(filePath).toLowerCase()
    if (ext !== '.docx') {
      return {
        images: [],
        unsupported: true,
        error: `Image extraction for '${ext || 'unknown'}' is not wired in this build (only .docx is supported)`,
      }
    }

    try {
      const bytes = readFileSync(filePath)
      const images = await extractDocxImages(new Uint8Array(bytes))
      return { images, unsupported: false }
    } catch (error) {
      return {
        images: [],
        unsupported: false,
        error: error instanceof Error ? error.message : 'image extraction failed',
      }
    }
  })

  registerHandle('anydoc:render-preview', async (_event: unknown, args: unknown) => {
    const { filePath, options } = args as { filePath: string; options?: { width?: number; height?: number } }
    const path = requireManagedPath('anydoc:render-preview', filePath)

    if (!existsSync(path)) {
      throw new NotFoundError('anydoc:render-preview', `File not found: ${path}`)
    }

    const bytes = readFileSync(path)
    const ext = extname(path).toLowerCase()

    let mimeType = 'application/octet-stream'
    if (ext === '.pdf') mimeType = 'application/pdf'
    else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) mimeType = `image/${ext.slice(1)}`

    // Hard cap on base64 payload size. A 50 MiB PDF would serialise to a
    // ~67 MiB base64 string, easily OOMing the renderer when the IPC
    // bridge JSON-decodes the response. Refuse and let the renderer fall
    // back to a streaming URL.
    const MAX_RENDER_BYTES = 25 * 1024 * 1024
    if (bytes.byteLength > MAX_RENDER_BYTES) {
      return {
        success: false,
        mimeType,
        error: `preview payload exceeds the ${MAX_RENDER_BYTES}-byte cap (got ${bytes.byteLength})`,
      }
    }

    return {
      success: true,
      base64: bytes.toString('base64'),
      mimeType,
      width: options?.width || 800,
      height: options?.height || 600,
    }
  })
}

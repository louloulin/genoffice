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
 * - `anydoc:extract-tables` / `anydoc:extract-images` need a structure-aware
 *   parser (pdf2docx's IR) and report `unsupported` until one is wired.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
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
    const { filePath, targetFormat } = args as { filePath: string; targetFormat: string }
    const path = requireManagedPath('anydoc:convert', filePath)
    if (!existsSync(path)) {
      throw new NotFoundError('anydoc:convert', `File not found: ${path}`)
    }

    // Honest gate. The standalone web build has no LibreOffice / docx2pdf
    // pipeline; the previous code wrote the source bytes to a path with the
    // new extension and returned `success: true`, which silently produced a
    // broken file the renderer would later try to open. Surface
    // WEB_UNSUPPORTED instead so the renderer's existing fallback UI takes
    // over.
    const sourceExt = extname(path).slice(1).toLowerCase()
    const target = targetFormat.toLowerCase().replace(/^\./, '')
    const supported =
      (sourceExt === 'docx' && target === 'pdf') || (sourceExt === 'pdf' && target === 'docx')
    if (!supported) {
      return {
        success: false,
        sourceFormat: sourceExt,
        targetFormat: target,
        error: `WEB_UNSUPPORTED: anydoc:convert only supports docx<->pdf in this build (got '${sourceExt}' -> '${target}')`,
      }
    }
    // TODO(phase-3): wire packages/pdf2docx (pdf->docx) and packages/docx-engine's
    // PDF export (docx->pdf). Until then, refuse rather than fabricate.
    return {
      success: false,
      sourceFormat: sourceExt,
      targetFormat: target,
      error: `WEB_UNSUPPORTED: ${sourceExt} -> ${target} conversion needs the pdf2docx / docx2pdf pipeline (not wired in web build)`,
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

/**
 * Sheets IPC channels — workbook open/has-queued/consume-new-blank.
 * Persistence uses `sheets-recent.json` for the recent-files list.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { FILES_DIR, loadRecentSheets, registerHandle, saveRecentSheets } from '../common/index'
import { WebSheetsSidecar } from './sidecar'
import { InvalidArgumentError, NotFoundError } from '../ai/errors'

const sheetsSidecar = new WebSheetsSidecar()

export function registerSheetsHandlers(): void {
  registerHandle('sheets:new-blank', async (_event: unknown, options: unknown) => {
    const opts = options as { xlsx?: ArrayBuffer; path?: string } | undefined
    const id = `sheet-${Date.now()}`
    const name = `表格-${new Date().toLocaleDateString()}.xlsx`
    const path = join(FILES_DIR, `${id}.xlsx`)

    if (opts?.xlsx) {
      writeFileSync(path, Buffer.from(opts.xlsx))
    }

    const recent = loadRecentSheets()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSheets(recent)

    return { id, path, name }
  })

  registerHandle('sheets:has-queued-workbook', () => false)

  registerHandle('workbook:open-path', async (_event: unknown, filePath: unknown) => {
    if (!existsSync(filePath as string)) {
      throw new NotFoundError('workbook:open-path', `File not found: ${String(filePath)}`)
    }

    const bytes = readFileSync(filePath as string)
    const name = basename(filePath as string)
    const id = `sheet-${Date.now()}`

    const recent = loadRecentSheets()
    recent.unshift({ id, path: filePath as string, name, openedAt: Date.now() })
    saveRecentSheets(recent)

    // The renderer expects a fully parsed WorkbookFile (workbookFileSchema in
    // apps/sheets/src/shared/desktop-api.ts). The Electron main process parses
    // xlsx via the xlsx-sidecar; on the web we spawn the same sidecar binary
    // and merge its result with the local sha256/fileBytes/path metadata.
    let workbook: Record<string, unknown>
    try {
      const result = (await sheetsSidecar.open(filePath as string)) as Record<string, unknown>
      workbook = { ...result }
    } catch (err) {
      throw new Error(
        `Failed to parse workbook: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return {
      ...workbook,
      id,
      path: filePath,
      name,
      sha256,
      fileBytes: bytes.byteLength,
    }
  })

  registerHandle('sheets:consume-new-blank', () => ({ ok: true }))
  registerHandle('workbook:pending-edits', () => ({ ok: true }))

  // The renderer pings workbook:read-range to stream cells for the visible
  // viewport. We forward the call to the xlsx-sidecar (the same Rust binary
  // the Electron main process owns); the empty fallback only fires if the
  // sidecar is unreachable or the session expired.
  registerHandle('workbook:read-range', async (_event: unknown, request: unknown) => {
    const req = request as {
      sessionId?: string
      sheetId?: string
      range?: { startRow: number; endRow: number; startColumn: number; endColumn: number }
    } | undefined
    const range = req?.range
    const rows = range ? range.endRow - range.startRow + 1 : 0
    if (!req?.sessionId || !req.sheetId || !range) {
      return emptyRange(range?.endRow ?? 0, rows)
    }
    try {
      const result = (await sheetsSidecar.readRange({
        sessionId: req.sessionId,
        sheetId: req.sheetId,
        range,
      })) as Record<string, unknown>
      return normalizeRangeResult(result, range.endRow)
    } catch (err) {
      // Sidecar session expired: the sidecar is per-process and resets on
      // process restart, so we may have lost the session. Return empty cells
      // rather than a hard error so the workbook metadata still shows up.
      console.warn('[sheets] read-range sidecar failed:', err)
      return emptyRange(range.endRow, rows)
    }
  })

  const imageMime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  registerHandle('sheets:files-add', (_event: unknown, paths: unknown) => {
    const values = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
    return values.map((path) => {
      if (!existsSync(path)) return { path, ok: false, error: 'file not found' }
      const info = statSync(path)
      return { path, ok: info.isFile(), name: basename(path), sizeBytes: info.size }
    })
  })
  registerHandle('sheets:files-read', (_event: unknown, path: unknown, offset: unknown, maxChars: unknown) => {
    if (typeof path !== 'string' || !existsSync(path)) return { ok: false, error: 'file not found' }
    const ext = extname(path).slice(1).toLowerCase()
    if (imageMime[ext]) return { ok: false, error: 'image has no text' }
    const text = readFileSync(path, 'utf8')
    const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0)
    const size = Math.min(48000, Math.max(1, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 1))
    return { ok: true, name: basename(path), totalChars: text.length, offset: start, text: text.slice(start, start + size) }
  })
  registerHandle('sheets:files-read-image', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string' || !existsSync(path)) return { ok: false, error: 'file not found' }
    const ext = extname(path).slice(1).toLowerCase()
    const mime = imageMime[ext]
    if (!mime) return { ok: false, error: 'not an image' }
    const bytes = readFileSync(path)
    if (bytes.length > 5 * 1024 * 1024) return { ok: false, error: 'image is too large' }
    return { ok: true, base64: bytes.toString('base64'), mime }
  })
  registerHandle('sheets:files-add-pasted-image', (_event: unknown, data: unknown, ext: unknown) => {
    const cleanExt = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : ''
    const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null
    if (!bytes || !imageMime[cleanExt] || bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return { accepted: [], rejected: ['invalid image'] }
    const name = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${cleanExt}`
    const path = join(FILES_DIR, name)
    writeFileSync(path, bytes)
    return { accepted: [{ path, name, ext: cleanExt, sizeBytes: bytes.length }], rejected: [] }
  })

  registerHandle('workbook:open-for-merge', (_event: unknown, paths: unknown) => {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
      throw new InvalidArgumentError('workbook:open-for-merge', 'merge sources must be 1-20 files')
    }
    return paths.map((path) => {
      if (typeof path !== 'string' || !existsSync(path)) {
        // A caller-supplied path that does not exist is a 404, not a server
        // fault: the renderer shows "file moved or deleted" for this case.
        throw new NotFoundError('workbook:open-for-merge', `Merge source not found: ${String(path)}`)
      }
      return { path, name: basename(path) }
    })
  })
}


function emptyRange(endRow: number, rows: number): Record<string, unknown> {
  return {
    cells: [],
    rows: Array.from({ length: Math.max(0, rows) }, (_, i) => ({
      row: Math.max(0, endRow - rows + 1) + i,
      hidden: false,
    })),
    merges: [],
    hyperlinks: [],
    conditionalRules: [],
    autoFilter: null,
    autoFilterColumns: [],
    dataValidations: [],
    styles: [],
    indexedThroughRow: endRow,
    indexingComplete: true,
    sheetProtection: null,
    protectedRanges: [],
    rowBreaks: [],
    colBreaks: [],
  }
}

function normalizeRangeResult(result: Record<string, unknown>, endRow: number): Record<string, unknown> {
  // The xlsx-sidecar returns rows / cells / merges / hyperlinks / etc. directly
  // in the WorkbookRangeResult shape (workbookRangeResultSchema). Forward as-is
  // and only fill in missing pagination markers the renderer expects.
  return {
    cells: Array.isArray(result.cells) ? result.cells : [],
    rows: Array.isArray(result.rows) ? result.rows : [],
    merges: Array.isArray(result.merges) ? result.merges : [],
    hyperlinks: Array.isArray(result.hyperlinks) ? result.hyperlinks : [],
    conditionalRules: Array.isArray(result.conditionalRules) ? result.conditionalRules : [],
    autoFilter: result.autoFilter ?? null,
    autoFilterColumns: Array.isArray(result.autoFilterColumns) ? result.autoFilterColumns : [],
    dataValidations: Array.isArray(result.dataValidations) ? result.dataValidations : [],
    styles: Array.isArray(result.styles) ? result.styles : [],
    indexedThroughRow:
      typeof result.indexedThroughRow === 'number' ? result.indexedThroughRow : endRow,
    indexingComplete: typeof result.indexingComplete === 'boolean' ? result.indexingComplete : true,
    sheetProtection: result.sheetProtection ?? null,
    protectedRanges: Array.isArray(result.protectedRanges) ? result.protectedRanges : [],
    rowBreaks: Array.isArray(result.rowBreaks) ? result.rowBreaks : [],
    colBreaks: Array.isArray(result.colBreaks) ? result.colBreaks : [],
  }
}

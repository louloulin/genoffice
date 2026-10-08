/**
 * Sheets (xlsx) handlers for the office-ai UI host.
 *
 * The sheets renderer is the one format that does NOT parse in the browser: it
 * mounts Univer, and Univer is fed a `WorkbookFile` metadata shell plus cell
 * values pulled per viewport range. So this module owns the whole read path:
 *
 *   open-path ─ readBasicWorkbook(buffer) ─► indexed cell map
 *                        │
 *                        ├─ read-range ──► WorkbookRangeResult (cells stream per viewport)
 *                        └─ save ──► toGatewaySaveFields ─► planCellEditsToXlsx
 *                                   ─► assembleWithJsZip ─► atomic workspace write
 *
 * The gateway works in-process (no Rust xlsx-sidecar), so a save is a full
 * package rewrite: it is slower than the desktop streaming path but
 * byte-faithful for everything the planner understands.
 *
 * Wire-shape note: the renderer validates these payloads with its own
 * hand-written parsers (`apps/sheets/src/shared/sheets-api-factory.ts`), not
 * with the zod schemas in `shared/desktop-api.ts` — the zod side is the main
 * process's. Both are satisfied by emitting the full default-filled shape, so
 * a missing optional-looking field never becomes a `null` the renderer throws
 * on.
 */
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'

import {
  assembleWithJsZip,
  createBufferEntrySource,
  planCellEditsToXlsx,
  readBasicWorkbook,
} from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import type { ImportedXlsx } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { parseAddress } from '@genoffice/xlsx-gateway/domain/cell-address'
import {
  blankXlsxBuffer,
  decodeCsvBuffer,
  sheetCsvToXlsxBuffer,
} from '@genoffice/xlsx-gateway/gateway/csv-import'
import type { CellState, WorksheetState } from '@genoffice/xlsx-gateway/domain/workbook.types'

import { OfficeError } from '../../errors'
import type { Registry } from '../registry'
import type { Workspace } from '../workspace'
import { toGatewaySaveFields, type RendererCellEdit, type RendererSaveRequest } from './sheets-save-map'

/** Mirrors MAX_RANGE_CELLS in apps/sheets/src/shared/desktop-api.ts. */
const MAX_RANGE_CELLS = 100_000
/** A chunked edit transfer is bounded so one malformed renderer cannot OOM the host. */
const MAX_TRANSFER_EDITS = 10_000_000
/** Opened workbooks are LRU-capped: every save re-opens, so the map would otherwise grow per save. */
const MAX_SESSIONS = 32

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

/** One open workbook: the parsed snapshot plus the bytes every save patches from. */
export interface SheetSession {
  sessionId: string
  /** Where the workbook currently lives on disk (save target). */
  path: string
  name: string
  /** Bytes as of the last open/save — the patch base for the next save. */
  source: Buffer
  /** sheetId (Univer) → file sheet name. */
  sheetNames: Map<string, string>
  /** file sheet name → indexed worksheet. */
  sheets: Map<string, IndexedSheet>
  /** Set when the workbook was opened from CSV; saving writes xlsx beside it. */
  csvPath: string | null
  /** Package entry count of `source` (the renderer's `entryCount`). */
  entryCount: number
  touchedAt: number
}

interface IndexedSheet {
  /** Renderer's sheet id (the gateway's own sheet id round-trips unchanged). */
  id: string
  name: string
  rowCount: number
  columnCount: number
  /** row (0-based) → column-sorted cells on that row. */
  byRow: Map<number, { column: number; cell: CellState }[]>
  merges: readonly unknown[]
}

export interface SheetsHandlerState {
  sessions: Map<string, SheetSession>
  /** transferId → chunk payloads staged by save-edits-begin/chunk. */
  transfers: Map<string, string[]>
  /** Paths queued by sheets:new-blank for the renderer's consume handshake. */
  newBlank: string[]
}

export function createSheetsState(): SheetsHandlerState {
  return { sessions: new Map(), transfers: new Map(), newBlank: [] }
}

export function registerSheetsHandlers(
  registry: Registry,
  workspace: Workspace,
  state: SheetsHandlerState,
): SheetsHandlerState {
  const requirePath = (filePath: unknown): string => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new OfficeError('OFFICE_BAD_INPUT', 'workbook path must be a non-empty string')
    }
    const resolved = workspace.resolvePath(filePath)
    if (!resolved) {
      throw new OfficeError('OFFICE_BAD_INPUT', `path is outside the office-ai workspace: ${filePath}`)
    }
    return resolved
  }

  const openWorkbook = async (filePath: string): Promise<SheetSession> => {
    const path = requirePath(filePath)
    let source: Buffer
    let csvPath: string | null = null
    try {
      source = Buffer.from(workspace.readBytes(path))
    } catch (error) {
      throw new OfficeError('OFFICE_NOT_FOUND', `workbook not found: ${path}`, { cause: String(error) })
    }
    const ext = extname(path).slice(1).toLowerCase()
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      // CSV has no package to read: materialize a real xlsx so every later
      // save/merge/recalc path is the same code as a native workbook.
      source = await sheetCsvToXlsxBuffer(decodeCsvBuffer(source), defaultSheetName(basename(path)))
      csvPath = path
    } else if (ext === 'xls') {
      throw new OfficeError('OFFICE_UNSUPPORTED', 'legacy .xls workbooks are not supported; save as .xlsx first')
    }
    return buildSession(path, basename(path), source, csvPath)
  }

  const buildSession = async (
    path: string,
    name: string,
    source: Buffer,
    csvPath: string | null,
  ): Promise<SheetSession> => {
    const imported = await indexImported(source)
    const entrySource = await createBufferEntrySource(source)
    const session: SheetSession = {
      sessionId: randomUUID(),
      path,
      name,
      source,
      sheetNames: new Map(Object.entries(imported.sheetNamesById)),
      sheets: imported.sheets,
      csvPath,
      entryCount: (await entrySource.paths()).length,
      touchedAt: Date.now(),
    }
    state.sessions.set(session.sessionId, session)
    evictSessions(state)
    return session
  }

  const requireSession = (sessionId: unknown): SheetSession => {
    if (typeof sessionId !== 'string') {
      throw new OfficeError('OFFICE_BAD_INPUT', 'sessionId must be a string')
    }
    const session = state.sessions.get(sessionId)
    if (!session) throw new OfficeError('OFFICE_NOT_FOUND', `no open workbook for session ${sessionId}`)
    session.touchedAt = Date.now()
    return session
  }

  // ----- open -----------------------------------------------------------------

  registry.registerHandle('workbook:open-path', async (_event, filePath: unknown) => {
    const session = await openWorkbook(typeof filePath === 'string' ? filePath : '')
    return workbookFileOf(session)
  })

  registry.registerHandle('workbook:open-for-merge', async (_event, paths: unknown) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    return Promise.all(list.map((filePath) => openWorkbook(filePath).then(workbookFileOf)))
  })

  registry.registerHandle('workbook:select', () => null)
  registry.registerHandle('workbook:select-for-merge', () => null)
  registry.registerHandle('workbook:auto-rename', () => null)
  registry.registerHandle('workbook:renamed', () => ({ ok: true }))

  registry.registerHandle('sheets:has-queued-workbook', () => state.newBlank.length > 0)
  registry.registerHandle('sheets:consume-new-blank', () => state.newBlank.shift() !== undefined)
  registry.registerHandle('sheets:new-blank', async (_event, options: unknown) => {
    const opts = (options ?? {}) as { xlsx?: Uint8Array; path?: string }
    let source: Buffer
    let path: string
    if (opts.xlsx && opts.xlsx.byteLength > 0) {
      source = Buffer.from(opts.xlsx)
      path = workspace.stageBytes('workbook.xlsx', source)
    } else if (typeof opts.path === 'string') {
      path = requirePath(opts.path)
      source = Buffer.from(workspace.readBytes(path))
    } else {
      source = await blankXlsxBuffer()
      path = workspace.stageBytes('workbook.xlsx', source)
    }
    const session = await buildSession(path, basename(path), source, null)
    state.newBlank.push(session.path)
    return workbookFileOf(session)
  })

  // ----- read -----------------------------------------------------------------

  registry.registerHandle('workbook:read-range', (_event, request: unknown) => {
    const req = request as { sessionId?: unknown; sheetId?: unknown; range?: unknown }
    const session = requireSession(req?.sessionId)
    const bounds = normalizeRange(req?.range)
    const sheet = requireSheet(session, req?.sheetId)
    return rangeResult(sheet, bounds)
  })

  registry.registerHandle('workbook:read-formulas', (_event, request: unknown) => {
    const req = request as { sessionId?: unknown; sheetId?: unknown }
    const session = requireSession(req?.sessionId)
    const sheet = requireSheet(session, req?.sheetId)
    const cells: Record<string, unknown>[] = []
    for (const [row, entries] of sheet.byRow) {
      for (const { column, cell } of entries) {
        if (!cell.formula) continue
        cells.push({ row, column, value: cell.value ?? null, formula: cell.formula })
      }
    }
    return { cells, indexingComplete: true, truncated: false }
  })

  registry.registerHandle('workbook:recalc', () => {
    // The renderer already computed formula values for the screen and ships
    // them in the save request as `formulaValues`; there is no second engine
    // here to ask.
    return { cells: [] }
  })

  registry.registerHandle('workbook:read-media', () => {
    throw new OfficeError('OFFICE_NEEDS_APP', 'workbook media extraction is not available in the office-ai host')
  })

  registry.registerHandle('workbook:read-pivot-definition', () => ({ definition: null }))

  // ----- save -----------------------------------------------------------------

  registry.registerHandle('workbook:save-edits-begin', (_event, request: unknown) => {
    const req = request as { sessionId?: unknown; transferId?: unknown; total?: unknown }
    requireSession(req?.sessionId)
    if (typeof req?.transferId !== 'string') {
      throw new OfficeError('OFFICE_BAD_INPUT', 'transferId must be a string')
    }
    const total = Number(req.total)
    if (!Number.isFinite(total) || total <= 0 || total > MAX_TRANSFER_EDITS) {
      throw new OfficeError('OFFICE_BAD_INPUT', `transfer total out of range: ${String(req.total)}`)
    }
    state.transfers.set(req.transferId, new Array<string>(Math.ceil(total)))
    return { ok: true, transferId: req.transferId }
  })

  registry.registerHandle('workbook:save-edits-chunk', (_event, request: unknown) => {
    const req = request as { sessionId?: unknown; transferId?: unknown; seq?: unknown; editsJson?: unknown }
    requireSession(req?.sessionId)
    const chunks = state.transfers.get(String(req?.transferId))
    if (!chunks) throw new OfficeError('OFFICE_NOT_FOUND', `no staged transfer ${String(req?.transferId)}`)
    const seq = Number(req?.seq)
    if (!Number.isInteger(seq) || seq < 0 || seq >= chunks.length) {
      throw new OfficeError('OFFICE_BAD_INPUT', `chunk seq out of range: ${String(req?.seq)}`)
    }
    if (typeof req?.editsJson !== 'string') {
      throw new OfficeError('OFFICE_BAD_INPUT', 'editsJson must be a string')
    }
    chunks[seq] = req.editsJson
    return { ok: true, seq }
  })

  registry.registerHandle('workbook:save-edits-abort', (_event, request: unknown) => {
    const req = request as { transferId?: unknown }
    state.transfers.delete(String(req?.transferId))
    return { ok: true }
  })

  const save = async (_event: unknown, request: unknown): Promise<unknown> => {
    const req = (request ?? {}) as RendererSaveRequest & { path?: string }
    const session = requireSession(req.sessionId)
    const edits = req.editsTransferId
      ? collectTransferEdits(state, req.editsTransferId)
      : (req.edits ?? [])
    const fields = toGatewaySaveFields({ ...req, edits }, session.sheetNames)

    const source = await createBufferEntrySource(session.source)
    const plan = await planCellEditsToXlsx(
      source,
      fields.edits,
      fields.structuralOps,
      fields.chartEdits,
      fields.sheetPlan,
      fields.filterStates,
      fields.hyperlinkEdits,
      fields.cfStates,
      fields.dvStates,
      fields.sheetProtections,
      fields.definedNamesState,
      fields.visualAdditions,
      fields.pageSetupStates,
      fields.noteStates,
      fields.tableAdditions,
      fields.pivotAdditions,
      fields.pivotCacheRefreshPaths,
      fields.pivotRefreshUpdates,
      fields.visualEdits,
      fields.sparklineAdditions,
      fields.formulaValues,
      fields.themeState,
      fields.workbookProtectionState,
      fields.protectedRangeStates,
      fields.bulkConstantFills,
    )
    const mutation = await assembleWithJsZip(session.source, plan)

    const targetPath =
      req.mode === 'save-as' && typeof req.path === 'string' ? requirePath(req.path) : session.path
    workspace.writeBytes(targetPath, mutation.buffer)
    if (req.editsTransferId) state.transfers.delete(req.editsTransferId)

    // The save target may have moved (save-as) and the bytes are now the new
    // base; re-read so a second save patches what was just written.
    const reopened = await openWorkbook(targetPath)
    reopened.name = basename(targetPath)
    return { ok: true, path: reopened.path, touchedEntries: [...mutation.touchedEntries] }
  }

  registry.registerHandle('workbook:save', (event, request) => save(event, request))
  registry.registerHandle('workbook:save-as', (event, request) =>
    save(event, { ...(request as object), mode: 'save-as' }),
  )

  registry.registerHandle('workbook:write-recovery', (_event, request: unknown) => {
    const req = request as { sessionId?: unknown }
    requireSession(req?.sessionId)
    return { ok: true }
  })

  registry.registerHandle('workbook:close', (_event, sessionId: unknown) => {
    if (typeof sessionId === 'string') state.sessions.delete(sessionId)
    return { ok: true }
  })

  registry.registerHandle('workbook:pending-edits', () => ({ count: 0, sessionId: null }))

  // ----- export / misc --------------------------------------------------------

  registry.registerHandle('workbook:export-csv', (_event, request: unknown) => {
    const req = request as { content?: unknown; targetPath?: unknown; fileName?: unknown }
    if (typeof req?.content !== 'string') return { canceled: true }
    // No targetPath means "the desktop save dialog" — the renderer already
    // treats the canceled answer as its own fallback UX, and the loopback host
    // has no dialog to open (web-server parity).
    if (typeof req?.targetPath !== 'string' || !req.targetPath) return { canceled: true }
    const target = requirePath(req.targetPath)
    workspace.writeBytes(target, Buffer.from(req.content, 'utf8'))
    return { canceled: false, path: target }
  })

  registry.registerHandle('workbook:csv-save-confirm', () => 'csv')
  registry.registerHandle('workbook:export-pdf', () => {
    throw new OfficeError('OFFICE_NEEDS_APP', 'workbook PDF export needs the desktop print path')
  })
  registry.registerHandle('workbook:print', () => ({ ok: false }))
  registry.registerHandle('workbook:close-save-request', () => null)
  registry.registerHandle('workbook:close-save-result', () => ({ ok: true }))
  registry.registerHandle('workbook:recovery-prompt', () => null)
  registry.registerHandle('workbook:recovery-prompt-reply', () => ({ ok: true }))
  registry.registerHandle('workbook:create-document', () => ({ canceled: true }))
  registry.registerHandle('shell:read-local-image', () => null)
  registry.registerHandle('shell:open-external', () => ({ ok: false }))
  registry.registerHandle('menu:action', () => ({ ok: true }))
  registry.registerHandle('sheets:ai-generate-image', () => null)

  registry.registerHandle('sheets:files-pick', () => ({ canceled: true, paths: [] }))
  registry.registerHandle('sheets:files-add', (_event, paths: unknown) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    return list.map((filePath) => {
      const resolved = workspace.resolvePath(filePath)
      if (!resolved) return { path: filePath, ok: false, error: 'path is outside the workspace' }
      try {
        const info = workspaceBytes(workspace, resolved)
        return { path: resolved, ok: true, name: basename(resolved), sizeBytes: info }
      } catch {
        return { path: resolved, ok: false, error: 'file not found' }
      }
    })
  })
  registry.registerHandle('sheets:files-read', (_event, path: unknown, offset: unknown, maxChars: unknown) => {
    const resolved = typeof path === 'string' ? workspace.resolvePath(path) : null
    if (!resolved) return { ok: false, error: 'path is outside the workspace' }
    const mime = IMAGE_MIME[extname(resolved).slice(1).toLowerCase()]
    if (mime) return { ok: false, error: 'image has no text' }
    let text: string
    try {
      text = Buffer.from(workspace.readBytes(resolved)).toString('utf8')
    } catch {
      return { ok: false, error: 'file not found' }
    }
    const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0)
    const size = Math.min(
      48000,
      Math.max(1, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 1),
    )
    return {
      ok: true,
      name: basename(resolved),
      totalChars: text.length,
      offset: start,
      text: text.slice(start, start + size),
    }
  })
  registry.registerHandle('sheets:files-read-image', (_event, path: unknown) => {
    const resolved = typeof path === 'string' ? workspace.resolvePath(path) : null
    if (!resolved) return { ok: false, error: 'path is outside the workspace' }
    const mime = IMAGE_MIME[extname(resolved).slice(1).toLowerCase()]
    if (!mime) return { ok: false, error: 'not an image' }
    let bytes: Uint8Array
    try {
      bytes = workspace.readBytes(resolved)
    } catch {
      return { ok: false, error: 'file not found' }
    }
    if (bytes.byteLength > 5 * 1024 * 1024) return { ok: false, error: 'image is too large' }
    return { ok: true, base64: Buffer.from(bytes).toString('base64'), mime }
  })
  registry.registerHandle('sheets:files-add-pasted-image', (_event, data: unknown, ext: unknown) => {
    const bytes = toBytes(data)
    if (!bytes) return { ok: false, error: 'invalid image payload' }
    const clean = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : 'png'
    const path = workspace.stageBytes(`pasted.${clean}`, bytes)
    return { ok: true, path, name: basename(path), sizeBytes: bytes.byteLength }
  })

  return state
}

// ----- snapshot → wire shapes -----------------------------------------------

/** Parse the gateway snapshot once: A1 keys become a row/column index both the range reads and the cell iterator share. */
async function indexImported(source: Buffer): Promise<{
  sheets: Map<string, IndexedSheet>
  sheetNamesById: Record<string, string>
}> {
  const imported = await readBasicWorkbook(source)
  const sheets = new Map<string, IndexedSheet>()
  for (const sheet of imported.snapshot.sheets) {
    sheets.set(sheet.name, indexSheet(sheet, sheet.id))
  }
  return { sheets, sheetNamesById: { ...imported.sheetNamesById } }
}

function indexSheet(sheet: WorksheetState, id: string): IndexedSheet {
  const byRow = new Map<number, { column: number; cell: CellState }[]>()
  let maxRow = 0
  let maxColumn = 0
  for (const [address, cell] of Object.entries(sheet.cells)) {
    let coords: { row: number; column: number }
    try {
      coords = parseAddress(address)
    } catch {
      continue
    }
    const row = byRow.get(coords.row) ?? []
    row.push({ column: coords.column, cell })
    byRow.set(coords.row, row)
    if (coords.row > maxRow) maxRow = coords.row
    if (coords.column > maxColumn) maxColumn = coords.column
  }
  for (const row of byRow.values()) row.sort((a, b) => a.column - b.column)
  return {
    id,
    name: sheet.name,
    rowCount: maxRow + 1,
    columnCount: maxColumn + 1,
    byRow,
    merges: sheet.merges ?? [],
  }
}

function workbookFileOf(session: SheetSession): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    name: session.name,
    path: session.path,
    sha256: createHash('sha256').update(session.source).digest('hex'),
    fileBytes: session.source.byteLength,
    entryCount: session.entryCount,
    sheets: [...session.sheets.values()].map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      rowCount: Math.max(1, sheet.rowCount),
      columnCount: Math.max(1, sheet.columnCount),
      columnWidths: [],
      defaultRowHeight: null,
      defaultColumnWidth: null,
      freeze: null,
      hidden: false,
      tabColor: null,
      showGridLines: true,
      tables: [],
      comments: [],
      pivotRanges: [],
      pivotTables: [],
      sparklines: [],
      cellImages: [],
    })),
    activeTab: 0,
    styles: [],
    dxfStyles: [],
    visuals: [],
    definedNames: [],
    readOnly: false,
    ...(session.csvPath ? { csvPath: session.csvPath } : {}),
  }
}

interface RangeBounds {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

function normalizeRange(range: unknown): RangeBounds {
  const raw = (range ?? {}) as Partial<RangeBounds>
  const startRow = intField(raw.startRow, 0)
  const endRow = intField(raw.endRow, startRow)
  const startColumn = intField(raw.startColumn, 0)
  const endColumn = intField(raw.endColumn, startColumn)
  if (endRow < startRow || endColumn < startColumn) {
    throw new OfficeError('OFFICE_BAD_INPUT', 'range end must not precede its start')
  }
  if ((endRow - startRow + 1) * (endColumn - startColumn + 1) > MAX_RANGE_CELLS) {
    throw new OfficeError('OFFICE_BAD_INPUT', `range exceeds ${MAX_RANGE_CELLS} cells`)
  }
  return { startRow, endRow, startColumn, endColumn }
}

function intField(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

function requireSheet(session: SheetSession, sheetId: unknown): IndexedSheet {
  if (typeof sheetId !== 'string') {
    throw new OfficeError('OFFICE_BAD_INPUT', 'sheetId must be a string')
  }
  const name = session.sheetNames.get(sheetId)
  const sheet = name ? session.sheets.get(name) : undefined
  if (!sheet) throw new OfficeError('OFFICE_NOT_FOUND', `no worksheet ${sheetId} in session ${session.sessionId}`)
  return sheet
}

function rangeResult(sheet: IndexedSheet, bounds: RangeBounds): Record<string, unknown> {
  const cells: Record<string, unknown>[] = []
  for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
    const entries = sheet.byRow.get(row)
    if (!entries) continue
    for (const { column, cell } of entries) {
      if (column < bounds.startColumn || column > bounds.endColumn) continue
      cells.push(cellRecord(row, column, cell))
    }
  }
  const lastRow = Math.min(bounds.endRow, Math.max(bounds.startRow, sheet.rowCount - 1))
  const rows = Array.from({ length: lastRow - bounds.startRow + 1 }, (_, i) => ({
    row: bounds.startRow + i,
    hidden: false,
  }))
  return {
    cells,
    rows,
    merges: sheet.merges,
    hyperlinks: [],
    conditionalRules: [],
    autoFilter: null,
    autoFilterColumns: [],
    dataValidations: [],
    styles: [],
    indexedThroughRow: bounds.endRow,
    indexingComplete: true,
    sheetProtection: null,
    protectedRanges: [],
    rowBreaks: [],
    colBreaks: [],
  }
}

function cellRecord(row: number, column: number, cell: CellState): Record<string, unknown> {
  return {
    row,
    column,
    value: cell.value ?? null,
    ...(cell.formula ? { formula: cell.formula } : {}),
  }
}

function collectTransferEdits(state: SheetsHandlerState, transferId: string): RendererCellEdit[] {
  const chunks = state.transfers.get(transferId)
  if (!chunks) throw new OfficeError('OFFICE_NOT_FOUND', `no staged transfer ${transferId}`)
  const edits: RendererCellEdit[] = []
  for (const [seq, payload] of chunks.entries()) {
    if (payload === undefined) {
      throw new OfficeError('OFFICE_BAD_INPUT', `transfer ${transferId} is missing chunk ${seq}`)
    }
    const parsed = JSON.parse(payload) as unknown
    if (Array.isArray(parsed)) edits.push(...(parsed as RendererCellEdit[]))
  }
  return edits
}

function evictSessions(state: SheetsHandlerState): void {
  if (state.sessions.size <= MAX_SESSIONS) return
  const byAge = [...state.sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt)
  for (const session of byAge.slice(0, state.sessions.size - MAX_SESSIONS)) {
    state.sessions.delete(session.sessionId)
  }
}

function defaultSheetName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '').slice(0, 31)
  return stem || 'Sheet1'
}

function workspaceBytes(workspace: Workspace, path: string): number {
  return workspace.readBytes(path).byteLength
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}
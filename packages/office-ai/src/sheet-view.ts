import { parseAddress } from '@genoffice/xlsx-gateway/domain/cell-address'
import { readBasicWorkbook } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'

/** A worksheet summarised for callers who just need to know it exists. */
export interface SheetSummaryView {
  name: string
  rows: number
  columns: number
}

/** Every worksheet in a workbook. */
export interface WorkbookView {
  sheets: SheetSummaryView[]
  activeSheet: string | null
}

/** One worksheet's cells, keyed by A1 address. */
export interface SheetGridView extends SheetSummaryView {
  /** address (A1) → display text; a cell holding a formula reports its formula text */
  cells: Record<string, string>
  /** true when the grid was capped, so `rows`/`columns` are a lower bound */
  truncated: boolean
}

/**
 * Reads a workbook's cells without the Rust sidecar. Uses the same
 * `xlsx-gateway` reader the sheet *writer* uses, so reading and writing agree
 * on addresses. Number formatting is not applied here: a date cell reports its
 * serial. Use the CLI's `readSheet` (sidecar-backed) when display formatting
 * matters.
 */
export async function readWorkbookView(source: Buffer): Promise<{
  workbook: WorkbookView
  sheets: Map<string, SheetGridView>
}> {
  const imported = await readBasicWorkbook(source)
  const sheets = new Map<string, SheetGridView>()
  const summaries: SheetSummaryView[] = []
  for (const sheet of imported.snapshot.sheets) {
    const view = gridOf(sheet.name, sheet.cells)
    sheets.set(sheet.name, view)
    summaries.push({ name: view.name, rows: view.rows, columns: view.columns })
  }
  return {
    workbook: { sheets: summaries, activeSheet: summaries[0]?.name ?? null },
    sheets,
  }
}

const GRID_CAP = 5000

interface StoredCell {
  value: string | number | boolean | null
  formula?: string | undefined
}

function gridOf(name: string, cells: Readonly<Record<string, StoredCell>>): SheetGridView {
  const out: Record<string, string> = {}
  let rows = 0
  let columns = 0
  let kept = 0
  let truncated = false
  for (const [address, cell] of Object.entries(cells)) {
    const at = coordinatesOf(address)
    if (!at) continue
    rows = Math.max(rows, at.row + 1)
    columns = Math.max(columns, at.column + 1)
    if (kept >= GRID_CAP) {
      truncated = true
      continue
    }
    out[address] = cell.formula ?? displayText(cell.value)
    kept += 1
  }
  return { name, rows, columns, cells: out, truncated }
}

/** Parses an A1 address, or `null` when it is not a single cell reference. */
export function coordinatesOf(address: string): { row: number; column: number } | null {
  try {
    return parseAddress(address)
  } catch {
    return null
  }
}

function displayText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return String(value)
}

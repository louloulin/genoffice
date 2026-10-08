/**
 * Renderer save request → xlsx-gateway save fields.
 *
 * The sheets renderer addresses worksheets by Univer sheet id; the gateway
 * patches package parts by the file's sheet name. This is the one place that
 * resolution happens. It mirrors `apps/sheets/src/main/save-request-mapping.ts`
 * (which the Electron main and apps/web-server share) — a port rather than an
 * import, because office-ai must not reach into apps/ source from inside a
 * published tarball. Keep the two in sync: if the renderer starts sending a new
 * save field and it is dropped here, the save silently loses that edit.
 *
 * Pure: `sheetNames` is the opened session's sheet id → file sheet name map.
 */
import type {
  BulkConstantFill,
  CellEdit,
  SheetCfState,
  SheetDvState,
  SheetHyperlinkEdits,
  SheetNoteState,
  SheetPivotAddition,
  SheetProtectionState,
  SheetProtectedRangesState,
  SheetSparklineAddition,
  SheetStructuralOps,
  SheetTableAddition,
  SheetVisualAddition,
} from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import type { SheetPageSetupState } from '@genoffice/xlsx-gateway/gateway/xlsx-page-setup'
import type { WorkbookChartEdit, WorkbookVisualEdit } from '@genoffice/xlsx-gateway/shared/edit-schemas'
import type { SheetFilterState } from '@genoffice/xlsx-gateway/gateway/xlsx-filter'
import type { DefinedNamesState } from '@genoffice/xlsx-gateway/gateway/xlsx-defined-names'
import type { WorkbookThemeState } from '@genoffice/xlsx-gateway/gateway/xlsx-theme'
import type { PivotRefreshUpdate } from '@genoffice/xlsx-gateway/gateway/xlsx-pivot-expand'
import type { SheetEditPlan } from '@genoffice/xlsx-gateway/gateway/xlsx-sheets'

/** A gateway per-sheet payload as the renderer sends it: same fields, sheetId instead of sheetName. */
type ById<T> = Omit<T, 'sheetName'> & { sheetId: string }

export interface RendererSheetOp {
  kind:
    | 'add-sheet'
    | 'duplicate-sheet'
    | 'rename-sheet'
    | 'set-sheet-hidden'
    | 'remove-sheet'
    | 'reorder-sheets'
  sheetId: string
  name?: string
  newName?: string
  hidden?: boolean
  sourceSheetId?: string
}

export interface RendererSaveRequest {
  mode: 'save' | 'save-as'
  sessionId: string
  path?: string
  /**
   * The active sheet serialized as CSV text, sent on a plain `save` of a
   * workbook that was opened from `.csv`/`.tsv`/`.txt` (Excel's "keep current
   * format?" flow). The host writes this to the original file — the xlsx bytes
   * it assembles always go to the staged working copy instead.
   */
  csvContent?: string
  edits?: RendererCellEdit[]
  bulkConstantFills?: ById<BulkConstantFill>[]
  structuralOps?: (ById<SheetStructuralOps['ops'][number]> & { sheetId: string })[]
  chartEdits?: WorkbookChartEdit[]
  visualEdits?: WorkbookVisualEdit[]
  sheetOps?: RendererSheetOp[]
  sheetOrder?: string[]
  filterStates?: ById<SheetFilterState>[]
  hyperlinkEdits?: { sheetId: string; row: number; column: number; target: string | null }[]
  cfStates?: ById<SheetCfState>[]
  dvStates?: ById<SheetDvState>[]
  pageSetupStates?: ById<SheetPageSetupState>[]
  noteStates?: ById<SheetNoteState>[]
  visualAdditions?: ById<SheetVisualAddition>[]
  tableAdditions?: ById<SheetTableAddition>[]
  pivotAdditions?: (Omit<SheetPivotAddition, 'sheetName' | 'sourceSheetName'> & {
    sheetId: string
    sourceSheetId: string
  })[]
  sparklineAdditions?: ById<SheetSparklineAddition>[]
  sheetProtections?: ById<SheetProtectionState>[]
  protectedRangeStates?: ById<SheetProtectedRangesState>[]
  formulaValues?: { sheetId: string; row: number; column: number; value: string | number | boolean | null }[]
  pivotCacheRefreshPaths?: string[]
  pivotRefreshUpdates?: (Omit<PivotRefreshUpdate, 'sheetName'> & { sheetId: string })[]
  definedNamesState?: DefinedNamesState | null
  themeState?: WorkbookThemeState | null
  workbookProtectionState?: { lockStructure: boolean } | null
  editsTransferId?: string
  restoreWriteBack?: boolean
}

export interface RendererCellEdit {
  sheetId: string
  row: number
  column: number
  writeValue: boolean
  value: string | number | boolean | null
  formula?: string
  style?: CellEdit['style']
  rich?: CellEdit['rich']
  styleReset?: boolean
}

/** Everything a gateway save needs besides the entry source and the target path. */
export interface GatewaySaveFields {
  edits: CellEdit[]
  bulkConstantFills: BulkConstantFill[]
  structuralOps: SheetStructuralOps[]
  chartEdits: WorkbookChartEdit[]
  visualEdits: WorkbookVisualEdit[]
  sheetPlan: SheetEditPlan | undefined
  filterStates: SheetFilterState[]
  hyperlinkEdits: SheetHyperlinkEdits[]
  cfStates: SheetCfState[]
  dvStates: SheetDvState[]
  sheetProtections: SheetProtectionState[]
  protectedRangeStates: SheetProtectedRangesState[]
  visualAdditions: SheetVisualAddition[]
  pageSetupStates: SheetPageSetupState[]
  noteStates: SheetNoteState[]
  tableAdditions: SheetTableAddition[]
  pivotAdditions: SheetPivotAddition[]
  sparklineAdditions: SheetSparklineAddition[]
  formulaValues: { sheetName: string; cells: { row: number; column: number; value: string | number | boolean | null }[] }[]
  pivotCacheRefreshPaths: string[]
  pivotRefreshUpdates: PivotRefreshUpdate[]
  definedNamesState: DefinedNamesState | null
  themeState: WorkbookThemeState | null
  workbookProtectionState: { lockStructure: boolean } | null
}

export function toGatewaySaveFields(
  request: RendererSaveRequest,
  sheetNames: ReadonlyMap<string, string>,
): GatewaySaveFields {
  // Sheet ops resolve first: added sheets have Univer ids the session map
  // doesn't know, so cell edits into them resolve through the op's name.
  const addedSheetNames = new Map<string, string>()
  // Added sheet id → file name of the sheet whose part seeds the new part.
  const duplicateSources = new Map<string, string>()
  const renames: { sheetName: string; newName: string }[] = []
  const removals: string[] = []
  const hiddenChanges: { sheetName: string; hidden: boolean }[] = []
  let orderChanged = false
  for (const op of request.sheetOps ?? []) {
    if (op.kind === 'add-sheet') {
      addedSheetNames.set(op.sheetId, op.name!)
      continue
    }
    if (op.kind === 'duplicate-sheet') {
      // The renderer resolves duplicate chains to a sheet the file knows,
      // so the source must be in the session map.
      const sourceName = sheetNames.get(op.sourceSheetId!)
      if (!sourceName) throw new Error(`Unknown duplicate source ${op.sourceSheetId}.`)
      addedSheetNames.set(op.sheetId, op.name!)
      duplicateSources.set(op.sheetId, sourceName)
      continue
    }
    if (op.kind === 'reorder-sheets') {
      orderChanged = true
      continue
    }
    const sheetName = addedSheetNames.get(op.sheetId) ?? sheetNames.get(op.sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet ${op.sheetId}.`)
    if (op.kind === 'rename-sheet') renames.push({ sheetName, newName: op.newName! })
    else if (op.kind === 'set-sheet-hidden') hiddenChanges.push({ sheetName, hidden: op.hidden! })
    else removals.push(sheetName)
  }
  const renameByOriginal = new Map(renames.map((rename) => [rename.sheetName, rename.newName]))
  const resolveSheetName = (sheetId: string): string => {
    const sheetName = addedSheetNames.get(sheetId) ?? sheetNames.get(sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet ${sheetId}.`)
    return sheetName
  }
  let sheetPlan: SheetEditPlan | undefined
  const sheetOps = request.sheetOps ?? []
  if (sheetOps.length > 0) {
    sheetPlan = {
      renames,
      additions: [...addedSheetNames].map(([sheetId, name]) => ({
        name,
        sourceSheetName: duplicateSources.get(sheetId),
      })),
      removals,
      hiddenChanges,
      orderChanged,
      order: (request.sheetOrder ?? []).map((sheetId) => {
        const original = resolveSheetName(sheetId)
        return addedSheetNames.has(sheetId) ? original : (renameByOriginal.get(original) ?? original)
      }),
    }
  }

  const edits: CellEdit[] = (request.edits ?? []).map((edit) => ({
    sheetName: resolveSheetName(edit.sheetId),
    row: edit.row,
    column: edit.column,
    writeValue: edit.writeValue,
    cell: { value: edit.value, formula: edit.formula },
    style: edit.style,
    rich: edit.rich,
    styleReset: edit.styleReset,
  }))
  const bulkConstantFills = (request.bulkConstantFills ?? []).map(({ sheetId, ...fill }) => ({
    sheetName: resolveSheetName(sheetId),
    ...fill,
  }))

  const opsBySheet = new Map<string, SheetStructuralOps['ops'][number][]>()
  for (const op of request.structuralOps ?? []) {
    const sheetName = resolveSheetName(op.sheetId)
    const { sheetId: _sheetId, ...rest } = op
    const sheetOps = opsBySheet.get(sheetName) ?? []
    sheetOps.push(rest as SheetStructuralOps['ops'][number])
    opsBySheet.set(sheetName, sheetOps)
  }
  const structuralOps: SheetStructuralOps[] = [...opsBySheet].map(([sheetName, ops]) => ({
    sheetName,
    ops,
  }))

  const filterStates = (request.filterStates ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })

  const linksBySheet = new Map<string, { row: number; column: number; target: string | null }[]>()
  for (const link of request.hyperlinkEdits ?? []) {
    const sheetName = resolveSheetName(link.sheetId)
    const sheetLinks = linksBySheet.get(sheetName) ?? []
    sheetLinks.push({ row: link.row, column: link.column, target: link.target })
    linksBySheet.set(sheetName, sheetLinks)
  }
  const hyperlinkEdits: SheetHyperlinkEdits[] = [...linksBySheet].map(([sheetName, edits]) => ({
    sheetName,
    edits,
  }))

  const cfStates = (request.cfStates ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const dvStates = (request.dvStates ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const sheetProtections = (request.sheetProtections ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const protectedRangeStates = (request.protectedRangeStates ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const pageSetupStates = (request.pageSetupStates ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const noteStates = (request.noteStates ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const visualAdditions = (request.visualAdditions ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const tableAdditions = (request.tableAdditions ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })
  const pivotAdditions = (request.pivotAdditions ?? []).map((state) => {
    const { sheetId, sourceSheetId, ...rest } = state
    return {
      sheetName: resolveSheetName(sheetId),
      sourceSheetName: resolveSheetName(sourceSheetId),
      ...rest,
    }
  })
  const sparklineAdditions = (request.sparklineAdditions ?? []).map((state) => {
    const { sheetId, ...rest } = state
    return { sheetName: resolveSheetName(sheetId), ...rest }
  })

  // Recalculated formula values: sheetId → file sheet name, the same
  // resolution the cell edits use.
  const formulaValuesBySheet = new Map<
    string,
    { row: number; column: number; value: string | number | boolean | null }[]
  >()
  for (const cell of request.formulaValues ?? []) {
    const sheetName = resolveSheetName(cell.sheetId)
    const list = formulaValuesBySheet.get(sheetName) ?? []
    list.push({ row: cell.row, column: cell.column, value: cell.value })
    formulaValuesBySheet.set(sheetName, list)
  }
  const formulaValues = [...formulaValuesBySheet].map(([sheetName, cells]) => ({ sheetName, cells }))

  return {
    edits,
    bulkConstantFills,
    structuralOps,
    chartEdits: request.chartEdits ?? [],
    // Located by package-absolute drawingPath, so no sheet-name mapping.
    visualEdits: request.visualEdits ?? [],
    sheetPlan,
    filterStates,
    hyperlinkEdits,
    cfStates,
    dvStates,
    sheetProtections,
    protectedRangeStates,
    visualAdditions,
    pageSetupStates,
    noteStates,
    tableAdditions,
    pivotAdditions,
    sparklineAdditions,
    formulaValues,
    pivotCacheRefreshPaths: request.pivotCacheRefreshPaths ?? [],
    // Output-area expansion from layout growth: sheetId → sheet name; the part
    // path is resolved by the gateway.
    pivotRefreshUpdates: (request.pivotRefreshUpdates ?? []).map((update) => {
      const { sheetId, relayout, ...rest } = update
      return relayout
        ? {
            ...rest,
            sheetName: resolveSheetName(sheetId),
            relayout: (({ sourceSheetId, ...layout }) => ({
              ...layout,
              sourceSheetName: resolveSheetName(sourceSheetId),
            }))(relayout as unknown as PivotRefreshUpdate['relayout'] & { sourceSheetId: string }) as PivotRefreshUpdate['relayout'],
          }
        : { ...rest, sheetName: resolveSheetName(sheetId) }
    }),
    definedNamesState: request.definedNamesState ?? null,
    themeState: request.themeState ?? null,
    workbookProtectionState: request.workbookProtectionState ?? null,
  }
}
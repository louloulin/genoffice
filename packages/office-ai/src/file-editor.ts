/**
 * File-backed editor adapters — §5.3's "core missing piece".
 *
 * The GenOffice AI extensions in `@genoffice/agent-skills` reach a document
 * through a small editor contract (`DocsEditor` / `SheetsEditor`): open a file,
 * read its structure, apply edits, save. Inside the apps those contracts are
 * implemented by the renderer (Tiptap for docs, Univer for sheets). This module
 * implements them over the same engines the headless CLI drives, so an
 * editor-semantics caller needs no Electron, no React and no iframe.
 *
 * The contracts are re-declared here rather than imported from
 * `@genoffice/agent-skills`: they are plain TypeScript shapes, while the skill
 * package pulls in pi (`@earendil-works/pi-coding-agent`) and the React UI
 * adapter. Structural typing makes these drop-in equivalents — pass one to a
 * skill that expects the original and it typechecks.
 *
 * Only `save()` is asynchronous. Everything else runs against a live, in-memory
 * engine document, exactly as the renderer's editor does; the bytes only come
 * back at the end.
 */
import {
  blockRangeHtml,
  closeDocument,
  describeDocument,
  openDocument,
  saveDocument,
  type OpenDocument,
} from '@genoffice/cli/formats/docx'
import { formatAddress } from '@genoffice/xlsx-gateway/domain/cell-address'
import { OfficeError } from './errors'
import { guarded } from './internal'
import { readWorkbookView, type SheetGridView, type WorkbookView } from './sheet-view'
import type { BlockSummary } from './views'

// ---------------------------------------------------------------------------
// DocsEditor — mirror of `agent-skills/src/extensions/docs-skill.ts`
// ---------------------------------------------------------------------------

export interface DocsBlock {
  /** Block index in the document. */
  index: number
  /** Block kind: paragraph, heading, list, image … */
  kind: string
  /** HTML representation of the block. */
  html: string
  /** Pending tracked deletion: no longer current content. */
  trackedDeleted?: boolean
}

export interface DocsEditor {
  getBlockCount(): number
  /** Throws when the index is out of range. */
  getBlock(index: number): DocsBlock
  /** Concatenated HTML of blocks [start, end] inclusive. */
  getRangeHtml(start: number, end: number): string
  /** Normalize a requested inclusive range, or `null` when it can address nothing. */
  clampRange(start: number, end: number): { start: number; end: number } | null
  /** `afterIndex` of -1 inserts before the first block. */
  insertBlocks(afterIndex: number, blocksHtml: string): { inserted: number }
  replaceBlockRange(
    start: number,
    end: number,
    blocksHtml: string,
  ): { inserted: number; removed: number }
  /** Headless documents have no user selection, so this never replaces anything. */
  replaceSelection(inlineHtml: string): { replaced: boolean }
  /** Formatting/structure ops, validated atomically. `dryRun` plans without applying. */
  applyOps(ops: ReadonlyArray<unknown>, dryRun: boolean): { applied: number; dryRun: boolean }
  /** No-op headless: there is no second editor whose writes could go stale. */
  markDocSeen(): void
}

/** An open `.docx` driven through editor semantics. */
export interface OpenDocsFile {
  readonly editor: DocsEditor
  /** Every top-level block with its full text, as `readDocument` reports it. */
  blocks(): BlockSummary[]
  /** The body as restricted HTML. */
  html(): string
  /**
   * Serializes the current editor state. The file stays open and editable
   * afterwards, so a caller can save intermediate versions.
   */
  save(): Promise<Uint8Array>
  close(): void
}

export interface OpenDocsFileOptions {
  /** Reject the request when the file is not a Word document. */
  format?: string
}

/**
 * Opens a `.docx` for repeated editor-style reads and edits.
 *
 * This is the DOM-coupled half of the library: the Word editing surface is a
 * ProseMirror document, so a jsdom is installed before the engine loads (the
 * same shim `@genoffice/cli` uses).
 */
export async function openDocsFile(
  bytes: Uint8Array,
  opts: OpenDocsFileOptions = {},
): Promise<OpenDocsFile> {
  if (!bytes?.byteLength) throw new OfficeError('OFFICE_BAD_INPUT', 'cannot open an empty document')
  const doc = await guarded('open .docx', () => openDocument(bytes))
  return { ...docsEditor(doc), save: () => saveDocument(doc), close: () => closeDocument(doc) }
}

function docsEditor(doc: OpenDocument): Omit<OpenDocsFile, 'save' | 'close'> {
  const { editor, mods } = doc
  const body = () => editor.state.doc
  const count = () => body().childCount

  const range = (start: number, end: number): { start: number; end: number } | null => {
    const n = count()
    if (n === 0 || !Number.isInteger(start) || !Number.isInteger(end)) return null
    const from = Math.min(Math.max(start, 0), n - 1)
    const to = Math.min(Math.max(end, 0), n - 1)
    return to < from ? null : { start: from, end: to }
  }

  /** Restricted HTML → ProseMirror nodes; the parser is the one the renderer uses. */
  const parse = (html: string) => mods.protocol.parseHtmlFragment(html, doc.numIds)

  const requireBlocks = (html: string, where: string) => {
    const nodes = parse(html)
    if (nodes.length === 0)
      throw new OfficeError('OFFICE_BAD_INPUT', `no content could be parsed from the HTML (${where})`)
    return nodes
  }

  return {
    editor: {
      getBlockCount: count,

      getBlock(index) {
        const n = count()
        if (!Number.isInteger(index) || index < 0 || index >= n)
          throw new OfficeError(
            'OFFICE_BAD_INPUT',
            `block ${index} is out of range (document has ${n})`,
          )
        const summary = describeDocument(doc, [index, index], true)[0]!
        return {
          index,
          kind: summary.kind ?? summary.type,
          html: blockRangeHtml(doc, index, index),
          ...(mods.protocol.isTrackedDeleted(body().child(index)) ? { trackedDeleted: true } : {}),
        }
      },

      getRangeHtml(start, end) {
        const r = range(start, end)
        if (!r) throw new OfficeError('OFFICE_BAD_INPUT', `block range [${start}, ${end}] is empty or invalid`)
        return blockRangeHtml(doc, r.start, r.end)
      },

      clampRange: range,

      insertBlocks(afterIndex, blocksHtml) {
        const n = count()
        if (!Number.isInteger(afterIndex) || afterIndex < -1 || afterIndex >= n)
          throw new OfficeError(
            'OFFICE_BAD_INPUT',
            `afterBlockIndex ${afterIndex} is out of range (-1…${n - 1})`,
          )
        const nodes = requireBlocks(blocksHtml, `insert after ${afterIndex}`)
        // -1 lands on position 0: the offset before the first block
        mods.protocol.insertBlocksAfter(editor, afterIndex, nodes)
        return { inserted: nodes.length }
      },

      replaceBlockRange(start, end, blocksHtml) {
        const r = range(start, end)
        if (!r) throw new OfficeError('OFFICE_BAD_INPUT', `block range [${start}, ${end}] is empty or invalid`)
        const nodes = requireBlocks(blocksHtml, `replace ${r.start}…${r.end}`)
        mods.protocol.replaceBlockRange(editor, r.start, r.end, nodes)
        return { inserted: nodes.length, removed: r.end - r.start + 1 }
      },

      replaceSelection() {
        // The app's contract is "replace exactly the user's selected text".
        // There is no user and no selection here, so reporting a replacement
        // would be a lie; callers fall back to block-level edits.
        return { replaced: false }
      },

      applyOps(ops, dryRun) {
        const outcome = mods.ops.executeOps(editor, ops, { dryRun })
        if (!outcome.ok)
          throw new OfficeError('OFFICE_BAD_INPUT', outcome.error ?? 'the op batch was rejected')
        return {
          applied: dryRun ? 0 : outcome.results.filter((r) => r.changed > 0).length,
          dryRun,
        }
      },

      markDocSeen() {
        // The renderer keeps a "changed since the model last read it" baseline
        // so a stale index is refused. A file-backed editor is the only writer.
      },
    },

    blocks: () => describeDocument(doc, undefined, true),
    html: () => blockRangeHtml(doc, 0, count() - 1),
  }
}

// ---------------------------------------------------------------------------
// SheetsEditor — mirror of `agent-skills/src/extensions/sheets-skill.ts`
// ---------------------------------------------------------------------------

export interface SheetsRange {
  startRow: number
  endRow: number
  startCol: number
  endCol: number
  sheet: string
}

export interface CellValue {
  raw: string | number | boolean | null
  format?: string
}

export interface WorkbookSummary {
  sheetNames: string[]
  activeSheet: string
  totalCells: number
  totalFormulas: number
}

export interface SheetsEditor {
  getWorkbookSummary(): WorkbookSummary
  readRange(range: SheetsRange): CellValue[][]
  aggregateRange(range: SheetsRange, op: 'sum' | 'avg' | 'count' | 'min' | 'max'): number | null
  findCells(sheet: string, query: string, maxResults?: number): string[]
  getSheetFeatures(sheet: string): {
    mergedRanges: SheetsRange[]
    frozenPanes: { row: number; col: number } | null
  }
}

/** An open `.xlsx`, read through the sheet editor contract. */
export interface OpenSheetsFile {
  readonly editor: SheetsEditor
  readonly workbook: WorkbookView
  close(): void
}

/**
 * Opens a workbook for editor-style reads. Reads are served from memory, so
 * they are synchronous like the renderer's Univer-backed editor.
 *
 * There is no write side to implement: `SheetsEditor`'s only mutator is the
 * optional `createNewDocument`, and a file-backed host creates documents with
 * `writeDocument` instead.
 */
export async function openSheetsFile(bytes: Uint8Array): Promise<OpenSheetsFile> {
  if (!bytes?.byteLength) throw new OfficeError('OFFICE_BAD_INPUT', 'cannot open an empty document')
  const { workbook, sheets } = await guarded('open workbook', () =>
    readWorkbookView(Buffer.from(bytes)),
  )
  const active = workbook.activeSheet ?? sheets.keys().next().value ?? ''
  const gridOf = (name: string): SheetGridView => {
    const grid = sheets.get(name)
    if (!grid) throw new OfficeError('OFFICE_BAD_INPUT', `no worksheet named "${name}"`)
    return grid
  }

  const editor: SheetsEditor = {
    getWorkbookSummary() {
      let totalCells = 0
      let totalFormulas = 0
      for (const grid of sheets.values()) {
        for (const text of Object.values(grid.cells)) {
          totalCells += 1
          if (text.startsWith('=')) totalFormulas += 1
        }
      }
      return {
        sheetNames: workbook.sheets.map((s) => s.name),
        activeSheet: active,
        totalCells,
        totalFormulas,
      }
    },

    readRange(r) {
      const grid = gridOf(r.sheet)
      const rows: CellValue[][] = []
      for (let row = r.startRow; row <= r.endRow; row++) {
        const line: CellValue[] = []
        for (let col = r.startCol; col <= r.endCol; col++) {
          const text = grid.cells[formatAddress(row, col)]
          // number formatting is not applied by the sidecar-free reader, so a
          // numeric-looking cell only reports `raw`; dates come back as serials
          line.push({ raw: text === undefined ? null : numeral(text) })
        }
        rows.push(line)
      }
      return rows
    },

    aggregateRange(r, op) {
      const values: number[] = []
      for (const line of editor.readRange(r))
        for (const cell of line) if (typeof cell.raw === 'number') values.push(cell.raw)
      if (values.length === 0) return null
      switch (op) {
        case 'count':
          return values.length
        case 'sum':
          return values.reduce((a, b) => a + b, 0)
        case 'avg':
          return values.reduce((a, b) => a + b, 0) / values.length
        case 'min':
          return Math.min(...values)
        case 'max':
          return Math.max(...values)
      }
    },

    findCells(sheet, query, maxResults = 100) {
      const grid = gridOf(sheet)
      const needle = query.toLowerCase()
      const hits: string[] = []
      for (const [address, text] of Object.entries(grid.cells)) {
        if (text.toLowerCase().includes(needle)) hits.push(address)
        if (hits.length >= maxResults) break
      }
      return hits.sort(byPosition)
    },

    getSheetFeatures(sheet) {
      gridOf(sheet)
      // The sidecar-free reader keeps cell values only, so merges and frozen
      // panes come back empty rather than guessed at.
      return { mergedRanges: [], frozenPanes: null }
    },
  }

  return { editor, workbook, close: () => {} }
}

/** A cell's stored text as a value: a bare number stays a number, everything else is text. */
function numeral(text: string): string | number {
  if (text === '') return ''
  const n = Number(text)
  return text.trim() !== '' && Number.isFinite(n) ? n : text
}

function byPosition(a: string, b: string): number {
  const col = (address: string) => /^([A-Z]+)(\d+)$/.exec(address) ?? ['', '', '']
  const [, ac = '', ar = ''] = col(a)
  const [, bc = '', br = ''] = col(b)
  if (ar.length !== br.length) return ar.length - br.length
  if (ar !== br) return Number(ar) - Number(br)
  return ac.length === bc.length ? ac.localeCompare(bc) : ac.length - bc.length
}

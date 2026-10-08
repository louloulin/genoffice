import { join } from 'node:path'
import {
  applyDocOps,
  closeDocument,
  describeDocument,
  documentHtml,
  headerFooterState,
  listComments,
  listRevisions,
  openDocument,
  saveDocument,
} from '@genoffice/cli/formats/docx'
import {
  applyOps as applyPptxOps,
  describeDeck,
  inlineLocalFiles,
  openDeck,
  saveDeck,
} from '@genoffice/cli/formats/pptx'
import { writeWorkbook } from '@genoffice/cli/formats/xlsx'
import { runWorkbookDsl } from '@genoffice/cli/formats/xlsx-dsl'
import { convertPdf, pdfInfo } from '@genoffice/cli/formats/pdf'
import { htmlToMarkdown, markdownToDocx, markdownToHtml } from '@genoffice/cli/formats/markdown'
import { csvInfo, csvToXlsx } from '@genoffice/cli/formats/csv'
import { rasterizePdf, type RasterizedPage } from '@genoffice/cli/formats/slide-spec'
import { docToText, pdfToText, pptToText, pptxToText, xlsxToText } from '@genoffice/file-parse'
import type { Op } from '@genoffice/pptx-ops'
import { detectFormat, type DocFormat } from './detect'
import { OfficeError } from './errors'
import { decodeText, guarded, makeCtx, readScratch, withTempDir } from './internal'
import {
  coordinatesOf,
  readWorkbookView,
  type SheetGridView,
  type WorkbookView,
} from './sheet-view'
import type { BlockSummary, CsvInfo, DeckSummary, PdfInfo } from './views'

export type {
  BlockSummary,
  CsvInfo,
  DeckSummary,
  ElementSummary,
  PdfInfo,
  SlideSummary,
} from './views'
export type { SheetGridView, SheetSummaryView, WorkbookView } from './sheet-view'

/** An op object in the same shape the in-app AI uses. The set of valid ops depends on the target format. */
export type OfficeOp = Record<string, unknown>

export interface ReadOptions {
  /** filename or extension hint; trusted when it names a known format */
  format?: DocFormat | string
  /** xlsx/xlsm: worksheet to read (default: the active one) */
  sheet?: string
  /** xlsx/xlsm: an A1 range to read instead of the whole sheet */
  range?: string
  /** xlsx/xlsm: include the number formats of each cell */
  formats?: boolean
  /** docx/pptx: keep whole text and every table row instead of previews */
  full?: boolean
  /** pptx: read only this 0-based slide */
  slide?: number
  /** pdf: password for an encrypted document */
  password?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface DocumentView {
  format: DocFormat
  /** the container family, i.e. which engine answered */
  kind: 'docx' | 'sheet' | 'slides' | 'pdf' | 'text'
  /** best-effort plain text; empty for containers with no text extractor (`.xls`, `.xlsb`, `.ods`) */
  text: string
  blocks?: BlockSummary[]
  html?: string
  comments?: unknown[]
  revisions?: unknown[]
  headerFooter?: unknown
  workbook?: WorkbookView
  sheet?: SheetGridView
  deck?: DeckSummary
  pdf?: PdfInfo
  csv?: CsvInfo
}

/** Reads any supported document into a uniform view; no LLM, no network. */
export async function readDocument(
  bytes: Uint8Array,
  opts: ReadOptions = {},
): Promise<DocumentView> {
  const format = detectFormat(bytes, { hint: opts.format })
  switch (format) {
    case 'docx':
      return guarded(`read .${format}`, () => readDocx(bytes, opts))
    case 'pptx':
      return guarded(`read .${format}`, () => readPptx(bytes, opts))
    case 'xlsx':
    case 'xlsm':
      return guarded(`read .${format}`, () => readSheetView(bytes, format, opts))
    case 'pdf':
      return guarded(`read .${format}`, () => readPdf(bytes, opts))
    case 'csv':
      return { format, kind: 'text', text: decodeText(bytes), csv: csvInfo(bytes) }
    case 'md':
    case 'markdown':
    case 'html':
    case 'htm':
    case 'txt':
      return { format, kind: 'text', text: decodeText(bytes) }
    case 'doc':
    case 'ppt':
      return { format, kind: 'text', text: await legacyText(format, bytes) }
    case 'xls':
    case 'xlsb':
    case 'ods':
      // no text extractor ships for these; convert to xlsx first (see `convert`)
      return { format, kind: 'text', text: '' }
  }
}

// ── reading ────────────────────────────────────────────────────────────

async function readDocx(bytes: Uint8Array, opts: ReadOptions): Promise<DocumentView> {
  const doc = await openDocument(bytes)
  try {
    const full = describeDocument(doc, undefined, true)
    return {
      format: 'docx',
      kind: 'docx',
      text: full.map((b) => b.text).join('\n\n'),
      blocks: opts.full ? full : describeDocument(doc, undefined, false),
      html: documentHtml(doc).html,
      comments: listComments(doc),
      revisions: listRevisions(doc),
      headerFooter: headerFooterState(doc),
    }
  } finally {
    closeDocument(doc)
  }
}

async function readPptx(bytes: Uint8Array, opts: ReadOptions): Promise<DocumentView> {
  const opened = await openDeck(bytes)
  return {
    format: 'pptx',
    kind: 'slides',
    text: await pptxToText(bytes),
    deck: describeDeck(opened, opts.slide, opts.full ?? false),
  }
}

async function readSheetView(
  bytes: Uint8Array,
  format: DocFormat,
  opts: ReadOptions,
): Promise<DocumentView> {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const { workbook, sheets } = await readWorkbookView(source)
  const wanted = opts.sheet ?? workbook.activeSheet
  let sheet = wanted !== null && wanted !== undefined ? sheets.get(wanted) : undefined
  if (sheet && opts.range) sheet = narrowToRange(sheet, opts.range)
  return {
    format,
    kind: 'sheet',
    text: await xlsxToText(bytes),
    workbook,
    ...(sheet ? { sheet } : {}),
  }
}

/** Narrows a grid to an A1 range (`A1:C10`), keeping the source's row/column bounds. */
function narrowToRange(sheet: SheetGridView, range: string): SheetGridView {
  const [start, end] = range.split(':')
  if (!start) return sheet
  const from = coordinatesOf(start.trim().toUpperCase())
  const to = end ? coordinatesOf(end.trim().toUpperCase()) : from
  if (!from || !to) return sheet
  const r0 = Math.min(from.row, to.row)
  const r1 = Math.max(from.row, to.row)
  const c0 = Math.min(from.column, to.column)
  const c1 = Math.max(from.column, to.column)
  const cells: Record<string, string> = {}
  for (const [address, text] of Object.entries(sheet.cells)) {
    const at = coordinatesOf(address)
    if (!at) continue
    if (at.row >= r0 && at.row <= r1 && at.column >= c0 && at.column <= c1) cells[address] = text
  }
  return { name: sheet.name, rows: r1 - r0 + 1, columns: c1 - c0 + 1, cells, truncated: sheet.truncated }
}

async function readPdf(bytes: Uint8Array, opts: ReadOptions): Promise<DocumentView> {
  const info = await pdfInfo(bytes, opts.password)
  let text = ''
  try {
    text = await pdfToText(bytes)
  } catch {
    // an encrypted or malformed page stream should not sink the structural read
  }
  return { format: 'pdf', kind: 'pdf', text, pdf: info }
}

async function legacyText(format: DocFormat, bytes: Uint8Array): Promise<string> {
  if (format === 'doc') return docToText(bytes)
  if (format === 'ppt') return pptToText(bytes)
  return ''
}

// ── writing ────────────────────────────────────────────────────────────

export interface WriteOptions {
  /** folder of the ops source, for relative image paths in docx ops */
  baseDir?: string
  /** xlsx: the worksheet the ops target by default */
  sheet?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Serializes a grid to RFC-4180 CSV over its used bounding box. */
function gridToCsv(sheet: SheetGridView): string {
  const byRow = new Map<number, Map<number, string>>()
  for (const [address, text] of Object.entries(sheet.cells)) {
    const at = coordinatesOf(address)
    if (!at) continue
    let row = byRow.get(at.row)
    if (!row) {
      row = new Map()
      byRow.set(at.row, row)
    }
    row.set(at.column, text)
  }
  const lines: string[] = []
  for (let r = 0; r < sheet.rows; r += 1) {
    const row = byRow.get(r)
    const cells: string[] = []
    for (let c = 0; c < sheet.columns; c += 1) cells.push(csvField(row?.get(c) ?? ''))
    lines.push(cells.join(','))
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Applies docx ops (the same syntax the in-app AI uses) and returns the saved bytes. */
export async function applyDocxOps(
  bytes: Uint8Array,
  ops: readonly OfficeOp[],
  opts: WriteOptions = {},
): Promise<Uint8Array> {
  return guarded('apply docx ops', async () => {
    const doc = await openDocument(bytes)
    try {
      await applyDocOps(doc, ops as Record<string, unknown>[], {
        ctx: makeCtx(opts),
        ...(opts.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
      })
      return await saveDocument(doc)
    } finally {
      closeDocument(doc)
    }
  })
}

/** Applies pptx ops (pptx-ops vocabulary) and returns the saved bytes. */
export async function applySlidesOps(
  bytes: Uint8Array,
  ops: readonly OfficeOp[],
  opts: WriteOptions = {},
): Promise<Uint8Array> {
  return guarded('apply pptx ops', async () => {
    const list = inlineLocalFiles(ops as Op[], makeCtx(opts))
    const opened = await openDeck(bytes)
    for (const [index, op] of list.entries()) {
      const r = applyPptxOps(opened, [op], { isolation: 'atomic' })
      if (!r.applied) {
        throw new OfficeError('OFFICE_BAD_INPUT', `pptx op ${index} (${op.op}) rejected`, {
          failures: r.failures ?? [],
        })
      }
    }
    return await saveDeck(opened)
  })
}

/** Applies workbook DSL ops (xlsx-dsl vocabulary) and returns the saved bytes. */
export async function applySheetOps(
  bytes: Uint8Array,
  ops: readonly OfficeOp[],
  opts: WriteOptions = {},
): Promise<Uint8Array> {
  return guarded('apply sheet ops', () =>
    withTempDir(async (dir) => {
      const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const r = await runWorkbookDsl(source, ops as unknown[], opts.sheet, makeCtx(opts))
      const out = join(dir, 'out.xlsx')
      await writeWorkbook(source, r.edits, out, {
        plan: r.sheetPlan,
        structuralOps: r.structuralOps,
        renames: r.renames,
        gateway: r.gateway,
      })
      return readScratch(out)
    }),
  )
}

/**
 * The unified op entry: dispatches on the container, so a host can edit a
 * document without first branching on its format.
 */
export async function applyDocumentOps(
  bytes: Uint8Array,
  ops: readonly OfficeOp[],
  opts: WriteOptions & { format?: DocFormat | string } = {},
): Promise<Uint8Array> {
  const format = detectFormat(bytes, { hint: opts.format })
  switch (format) {
    case 'docx':
      return applyDocxOps(bytes, ops, opts)
    case 'pptx':
      return applySlidesOps(bytes, ops, opts)
    case 'xlsx':
    case 'xlsm':
      return applySheetOps(bytes, ops, opts)
    default:
      throw new OfficeError('OFFICE_UNSUPPORTED', `cannot apply ops to a .${format} document`, {
        format,
        supported: ['docx', 'xlsx', 'xlsm', 'pptx'],
      })
  }
}

/** Alias of {@link applyDocumentOps}, for readers who think in "read/write". */
export { applyDocumentOps as writeDocument }

// ── conversion ──────────────────────────────────────────────────────────

/**
 * Conversions the library runs in-process. Mirrors the CLI's node routes, with
 * one caveat: the `xls|xlsb|ods → xlsx` entries route through the Rust sidecar,
 * so without one they surface as `OFFICE_NEEDS_SIDECAR` rather than converting.
 * Everything else here is pure TS.
 */
export const NODE_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pdf: ['docx', 'pptx', 'xlsx'],
  csv: ['xlsx'],
  xls: ['xlsx'],
  xlsb: ['xlsx'],
  ods: ['xlsx'],
  md: ['docx', 'html'],
  markdown: ['docx', 'html'],
  docx: ['md'],
  xlsx: ['csv'],
  xlsm: ['csv'],
})

/** Conversions that need an app renderer (Electron `--headless-export`) the library does not ship. */
export const APP_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  csv: ['pdf'],
  xls: ['pdf'],
  md: ['pdf'],
  markdown: ['pdf'],
  docx: ['pdf', 'html'],
  xlsx: ['pdf'],
  xlsm: ['pdf'],
  pptx: ['pdf'],
  html: ['pdf', 'docx'],
  htm: ['pdf', 'docx'],
})

export interface ConvertOptions {
  /** xlsx→csv: worksheet to export (default: the active one) */
  sheet?: string
  /** md→docx: title; also the docx→md fallback title */
  title?: string
  /** md→docx: the markdown file's path, so relative image paths resolve beside it */
  file?: string
  /** pdf: password for an encrypted document */
  password?: string
  onProgress?: (page: number, total: number) => void
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Converts between formats in-process. Only {@link NODE_ROUTES} are available; others need the app. */
export async function convert(
  bytes: Uint8Array,
  from: DocFormat | string,
  to: DocFormat | string,
  opts: ConvertOptions = {},
): Promise<Uint8Array> {
  const src = from.slice(from.lastIndexOf('.') + 1).toLowerCase()
  const dst = to.slice(to.lastIndexOf('.') + 1).toLowerCase()
  const targets = NODE_ROUTES[src]
  if (!targets?.includes(dst)) {
    if (APP_ROUTES[src]?.includes(dst)) {
      throw new OfficeError(
        'OFFICE_NEEDS_APP',
        `${src}→${dst} needs an app renderer (page layout for pdf, the Word HTML exporter, html2docx)`,
        { from: src, to: dst, hint: 'run it through the GenOffice app / headless-export' },
      )
    }
    throw new OfficeError('OFFICE_UNSUPPORTED', `cannot convert .${src} to .${dst}`, {
      from: src,
      to: dst,
      supported: NODE_ROUTES,
    })
  }

  if (src === 'pdf') {
    return guarded(`convert .${src}→.${dst}`, async () => {
      const r = await convertPdf(bytes, dst as 'docx' | 'pptx' | 'xlsx', {
        ...(opts.password !== undefined ? { password: opts.password } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      })
      return r.bytes
    })
  }
  return guarded(`convert .${src}→.${dst}`, async () => {
    if (src === 'csv') {
      const name = (opts.title ?? 'Sheet1').slice(0, 31) || 'Sheet1'
      return csvToXlsx(bytes, name)
    }
    if (src === 'md' || src === 'markdown') {
      const text = decodeText(bytes)
      const title = opts.title ?? 'document'
      if (dst === 'html') return new TextEncoder().encode(await markdownToHtml(text, title))
      return markdownToDocx(text, { file: opts.file ?? title, ctx: makeCtx(opts) })
    }
    if (src === 'docx') {
      const doc = await openDocument(bytes)
      try {
        const markdown = await htmlToMarkdown(documentHtml(doc).html)
        return new TextEncoder().encode(markdown.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
      } finally {
        closeDocument(doc)
      }
    }
    if (dst === 'csv') {
      const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const { workbook, sheets } = await readWorkbookView(source)
      const wanted = opts.sheet ?? workbook.activeSheet
      const sheet = wanted ? sheets.get(wanted) : undefined
      if (!sheet) {
        throw new OfficeError('OFFICE_BAD_INPUT', `no worksheet named ${wanted ?? '(active)'}`, {
          from: src,
          sheet: wanted,
          available: workbook.sheets.map((s) => s.name),
        })
      }
      // UTF-8 BOM, as the app writes it, so Excel opens the file without a wizard
      return new TextEncoder().encode('﻿' + gridToCsv(sheet))
    }
    // xls / xlsb / ods → xlsx goes through the Rust sidecar, which is not part of the default build
    throw new OfficeError(
      'OFFICE_NEEDS_SIDECAR',
      `${src}→xlsx needs the xlsx sidecar (not bundled); convert the file first or run it through the app`,
      { from: src, to: dst, hint: 'set XLSX_SIDECAR_PATH to a sidecar binary' },
    )
  })
}

// ── rendering ───────────────────────────────────────────────────────────

export interface RenderOptions {
  /** pixels per point (2 = 144 dpi); default 1 */
  scale?: number
  /** 0-based page to render; all pages when absent */
  pages?: number[]
  /** pdf: password for an encrypted document */
  password?: string
}

/**
 * Rasterizes a document to one PNG per page. PDF is rendered in-process with
 * pdfium; every other format is printed to PDF by the app first, so it comes
 * back as `OFFICE_NEEDS_APP`.
 */
export async function render(
  bytes: Uint8Array,
  opts: RenderOptions & { format?: DocFormat | string } = {},
): Promise<Uint8Array[]> {
  const format = detectFormat(bytes, { hint: opts.format })
  if (format !== 'pdf') {
    throw new OfficeError('OFFICE_NEEDS_APP', `rendering .${format} needs the app (print to pdf first)`, {
      format,
      hint: 'convert to pdf via the GenOffice app, then rasterize the pdf here',
    })
  }
  const scale = opts.scale ?? 1
  const pages = opts.pages ?? []
  return guarded('render pdf', async () => {
    if (pages.length === 0) {
      const out: RasterizedPage[] = await rasterizePdf(bytes, scale, undefined, undefined, opts.password)
      return out.map((p) => p.png)
    }
    const rendered: Uint8Array[] = []
    for (const page of pages) {
      const [one] = await rasterizePdf(bytes, scale, page, undefined, opts.password)
      if (one) rendered.push(one.png)
    }
    return rendered
  })
}

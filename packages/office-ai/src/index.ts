/**
 * `@genoffice/office-ai` — the headless Office document engine.
 *
 * Tier 1 (exported here): read, convert, render and op-level edit
 * docx/xlsx/pptx/pdf (+md/html/csv) as pure byte-in / byte-out functions.
 * Runs in-process: no Electron, no HTTP, no model calls.
 *
 * Tier 2 (also here): a stateful {@link openSession} and a host-agnostic
 * {@link officeTools} set, for an agent loop rather than a pipeline. No pi
 * dependency, so any agent host can map the tools onto its own tool type.
 *
 * Tier 3 (AI runtime, pi-coupled) is a separate entry point.
 */
export {
  // tier 1 — document engine
  readDocument,
  writeDocument,
  applyDocumentOps,
  applyDocxOps,
  applySheetOps,
  applySlidesOps,
  convert,
  render,
  NODE_ROUTES,
  APP_ROUTES,
  type DocumentView,
  type ReadOptions,
  type WriteOptions,
  type ConvertOptions,
  type RenderOptions,
  type OfficeOp,
  // re-exported payload types the views carry
  type BlockSummary,
  type CsvInfo,
  type DeckSummary,
  type ElementSummary,
  type PdfInfo,
  type SheetGridView,
  type SheetSummaryView,
  type SlideSummary,
  type WorkbookView,
} from './documents'

export { detectFormat, formatExtension, type DocFormat } from './detect'
export { OfficeError, isOfficeError, type OfficeErrorCode } from './errors'

// tier 2 — a stateful session and the host-agnostic Office tool set
export {
  openSession,
  sessionExtension,
  type DocumentSession,
  type OpenSessionOptions,
} from './session'
export {
  officeTools,
  OFFICE_TOOL_NAMES,
  type OfficeTool,
  type OfficeToolFile,
  type OfficeToolName,
  type OfficeToolResult,
  type OfficeToolSchema,
  type OfficeToolbox,
  type OfficeToolboxOptions,
} from './tools'

// tier 2 — file-backed editor adapters: open once, edit with editor semantics, save
export {
  openDocsFile,
  openSheetsFile,
  type CellValue,
  type DocsBlock,
  type DocsEditor,
  type OpenDocsFile,
  type OpenDocsFileOptions,
  type OpenSheetsFile,
  type SheetsEditor,
  type SheetsRange,
  type WorkbookSummary,
} from './file-editor'

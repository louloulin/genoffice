/**
 * Host-agnostic tool definitions over a document session — the "Office Skills"
 * tier of the SDK, without the renderer or pi.
 *
 * The repo's existing skill tools (`@genoffice/agent-skills`) are pi tools wired
 * to a React UI adapter, so they only run inside the Electron app. This module
 * is the same capability expressed as plain data: a name, a description, a JSON
 * Schema, and an `execute`. Any agent host can map that onto its own tool type
 * (aiwork maps them onto `@dfn/agent-kernel`), and nothing here imports pi.
 *
 * Failures come back as a normal result carrying `data.error`, not a throw —
 * an agent loop should see the error and adapt, the same way its other tools
 * report failure.
 */
import type { DocumentView, OfficeOp } from './documents'
import { OfficeError, isOfficeError } from './errors'
import { openSession, type DocumentSession, type OpenSessionOptions } from './session'

// ── shapes ────────────────────────────────────────────────────────────────

/** The JSON Schema subset tools need; hosts accept it as-is. */
export interface OfficeToolSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface OfficeToolFile {
  name: string
  mimeType: string
  bytes: Uint8Array
}

export interface OfficeToolResult {
  /** What the model reads. */
  text: string
  /** Structured payload for the host (`undefined` when there is nothing to add). */
  data?: Record<string, unknown>
  /** Files the tool produced, for the host to store. */
  files?: OfficeToolFile[]
}

export interface OfficeTool {
  name: string
  description: string
  parameters: OfficeToolSchema
  execute(args?: Record<string, unknown>): Promise<OfficeToolResult>
}

export interface OfficeToolbox {
  tools: OfficeTool[]
  /** Loads a document into the toolbox; every tool then works on it. */
  open(bytes: Uint8Array, opts?: OpenSessionOptions): Promise<DocumentView>
  /** Serializes the loaded document (converting when `to` names another format). */
  save(to?: string): Promise<Uint8Array>
  /** The session, or `undefined` before `open`. */
  session(): DocumentSession | undefined
  /** The last view read by `open` or an edit tool, or `undefined`. */
  view(): DocumentView | undefined
}

export interface OfficeToolboxOptions {
  /** Restrict the tool list, e.g. `['read_document', 'apply_ops']`. Unknown names are ignored. */
  only?: readonly string[]
  /** Default worksheet for the sheet tools when an argument omits one. */
  sheet?: string
  /** Cap on characters a single read may return (default 200_000). */
  maxChars?: number
  /** Working directory for relative paths inside ops. */
  cwd?: string
  env?: NodeJS.ProcessEnv
}

// ── helpers ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHARS = 200_000

const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
  md: 'text/markdown',
  html: 'text/html',
  txt: 'text/plain',
  png: 'image/png',
}

const EXT: Record<string, string> = { markdown: 'md', htm: 'html' }

function mimeOf(format: string): string {
  return MIME[format] ?? 'application/octet-stream'
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Truncates with a notice the model can act on, rather than silently cutting. */
function clamp(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  return {
    text: `${s.slice(0, max)}\n\n[truncated at ${max} of ${s.length} characters — narrow the request]`,
    truncated: true,
  }
}

function asInt(value: unknown, fallback?: number): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Runs a tool body, turning an OfficeError into a result the model can read. */
async function guarded(
  label: string,
  fn: () => Promise<OfficeToolResult> | OfficeToolResult,
): Promise<OfficeToolResult> {
  try {
    return await fn()
  } catch (error) {
    const code = isOfficeError(error) ? (error as OfficeError).code : 'OFFICE_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)
    return { text: `${label} failed [${code}]: ${message}`, data: { error: { code, message } } }
  }
}

// ── the toolbox ────────────────────────────────────────────────────────────

/**
 * Builds the headless Office tool set. The returned box holds one open document;
 * `open` replaces it. Every tool reads or edits that document and nothing else —
 * no network, no model calls.
 */
export function officeTools(opts: OfficeToolboxOptions = {}): OfficeToolbox {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  let session: DocumentSession | undefined
  let lastView: DocumentView | undefined

  const require = (): DocumentSession => {
    if (!session) {
      throw new OfficeError('OFFICE_BAD_INPUT', 'no document is open — call open() first')
    }
    return session
  }

  const defaultSheet = (arg: unknown): string | undefined => asString(arg) ?? opts.sheet

  const tools: OfficeTool[] = [
    {
      name: 'get_document_context',
      description:
        'Summarize the open document: its format and the structure the other tools address (block indexes, sheet names, slide indexes, page count). Call this before editing when you are unsure of the current state.',
      parameters: { type: 'object', properties: {} },
      execute: () =>
        guarded('get_document_context', async () => {
          const view = lastView ?? (await require().read())
          lastView = view
          return { text: describeContext(view), data: { format: view.format, kind: view.kind } }
        }),
    },

    {
      name: 'read_document',
      description:
        'Read the open document as text, plus structure: docx paragraphs and blocks, a sheet grid, a slide deck, or PDF page info. Use `sheet`/`range` to narrow a workbook, `slide` to narrow a deck.',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'keep whole text instead of previews (docx/pptx)' },
          sheet: { type: 'string', description: 'worksheet to read (workbooks)' },
          range: { type: 'string', description: 'A1 range to read instead of the whole sheet, e.g. A1:D20' },
          slide: { type: 'integer', description: '0-based slide to read (decks)' },
        },
      },
      execute: (args = {}) =>
        guarded('read_document', async () => {
          const view = await require().read({
            ...(asString(args.sheet) ? { sheet: asString(args.sheet)! } : {}),
            ...(asString(args.range) ? { range: asString(args.range)! } : {}),
            ...(asInt(args.slide) !== undefined ? { slide: asInt(args.slide)! } : {}),
            ...(args.full === true ? { full: true } : {}),
          })
          lastView = view
          const body = clamp(view.text, maxChars)
          return {
            text: `${describeContext(view)}\n\n${body.text}`,
            data: { format: view.format, kind: view.kind, truncated: body.truncated },
          }
        }),
    },

    {
      name: 'read_blocks',
      description:
        'Read a paragraph block range of a docx with its text, so you can rewrite it accurately. Previews in get_document_context are shortened; read the full text here before replacing.',
      parameters: {
        type: 'object',
        properties: {
          startBlockIndex: { type: 'integer', description: 'start block index, 0-based inclusive' },
          endBlockIndex: { type: 'integer', description: 'end block index, inclusive' },
        },
        required: ['startBlockIndex', 'endBlockIndex'],
      },
      execute: (args = {}) =>
        guarded('read_blocks', async () => {
          const view = await require().read({ full: true })
          lastView = view
          const blocks = view.blocks ?? []
          const start = asInt(args.startBlockIndex, 0)!
          const end = asInt(args.endBlockIndex, blocks.length - 1)!
          if (!blocks.length) return { text: 'This document has no blocks.', data: { blockCount: 0 } }
          if (start < 0 || end < start || start >= blocks.length) {
            return {
              text: `Invalid range [${start}, ${end}] — the document has ${blocks.length} block(s).`,
              data: { blockCount: blocks.length },
            }
          }
          const slice = blocks.slice(start, Math.min(end, blocks.length - 1) + 1)
          const body = clamp(slice.map((b) => `[${b.index}] ${b.type}${b.level ? ` h${b.level}` : ''}: ${b.text}`).join('\n'), maxChars)
          return {
            text: `${slice.length} block(s) of ${blocks.length}\n${body.text}`,
            data: { blockCount: blocks.length, from: start, to: end, truncated: body.truncated },
          }
        }),
    },

    {
      name: 'insert_content',
      description:
        'Insert new content into a docx at a position (restricted HTML, may span several blocks). Use it to write new material; to rewrite existing material use replace_blocks.',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string', description: 'restricted HTML fragment to insert' },
          afterBlockIndex: {
            type: 'integer',
            description: 'insert after this block index; -1 = start of document; omitted = end of document',
          },
        },
        required: ['html'],
      },
      execute: (args = {}) =>
        guarded('insert_content', async () => {
          const html = asString(args.html)
          if (!html) return { text: 'insert_content needs a non-empty `html` argument.' }
          const after = asInt(args.afterBlockIndex)
          const view = await require().edit([
            { op: 'insert_content', html, ...(after !== undefined ? { afterBlockIndex: after } : {}) },
          ])
          lastView = view
          return { text: `Inserted into the document; it now has ${view.blocks?.length ?? 0} block(s).`, data: { blocks: view.blocks?.length ?? 0 } }
        }),
    },

    {
      name: 'replace_blocks',
      description:
        "Replace a block range of a docx with new content (restricted HTML). Use it to rewrite, translate, condense or expand existing text; the replacement may have a different block count and inherits the replaced blocks' formatting.",
      parameters: {
        type: 'object',
        properties: {
          startBlockIndex: { type: 'integer', description: 'start block index, 0-based inclusive' },
          endBlockIndex: { type: 'integer', description: 'end block index, inclusive' },
          html: { type: 'string', description: 'replacement restricted HTML fragment' },
        },
        required: ['startBlockIndex', 'endBlockIndex', 'html'],
      },
      execute: (args = {}) =>
        guarded('replace_blocks', async () => {
          const html = asString(args.html)
          const start = asInt(args.startBlockIndex)
          const end = asInt(args.endBlockIndex)
          if (!html || start === undefined || end === undefined) {
            return { text: 'replace_blocks needs startBlockIndex, endBlockIndex and html.' }
          }
          const view = await require().edit([{ op: 'replace_blocks', startBlockIndex: start, endBlockIndex: end, html }])
          lastView = view
          return { text: `Replaced blocks ${start}–${end}; the document now has ${view.blocks?.length ?? 0} block(s).`, data: { blocks: view.blocks?.length ?? 0 } }
        }),
    },

    {
      name: 'replace_document',
      description:
        'Replace the whole document body with new HTML, implemented as a replace of every block. Destructive — use it only when everything is meant to be rewritten; prefer replace_blocks or insert_content otherwise.',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string', description: 'the new document body as restricted HTML' },
          reason: { type: 'string', description: 'why the whole document is being replaced' },
        },
        required: ['html'],
      },
      execute: (args = {}) =>
        guarded('replace_document', async () => {
          const html = asString(args.html)
          if (!html) return { text: 'replace_document needs a non-empty `html` argument.' }
          const current = require()
          const before = lastView?.blocks?.length ?? (await current.read({})).blocks?.length ?? 0
          const view = before
            ? await current.edit([
                { op: 'replace_blocks', startBlockIndex: 0, endBlockIndex: before - 1, html },
              ])
            : await current.edit([{ op: 'insert_content', html, afterBlockIndex: -1 }])
          lastView = view
          return {
            text: `Replaced the document body (${before} block(s) → ${view.blocks?.length ?? 0}).`,
            data: { replaced: before, blocks: view.blocks?.length ?? 0 },
          }
        }),
    },

    {
      name: 'apply_ops',
      description:
        'Apply format-native ops in one batch, the escape hatch for anything the other tools do not cover. docx formatting ops: setFont, setMatchedFont, setParagraphFormat, setHeadingLevel, stepIndent, stepHangingIndent, setList, clearList, moveBlocks, deleteBlocks, findReplace, setImageProperties, insertToc. Workbooks take the DSL (set_cell, set_formula, add_sheet, rename_sheet, merge_cells, set_col_width, set_row_height, set_freeze, protect_sheet, add_chart, …). Decks take the pptx ops.',
      parameters: {
        type: 'object',
        properties: {
          ops: { type: 'array', items: { type: 'object' }, description: 'the ops to apply, in order' },
        },
        required: ['ops'],
      },
      execute: (args = {}) =>
        guarded('apply_ops', async () => {
          const ops = Array.isArray(args.ops) ? (args.ops as OfficeOp[]) : []
          if (!ops.length) return { text: 'apply_ops needs a non-empty `ops` array.' }
          const view = await require().edit(ops)
          lastView = view
          return { text: `Applied ${ops.length} op(s).`, data: { applied: ops.length } }
        }),
    },

    {
      name: 'read_range',
      description:
        'Read a rectangular range of a worksheet as tab-separated rows (row-major). Use A1 notation; omit the range to read the whole sheet.',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'worksheet name; defaults to the active one' },
          range: { type: 'string', description: 'A1 range, e.g. A1:D20' },
        },
      },
      execute: (args = {}) =>
        guarded('read_range', async () => {
          const view = await require().read({
            ...(defaultSheet(args.sheet) ? { sheet: defaultSheet(args.sheet)! } : {}),
            ...(asString(args.range) ? { range: asString(args.range)! } : {}),
          })
          lastView = view
          const grid = view.sheet
          if (!grid) return { text: 'This document has no worksheet.', data: { rows: 0, columns: 0 } }
          const rows = gridToRows(grid.cells)
          const body = clamp(rows.map((row) => row.join('\t')).join('\n'), maxChars)
          return {
            text: `${grid.name}!${asString(args.range) ?? `${grid.rows}x${grid.columns}`}\n${body.text}`,
            data: { sheet: grid.name, rows: grid.rows, columns: grid.columns, truncated: body.truncated },
          }
        }),
    },

    {
      name: 'find_cells',
      description:
        'Find cells in a worksheet whose value contains a substring (case-insensitive). Returns A1 references.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'substring to look for' },
          sheet: { type: 'string', description: 'worksheet name; defaults to the active one' },
          maxResults: { type: 'integer', description: 'cap on matches (default 20)' },
        },
        required: ['query'],
      },
      execute: (args = {}) =>
        guarded('find_cells', async () => {
          const query = asString(args.query)
          if (!query) return { text: 'find_cells needs a `query`.' }
          const view = await require().read({
            ...(defaultSheet(args.sheet) ? { sheet: defaultSheet(args.sheet)! } : {}),
          })
          lastView = view
          const cells = view.sheet?.cells ?? {}
          const needle = query.toLowerCase()
          const max = asInt(args.maxResults, 20)!
          const hits: string[] = []
          for (const [address, value] of Object.entries(cells)) {
            if (value.toLowerCase().includes(needle)) hits.push(address)
            if (hits.length >= max) break
          }
          return {
            text: hits.length ? `Found ${hits.length} cell(s): ${hits.join(', ')}` : 'No matches.',
            data: { count: hits.length, cells: hits },
          }
        }),
    },

    {
      name: 'aggregate_range',
      description: 'Aggregate the numeric cells of a worksheet range: sum, avg, count, min or max.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'], description: 'aggregation' },
          sheet: { type: 'string', description: 'worksheet name; defaults to the active one' },
          range: { type: 'string', description: 'A1 range, e.g. B2:B40' },
        },
        required: ['op'],
      },
      execute: (args = {}) =>
        guarded('aggregate_range', async () => {
          const op = asString(args.op)
          if (!op || !['sum', 'avg', 'count', 'min', 'max'].includes(op)) {
            return { text: 'aggregate_range needs `op` to be sum, avg, count, min or max.' }
          }
          const view = await require().read({
            ...(defaultSheet(args.sheet) ? { sheet: defaultSheet(args.sheet)! } : {}),
            ...(asString(args.range) ? { range: asString(args.range)! } : {}),
          })
          lastView = view
          const values = Object.values(view.sheet?.cells ?? {})
            .map((v) => Number(v.replaceAll(',', '').trim()))
            .filter((n) => Number.isFinite(n))
          const result =
            op === 'count' || !values.length
              ? values.length
              : op === 'sum'
                ? values.reduce((a, b) => a + b, 0)
                : op === 'avg'
                  ? values.reduce((a, b) => a + b, 0) / values.length
                  : op === 'min'
                    ? Math.min(...values)
                    : Math.max(...values)
          return { text: `${op} = ${result}`, data: { op, result, count: values.length } }
        }),
    },

    {
      name: 'set_cells',
      description:
        'Write values into cells of a worksheet. Addresses use A1 notation; a leading `=` in a value is stored as a formula.',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'worksheet name; defaults to the active one' },
          cells: {
            type: 'array',
            description: 'the cells to write, as { address, value }',
            items: {
              type: 'object',
              properties: { address: { type: 'string' }, value: { type: 'string' } },
              required: ['address', 'value'],
            },
          },
        },
        required: ['cells'],
      },
      execute: (args = {}) =>
        guarded('set_cells', async () => {
          const raw = Array.isArray(args.cells) ? args.cells : []
          const sheet = defaultSheet(args.sheet)
          const ops: OfficeOp[] = []
          for (const cell of raw) {
            const c = cell as { address?: unknown; value?: unknown }
            const address = asString(c.address)
            if (!address) continue
            ops.push({
              op: c.value !== undefined && String(c.value).startsWith('=') ? 'set_formula' : 'set_cell',
              ...(sheet ? { sheet } : {}),
              address,
              ...(c.value !== undefined && String(c.value).startsWith('=')
                ? { formula: String(c.value) }
                : { value: c.value === undefined ? '' : String(c.value) }),
            })
          }
          if (!ops.length) return { text: 'set_cells needs a non-empty `cells` array of { address, value }.' }
          const view = await require().edit(ops)
          lastView = view
          return { text: `Wrote ${ops.length} cell(s).`, data: { written: ops.length, sheet: view.sheet?.name } }
        }),
    },

    {
      name: 'read_comments',
      description: 'List the review comments on a docx, with their anchors, authors and replies.',
      parameters: { type: 'object', properties: {} },
      execute: () =>
        guarded('read_comments', async () => {
          const view = await require().read({})
          lastView = view
          const comments = (view.comments ?? []) as Array<Record<string, unknown>>
          if (!comments.length) return { text: 'No comments on this document.', data: { count: 0 } }
          const lines = comments.map((c, i) => {
            const author = String(c.author ?? c.user ?? '?')
            const body = String(c.text ?? c.body ?? '')
            const replies = Array.isArray(c.replies) ? ` (+${(c.replies as unknown[]).length} repl${(c.replies as unknown[]).length === 1 ? 'y' : 'ies'})` : ''
            return `[${i}] ${author}: ${body}${replies}`
          })
          return { text: `${comments.length} comment(s)\n${lines.join('\n')}`, data: { count: comments.length } }
        }),
    },

    {
      name: 'convert_document',
      description:
        'Convert the open document to another format and return the file. In-process targets: docx→md, xlsx→csv, csv→xlsx, md→docx|html, pdf→docx|pptx|xlsx. Anything else (notably *→pdf) needs the GenOffice app and reports OFFICE_NEEDS_APP.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'target format or extension, e.g. csv, docx, md' },
          sheet: { type: 'string', description: 'xlsx→csv: which worksheet to export' },
          title: { type: 'string', description: 'md→docx: document title' },
        },
        required: ['to'],
      },
      execute: (args = {}) =>
        guarded('convert_document', async () => {
          const to = asString(args.to)
          if (!to) return { text: 'convert_document needs a `to` format.' }
          const current = require()
          const dst = to.slice(to.lastIndexOf('.') + 1).toLowerCase()
          const bytes = await current.save(dst, {
            ...(asString(args.sheet) ? { sheet: asString(args.sheet)! } : {}),
            ...(asString(args.title) ? { title: asString(args.title)! } : {}),
          })
          const ext = EXT[dst] ?? dst
          return {
            text: `Converted to .${ext} (${bytes.byteLength} bytes).`,
            data: { format: ext, bytes: bytes.byteLength },
            files: [{ name: `document.${ext}`, mimeType: mimeOf(dst), bytes }],
          }
        }),
    },

    {
      name: 'render_pages',
      description:
        'Rasterize a PDF to one PNG per page. Only PDF renders in-process; other formats must be converted to PDF by the GenOffice app first and report OFFICE_NEEDS_APP.',
      parameters: {
        type: 'object',
        properties: {
          pages: { type: 'array', items: { type: 'integer' }, description: '0-based pages; omit for all' },
          scale: { type: 'number', description: 'pixels per point (2 = 144 dpi); default 1' },
        },
      },
      execute: (args = {}) =>
        guarded('render_pages', async () => {
          const pages = Array.isArray(args.pages) ? (args.pages.map((p) => asInt(p)).filter((p) => p !== undefined) as number[]) : undefined
          const scale = Number(args.scale)
          const pngs = await require().render({
            ...(pages?.length ? { pages } : {}),
            ...(Number.isFinite(scale) ? { scale } : {}),
          })
          return {
            text: `Rendered ${pngs.length} page(s).`,
            data: { pages: pngs.length },
            files: pngs.map((bytes, i) => ({ name: `page-${i + 1}.png`, mimeType: 'image/png', bytes })),
          }
        }),
    },
  ]

  const only = opts.only ? new Set(opts.only) : undefined
  const selected = only ? tools.filter((t) => only.has(t.name)) : tools

  return {
    tools: selected,
    async open(bytes, openOpts) {
      session = await openSession(bytes, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...openOpts,
      })
      lastView = await session.read({})
      return lastView
    },
    save: (to) => require().save(to),
    session: () => session,
    view: () => lastView,
  }
}

/** The tool names this module ships, for a host that wants to advertise them up front. */
export const OFFICE_TOOL_NAMES = [
  'get_document_context',
  'read_document',
  'read_blocks',
  'insert_content',
  'replace_blocks',
  'replace_document',
  'apply_ops',
  'read_range',
  'find_cells',
  'aggregate_range',
  'set_cells',
  'read_comments',
  'convert_document',
  'render_pages',
] as const

export type OfficeToolName = (typeof OFFICE_TOOL_NAMES)[number]

// ── view rendering ─────────────────────────────────────────────────────────

/** One line about the document's structure, whichever kind it is. */
function describeContext(view: DocumentView): string {
  switch (view.kind) {
    case 'docx': {
      const blocks = view.blocks ?? []
      const headings = blocks.filter((b) => b.type === 'heading').length
      const comments = (view.comments ?? []).length
      return `docx: ${blocks.length} block(s), ${headings} heading(s), ${comments} comment(s), ${view.text.length} characters`
    }
    case 'sheet': {
      const sheets = view.workbook?.sheets ?? []
      const names = sheets.map((s) => s.name).join(', ')
      const active = view.workbook?.activeSheet ?? view.sheet?.name ?? '?'
      return `workbook: ${sheets.length} sheet(s) [${names}]; active "${active}"; current ${view.sheet?.rows ?? 0}×${view.sheet?.columns ?? 0}`
    }
    case 'slides': {
      const deck = view.deck
      const elements = deck?.pages.reduce((n, s) => n + s.elements.length, 0) ?? 0
      return `deck: ${deck?.slides ?? 0} slide(s), ${elements} element(s)`
    }
    case 'pdf':
      return `pdf: ${view.pdf?.pages ?? '?'} page(s)${view.pdf?.encrypted ? ' (encrypted)' : ''}`
    default:
      return `${view.format}: ${view.text.length} characters of text`
  }
}

/** Paints a sparse A1-keyed grid into a dense row-major matrix over its bounds. */
function gridToRows(cells: Record<string, string>): string[][] {
  const parsed = Object.entries(cells)
    .map(([address, value]) => {
      const m = /^([A-Z]+)(\d+)$/.exec(address)
      if (!m) return null
      let column = 0
      for (const ch of m[1]!) column = column * 26 + (ch.charCodeAt(0) - 64)
      return { row: Number(m[2]) - 1, column: column - 1, value }
    })
    .filter((c): c is { row: number; column: number; value: string } => c !== null)
  if (!parsed.length) return []
  const rows = Math.max(...parsed.map((c) => c.row)) + 1
  const columns = Math.max(...parsed.map((c) => c.column)) + 1
  const matrix: string[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''))
  for (const cell of parsed) matrix[cell.row]![cell.column] = cell.value
  return matrix
}

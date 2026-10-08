/**
 * A document held open in memory — the stateful half of the library.
 *
 * Tier 1 is byte-in / byte-out, which suits a pipeline but not an agent loop:
 * an agent wants to open once, look at the structure, apply a few edits, and
 * save. `DocumentSession` is exactly that, with no renderer and no filesystem
 * (the bytes live in the session; the caller decides where they land).
 */
import {
  applyDocumentOps,
  convert,
  readDocument,
  render,
  type ConvertOptions,
  type DocumentView,
  type OfficeOp,
  type ReadOptions,
  type RenderOptions,
  type WriteOptions,
} from './documents'
import { detectFormat, formatExtension, type DocFormat } from './detect'
import { OfficeError } from './errors'

/** Ops are format-native: docx tool inputs, the workbook DSL, or pptx ops. */
export interface DocumentSession {
  /** The format detected when the session opened; edits never change it. */
  readonly format: DocFormat
  /** Current bytes. A fresh copy on every call — mutating it does not affect the session. */
  bytes(): Uint8Array
  /** Re-reads the current state (blocks / grid / deck / pdf info / text). */
  read(opts?: ReadOptions): Promise<DocumentView>
  /** Applies format-native ops, keeps the result, and returns the new view. */
  edit(ops: readonly OfficeOp[], opts?: WriteOptions): Promise<DocumentView>
  /**
   * Serializes the document. With `to` set to another format the session first
   * converts; only `NODE_ROUTES` are available in-process, everything else
   * surfaces as `OFFICE_NEEDS_APP`. The session's own bytes are left alone
   * either way.
   */
  save(to?: string, opts?: ConvertOptions): Promise<Uint8Array>
  /** Rasterizes the document to one PNG per page (PDF only, in-process). */
  render(opts?: RenderOptions): Promise<Uint8Array[]>
}

export interface OpenSessionOptions extends ReadOptions {
  /** Working directory for relative paths inside ops (docx image paths). */
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Opens a document for repeated read/edit/save. The bytes are copied, not adopted. */
export async function openSession(
  bytes: Uint8Array,
  opts: OpenSessionOptions = {},
): Promise<DocumentSession> {
  if (!bytes?.byteLength) throw new OfficeError('OFFICE_BAD_INPUT', 'cannot open an empty document')
  const format = detectFormat(bytes, { hint: opts.format })
  let current: Uint8Array = Uint8Array.from(bytes)
  const base: WriteOptions = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }

  return {
    format,
    bytes: () => Uint8Array.from(current),
    read: (readOpts) => readDocument(current, readOpts ?? {}),
    async edit(ops, writeOpts) {
      const next = await applyDocumentOps(current, ops, {
        ...base,
        ...writeOpts,
        format: (writeOpts as { format?: string } | undefined)?.format ?? format,
      })
      current = next
      return readDocument(current, {})
    },
    async save(to, convertOpts) {
      const dst = to ? to.slice(to.lastIndexOf('.') + 1).toLowerCase() : format
      if (dst === format) return Uint8Array.from(current)
      return convert(current, format, dst, convertOpts)
    },
    render: (renderOpts) => render(current, { format, ...renderOpts }),
  }
}

/** The file extension a session would save as, e.g. `docx`. */
export function sessionExtension(session: DocumentSession, to?: string): string {
  return to ? to.slice(to.lastIndexOf('.') + 1).toLowerCase() : formatExtension(session.format)
}

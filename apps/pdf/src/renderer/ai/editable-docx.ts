/**
 * PDF → editable DOCX: the fallback for a PDF whose layout the in-place text
 * rewrite cannot carry faithfully.
 *
 * ## Why this is a fallback and not the main path
 *
 * The main path rewrites the PDF in place through the engine's own pending-edit
 * queue (`TextEditInput` / `TextInsertInput` → `pdf:save` swaps the page
 * objects). That preserves the original file byte-for-byte apart from the text
 * runs it replaced, which is what a reader of a translated PDF expects. This
 * module is for the other case: complex multi-column or font-embedded layouts
 * where that rewrite is the wrong tool, and the user would rather have an
 * editable Word document than a PDF that half-converted.
 *
 * ## What it does NOT do
 *
 * It does not translate. The DOCX it produces is the document's content in an
 * editable form; the translation of that DOCX is the docs app's whole-document
 * pipeline, which already exists and is already reachable. Folding a second
 * translation engine in here would mean a tiptap editor in a PDF application.
 * The outcome therefore always says plainly that the file is a converted,
 * *untranslated* starting point — a fallback that quietly handed over
 * untranslated bytes while claiming to be a translation is worse than no
 * fallback at all.
 *
 * ## Why the failure reasons are kept apart
 *
 * "encrypted", "not a PDF", "nothing to convert" and "the upload was refused"
 * are four different things a user can act on, and collapsing them into one
 * "conversion failed" is what makes a fallback feel broken.
 */
import { DRIVE_NAME_MAX_LENGTH } from '@genoffice/translation-core/translated-file-name'

// The wire shape is declared next to the channel it belongs to, so the
// transport contract and this module's consumer of it cannot drift apart.
import type { EditableDocxResult, PdfToDocxResponse } from '../../shared/ipc'

/** MIME for a Word document; the host files the bytes by this, not by the open document's type. */
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const NAME_SUFFIX = 'editable'
const FALLBACK_NAME = 'untitled'


/**
 * `手册.pdf` → `手册.editable.docx`.
 *
 * Not `deriveTranslatedName`, which deliberately *preserves* the extension —
 * correct when a translation keeps the format, wrong here, where the whole
 * point is that the format changed. Truncation follows the same rule as the
 * shared helper: the base gives way, the `.editable.docx` tail never does,
 * because that tail is what tells a drive listing this file is a conversion.
 */
export function deriveEditableDocxName(original: string | null | undefined): string {
  const name = original && original.trim() ? original.trim() : FALLBACK_NAME
  const dot = name.lastIndexOf('.')
  // A leading dot (`.gitignore`) or a trailing one leaves the whole name as base.
  const hasExt = dot > 0 && dot < name.length - 1
  const base = hasExt ? name.slice(0, dot) : name
  const tail = `.${NAME_SUFFIX}.docx`
  const room = DRIVE_NAME_MAX_LENGTH - tail.length
  if (room <= 0) return `${FALLBACK_NAME}${tail}`
  const trimmedBase = base.length > room ? base.slice(base.length - room) : base
  return `${trimmedBase}${tail}`
}

export interface CreateEditableDocxDeps {
  /** The open PDF's bytes; `null` when the document has nothing to convert. */
  readSource: () => Promise<ArrayBuffer | null>
  /** Call the server's PDF→DOCX channel. */
  convert: (pdf: ArrayBuffer) => Promise<PdfToDocxResponse>
  /** File the result as a sibling of the open document in the drive. */
  saveAsDocx: (
    docx: ArrayBuffer,
    fileName: string,
  ) => Promise<{ ok: boolean; error?: string; itemId?: string }>
  /** The open document's name, used to derive the sibling's. */
  sourceName: string
}

/**
 * Convert the open PDF and file the result next to it.
 *
 * Every dependency is injected so the ordering guarantees below — no convert
 * without a source, no save without real bytes — are testable without a
 * document, a server, or a drive.
 */
export async function createEditableDocx(
  deps: CreateEditableDocxDeps,
): Promise<EditableDocxResult> {
  const fileName = deriveEditableDocxName(deps.sourceName)

  const source = await deps.readSource()
  if (!source || source.byteLength === 0) {
    return { ok: false, reason: 'no-source' }
  }

  const converted = await deps.convert(source)
  if (!converted.ok) {
    // An encrypted PDF is a prompt, not a failure: the user can supply the
    // password and get a real document. Everything else is a dead end.
    if (converted.code === 'PDF_PASSWORD_REQUIRED') {
      return {
        ok: false,
        reason: 'password-required',
        ...(converted.message ? { message: converted.message } : {}),
      }
    }
    return {
      ok: false,
      reason: 'convert-failed',
      ...(converted.message ? { message: converted.message } : {}),
    }
  }

  const bytes = converted.docx
  // `ok: true` with nothing in it is a converter bug, and filing a zero-byte
  // `.docx` in the user's drive is the exact failure this module exists to
  // avoid. Treat it as a conversion failure rather than a success.
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, reason: 'empty-output' }
  }

  // Copy into a standalone ArrayBuffer: `bytes` may be a view onto a larger
  // buffer (the IPC codec decodes into one), and the multipart upload would
  // otherwise carry the whole pool.
  const payload = bytes.slice().buffer

  const saved = await deps.saveAsDocx(payload, fileName)
  if (!saved.ok) {
    return {
      ok: false,
      reason: 'save-failed',
      ...(saved.error ? { message: saved.error } : {}),
    }
  }

  return {
    ok: true,
    fileName,
    ...(saved.itemId ? { itemId: saved.itemId } : {}),
    ...(converted.pages !== undefined ? { pages: converted.pages } : {}),
    ...(converted.warnings && converted.warnings.length > 0
      ? { warnings: converted.warnings }
      : {}),
    scannedDocument: converted.scannedDocument === true,
  }
}

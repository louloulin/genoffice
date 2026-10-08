import { OfficeError } from './errors'

/** Every container the library knows how to name. Not every one is readable. */
export type DocFormat =
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xlsm'
  | 'xls'
  | 'xlsb'
  | 'ods'
  | 'pptx'
  | 'ppt'
  | 'pdf'
  | 'md'
  | 'markdown'
  | 'html'
  | 'htm'
  | 'csv'
  | 'txt'

const KNOWN: ReadonlySet<string> = new Set<DocFormat>([
  'docx',
  'doc',
  'xlsx',
  'xlsm',
  'xls',
  'xlsb',
  'ods',
  'pptx',
  'ppt',
  'pdf',
  'md',
  'markdown',
  'html',
  'htm',
  'csv',
  'txt',
])

/** OOXML / ODF members that identify a zip container's flavour. */
const ZIP_MARKERS: ReadonlyArray<readonly [string, DocFormat]> = [
  ['word/document.xml', 'docx'],
  ['xl/workbook.xml', 'xlsx'],
  ['ppt/presentation.xml', 'pptx'],
  ['content.xml', 'ods'],
]

/** OLE2 (CFB) stream names that identify a legacy binary Office container. */
const OLE_MARKERS: ReadonlyArray<readonly [string, DocFormat]> = [
  ['WordDocument', 'doc'],
  ['PowerPoint Document', 'ppt'],
  ['Workbook', 'xls'],
  ['Book', 'xls'],
]

function hasPrefix(buf: Uint8Array, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false
  return true
}

const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04] // PK\x03\x04
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** One latin1 pass so the marker probes below are native-string `indexOf`, not O(n·m) byte loops. */
function latin1(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1')
}

export interface DetectOptions {
  /** filename or extension hint; trusted when it names a known format */
  hint?: string
}

/**
 * Names the container from its bytes, falling back to the caller's hint.
 *
 * A hint wins outright: OOXML zip members cannot distinguish `.xlsm` from
 * `.xlsx`, and only the caller knows the file was named `.csv` rather than
 * `.txt`. Without a hint the container is sniffed from its signature, and for
 * zip/OLE2 the identifying member is looked up by name.
 */
export function detectFormat(bytes: Uint8Array, opts: DetectOptions = {}): DocFormat {
  const hint = normaliseHint(opts.hint)
  if (hint) return hint
  if (hasPrefix(bytes, PDF_SIG)) return 'pdf'
  if (hasPrefix(bytes, OLE_SIG)) {
    const s = latin1(bytes)
    for (const [marker, format] of OLE_MARKERS) if (s.includes(marker)) return format
    throw new OfficeError('OFFICE_BAD_INPUT', 'unrecognised OLE2 container (not .doc/.xls/.ppt)', {
      hint: 'pass { format } when the extension is known',
    })
  }
  if (hasPrefix(bytes, ZIP_SIG)) {
    const s = latin1(bytes)
    for (const [marker, format] of ZIP_MARKERS) if (s.includes(marker)) return format
    throw new OfficeError('OFFICE_BAD_INPUT', 'unrecognised zip container (not an OOXML document)', {
      hint: 'pass { format } when the extension is known',
    })
  }
  const head = latin1(bytes.subarray(0, 1024)).trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html'
  return 'txt'
}

function normaliseHint(hint: string | undefined): DocFormat | null {
  if (!hint) return null
  const ext = hint.slice(hint.lastIndexOf('.') + 1).toLowerCase().trim()
  return KNOWN.has(ext) ? (ext as DocFormat) : null
}

/** The public, lowercase extension for a format (`.markdown` normalises to `md`). */
export function formatExtension(format: DocFormat): string {
  return format === 'markdown' ? 'md' : format === 'htm' ? 'html' : format
}

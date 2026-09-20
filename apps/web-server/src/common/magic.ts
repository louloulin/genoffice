/**
 * File-magic detection — open-then-reject gate for renderer-supplied bytes.
 *
 * The web build has no Electron path-grant map, so the only thing
 * protecting the file parser from a "this JPEG is actually a docx" upload
 * is the extension we get from the renderer. That is not enough: a
 * renderer (or anything reachable on the LAN) can ship bytes that don't
 * match their declared extension and we want a clear error instead of a
 * cryptic zip-parser stack trace.
 *
 * This module does NOT replace the parser. It only decides whether the
 * declared extension is plausible for the first N bytes. Callers that
 * want full validation still need to run the real parser afterwards.
 *
 * Detection is intentionally conservative: a failure here throws
 * `MagicMismatchError`, a success only means "this is worth trying to
 * parse". Plain text is matched last because every Office container has
 * its own magic; plain text has none.
 */

import { extname } from 'node:path'
import { InvalidArgumentError } from '../ai/errors'

export type FileMagicKind =
  | 'zip' // docx / xlsx / pptx / jar / odt …
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'plain'

export class MagicMismatchError extends Error {
  readonly code: 'MAGIC_MISMATCH' = 'MAGIC_MISMATCH'
  readonly channel: string
  readonly declaredExtension: string
  readonly actualMagic: FileMagicKind | null
  constructor(
    channel: string,
    declaredExtension: string,
    actualMagic: FileMagicKind | null,
  ) {
    super(
      `Refusing '${channel}': bytes do not match declared extension '${declaredExtension}' (detected ${actualMagic ?? 'unknown'})`,
    )
    this.name = 'MagicMismatchError'
    this.channel = channel
    this.declaredExtension = declaredExtension
    this.actualMagic = actualMagic
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // "PK\x03\x04"
const PDF_MAGIC = Buffer.from('%PDF-')
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const GIF_MAGIC_87A = Buffer.from('GIF87a')
const GIF_MAGIC_89A = Buffer.from('GIF89a')
const WEBP_RIFF = Buffer.from('RIFF')
const WEBP_WEBP = Buffer.from('WEBP')
const PLAIN_PRINTABLE_FRACTION = 0.85

function startsWith(buffer: Buffer, head: Buffer): boolean {
  if (buffer.length < head.length) return false
  return buffer.subarray(0, head.length).equals(head)
}

function isWebp(buffer: Buffer): boolean {
  // RIFF....WEBP — the WEBP tag sits at offset 8, not 0, so the simple
  // prefix check has to read past the size field.
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).equals(WEBP_RIFF) &&
    buffer.subarray(8, 12).equals(WEBP_WEBP)
  )
}

function isPlainText(buffer: Buffer): boolean {
  // A pure-text upload (.txt, .md, .csv, .json, …) has no magic. We treat
  // a buffer as plain when at least 85% of the first 4 KiB is printable
  // ASCII / UTF-8 whitespace, and no NUL byte ever appears. NUL is the
  // smoking gun for binary masquerading as text.
  if (buffer.length === 0) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let printable = 0
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i]
    if (b === 0) return false
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80) {
      printable += 1
    }
  }
  return printable / sample.length >= PLAIN_PRINTABLE_FRACTION
}

/**
 * Identify the magic of a byte buffer. Returns `null` when the buffer is
 * empty or the magic is not one we recognise — callers should treat `null`
 * as "don't know", not "wrong".
 */
export function detectFileMagic(bytes: Uint8Array | Buffer | ArrayBuffer): FileMagicKind | null {
  const buffer = bytes instanceof Buffer ? bytes : Buffer.from(bytes as ArrayBuffer)
  if (buffer.length === 0) return null
  if (startsWith(buffer, ZIP_MAGIC)) return 'zip'
  if (startsWith(buffer, PDF_MAGIC)) return 'pdf'
  if (startsWith(buffer, PNG_MAGIC)) return 'png'
  if (startsWith(buffer, JPEG_MAGIC)) return 'jpeg'
  if (startsWith(buffer, GIF_MAGIC_87A) || startsWith(buffer, GIF_MAGIC_89A)) return 'gif'
  if (isWebp(buffer)) return 'webp'
  if (isPlainText(buffer)) return 'plain'
  return null
}

interface MagicExpectation {
  magic: FileMagicKind
  /** Friendly label for the error message. */
  label: string
}

const EXTENSION_EXPECTATIONS: Record<string, MagicExpectation> = {
  '.docx': { magic: 'zip', label: 'docx (OOXML container)' },
  '.xlsx': { magic: 'zip', label: 'xlsx (OOXML container)' },
  '.pptx': { magic: 'zip', label: 'pptx (OOXML container)' },
  '.odt': { magic: 'zip', label: 'odt (ODF container)' },
  '.ods': { magic: 'zip', label: 'ods (ODF container)' },
  '.odp': { magic: 'zip', label: 'odp (ODF container)' },
  '.pdf': { magic: 'pdf', label: 'pdf' },
  '.png': { magic: 'png', label: 'png' },
  '.jpg': { magic: 'jpeg', label: 'jpeg' },
  '.jpeg': { magic: 'jpeg', label: 'jpeg' },
  '.gif': { magic: 'gif', label: 'gif' },
  '.webp': { magic: 'webp', label: 'webp' },
  '.txt': { magic: 'plain', label: 'plain text' },
  '.md': { magic: 'plain', label: 'plain text' },
  '.markdown': { magic: 'plain', label: 'plain text' },
  '.csv': { magic: 'plain', label: 'plain text' },
  '.json': { magic: 'plain', label: 'plain text' },
  '.xml': { magic: 'plain', label: 'plain text' },
  '.html': { magic: 'plain', label: 'plain text' },
  '.htm': { magic: 'plain', label: 'plain text' },
  '.log': { magic: 'plain', label: 'plain text' },
  '.yml': { magic: 'plain', label: 'plain text' },
  '.yaml': { magic: 'plain', label: 'plain text' },
}

/**
 * Throws `MagicMismatchError` if the declared extension on `filePath`
 * disagrees with the magic detected in `bytes`. Unknown extensions are
 * skipped (we can't validate them); unknown magic on a known extension
 * is the actual rejection case.
 *
 * Use after `requireManagedPath` and before the real parser runs.
 */
export function assertMagicMatchesExtension(
  channel: string,
  filePath: string,
  bytes: Uint8Array | Buffer | ArrayBuffer,
): void {
  const ext = extname(filePath).toLowerCase()
  const expectation = EXTENSION_EXPECTATIONS[ext]
  if (!expectation) return // unknown extension → trust the parser
  const actual = detectFileMagic(bytes)
  if (actual === null) {
    throw new InvalidArgumentError(
      channel,
      `bytes do not match declared extension '${ext}' (expected ${expectation.label}, got empty or unknown)`,
    )
  }
  if (actual !== expectation.magic) {
    throw new MagicMismatchError(channel, ext, actual)
  }
}

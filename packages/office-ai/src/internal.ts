import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asOfficeError, OfficeError } from './errors'

/**
 * The CLI reports a rejected op batch or a missing file with exit class `usage`
 * (1) or `file` (2); the other classes (`conversion`, `app`) are as likely to be
 * an engine fault as bad input, so they stay internal. Matched structurally so
 * this stays decoupled from the CLI's own module graph.
 */
const INPUT_ERROR_NAMES = new Set(['CliError'])

function isInputError(err: unknown): err is Error {
  if (!(err instanceof Error) || !INPUT_ERROR_NAMES.has(err.name)) return false
  const code = (err as { code?: unknown }).code
  return code === 1 || code === 2
}

/**
 * Runs an engine call and normalizes whatever it throws. A file that is not the
 * container it claims to be — a truncated docx, a stray `.xlsx` that is really
 * plain text — fails inside the parser (jszip, pdfium) with an untyped error;
 * a caller should still see a `code` it can branch on rather than `undefined`.
 *
 * A batch the caller could fix by sending different ops is reported as
 * `OFFICE_BAD_INPUT`, not as an engine fault: the two ask different things of a
 * host (correct the request vs. report a bug), and only the engine's own
 * `OfficeError` decisions are passed through untouched.
 */
export async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof OfficeError) throw err
    if (isInputError(err)) {
      throw new OfficeError('OFFICE_BAD_INPUT', `${what}: ${err.message}`, { context: what })
    }
    throw asOfficeError(err, what)
  }
}

/**
 * The CLI's `PathContext`, re-declared structurally so the facade does not
 * depend on the CLI's internal module graph just for a type. Any object with
 * these two fields satisfies the real `PathContext` the engines expect.
 */
export interface LibContext {
  cwd: string
  env: NodeJS.ProcessEnv
}

export function makeCtx(opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): LibContext {
  return { cwd: opts?.cwd ?? process.cwd(), env: opts?.env ?? process.env }
}

/**
 * A few engine entry points (the xlsx reader/writer, the legacy-workbook
 * converter) are path-based rather than byte-based. This bridges bytes to a
 * scratch directory that is always removed, so the public API can stay
 * byte-in / byte-out.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'office-ai-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function readScratch(path: string): Uint8Array {
  const buf = readFileSync(path)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

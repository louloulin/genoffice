/**
 * Error taxonomy for the headless Office engine. Mirrors the semantic buckets
 * of the CLI's own `result.ts` (usage / file / conversion) but is scoped to the
 * library's concerns so a host can branch on `code` without parsing messages.
 */
export type OfficeErrorCode =
  /** the format is recognised but this operation is not available for it */
  | 'OFFICE_UNSUPPORTED'
  /** the operation needs an app renderer (Electron `--headless-export`) the library does not ship */
  | 'OFFICE_NEEDS_APP'
  /** the operation needs the Rust xlsx sidecar, which is not part of the default library build */
  | 'OFFICE_NEEDS_SIDECAR'
  /** the caller passed bytes, options or ops that cannot be handled */
  | 'OFFICE_BAD_INPUT'
  /** a referenced file/workspace path does not exist */
  | 'OFFICE_NOT_FOUND'
  /** an underlying engine threw; `cause` carries the original error */
  | 'OFFICE_INTERNAL'

export class OfficeError extends Error {
  readonly code: OfficeErrorCode
  readonly detail: Record<string, unknown> | undefined

  constructor(code: OfficeErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'OfficeError'
    this.code = code
    this.detail = detail
  }
}

export function isOfficeError(err: unknown): err is OfficeError {
  return err instanceof OfficeError
}

/**
 * Normalizes an engine throw into an `OfficeError`, so a caller can always branch
 * on `code`. A parser (jszip, pdfium, xlsx) reports a malformed file in its own
 * words; without this the raw error escapes with no `code` at all.
 */
export function asOfficeError(err: unknown, context: string): OfficeError {
  if (err instanceof OfficeError) return err
  const message = err instanceof Error ? err.message : String(err)
  const wrapped = new OfficeError('OFFICE_INTERNAL', `${context}: ${message}`, { context })
  wrapped.cause = err
  return wrapped
}

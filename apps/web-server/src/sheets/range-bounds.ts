/**
 * `workbook:read-range` request validation.
 *
 * The web server forwards this channel straight to the Rust sidecar, which is
 * what makes the range security-relevant: the handler used to trust the
 * caller's bounds completely. `rows = endRow - startRow + 1` fed `emptyRange`,
 * whose `Array.from({ length: rows })` materialises one record per row — so
 * `{ startRow: -1, endRow: 999999 }` from an untrusted HTTP client allocated a
 * million rows (~30 MB of JSON, ~300 MB RSS) and answered 200. Four concurrent
 * requests pushed the process past 1 GB.
 *
 * The same bounds are also the sidecar's protocol contract. `CellRange` is a
 * pair of `usize`s on the Rust side, so a negative bound failed
 * `serde_json::from_str`, which replies `invalid_json` with an EMPTY
 * `requestId` (the request never parsed, so there was nothing to echo). The
 * client correlates responses by id, so it dropped the answer and stalled
 * until its timeout — 30 s per call for a read, 300 s for a save — while the
 * sidecar had already replied. Rejecting out-of-contract bounds here keeps
 * such a request out of the sidecar entirely.
 *
 * `MAX_RANGE_CELLS` mirrors `MAX_RANGE_CELLS` in
 * `apps/sheets/src/shared/desktop-api.ts` (`workbookRangeRequestSchema`'s
 * `superRefine`), the identical constant in
 * `apps/sheets/native/xlsx-engine/src/types.rs`, and the renderer's own
 * `parseRangeRequest` in `apps/sheets/src/shared/sheets-api-factory.ts`. All
 * four must agree: the renderer validates before sending, the desktop main
 * process validates again, and the sidecar enforces it a third time.
 */

/** Per-request cell budget for a sidecar range read. */
export const MAX_RANGE_CELLS = 100_000

/** Column ceiling for a single worksheet (Excel's XFD). Guards the
 *  multiplication in the cell cap against absurd column spans before the
 *  product is computed. */
export const MAX_RANGE_COLUMNS = 16_384

/** Row ceiling for a single worksheet (Excel's 1,048,576th row). */
export const MAX_RANGE_ROWS = 1_048_576

export interface ValidatedRangeRequest {
  readonly sessionId: string
  readonly sheetId: string
  readonly range: {
    readonly startRow: number
    readonly endRow: number
    readonly startColumn: number
    readonly endColumn: number
  }
}

export type RangeValidation =
  | { readonly ok: true; readonly request: ValidatedRangeRequest }
  | { readonly ok: false; readonly reason: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate a `workbook:read-range` request.
 *
 * Rejects rather than clamps. Every other layer of the stack (renderer,
 * desktop main process, Rust sidecar) rejects the same inputs, so clamping
 * here would make the web server answer a question the callers cannot ask —
 * the renderer would receive cells for rows it never requested and install
 * them at the wrong screen coordinates.
 */
export function validateRangeRequest(input: unknown): RangeValidation {
  if (!isPlainRecord(input)) {
    return { ok: false, reason: 'request must be an object' }
  }
  const { sessionId, sheetId, range } = input
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'sessionId must be a non-empty string' }
  }
  if (typeof sheetId !== 'string' || sheetId.length === 0) {
    return { ok: false, reason: 'sheetId must be a non-empty string' }
  }
  if (!isPlainRecord(range)) {
    return { ok: false, reason: 'range must be an object' }
  }
  const { startRow, endRow, startColumn, endColumn } = range
  if (
    !isNonNegativeInteger(startRow) ||
    !isNonNegativeInteger(endRow) ||
    !isNonNegativeInteger(startColumn) ||
    !isNonNegativeInteger(endColumn)
  ) {
    return {
      ok: false,
      reason: 'range bounds must be non-negative integers',
    }
  }
  if (startRow > endRow || startColumn > endColumn) {
    return { ok: false, reason: 'range boundaries are reversed' }
  }
  // Guard the multiplicands before multiplying: `endRow - startRow + 1` on a
  // pair of values near Number.MAX_SAFE_INTEGER would exceed the exact-integer
  // range and make the product meaningless.
  if (endRow >= MAX_RANGE_ROWS || endColumn >= MAX_RANGE_COLUMNS) {
    return {
      ok: false,
      reason: `range must stay inside the sheet limits (${MAX_RANGE_ROWS} rows x ${MAX_RANGE_COLUMNS} columns)`,
    }
  }
  const rows = endRow - startRow + 1
  const columns = endColumn - startColumn + 1
  if (rows * columns > MAX_RANGE_CELLS) {
    return { ok: false, reason: `range exceeds ${MAX_RANGE_CELLS} cells` }
  }
  return {
    ok: true,
    request: { sessionId, sheetId, range: { startRow, endRow, startColumn, endColumn } },
  }
}

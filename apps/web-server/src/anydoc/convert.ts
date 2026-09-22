/**
 * Local PDF ⇄ office conversion for the standalone web build.
 *
 * `anydoc:convert` used to be an honest "WEB_UNSUPPORTED" stub because the
 * web build has no LibreOffice / docx2pdf / headless-Chrome pipeline. That is
 * still true for the *office* half of the matrix, but the PDF → DOCX
 * direction does not need any of it: `@genoffice/pdf2docx` is a pure
 * TypeScript port that only wants an initialized `@embedpdf/pdfium` wasm
 * module, and both ship in this repo. This module provides that module and
 * exposes a single `convertPdfToDocxBytes` helper the IPC handler calls.
 *
 * Deliberately no fallback that writes the source bytes under the new
 * extension: that is exactly the bug the old stub was written to stop (it
 * produced a file with a `.docx` name that no reader could open, and the
 * renderer reported success).
 *
 * DOCX → PDF needs a layout engine (the desktop build shells out to
 * LibreOffice); it stays unsupported and the handler keeps answering
 * WEB_UNSUPPORTED so the renderer's existing fallback UI takes over.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { convertPdfToDocx, PdfLoadError, type ConvertResult } from '@genoffice/pdf2docx'
import { ROOT } from '../common/paths'

/**
 * Minimal structural type for the pdfium module. `@genoffice/pdf2docx`
 * declares its own `PdfiumModule`; we only need to hand the object back, so
 * this stays loose on purpose (the package owns the real contract).
 */
type PdfiumModuleLike = Parameters<typeof convertPdfToDocx>[1]['pdfium']

let pdfiumPromise: Promise<PdfiumModuleLike> | null = null

/**
 * Directory holding this module. Valid in both runtimes the server ships
 * in: `tsx src/index.ts` (source tree) and the esbuild ESM bundle
 * (`dist/bundle/index.js`, where the banner reinstates `import.meta`).
 */
function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

/**
 * Relative location of the wasm inside the `@embedpdf/pdfium` package.
 * Note the `dist/` segment: the package's export map exposes
 * `./pdfium.wasm` → `./dist/pdfium.wasm`, so the file is NOT at the
 * package root.
 */
const PDFIUM_WASM_REL = join('@embedpdf', 'pdfium', 'dist', 'pdfium.wasm')

/**
 * Locate `pdfium.wasm` across the three places it can live.
 *
 *   1. `WEB_PDFIUM_WASM` — operator override for exotic deployments (e.g.
 *      a read-only image where node_modules sits outside the repo).
 *   2. Next to the bundle — `scripts/bundle.mjs` copies the wasm into
 *      `dist/bundle/`, so the Docker runtime (which copies only that
 *      directory, not node_modules) can find it. This is the production
 *      path.
 *   3. `ROOT/node_modules/...` then `<cwd>/node_modules/...` — dev
 *      (`tsx`) and `pnpm start` from the repo.
 *
 * Falls back to the package's own export map so a future pnpm layout
 * change (hoisting the package elsewhere) still resolves.
 */
function pdfiumWasmPath(): string {
  const override = process.env.WEB_PDFIUM_WASM
  if (override && override.length > 0) {
    if (existsSync(override)) return override
    throw new Error(`WEB_PDFIUM_WASM points at a missing file: ${override}`)
  }

  const candidates = [
    // (2) copied next to the bundle by scripts/bundle.mjs
    join(moduleDir(), 'pdfium.wasm'),
    // (3) workspace install
    join(ROOT, 'node_modules', PDFIUM_WASM_REL),
    join(process.cwd(), 'node_modules', PDFIUM_WASM_REL),
    resolve(moduleDir(), '..', '..', '..', '..', 'node_modules', PDFIUM_WASM_REL),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Last resort: let the package's export map resolve it.
  const require = createRequire(join(process.cwd(), 'package.json'))
  return require.resolve('@embedpdf/pdfium/pdfium.wasm')
}

/** Initialize (once) the pdfium wasm module pdf2docx needs. */
export function ensurePdfium(): Promise<PdfiumModuleLike> {
  pdfiumPromise ??= (async () => {
    const { init } = (await import('@embedpdf/pdfium')) as unknown as {
      init(overrides: object): Promise<object>
    }
    const raw = readFileSync(pdfiumWasmPath())
    // Exact slice: a Node Buffer's `.buffer` is a shared pool that may be
    // larger than the file, and handing emscripten the whole pool corrupts
    // the wasm load.
    const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    // `thisProgram` is required: emscripten's synthetic environ writes
    // process.argv[1] through an ASCII-asserting helper, and a document path
    // containing CJK characters (common on Windows file associations) aborts
    // init. Same fix as apps/pdf/src/main/text-edit.ts.
    const wrapped = (await init({ wasmBinary, thisProgram: 'genoffice-pdf' })) as {
      pdfium?: unknown
    }
    const mod = (wrapped.pdfium ?? wrapped) as PdfiumModuleLike & { _PDFiumExt_Init(): void }
    // pdf2docx's extract layer asserts this ran; without it every page falls
    // back to a full-page raster.
    mod._PDFiumExt_Init()
    return mod
  })()
  return pdfiumPromise
}

/** Test hook: drop the cached wasm module so a fresh init can be observed. */
export function _resetPdfiumForTests(): void {
  pdfiumPromise = null
}

export interface PdfToDocxOutcome {
  ok: boolean
  /** Present only when `ok`. */
  docx?: Uint8Array
  pages?: number
  /** Human-readable notes about degraded / scanned pages (1-based). */
  warnings?: string[]
  /** True when most pages were scans and the caller should steer to OCR. */
  scannedDocument?: boolean
  /** Present only when `!ok`. */
  code?: 'PDF_PASSWORD_REQUIRED' | 'PDF_LOAD_FAILED' | 'CONVERT_FAILED'
  message?: string
}

/**
 * Convert PDF bytes to DOCX bytes, fully locally.
 *
 * Returns a discriminated result instead of throwing so the IPC layer can
 * map each failure to the right user-facing message — an encrypted PDF needs
 * a password prompt, not a "conversion failed" toast.
 */
export async function convertPdfToDocxBytes(
  pdf: Uint8Array,
  opts: { password?: string } = {},
): Promise<PdfToDocxOutcome> {
  let pdfium: PdfiumModuleLike
  try {
    pdfium = await ensurePdfium()
  } catch (err) {
    return {
      ok: false,
      code: 'CONVERT_FAILED',
      message: `pdfium could not be initialized: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    const result: ConvertResult = await convertPdfToDocx(pdf, {
      pdfium,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
    })
    return {
      ok: true,
      docx: result.docx,
      pages: result.pages,
      warnings: result.warnings,
      scannedDocument: result.scannedDocument,
    }
  } catch (err) {
    if (err instanceof PdfLoadError) {
      // A wrong password and a missing password are the same answer to the
      // renderer ("ask the user"), so one stable code covers both and the
      // UI never has to know pdf2docx's enum.
      if (err.code === 'password-required') {
        return { ok: false, code: 'PDF_PASSWORD_REQUIRED', message: err.message }
      }
      return { ok: false, code: 'PDF_LOAD_FAILED', message: err.message }
    }
    return {
      ok: false,
      code: 'CONVERT_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Directory helper kept next to the wasm probe so both stay in sync. */
export function pdfiumPackageDir(): string {
  return dirname(pdfiumWasmPath())
}

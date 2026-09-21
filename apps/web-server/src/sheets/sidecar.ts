/// Minimal xlsx-sidecar wrapper for the web server.
///
/// The Electron main process owns the full XlsxSidecarClient (session lifecycle,
/// read range, recalc, archive commands). The web server only needs `open` to
/// satisfy `workbook:open-path`; everything else stays web-only. A separate
/// per-process subprocess keeps the web server free of Electron dependencies
/// and avoids fighting the desktop main for stdin/stdout ownership.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROTOCOL_VERSION = 1
const OPEN_TIMEOUT_MS = 30_000
/** Save commands stream whole workbooks through the sidecar and may run the
 *  IronCalc recalc pipeline before writing bytes; an 8 MiB workbook's save
 *  routinely takes 20+ seconds. A 5-minute cap leaves headroom for a slow
 *  disk + a large formula graph, but still surfaces a hung sidecar as a
 *  caller-visible error instead of a silent timeout. */
const SAVE_TIMEOUT_MS = 300_000
const ARCHIVE_TIMEOUT_MS = 180_000
const MAX_STDERR_LENGTH = 8_192

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timeout: NodeJS.Timeout
}

interface SidecarResponse {
  readonly version: number
  readonly requestId: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

function defaultSidecarPath(): string {
  if (process.env.XLSX_SIDECAR_PATH) return process.env.XLSX_SIDECAR_PATH
  // apps/web-server/src/sheets/sidecar.ts → repo root → native binary
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..', '..')
  const exe = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  return join(repoRoot, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', exe)
}

export class WebSheetsSidecar {
  private process: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private nextId = 1
  private stderrTail = ''
  private lastError: Error | null = null

  constructor(private readonly binaryPath: string = defaultSidecarPath()) {}

  async open(path: string, locale = 'zh'): Promise<unknown> {
    return this.request({ command: 'open', path, locale })
  }

  async readRange(input: {
    readonly sessionId: string
    readonly sheetId: string
    readonly range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
  }): Promise<unknown> {
    return this.request({ command: 'read_range', ...input })
  }

  /** Read the archive entry manifest for a workbook. The save pipeline
   *  (`saveWorkbookViaSidecar`) needs this to plan cell edits against the
   *  real on-disk entries before sending a `save_archive` payload. */
  async archiveManifest(path: string): Promise<unknown> {
    return this.request(
      { command: 'archive_manifest', path },
      ARCHIVE_TIMEOUT_MS,
    )
  }

  /** Write a patched archive atomically. The payload is the in-memory
   *  manifest of the source plus per-entry replacement/addition content
   *  paths under the caller's work directory; the sidecar copies
   *  untouched entries raw and validates the CRC against the manifest.
   *  Used by `workbook:save` after `planCellEditsToXlsx` materialises
   *  the edits into actual ZIP entries. */
  async saveArchive(input: {
    readonly sourcePath: string
    readonly targetPath: string
    readonly replacements: readonly { name: string; contentPath: string }[]
    readonly removals: readonly string[]
    readonly additions: readonly { name: string; contentPath: string }[]
  }): Promise<unknown> {
    return this.request(
      { command: 'save_archive', ...input },
      SAVE_TIMEOUT_MS,
    )
  }

  /** Extract specific archive entries to a directory. Used by the save
   *  planner's `EntrySource.readText` to materialise the OOXML parts it
   *  needs to rewrite — shared XMLs, sheet XML, sharedStrings.xml, etc.
   *  Untouched entries stay in the source archive and are copied raw by
   *  `save_archive`. */
  async readEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly outputDir: string
  }): Promise<unknown> {
    return this.request(
      { command: 'read_entries', ...input },
      ARCHIVE_TIMEOUT_MS,
    )
  }

  /** Check whether a single archive entry contains a substring. The save
   *  planner calls this before reading an entry's full text so it can
   *  skip a several-MB part when no cell edit touches it. */
  async scanEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly needle: string
  }): Promise<unknown> {
    return this.request(
      { command: 'scan_entries', ...input },
      ARCHIVE_TIMEOUT_MS,
    )
  }

  stop(): void {
    this.lines?.close()
    this.lines = null
    this.process?.kill()
    this.process = null
    this.rejectPending(new Error('XLSX sidecar stopped.'))
  }

  /** Lazy spawn: don't pay cold-start until the first request. */
  private ensureStarted(): void {
    if (this.process) return
    if (!existsSync(this.binaryPath)) {
      throw new Error(
        `xlsx-sidecar binary not found at ${this.binaryPath}. Build it with ` +
          `\`cargo build --release\` in apps/sheets/native/xlsx-engine.`,
      )
    }
    const proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = proc
    this.lines = createInterface({ input: proc.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-MAX_STDERR_LENGTH)
    })
    proc.on('exit', (code) => {
      const err = new Error(
        `XLSX sidecar exited (code=${code ?? 'null'}). stderr: ${this.stderrTail.slice(-512)}`,
      )
      this.process = null
      this.lines = null
      this.rejectPending(err)
    })
    proc.on('error', (err) => {
      this.lastError = err
      this.process = null
      this.lines = null
      this.rejectPending(err)
    })
  }

  private request(payload: Record<string, unknown>, timeoutMs = OPEN_TIMEOUT_MS): Promise<unknown> {
    this.ensureStarted()
    const requestId = `r${this.nextId++}`
    const envelope = { version: PROTOCOL_VERSION, requestId, ...payload }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Sidecar '${payload.command}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timeout })
      this.process!.stdin.write(JSON.stringify(envelope) + '\n')
    })
  }

  private handleLine(line: string): void {
    let parsed: SidecarResponse
    try {
      parsed = JSON.parse(line) as SidecarResponse
    } catch {
      return
    }
    const entry = this.pending.get(parsed.requestId)
    if (!entry) return
    this.pending.delete(parsed.requestId)
    clearTimeout(entry.timeout)
    if (parsed.ok) entry.resolve(parsed.result)
    else entry.reject(new Error(parsed.error?.message ?? `Sidecar error ${parsed.error?.code}`))
  }

  private rejectPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timeout)
      entry.reject(err)
      this.pending.delete(id)
    }
  }
}

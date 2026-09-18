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

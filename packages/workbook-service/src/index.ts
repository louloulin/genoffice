import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

export interface WorkbookBackend {
  open(path: string, locale?: string): Promise<unknown>
  readRange(input: unknown): Promise<unknown>
  close(sessionId: string): Promise<void>
}

/** Minimal Node adapter for the Rust sidecar JSONL protocol. */
export class XlsxSidecarBackend implements WorkbookBackend {
  private process: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(private readonly binaryPath: string) {}

  async open(path: string, locale = 'zh'): Promise<unknown> {
    return this.request({ command: 'open', path: resolve(path), locale })
  }

  async readRange(input: unknown): Promise<unknown> {
    return this.request({ command: 'read_range', ...(input as object) })
  }

  async close(sessionId: string): Promise<void> {
    await this.request({ command: 'close', sessionId })
  }

  stop(): void {
    this.process?.kill()
    this.process = null
  }

  private request(command: Record<string, unknown>): Promise<unknown> {
    const child = this.ensureStarted()
    const requestId = randomUUID()
    child.stdin.write(`${JSON.stringify({ version: 1, requestId, ...command })}\n`)
    return new Promise((resolvePromise, reject) => {
      this.pending.set(requestId, { resolve: resolvePromise, reject })
    })
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) return this.process
    const child = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.process = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try {
        const result = JSON.parse(line) as {
          requestId: string
          ok: boolean
          result?: unknown
          error?: { message?: string }
        }
        const pending = this.pending.get(result.requestId)
        if (!pending) return
        this.pending.delete(result.requestId)
        if (result.ok) pending.resolve(result.result)
        else pending.reject(new Error(result.error?.message ?? 'XLSX sidecar request failed'))
      } catch {
        /* ignore malformed sidecar output */
      }
    })
    child.once('error', (error) => this.failPending(error))
    child.once('exit', () => {
      this.process = null
      this.failPending(new Error('XLSX sidecar exited'))
    })
    return child
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export class UnavailableWorkbookBackend implements WorkbookBackend {
  constructor(private readonly reason: string) {}
  async open(): Promise<never> {
    throw new Error(this.reason)
  }
  async readRange(): Promise<never> {
    throw new Error(this.reason)
  }
  async close(): Promise<never> {
    throw new Error(this.reason)
  }
}

export class WorkbookFileService {
  constructor(
    private readonly backend: WorkbookBackend,
    private readonly rootDir?: string,
  ) {}
  private allowed(path: string): string {
    if (!path || typeof path !== 'string') throw new Error('workbook file path is required')
    const resolved = resolve(path)
    if (this.rootDir && resolved !== this.rootDir && !resolved.startsWith(`${this.rootDir}/`)) {
      throw new Error('workbook file path is outside the configured root')
    }
    return resolved
  }
  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.allowed(path)))
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(this.allowed(path), bytes)
  }
  async open(path: string, locale?: string): Promise<unknown> {
    return this.backend.open(this.allowed(path), locale)
  }
  async readRange(input: unknown): Promise<unknown> {
    return this.backend.readRange(input)
  }
  async close(sessionId: string): Promise<void> {
    return this.backend.close(sessionId)
  }
}

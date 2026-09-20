/**
 * Atomic file writes and small filesystem helpers shared by every store.
 *
 * `writeFileSync(path, …)` truncates the target before it writes, so a crash,
 * a full disk, or a killed process leaves a half-written document where a
 * valid one used to be — the user's file is destroyed by the act of saving it.
 * Writing to a sibling temp file and renaming over the target makes the swap
 * atomic on POSIX and on Windows (`rename` over an existing file is allowed
 * there via `ReplaceFile` semantics in Node).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Windows returns EPERM/EACCES when a scanner or indexer holds the target
 *  open for a moment; a short retry loop rides that out instead of failing
 *  the user's save. */
const RENAME_RETRY_MS = [10, 20, 40, 80, 160]
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_RETRY_MS.length || !RETRYABLE.has(code)) throw error
      const until = Date.now() + RENAME_RETRY_MS[attempt]
      // Deliberately a spin-wait: the alternative (async) would force every
      // caller onto a promise for what is a sub-millisecond contention event.
      while (Date.now() < until) {
        /* wait out the lock holder */
      }
    }
  }
}

/**
 * Write `data` to `path` atomically, creating the parent directory first.
 *
 * An empty buffer is rejected: a 0-byte write is nearly always a bug upstream
 * (an unreadable upload, a truncated read), and silently replacing a real
 * document with an empty one is far worse than failing the call.
 */
export function atomicWriteFile(path: string, data: Buffer | string): void {
  const buffer = typeof data === 'string' ? Buffer.from(data) : data
  if (buffer.byteLength === 0) {
    throw new RangeError(`atomicWriteFile: refusing to write 0 bytes to ${path}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, buffer)
    renameWithRetry(tmp, path)
  } catch (error) {
    /* Never leave the temp file behind: the next save would use a fresh
     * UUID and the orphan would accumulate. */
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the original error is the interesting one */
    }
    throw error
  }
}

/** Write JSON atomically, pretty-printed so a human can inspect the state file. */
export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, JSON.stringify(value, null, 2))
}

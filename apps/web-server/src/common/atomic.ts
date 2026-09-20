/**
 * Process-wide utilities for stable, collision-free file identifiers and
 * atomic JSON writes.
 *
 * `randomFileId` is what the web build uses in place of the desktop
 * build's deterministic `${timestamp}-${name}` pattern. Two `Date.now()`
 * values in the same millisecond used to collide on the same FILES_DIR
 * path, silently overwriting the earlier upload; a random suffix takes
 * the birthday-paradox cost from "milliseconds in a session" to
 * "2^64", which is plenty for a single-host web server.
 *
 * `atomicWriteJson` writes via a sibling temp file + `rename`, so a
 * crash mid-write leaves the previous good copy intact. Every JSON
 * persistence channel in `common/state.ts` routes through it.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'

import { sanitizeFileName } from './paths'
import { atomicWriteJson } from '@genoffice/file-management'

/* `atomicWriteFile` is the shared kernel's implementation, not a second copy:
 * the temp+rename dance (including the Windows EPERM retry and the zero-byte
 * guard) is subtle enough that two implementations would drift, and the web
 * build and the desktop build must agree on what a save guarantees.
 * `atomicWriteJson` is re-exported from the same place for the same reason. */
export { atomicWriteFile, atomicWriteJson } from '@genoffice/file-management'

/**
 * Build a stable, filesystem-safe identifier for a renderer-supplied
 * filename. The result is a basename-only string safe to `join` into
 * `FILES_DIR` or any other managed directory.
 */
export function randomFileId(name: unknown): string {
  const safeName = sanitizeFileName(name, 'file')
  return `${randomUUID()}-${safeName}`
}

/**
 * Per-day byte counter for renderer-driven bulk actions (paste images,
 * etc.). The renderer can request `files:add-pasted-image` with a
 * hundred 20 MiB blobs in a minute; without a cap, a single malicious
 * tab fills `FILES_DIR` and the operator's disk. The cap is per
 * process (no auth, so no per-user identity), but a single process
 * is the only thing the web build can sandbox.
 */
export const DAILY_PASTE_LIMIT_BYTES = 100 * 1024 * 1024

function yyyymmddUtc(timestamp: number): string {
  const d = new Date(timestamp)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Reserve `bytes` against the daily cap. Returns the new used total if
   the reservation succeeds; throws `RangeError` if it would exceed the
   cap. The cap resets at UTC midnight; we expire the counter file when
   the day rolls over.
 */
export function reserveDailyPasteQuota(
  path: string,
  bytes: number,
  now: number = Date.now(),
): number {
  const today = yyyymmddUtc(now)
  let state: { day: string; used: number } = { day: today, used: 0 }
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed.day === 'string' && typeof parsed.used === 'number') {
        state = parsed
      }
    }
  } catch {
    /* A corrupt counter file resets to zero — the user gets the day's
     * full allowance instead of being permanently locked out. */
  }
  if (state.day !== today) state = { day: today, used: 0 }
  if (state.used + bytes > DAILY_PASTE_LIMIT_BYTES) {
    throw new RangeError(
      `daily paste quota exceeded (${state.used} used + ${bytes} requested > ${DAILY_PASTE_LIMIT_BYTES})`,
    )
  }
  state.used += bytes
  atomicWriteJson(path, state)
  return state.used
}
/**
 * Remove `WEB_TEMP_ROOT` upload directories older than `maxAgeMs`
 * (default 24 h). `web:write-temp-file` creates one directory per
 * upload and never deletes it, so without a sweeper the temp root
 * grows without bound. The directory mtime is used as the age signal
   — every `mkdirSync(..., { recursive: true })` resets it.
 */
/**
 * Remove `WEB_TEMP_ROOT` upload directories older than `maxAgeMs`
 * (default 24 h). `web:write-temp-file` creates one directory per
 * upload and never deletes it, so without a sweeper the temp root
 * grows without bound. The directory mtime is used as the age signal
 * — every `mkdirSync(..., { recursive: true })` resets it.
 */
export function sweepWebTempRoot(
  tempRoot: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): { removed: number; kept: number } {
  if (!existsSync(tempRoot)) return { removed: 0, kept: 0 }
  let removed = 0
  let kept = 0
  for (const entry of readdirSync(tempRoot)) {
    if (!entry.startsWith('upload-')) {
      kept += 1
      continue
    }
    const full = `${tempRoot}/${entry}`
    try {
      const st = statSync(full)
      if (now - st.mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true })
        removed += 1
      } else {
        kept += 1
      }
    } catch {
      kept += 1
    }
  }
  return { removed, kept }
}

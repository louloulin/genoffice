/**
 * File version history — disk-backed snapshots of every save.
 *
 * The previous in-memory `history:create-version` channel stored full
 * file content as a string in a `Map`, which:
 *   - did not handle binary editors (xlsx / pptx / pdf) whose content
 *     is opaque bytes the renderer never serialises to text;
 *   - did not survive a server restart, so version history reset on
 *     every code reload — defeating the "I changed it yesterday, can
 *     I roll back?" UX;
 *   - did not deduplicate consecutive identical saves (each save
 *     allocated another copy even when nothing changed).
 *
 * This module replaces the storage strategy with a directory of
 * snapshot files keyed by `(docId, versionNumber)`. The kernel exposes
 * three IPC channels the renderer uses directly, plus an internal
 * `captureBeforeSave(docId, content)` hook the save pipelines call
 * before they overwrite a managed file:
 *
 *   - `files:list-versions(docId)` → ordered version metadata list
 *   - `files:read-version(docId, versionId)` → bytes for preview / restore
 *   - `files:restore-version(docId, versionId)` → atomic swap onto current path
 *   - `files:delete-version(docId, versionId)` → trim a single snapshot
 *
 * Snapshots are stored under `DATA_DIR/versions/<docId>/<n>.bin`. The
 * directory is excluded from `search:files` (the file walker skips
 * anything matching `.versions` or `versions/`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './atomic'
import { DATA_DIR, FILES_DIR, isManagedPath, registerHandle } from './index'

const MAX_VERSIONS_PER_FILE = 10
const VERSIONS_DIR = join(DATA_DIR, 'versions')

export interface FileVersionMeta {
  id: string
  docId: string
  /** Sequential 1-based index inside the doc's version directory. */
  index: number
  /** Wall-clock timestamp the snapshot was captured (ms). */
  timestamp: number
  /** Snapshot size in bytes. */
  size: number
  /** Optional human note (auto/manual label). */
  message?: string
  /** SHA-256 of the snapshot bytes; lets the renderer dedupe no-op saves. */
  sha256: string
}

export interface FileVersionSnapshot {
  meta: FileVersionMeta
  bytes: Buffer
}

function ensureVersionsDir(): void {
  if (!existsSync(VERSIONS_DIR)) {
    mkdirSync(VERSIONS_DIR, { recursive: true })
  }
}

function versionsRootFor(docId: string): string {
  return join(VERSIONS_DIR, docId)
}

function safeDocId(docId: string): string {
  // docId is the basename the renderer uses — same character set the
  // file index already validates. Reject anything that wouldn't form a
  // safe directory name on top of that.
  const cleaned = basename(docId).replace(/[^\w.\-]+/g, '_')
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`unsafe docId: ${docId}`)
  }
  return cleaned
}

/** Read every snapshot's bytes and sha in one pass. Used by both
 *  list-versions (to emit the metadata) and the restore flow. */
function snapshotPath(docId: string, index: number): string {
  return join(versionsRootFor(safeDocId(docId)), `${index}.bin`)
}

/** Compute the next sequential index for a docId. Returns 1 when the
 *  directory does not yet exist. The result is a 1-based number that
 *  the renderer shows in the version list (v1 = oldest). */
function nextIndexFor(docId: string): number {
  const root = versionsRootFor(safeDocId(docId))
  if (!existsSync(root)) return 1
  const entries = readdirSync(root).filter((n) => n.endsWith('.bin'))
  if (entries.length === 0) return 1
  let max = 0
  for (const entry of entries) {
    const m = /^(\d+)\.bin$/.exec(entry)
    if (!m) continue
    const n = parseInt(m[1]!, 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

function computeSha(bytes: Buffer): string {
  // crypto is loaded lazily via Node's stdlib; importing at module top
  // would force every consumer to also load crypto even if they never
  // call into this module. Cheap enough to inline here.
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

/** Drop the oldest snapshots so the directory holds at most
 *  MAX_VERSIONS_PER_FILE entries. The newest entry is the one we just
 *  wrote, so trimming happens AFTER the write. */
function trimToCap(docId: string): void {
  const root = versionsRootFor(safeDocId(docId))

  if (!existsSync(root)) return
  const entries = readdirSync(root)
    .filter((n) => /^\d+\.bin$/.test(n))
    .map((n) => ({
      name: n,
      index: parseInt(/^(\d+)/.exec(n)![1]!, 10),
    }))
    .sort((a, b) => a.index - b.index)
  const overflow = entries.length - MAX_VERSIONS_PER_FILE
  for (let i = 0; i < overflow; i++) {
    const entry = entries[i]
    if (!entry) continue
    try {
      unlinkSync(join(root, entry.name))
      // Drop the sidecar metadata alongside the snapshot so the trim
      // doesn't leave orphan JSON files behind. Best effort.
      const sidecar = join(root, entry.name.replace(/\.bin$/, '.meta.json'))
      try { unlinkSync(sidecar) } catch { /* missing sidecar is fine */ }
    } catch {
      /* best effort — file may have been removed concurrently */
    }
  }
}

/**
 * Capture a snapshot of `bytes` for `docId`. Called by save pipelines
 * BEFORE they overwrite the live file. The caller is responsible for
 * waiting until any prior write has fsynced before calling — saving the
 * snapshot alongside an in-flight write would race the restore path.
 *
 * Returns the new snapshot's metadata, or `null` if the docId is
 * outside managed storage (silently skipped so a misconfigured caller
 * doesn't break the save).
 */
export function captureBeforeSave(docId: string, bytes: Buffer, message?: string): FileVersionMeta | null {
  try {
    if (!docId || !isManagedPath(join(FILES_DIR, docId))) return null
    if (bytes.byteLength === 0) return null
    const safeId = safeDocId(docId)
    const root = versionsRootFor(safeId)
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    // Dedupe against the newest snapshot: an autosave that lands the
    // exact same bytes as the prior version wastes disk and confuses
    // the renderer ("why is there a v3 of unchanged content?").
    const newest = readdirSync(root)
      .filter((n) => /^\d+\.bin$/.test(n))
      .map((n) => parseInt(/^(\d+)/.exec(n)![1]!, 10))
      .sort((a, b) => b - a)[0]
    if (newest) {
      const prevBytes = readFileSync(snapshotPath(safeId, newest))
      if (prevBytes.equals(bytes)) {
        return listVersions(safeId)[listVersions(safeId).length - 1] ?? null
      }
    }
    const idx = nextIndexFor(safeId)
    const sha = computeSha(bytes)
    const meta: FileVersionMeta = {
      id: `v-${safeId}-${idx}-${randomUUID().slice(0, 8)}`,
      docId: safeId,
      index: idx,
      timestamp: Date.now(),
      size: bytes.byteLength,
      ...(message ? { message } : {}),
      sha256: sha,
    }
    // Use atomicWriteFile directly so the kernel's temp+rename + Windows
    // EPERM-retry logic kicks in. A crashed snapshot write would leave a
    // half-written file under versions/, which the next restore would
    // happily read — atomicWriteFile guarantees the rename either fully
    // lands or the previous index remains untouched.
    const finalPath = snapshotPath(safeId, idx)
    atomicWriteFile(finalPath, bytes)
    // Persist the message + timestamp as a JSON sidecar so the metadata
    // survives a restart. Without this the renderer can't tell a
    // "pre-restore snapshot" apart from a regular autosave.
    const metaPath = join(root, `${idx}.meta.json`)
    writeFileSync(metaPath, JSON.stringify({ message, timestamp: meta.timestamp }))
    trimToCap(safeId)
    return meta
  } catch {
    // Snapshot failures must NEVER break the save pipeline. Log and
    // continue; the user keeps their save.
    return null
  }
}

/** Read all snapshot metadata for `docId`, oldest-first. */
export function listVersions(docId: string): FileVersionMeta[] {
  const safeId = safeDocId(docId)
  const root = versionsRootFor(safeId)
  if (!existsSync(root)) return []
  const out: FileVersionMeta[] = []
  const entries = readdirSync(root)
    .filter((n) => /^\d+\.bin$/.test(n))
    .sort((a, b) => {
      const ai = parseInt(/^(\d+)/.exec(a)![1]!, 10)
      const bi = parseInt(/^(\d+)/.exec(b)![1]!, 10)
      return ai - bi
    })
  for (const entry of entries) {
    const idx = parseInt(/^(\d+)/.exec(entry)![1]!, 10)
    try {
      const stat = statSync(join(root, entry))
      // Compute sha from disk so the renderer's dedupe + integrity check
      // works against the listing without an extra read IPC. Cheap relative
      // to the listing's purpose (snapshot picker in the UI).
      const bytes = readFileSync(join(root, entry))
      const sha = computeSha(bytes)
      // Sidecar JSON carries the optional label (e.g. "pre-restore snapshot")
      // and the original capture timestamp. Falls back to mtime + no message
      // when the sidecar is missing (older captures, or a crash before the
      // sidecar write landed).
      let message: string | undefined
      let timestamp = stat.mtimeMs
      const metaPath = join(root, entry.replace(/\.bin$/, '.meta.json'))
      if (existsSync(metaPath)) {
        try {
          const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as {
            message?: string
            timestamp?: number
          }
          if (typeof parsed.message === 'string') message = parsed.message
          if (typeof parsed.timestamp === 'number') timestamp = parsed.timestamp
        } catch {
          /* corrupt sidecar: ignore, fall back to defaults */
        }
      }
      out.push({
        id: `v-${safeId}-${idx}`,
        docId: safeId,
        index: idx,
        timestamp,
        size: stat.size,
        sha256: sha,
        ...(message ? { message } : {}),
      })
    } catch {
      /* skip unreadable */
    }
  }
  return out
}

/** Read the snapshot bytes for `docId, versionId`. Returns null when
 *  the version does not exist or the docId looks suspicious. */
export function readVersion(docId: string, versionId: string): FileVersionSnapshot | null {
  const safeId = safeDocId(docId)
  const index = indexFromVersionId(versionId, safeId)
  if (index == null) return null
  const path = snapshotPath(safeId, index)
  if (!existsSync(path)) return null
  const bytes = readFileSync(path)
  const meta: FileVersionMeta = {
    id: versionId,
    docId: safeId,
    index,
    timestamp: statSync(path).mtimeMs,
    size: bytes.byteLength,
    sha256: computeSha(bytes),
  }
  return { meta, bytes }
}

/** Parse a versionId ("v-<docId>-<n>[-<rand>]") back into the
 *  numeric index. Returns null when the id is malformed or the
 *  numeric suffix does not match what the directory holds. */
function indexFromVersionId(versionId: string, safeId: string): number | null {
  const m = /^v-(.+)-(\d+)(?:-[a-f0-9]+)?$/.exec(versionId)
  if (!m) return null
  if (m[1] !== safeId) return null
  const n = parseInt(m[2]!, 10)
  return Number.isFinite(n) ? n : null
}

/** Delete a single snapshot. Returns false when the version does not
 *  exist; true on successful unlink. The trim policy is independent
 *  — deletion never triggers re-numbering of remaining snapshots. */
export function deleteVersion(docId: string, versionId: string): boolean {
  const safeId = safeDocId(docId)
  const index = indexFromVersionId(versionId, safeId)
  if (index == null) return false
  const path = snapshotPath(safeId, index)
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** Atomic restore: write the snapshot bytes onto the live managed
 *  path, returning whether the swap succeeded. The renderer should
 *  re-open the document after this to refresh its in-memory model. */
export function restoreVersion(docId: string, versionId: string): { ok: boolean; error?: string } {
  const snap = readVersion(docId, versionId)
  if (!snap) return { ok: false, error: 'version not found' }
  if (!isManagedPath(join(FILES_DIR, snap.meta.docId))) {
    return { ok: false, error: 'docId is outside managed storage' }
  }
  const target = join(FILES_DIR, snap.meta.docId)
  if (!existsSync(target)) {
    return { ok: false, error: 'live file is missing — cannot restore' }
  }
  try {
    // Capture the current live bytes as a new snapshot before we
    // overwrite, so a "restore → restore back" round-trip doesn't
    // lose the intermediate state.
    const currentBytes = readFileSync(target)
    captureBeforeSave(snap.meta.docId, currentBytes, 'pre-restore snapshot')
    atomicWriteFile(target, snap.bytes)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Wire up the IPC handlers the renderer uses. Called from
 * `apps/web-server/src/index.ts` at boot, after the rest of the
 * modules have registered their handlers.
 */
export function registerVersionHistoryHandlers(): void {
  ensureVersionsDir()

  registerHandle('files:list-versions', (_event: unknown, args: unknown) => {
    const { docId } = (args ?? {}) as { docId?: unknown }
    if (typeof docId !== 'string' || !docId) {
      return { ok: false, error: 'files:list-versions expects { docId: string }' }
    }
    if (!isManagedPath(join(FILES_DIR, docId))) {
      return { ok: false, error: 'docId is outside managed storage' }
    }
    const meta = listVersions(docId).map((m) => ({
      id: m.id,
      index: m.index,
      timestamp: m.timestamp,
      size: m.size,
      sha256: m.sha256,
      ...(m.message ? { message: m.message } : {}),
    }))
    return { ok: true, docId, versions: meta, total: meta.length }
  })

  registerHandle('files:read-version', (_event: unknown, args: unknown) => {
    const { docId, versionId } = (args ?? {}) as { docId?: unknown; versionId?: unknown }
    if (typeof docId !== 'string' || typeof versionId !== 'string') {
      return { ok: false, error: 'files:read-version expects { docId, versionId }' }
    }
    if (!isManagedPath(join(FILES_DIR, docId))) {
      return { ok: false, error: 'docId is outside managed storage' }
    }
    const snap = readVersion(docId, versionId)
    if (!snap) return { ok: false, error: 'version not found' }
    return {
      ok: true,
      meta: {
        id: snap.meta.id,
        index: snap.meta.index,
        timestamp: snap.meta.timestamp,
        size: snap.meta.size,
        sha256: snap.meta.sha256,
      },
      bytesB64: snap.bytes.toString('base64'),
    }
  })

  registerHandle('files:restore-version', (_event: unknown, args: unknown) => {
    const { docId, versionId } = (args ?? {}) as { docId?: unknown; versionId?: unknown }
    if (typeof docId !== 'string' || typeof versionId !== 'string') {
      return { ok: false, error: 'files:restore-version expects { docId, versionId }' }
    }
    return restoreVersion(docId, versionId)
  })

  registerHandle('files:delete-version', (_event: unknown, args: unknown) => {
    const { docId, versionId } = (args ?? {}) as { docId?: unknown; versionId?: unknown }
    if (typeof docId !== 'string' || typeof versionId !== 'string') {
      return { ok: false, error: 'files:delete-version expects { docId, versionId }' }
    }
    return { ok: deleteVersion(docId, versionId) }
  })
}

/**
 * Snapshot-only test helper. Exported so the e2e suite can verify
 * the dedupe behaviour without going through the save pipeline.
 */
export function _resetForTests(): void {
  // Wipe every docId subdirectory under VERSIONS_DIR. We must recurse
  // because each subdirectory holds the actual `.bin` snapshots plus
  // `.meta.json` sidecars; a bare `unlinkSync` on the subdirectory
  // fails on POSIX (EPERM) and silently leaves the snapshots behind,
  // which is exactly the bug versions-v1-endpoint.test.ts caught.
  if (!existsSync(VERSIONS_DIR)) return
  const { rmSync } = require('node:fs') as typeof import('node:fs')
  for (const entry of readdirSync(VERSIONS_DIR)) {
    try {
      rmSync(join(VERSIONS_DIR, entry), { recursive: true, force: true })
    } catch {
      /* best effort — another test thread may have already removed it */
    }
  }
}

export const VERSION_HISTORY_CONSTANTS = {
  MAX_VERSIONS_PER_FILE,
  VERSIONS_DIR,
}

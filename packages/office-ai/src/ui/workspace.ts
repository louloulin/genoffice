/**
 * Per-host document workspace. The library has no storage backend and no
 * FILES_DIR: a consumer hands office-ai bytes (or a path it controls) and the
 * host stages them on disk so the renderer's file channels (`docs:open-path`,
 * `docs:save`, `web:write-temp-file`, …) have real paths to round-trip
 * through. Writes are atomic (temp + rename) so a crash mid-save cannot leave
 * a half-written document the next open rejects.
 *
 * Path policy: by default every path the renderer supplies must resolve inside
 * the workspace root. The loopback host answers IPC for any page on the local
 * machine that can reach the port, so honoring arbitrary absolute paths would
 * turn `docs:open-path` into an arbitrary-file-read primitive. Consumers that
 * need to open a file anywhere on disk pass those bytes through
 * `stageDocument()` (a copy) or opt out with `pathAccess: 'any'`.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export type PathAccess = 'workspace' | 'any'

export interface WorkspaceOptions {
  /** Root for staged documents and temp files. Default: a fresh temp dir. */
  dir?: string
  /** Path policy for renderer-supplied paths. Default 'workspace'. */
  pathAccess?: PathAccess
}

export interface Workspace {
  root: string
  filesDir: string
  tempDir: string
  pathAccess: PathAccess
  /** Resolve a renderer-supplied path to an absolute path, or null when it is outside the allowed root. */
  resolvePath(filePath: string): string | null
  /** Write bytes to a new unique file under tempDir; returns its absolute path. */
  stageBytes(name: string, bytes: Uint8Array): string
  /** Write bytes to `filePath` atomically (temp + rename in the same dir). */
  writeBytes(filePath: string, bytes: Uint8Array): void
  readBytes(filePath: string): Uint8Array
  dispose(): void
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const pathAccess = options.pathAccess ?? 'workspace'
  const root = resolve(options.dir ?? join(tmpdir(), `genoffice-office-ai-${process.pid}-${randomUUID().slice(0, 8)}`))
  const filesDir = join(root, 'files')
  const tempDir = join(root, 'temp')
  mkdirSync(filesDir, { recursive: true })
  mkdirSync(tempDir, { recursive: true })

  const resolvePath = (filePath: string): string | null => {
    if (!filePath) return null
    const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath)
    if (pathAccess === 'any') return absolute
    if (absolute === root || absolute.startsWith(root + sep)) return absolute
    return null
  }

  const writeBytes = (filePath: string, bytes: Uint8Array): void => {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = join(dirname(filePath), `.${basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`)
    writeFileSync(tmp, bytes)
    renameSync(tmp, filePath)
  }

  return {
    root,
    filesDir,
    tempDir,
    pathAccess,
    resolvePath,
    stageBytes(name, bytes) {
      const safe = safeFileStem(name) || 'document'
      // Unique dir, original basename: the renderer's display name comes from
      // basename(path), so the name must survive staging intact.
      const dir = join(tempDir, randomUUID().slice(0, 8))
      const target = join(dir, safe)
      writeBytes(target, bytes)
      return target
    },
    writeBytes,
    readBytes(filePath) {
      return new Uint8Array(readFileSync(filePath))
    },
    dispose() {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort: the OS reclaims the temp root regardless */
      }
    },
  }
}

/** Strip any directory component and characters that could escape a filename. */
export function safeFileStem(name: string): string {
  const base = basename(name).replace(/[\u0000-\u001f/\\:*?"<>|]/g, '_').trim()
  return base.slice(0, 120)
}

export function fileSize(filePath: string): number {
  return statSync(filePath).size
}

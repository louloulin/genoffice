/**
 * Cross-backend atomic promote (sdk1 §A.5 #9 close-out).
 *
 * Background: `promoteFileAtomically` in `@genoffice/xlsx-gateway`
 * operates at filesystem level (rename / copy-over-locked-target /
 * unlink) and only handles local FILES_DIR paths. The active
 * `StorageBackend` may be remote (s3 / minio / rustfs) and the
 * `recents-watcher.ts` already stores entries as
 * `storage://<backend-id>/<key>` URIs. This helper bridges the two
 * surfaces: a save handler stages bytes to a temp file the same way
 * it always has, then hands the (staging path, target) pair to this
 * function which picks the right promote strategy based on whether
 * the target is a storage URI.
 *
 *   target = `/files/foo.xlsx`         → local rename
 *   target = `storage://minio/abc123`  → backend.put + delete local temp
 *
 * Atomicity semantics per backend:
 *
 *   - local:  rename in same directory; EPERM/EACCES/EBUSY retried
 *             with backoff (existing behaviour).
 *   - s3:     single-shot PUT with the bytes. S3 PUT is itself atomic
 *             at the object level (last writer wins), and the local
 *             staging file is deleted only after the PUT resolves —
 *             a half-failed PUT either lands the new bytes or leaves
 *             the old object untouched.
 *   - minio:  identical to S3 (S3-compatible wire protocol).
 *   - rustfs: identical to S3 (S3-compatible wire protocol).
 *
 * Callers that want strict "no half-written target on failure"
 * semantics should keep their existing staging behaviour (write to
 * staging → promote via this helper → on success, return). Failures
 * here raise — the caller decides whether to retry, fall back to a
 * temp file under FILES_DIR, or surface the error to the renderer.
 */

import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'

import { getStorageBackend, storageKeyFromPath } from './state'

// Re-export the test hooks so consumers can use a single import path
// from the promote helper module. These are deliberately NOT in
// common/index — they're for tests only.
export { _setStorageBackendForTests, _resetStorageBackendForTests } from './state'
import { InvalidArgumentError } from '../ai/errors'

export interface PromoteOptions {
  /** MIME type for the remote PUT (ignored on local promote). */
  contentType?: string
}

export interface PromoteResult {
  /** Which branch ran. Useful for telemetry + retry strategy. */
  promoted: 'local-rename' | 'backend-put'
  /** The resolved storage key for the new bytes, when known. */
  key?: string
  /** Bytes shipped. */
  bytes: number
}

/**
 * Promote a staged file to either a local FILES_DIR path or a
 * `storage://` URI.
 *
 * @param stagingPath - already-written temp file holding the new bytes.
 * @param targetPath  - either an absolute FILES_DIR path or a
 *                      `storage://<backend>/<key>` URI.
 */
export async function promoteAcrossBackend(
  stagingPath: string,
  targetPath: string,
  options: PromoteOptions = {},
): Promise<PromoteResult> {
  if (!stagingPath || typeof stagingPath !== 'string') {
    throw new InvalidArgumentError('promoteAcrossBackend', 'stagingPath must be a non-empty string')
  }
  if (!targetPath || typeof targetPath !== 'string') {
    throw new InvalidArgumentError('promoteAcrossBackend', 'targetPath must be a non-empty string')
  }
  if (!existsSync(stagingPath)) {
    throw new InvalidArgumentError(
      'promoteAcrossBackend',
      `staging file does not exist: ${stagingPath}`,
    )
  }

  // Branch on storage URI vs local path. `storageKeyFromPath` returns a
  // non-null key for both `storage://` URIs and managed FILES_DIR
  // entries, so the local-rename branch is the "non-managed path"
  // fallback (e.g. an explicit /tmp save target).
  const key = storageKeyFromPath(targetPath)
  if (key !== null) {
    return await promoteToBackend(stagingPath, key, options)
  }
  return await promoteToLocalPath(stagingPath, targetPath)
}

async function promoteToBackend(
  stagingPath: string,
  key: string,
  options: PromoteOptions,
): Promise<PromoteResult> {
  const backend = getStorageBackend()
  const bytes = await readFile(stagingPath)
  // Re-use the backend's own typed-array overload. The cast is safe:
  // readFile returns a Buffer (Uint8Array subclass) and the StorageBackend
  // accepts `Uint8Array | Buffer`.
  await backend.put(key, bytes, options.contentType ? { contentType: options.contentType } : {})
  await unlink(stagingPath).catch(() => {
    // A leftover staging file on disk is fine; it lives under WEB_TEMP_ROOT
    // and gets swept at boot + every 24h.
  })
  return { promoted: 'backend-put', key, bytes: bytes.byteLength }
}

async function promoteToLocalPath(
  stagingPath: string,
  targetPath: string,
): Promise<PromoteResult> {
  // Defer to the well-tested xlsx-gateway helper which already handles
  // EPERM retries + Windows locked-target fallback. The staging file
  // is unlinked inside the helper on success, so we don't double-clean.
  const { promoteFileAtomically } = await import('@genoffice/xlsx-gateway/gateway/xlsx-package-io')
  await promoteFileAtomically(stagingPath, targetPath)
  // Approximate the byte count for telemetry — `promoteFileAtomically`
  // doesn't return it, but the staging file is gone now so we can
  // only report "promoted" without exact size. 0 is fine for the
  // metric; callers that need bytes can stat the target.
  return { promoted: 'local-rename', bytes: 0 }
}

import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { StorageNotFoundError } from '@genoffice/file-management'
import { InvalidArgumentError, NotFoundError } from '../ai/errors'
import { PATH_OUTSIDE_STORAGE } from './paths'
import { getStorageBackend, storageKeyFromPath } from './state'

/**
 * Resolve a renderer-supplied file reference to its bytes. Mirrors the
 * pattern that `apps/web-server/src/{docs,slides,pdf}/index.ts` already
 * carry locally — accept either a managed filesystem path (legacy callers)
 * or a `storage://<backend>/<key>` URI (what `web:save-file` returns).
 *
 * Without the storage branch, every uploaded file is invisible to the
 * corresponding editor: clicking the home recents row answers
 * "path is outside the web storage area" because the URI is neither inside
 * `DATA_DIR` nor inside `WEB_TEMP_ROOT`. The local backend writes the bytes
 * under `FILES_DIR/<key>` so the same call site works for either path
 * shape — we just route through the backend for URIs and read the
 * filesystem for managed paths.
 *
 * `extension` narrows the managed-path branch to the format this channel
 * owns (e.g. `.md`, `.html`). A storage URI is treated as already
 * validated by the upload pipeline.
 */
export async function readStorageOrManagedBytes(
  channel: string,
  filePath: string,
  extension: string,
): Promise<Buffer> {
  const key = storageKeyFromPath(filePath)
  if (key) {
    // Refuse traversal at the call site so a probe gets a 400, not the
    // 500 the local backend raises from `pathFor`'s `..` check.
    if (key.split(/[\\/]+/).some((seg) => seg === '..' || seg === '')) {
      throw new InvalidArgumentError(channel, PATH_OUTSIDE_STORAGE)
    }
    try {
      const u8 = await getStorageBackend().get(key)
      return Buffer.from(u8)
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        throw new NotFoundError(channel, `File not found: ${filePath}`)
      }
      throw err
    }
  }
  if (extname(filePath).toLowerCase() === extension.toLowerCase() && existsSync(filePath)) {
    return readFileSync(filePath)
  }
  throw new InvalidArgumentError(channel, PATH_OUTSIDE_STORAGE)
}

/** Re-export so handlers that already do their own extension-and-existence
 *  check can pull the PATH_OUTSIDE_STORAGE constant from one place. */
export { PATH_OUTSIDE_STORAGE }

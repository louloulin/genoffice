/**
 * Soft-delete with a manifest, backed by the active {@link StorageBackend}.
 *
 * Originally a filesystem-only affair: the trash directory held the payload
 * files and a JSON index sat alongside. Once the renderer can store files in
 * MinIO/S3/rustfs, the local `.trash/` stops being the right place — a file
 * living in a remote bucket can't be moved into a local directory. This
 * rewrite keeps the same external API (`delete`/`list`/`restore`/`purge`)
 * but routes every payload operation through the storage backend:
 *
 *   - local backend (id 'local')  : fast path uses rename into `.trash/`,
 *     falls back to copy+delete if the rename target lives across mounts
 *     (n/a today, but the abstraction doesn't preclude it).
 *   - any S3-compatible backend  : get → put under `<key>.trash-<ts>-<rand>`
 *     → delete original. The index is one object at `__path__/.trash/index.json`
 *     (single-process only — concurrent writers would race on it).
 *
 * The public API takes keys, not paths. Callers that have a managed-path
 * (e.g. `storage://<backend>/<key>` or `${FILES_DIR}/<key>`) extract the
 * `<key>` themselves and pass it in. This is the same wire shape across
 * all backends.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJson } from './atomic'
import type { StorageBackend } from './storage/backend'

/** Path the renderer/handlers see. Storage-agnostic: `abc.pdf`, not an
 *  absolute path or a `storage://` URI. */
export type StorageKey = string

export interface TrashEntry {
  id: string
  /** The key in the primary namespace that this entry came from. Restore
   *  moves the payload back to `originalKey`. */
  originalKey: StorageKey
  name: string
  deletedAt: number
  sizeBytes: number
  /** Backend id captured at delete time; restore refuses to write back
   *  if the active backend has changed since. */
  backendId: string
}

interface TrashRecord extends TrashEntry {
  /** Where the payload lives inside the trash namespace. */
  storedKey: StorageKey
}

/** Where the local backend keeps trash data. Sibling of the active files
 *  directory so `rm -rf <files>` doesn't sweep the trash. */
const LOCAL_TRASH_DIR = '.trash'

/** Suffix applied to the original key when moving into the trash under a
 *  remote backend. The unique suffix makes concurrent deletes of the same
 *  file impossible. */
const TRASH_SUFFIX = '__trash__'

export class Trash {
  private readonly indexPath: string

  constructor(
    /** Where the local-side state goes. Required so the index can sit in
     *  a stable location regardless of which backend holds the payload. */
    private readonly root: string,
    /** When provided, payload operations go through the backend so remote
     *  backends get the right semantics. Without a backend, Trash still
     *  works locally (the renderer can keep using it for the legacy
     *  desktop build that predates the storage abstraction). */
    private readonly storage: StorageBackend | null,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.indexPath = join(root, LOCAL_TRASH_DIR, 'index.json')
  }

  private async readIndex(): Promise<TrashRecord[]> {
    /* Read through the backend when it can serve the index path; otherwise
     * fall back to plain fs for the local-only legacy path. The index is
     * always local-rooted (see constructor) so the fs fallback is correct. */
    if (this.storage && this.storage.id !== 'local') {
      try {
        const bytes = await this.storage.get(this.indexKey())
        const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf-8'))
        if (!Array.isArray(parsed)) return []
        return parsed.filter(this.isTrashRecord)
      } catch {
        return []
      }
    }
    try {
      if (!existsSync(this.indexPath)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(this.isTrashRecord)
    } catch {
      return []
    }
  }

  private async writeIndex(records: TrashRecord[]): Promise<void> {
    const json = JSON.stringify(records, null, 2)
    if (this.storage && this.storage.id !== 'local') {
      await this.storage.put(this.indexKey(), new TextEncoder().encode(json))
      return
    }
    mkdirSync(dirname(this.indexPath), { recursive: true })
    atomicWriteJson(this.indexPath, records)
  }

  private indexKey(): StorageKey {
    /* Object key the remote backend uses for the index. Lives inside the
     * trash namespace so `list(prefix)` calls don't surface it. */
    return `${LOCAL_TRASH_DIR}/index.json`
  }

  private isTrashRecord(e: unknown): e is TrashRecord {
    return (
      !!e &&
      typeof e === 'object' &&
      typeof (e as TrashRecord).id === 'string' &&
      typeof (e as TrashRecord).originalKey === 'string' &&
      typeof (e as TrashRecord).storedKey === 'string'
    )
  }

  /** Move `key` into the trash. Returns the entry, or null when the key is
   *  already gone. */
  async delete(key: StorageKey): Promise<TrashEntry | null> {
    const backend = this.storage
    /* Local backend / no backend at all: the legacy rename path is both
     * faster and atomic, and the local backend's key validator refuses
     * paths with '/' so the storage::put route wouldn't work for it. */
    if (!backend || backend.id === 'local') {
      return this.deleteLocalPath(key)
    }
    /* Remote backend: read the original, write to the trash namespace,
     * then delete the original. The intermediate put is the only safe
     * ordering — reverse and a crash leaves the user with a trashed file
     * but no path to restore from. */
    const head = await backend.head(key)
    if (!head.exists) return null
    const id = randomUUID()
    const name = key.split('/').pop() ?? key
    const storedKey = `${LOCAL_TRASH_DIR}/${key}${TRASH_SUFFIX}-${id}`
    const bytes = await backend.get(key)
    await backend.put(storedKey, bytes)
    await backend.delete(key)

    const entry: TrashEntry = {
      id,
      originalKey: key,
      name,
      deletedAt: this.now(),
      sizeBytes: bytes.byteLength,
      backendId: backend.id,
    }
    const records = await this.readIndex()
    records.push({ ...entry, storedKey })
    await this.writeIndex(records)
    return entry
  }

  /** Legacy path-based delete for the desktop build. Mirrors the old
   *  renameSync-based behaviour. */
  private deleteLocalPath(path: string): TrashEntry | null {
    const trashDir = join(this.root, LOCAL_TRASH_DIR)
    if (!existsSync(path)) return null
    const stats = statSync(path)
    if (!stats.isFile()) return null
    mkdirSync(trashDir, { recursive: true })
    const id = randomUUID()
    const name = path.split('/').pop() ?? path
    const storedName = `${id}-${name}`
    renameSync(path, join(trashDir, storedName))
    // Move the .meta.json sidecar alongside the payload so the two stay
    // together in the trash and a future restore is complete.
    const metaPath = `${path}.meta.json`
    if (existsSync(metaPath)) {
      try {
        renameSync(metaPath, join(trashDir, `${id}-${name}.meta.json`))
      } catch {
        // A missing or locked sidecar must not fail the whole delete.
      }
    }
    const entry: TrashEntry = {
      id,
      originalKey: path,
      name,
      deletedAt: this.now(),
      sizeBytes: stats.size,
      backendId: 'local',
    }
    try {
      const raw = readFileSync(this.indexPath, 'utf-8')
      const records = JSON.parse(raw)
      if (Array.isArray(records)) {
        records.push({ ...entry, storedKey: `${LOCAL_TRASH_DIR}/${storedName}` })
        atomicWriteJson(this.indexPath, records)
      }
    } catch {
      mkdirSync(dirname(this.indexPath), { recursive: true })
      atomicWriteJson(this.indexPath, [{ ...entry, storedKey: `${LOCAL_TRASH_DIR}/${storedName}` }])
    }
    return entry
  }

  /** Everything currently in the trash, newest first. */
  async list(): Promise<TrashEntry[]> {
    const records = await this.readIndex()
    return records
      .map(({ storedKey: _storedKey, ...entry }) => entry)
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /** Put `id` back at its original key. */
  async restore(id: string): Promise<{ ok: true; key: StorageKey } | { ok: false; error: string }> {
    const records = await this.readIndex()
    const record = records.find((r) => r.id === id)
    if (!record) return { ok: false, error: 'trash entry not found' }

    const backend = this.storage
    /* Same dispatch as `delete()` — the local branch uses rename for
     * atomicity and to avoid the roundtrip through the storage layer. */
    if (!backend || backend.id === 'local') return this.restoreLocalPath(id, records, record)

    if (backend.id !== record.backendId) {
      return {
        ok: false,
        error: `trash entry belongs to backend "${record.backendId}" but active backend is "${backend.id}"`,
      }
    }
    const head = await backend.head(record.originalKey)
    if (head.exists) return { ok: false, error: 'original key is occupied' }
    const storedHead = await backend.head(record.storedKey)
    if (!storedHead.exists) {
      await this.writeIndex(records.filter((r) => r.id !== id))
      return { ok: false, error: 'trashed payload is missing' }
    }
    const bytes = await backend.get(record.storedKey)
    await backend.put(record.originalKey, bytes)
    await backend.delete(record.storedKey)
    await this.writeIndex(records.filter((r) => r.id !== id))
    return { ok: true, key: record.originalKey }
  }

  private restoreLocalPath(
    id: string,
    records: TrashRecord[],
    record: TrashRecord,
  ): { ok: true; key: StorageKey } | { ok: false; error: string } {
    const trashDir = join(this.root, LOCAL_TRASH_DIR)
    const payload = join(trashDir, record.storedKey.split('/').pop() ?? record.storedKey)
    if (!existsSync(payload)) {
      const filtered = records.filter((r) => r.id !== id)
      atomicWriteJson(this.indexPath, filtered)
      return { ok: false, error: 'trashed file is missing' }
    }
    if (existsSync(record.originalKey)) {
      return { ok: false, error: 'original path is occupied' }
    }
    mkdirSync(dirname(record.originalKey), { recursive: true })
    renameSync(payload, record.originalKey)
    atomicWriteJson(this.indexPath, records.filter((r) => r.id !== id))
    return { ok: true, key: record.originalKey }
  }

  /** Permanently drop an entry and its payload. */
  async purge(id: string): Promise<boolean> {
    const records = await this.readIndex()
    const record = records.find((r) => r.id === id)
    if (!record) return false
    const backend = this.storage
    if (backend) {
      try {
        await backend.delete(record.storedKey)
      } catch {
        /* backend.delete is idempotent on S3; if it failed for another reason,
         * still drop the index row so the UI stops offering a stuck entry. */
      }
    } else {
      const trashDir = join(this.root, LOCAL_TRASH_DIR)
      const localName = record.storedKey.split('/').pop() ?? record.storedKey
      rmSync(join(trashDir, localName), { force: true })
    }
    await this.writeIndex(records.filter((r) => r.id !== id))
    return true
  }

  /** Convenience for the reverse direction: which of these keys are in the
   *  trash. Used by the recents watcher, which must not re-add a file that was
   *  just deleted. */
  async has(key: StorageKey): Promise<boolean> {
    const records = await this.readIndex()
    return records.some((r) => r.originalKey === key)
  }

  /** Payload keys currently in the trash namespace, for diagnostics. */
  async storedKeys(): Promise<string[]> {
    const backend = this.storage
    if (backend && backend.id !== 'local') {
      const list = await backend.list(`${LOCAL_TRASH_DIR}/`)
      return list.map((e) => e.key).filter((k) => !k.endsWith('index.json'))
    }
    const trashDir = join(this.root, LOCAL_TRASH_DIR)
    if (!existsSync(trashDir)) return []
    return readdirSync(trashDir).filter((n) => n !== 'index.json')
  }
}

/* Re-exports kept so existing consumers don't break. */
export const __TESTING__ = { TRASH_SUFFIX }
export { LOCAL_TRASH_DIR }

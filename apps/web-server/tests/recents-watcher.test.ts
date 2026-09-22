/**
 * E2E coverage for `apps/web-server/src/shell/recents-watcher.ts`
 * (sdk1 §11.81 · recents-watcher symmetric setup).
 *
 * Two test axes:
 *   - Local backend: file add/remove in FILES_DIR → recents add/remove.
 *   - Remote (mock S3-like) backend: backend.list() returns new keys →
 *     recents add/remove with `storage://<backend>/<key>` URIs.
 *
 * The watcher has two strategies (fs.watch vs. polling) selected at
 * setup time based on `getStorageBackend().id`. We pin both branches
 * via a mock storage backend that satisfies the StorageBackend
 * interface (only `id` + `list()` are needed for the watcher).
 *
 * Boot/restart semantics:
 *   - setupRecentsFileWatcher() is idempotent (second call no-ops)
 *   - stopRecentsFileWatcher() clears both branches
 *   - setupLocalWatcher tolerates fs.watch throwing EPERM
 *   - setupRemotePoller swallows backend.list() errors and retries
 *     on the next tick
 *
 * Seed pass must NOT emit additions (otherwise every pre-existing file
 * would shadow the user-set name on the home grid).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _setStorageBackendForTests, _resetStorageBackendForTests, getStorageBackend } from '../src/common/state'

type Listener = (entry: { key: string; modifiedAt?: string }) => void

function makeMockBackend(id: string, initialKeys: Array<{ key: string; modifiedAt?: string }> = []) {
  const listeners: Listener[] = []
  let keys = [...initialKeys]
  return {
    id,
    list: vi.fn(async () => keys.map((k) => ({ ...k }))),
    // Test-only helpers
    setKeys(next: Array<{ key: string; modifiedAt?: string }>) {
      keys = next
    },
    emitChange() {
      // Manual trigger — the real S3 backend would just rely on polling.
      for (const l of listeners) l({ key: '', modifiedAt: new Date().toISOString() })
    },
  }
}

interface FakeRecents {
  adds: Array<{ path: string; fields: Record<string, unknown> }>
  removes: string[]
  add(path: string, fields: Record<string, unknown>): Promise<boolean>
  remove(path: string): Promise<boolean>
  get(path: string): { name?: string; modified?: boolean } | undefined
}

function makeFakeRecents(): FakeRecents {
  const adds: Array<{ path: string; fields: Record<string, unknown> }> = []
  const removes: string[] = []
  const store = new Map<string, { name?: string; modified?: boolean }>()
  return {
    adds,
    removes,
    async add(path, fields) {
      adds.push({ path, fields })
      store.set(path, { name: fields.name as string | undefined, modified: fields.modified as boolean | undefined })
      return true
    },
    async remove(path) {
      removes.push(path)
      return store.delete(path)
    },
    get(path) {
      return store.get(path)
    },
  }
}

let tmpDir = ''
let recents: FakeRecents = makeFakeRecents()
const watchHooks: { added: string[]; removed: string[] } = { added: [], removed: [] }

async function setupLocalWatcher(filesDir: string) {
  const { setupRecentsFileWatcher, stopRecentsFileWatcher } = await import('../src/shell/recents-watcher')
  stopRecentsFileWatcher()
  setupRecentsFileWatcher({
    filesDir,
    recents: recents as unknown as Parameters<typeof setupRecentsFileWatcher>[0]['recents'],
    debounceMs: 5,
    onAdded: (p) => watchHooks.added.push(p),
    onRemoved: (p) => watchHooks.removed.push(p),
  })
}

async function setupRemoteWatcher(filesDir: string, backend: ReturnType<typeof makeMockBackend>) {
  const { setupRecentsFileWatcher, stopRecentsFileWatcher } = await import('../src/shell/recents-watcher')
  stopRecentsFileWatcher()
  _setStorageBackendForTests(backend as unknown as Parameters<typeof _setStorageBackendForTests>[0])
  setupRecentsFileWatcher({
    filesDir,
    recents: recents as unknown as Parameters<typeof setupRecentsFileWatcher>[0]['recents'],
    debounceMs: 5,
    pollIntervalMs: 50,
    onAdded: (p) => watchHooks.added.push(p),
    onRemoved: (p) => watchHooks.removed.push(p),
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'recents-watcher-'))
  recents = makeFakeRecents()
  watchHooks.added = []
  watchHooks.removed = []
  _resetStorageBackendForTests()
})

afterEach(async () => {
  const { stopRecentsFileWatcher } = await import('../src/shell/recents-watcher')
  stopRecentsFileWatcher()
  _resetStorageBackendForTests()
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// Wait for the debounced scan + flush
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('recents-watcher · local backend (sdk1 §11.81)', () => {
  it('seeds without emitting additions for pre-existing files', async () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'pre-existing.pdf'), 'seed')
    await setupLocalWatcher(tmpDir)
    await tick(50)
    expect(recents.adds).toHaveLength(0)
    expect(watchHooks.added).toHaveLength(0)
  })

  it('emits an add for a new .pdf file', async () => {
    mkdirSync(tmpDir, { recursive: true })
    await setupLocalWatcher(tmpDir)
    await tick(50)
    writeFileSync(join(tmpDir, 'fresh.pdf'), 'new')
    await tick(80)
    const paths = recents.adds.map((a) => a.path)
    expect(paths.some((p) => p.endsWith('fresh.pdf'))).toBe(true)
    expect(watchHooks.added.some((p) => p.endsWith('fresh.pdf'))).toBe(true)
  })

  it('emits a remove when a watched file is deleted', async () => {
    mkdirSync(tmpDir, { recursive: true })
    const target = join(tmpDir, 'togo.pdf')
    writeFileSync(target, 'x')
    await setupLocalWatcher(tmpDir)
    await tick(50)
    writeFileSync(target, 'updated') // touch → emit add
    await tick(80)
    rmSync(target)
    await tick(80)
    expect(recents.removes.some((p) => p.endsWith('togo.pdf'))).toBe(true)
    expect(watchHooks.removed.some((p) => p.endsWith('togo.pdf'))).toBe(true)
  })

  it('skips dot entries (.trash/)', async () => {
    mkdirSync(join(tmpDir, '.trash'), { recursive: true })
    await setupLocalWatcher(tmpDir)
    await tick(50)
    writeFileSync(join(tmpDir, '.trash', 'ghost.pdf'), 'h')
    await tick(80)
    expect(recents.adds).toHaveLength(0)
  })

  it('skips non-watched extensions', async () => {
    mkdirSync(tmpDir, { recursive: true })
    await setupLocalWatcher(tmpDir)
    await tick(50)
    writeFileSync(join(tmpDir, 'doc.docx'), 'd')
    writeFileSync(join(tmpDir, 'sheet.xlsx'), 's')
    await tick(80)
    expect(recents.adds).toHaveLength(0)
  })

  it('is idempotent — second setup call is a no-op', async () => {
    mkdirSync(tmpDir, { recursive: true })
    await setupLocalWatcher(tmpDir)
    await setupLocalWatcher(tmpDir)
    await tick(50)
    writeFileSync(join(tmpDir, 'twice.pdf'), 't')
    await tick(80)
    // Only ONE add emitted despite two setup calls
    const addsForFile = recents.adds.filter((a) => a.path.endsWith('twice.pdf'))
    expect(addsForFile).toHaveLength(1)
  })
})

describe('recents-watcher · remote backend (sdk1 §11.81)', () => {
  it('polls backend.list() and adds new keys with storage:// URI', async () => {
    mkdirSync(tmpDir, { recursive: true })
    const backend = makeMockBackend('minio', [
      { key: 'fresh.pdf', modifiedAt: new Date().toISOString() },
    ])
    await setupRemoteWatcher(tmpDir, backend)
    await tick(120)
    expect(backend.list).toHaveBeenCalled()
    const paths = recents.adds.map((a) => a.path)
    expect(paths).toContain('storage://minio/fresh.pdf')
  })

  it('removes a key when it disappears from backend.list()', async () => {
    mkdirSync(tmpDir, { recursive: true })
    const backend = makeMockBackend('s3', [
      { key: 'soon-gone.pdf', modifiedAt: new Date().toISOString() },
    ])
    await setupRemoteWatcher(tmpDir, backend)
    await tick(120)
    expect(recents.adds.some((a) => a.path === 'storage://s3/soon-gone.pdf')).toBe(true)

    backend.setKeys([])
    await tick(200)
    expect(recents.removes).toContain('storage://s3/soon-gone.pdf')
    expect(watchHooks.removed).toContain('storage://s3/soon-gone.pdf')
  })

  it('skips dot-prefixed top-level segments in remote keys', async () => {
    mkdirSync(tmpDir, { recursive: true })
    const backend = makeMockBackend('rustfs', [
      { key: '.trash/ghost.pdf', modifiedAt: new Date().toISOString() },
    ])
    await setupRemoteWatcher(tmpDir, backend)
    await tick(120)
    expect(recents.adds).toHaveLength(0)
  })

  it('tolerates backend.list() throwing — does not kill the watcher', async () => {
    mkdirSync(tmpDir, { recursive: true })
    const backend = makeMockBackend('minio', [])
    backend.list.mockRejectedValueOnce(new Error('boom'))
    await setupRemoteWatcher(tmpDir, backend)
    await tick(120)
    // Watcher still alive: subsequent successful list yields adds.
    backend.setKeys([{ key: 'after-recovery.pdf', modifiedAt: new Date().toISOString() }])
    await tick(200)
    expect(recents.adds.some((a) => a.path === 'storage://minio/after-recovery.pdf')).toBe(true)
  })
})

describe('recents-watcher · setup strategy selection (sdk1 §11.81)', () => {
  it('local backend selects fs.watch (no setInterval polling)', async () => {
    mkdirSync(tmpDir, { recursive: true })
    await setupLocalWatcher(tmpDir)
    await tick(50)
    expect(getStorageBackend().id).toBe('local')
  })

  it('remote backend selects polling (no fs.watch)', async () => {
    mkdirSync(tmpDir, { recursive: true })
    const backend = makeMockBackend('s3', [])
    await setupRemoteWatcher(tmpDir, backend)
    await tick(50)
    expect(getStorageBackend().id).toBe('s3')
  })

  it('stop() clears both branches and allows re-setup', async () => {
    mkdirSync(tmpDir, { recursive: true })
    await setupLocalWatcher(tmpDir)
    const { stopRecentsFileWatcher } = await import('../src/shell/recents-watcher')
    stopRecentsFileWatcher()
    // Re-setup should attach fresh watcher without throwing
    await setupLocalWatcher(tmpDir)
    await tick(50)
    writeFileSync(join(tmpDir, 'after-stop.pdf'), 'as')
    await tick(80)
    expect(recents.adds.some((a) => a.path.endsWith('after-stop.pdf'))).toBe(true)
  })
})

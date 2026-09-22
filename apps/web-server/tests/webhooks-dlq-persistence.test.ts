/**
 * DLQ disk persistence (sdk1.md §11.33.4 / §11.35.4 backlog closed).
 *
 * The DLQ writes atomically to `DATA_DIR/webhooks-dlq.json` on every
 * mutation and hydrates from it at module init. These tests restart the
 * module (via `vi.resetModules()` + dynamic import) so the real load
 * path is exercised — not a mock that happens to look right.
 *
 * Isolation: each case owns its own TMP DATA_DIR because the module reads
 * `process.env.DATA_DIR` at import time. `webhooks-dlq.ts` resolves
 * `DATA_DIR` through `common/state.ts` at first import; `vi.resetModules()`
 * re-runs that resolution, so setting the env before each `import()` is
 * enough to point the reloaded module at the fresh dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'webhooks-dlq-persist-'))
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function dlqFile(): string {
  return join(TMP, 'webhooks-dlq.json')
}

function sampleEntry(overrides: Partial<{
  url: string
  event: string
  fileId: string
  body: string
  reason: 'max_attempts' | 'non_retryable_4xx'
}> = {}) {
  return {
    url: 'https://receiver.example/hook',
    event: 'file.saved',
    fileId: 'persist-doc',
    body: '{"hello":"world"}',
    attempts: 3,
    lastStatus: 503,
    lastError: null,
    reason: 'max_attempts' as const,
    ...overrides,
  }
}

describe('DLQ disk persistence (sdk1.md §11.33.4 / §11.35.4)', () => {
  it('persists entries to disk and reloads them after a module reset', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '1')
    const mod = await import('../src/common/webhooks-dlq')
    const id = mod.pushDeadLetter(sampleEntry())

    expect(existsSync(dlqFile())).toBe(true)
    const raw = JSON.parse(readFileSync(dlqFile(), 'utf8')) as { version: number; entries: unknown[] }
    expect(raw.version).toBe(1)
    expect(raw.entries).toHaveLength(1)

    // Simulate a restart: drop the module cache, re-import, verify hydrate.
    vi.resetModules()
    const reloaded = await import('../src/common/webhooks-dlq')
    const live = reloaded.listDeadLetters()
    expect(live).toHaveLength(1)
    expect(live[0]!.id).toBe(id)
    expect(live[0]!.body).toBe('{"hello":"world"}')
    expect(live[0]!.reason).toBe('max_attempts')
    expect(live[0]!.url).toBe('https://receiver.example/hook')
  })

  it('removing an entry rewrites the file so a restart does not resurrect it', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '1')
    const mod = await import('../src/common/webhooks-dlq')
    const id = mod.pushDeadLetter(sampleEntry({ fileId: 'drop-doc' }))
    expect(mod.deleteDeadLetter(id)).toBe(true)
    const raw = JSON.parse(readFileSync(dlqFile(), 'utf8')) as { entries: unknown[] }
    expect(raw.entries).toHaveLength(0)
    vi.resetModules()
    const reloaded = await import('../src/common/webhooks-dlq')
    expect(reloaded.listDeadLetters()).toHaveLength(0)
  })

  it('a failed replay persists the updated attempts/lastError across a restart', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '1')
    // Stub fetch so the replay attempt fails with a retryable 503. The
    // replay path calls store.update() on failure — that's the only
    // public surface that exercises the update() disk write.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch
    try {
      const mod = await import('../src/common/webhooks-dlq')
      const id = mod.pushDeadLetter(sampleEntry({ fileId: 'replay-fail' }))
      const result = await mod.replayDeadLetter(id, { maxAttempts: 1, initialBackoffMs: 0 })
      expect(result.ok).toBe(true)
      expect((result as { removed: boolean }).removed).toBe(false)

      // The on-disk entry must reflect the update (not the original push).
      const raw = JSON.parse(readFileSync(dlqFile(), 'utf8')) as {
        entries: Array<{ id: string; attempts: number; lastStatus: number | null }>
      }
      expect(raw.entries).toHaveLength(1)
      expect(raw.entries[0]!.id).toBe(id)
      expect(raw.entries[0]!.attempts).toBe(4) // 3 from push + 1 replay
      expect(raw.entries[0]!.lastStatus).toBe(503)

      // Hydrating after a restart sees the patched entry too.
      vi.resetModules()
      const reloaded = await import('../src/common/webhooks-dlq')
      const live = reloaded.listDeadLetters()
      expect(live).toHaveLength(1)
      expect(live[0]!.attempts).toBe(4)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('a successful replay removes the entry from disk', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '1')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('ok', { status: 200 })) as unknown as typeof globalThis.fetch
    try {
      const mod = await import('../src/common/webhooks-dlq')
      const id = mod.pushDeadLetter(sampleEntry({ fileId: 'replay-ok' }))
      const result = await mod.replayDeadLetter(id, { maxAttempts: 1, initialBackoffMs: 0 })
      expect(result).toEqual({
        ok: true,
        removed: true,
        result: { finalStatus: 200, attempts: 1, delivered: true },
      })
      const raw = JSON.parse(readFileSync(dlqFile(), 'utf8')) as { entries: unknown[] }
      expect(raw.entries).toHaveLength(0)
      vi.resetModules()
      const reloaded = await import('../src/common/webhooks-dlq')
      expect(reloaded.listDeadLetters()).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('GENOFFICE_DLQ_PERSIST=0 keeps the queue in memory only', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '0')
    const mod = await import('../src/common/webhooks-dlq')
    mod.pushDeadLetter(sampleEntry({ fileId: 'mem-only' }))
    expect(existsSync(dlqFile())).toBe(false)
    vi.resetModules()
    const reloaded = await import('../src/common/webhooks-dlq')
    expect(reloaded.listDeadLetters()).toHaveLength(0)
  })

  it('a corrupt DLQ file is ignored (server boots, queue starts empty, file kept)', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '1')
    writeFileSync(dlqFile(), '{ this is not json', 'utf8')
    const mod = await import('../src/common/webhooks-dlq')
    expect(mod.listDeadLetters()).toHaveLength(0)
    // The corrupt file stays on disk for manual recovery.
    expect(existsSync(dlqFile())).toBe(true)
    expect(readFileSync(dlqFile(), 'utf8')).toBe('{ this is not json')
  })

  it('malformed entries inside a valid-looking file are filtered out', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '1')
    writeFileSync(
      dlqFile(),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'ok',
            url: 'https://x',
            event: 'file.saved',
            fileId: 'f',
            body: '{}',
            attempts: 3,
            lastStatus: 500,
            lastError: null,
            reason: 'max_attempts',
            droppedAt: 1,
          },
          // missing url
          { id: 'bad-missing-url', event: 'file.saved', fileId: 'f', body: '{}', attempts: 3, lastStatus: 500, lastError: null, reason: 'max_attempts', droppedAt: 1 },
          // unknown reason
          { id: 'bad-reason', url: 'https://x', event: 'file.saved', fileId: 'f', body: '{}', attempts: 3, lastStatus: 500, lastError: null, reason: 'wat', droppedAt: 1 },
          null,
        ],
      }),
      'utf8',
    )
    const mod = await import('../src/common/webhooks-dlq')
    const live = mod.listDeadLetters()
    expect(live).toHaveLength(1)
    expect(live[0]!.id).toBe('ok')
  })

  it('entries persist newest-first across a restart', async () => {
    vi.stubEnv('GENOFFICE_DLQ_PERSIST', '1')
    const mod = await import('../src/common/webhooks-dlq')
    const a = mod.pushDeadLetter(sampleEntry({ fileId: 'first' }))
    const b = mod.pushDeadLetter(sampleEntry({ fileId: 'second' }))
    vi.resetModules()
    const reloaded = await import('../src/common/webhooks-dlq')
    const live = reloaded.listDeadLetters()
    expect(live.map((e) => e.id)).toEqual([b, a])
  })
})

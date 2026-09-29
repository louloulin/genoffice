/**
 * Dataflare host documents (drive xlsx) in the web build:
 *   - the web-server's workbook:save answer is adapted to the reopened
 *     desktop contract (it used to fail response validation after writing);
 *   - a saved host document is pushed back exactly once per Save, and a failed
 *     push stays pending so the next Save re-sends it with an empty journal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostDocumentSync } from '../src/renderer/dataflare-host-sync'
import { saveWorkbookOverHttp } from '../src/renderer/web-save'
import { handleSave, type SaveContext } from '../src/renderer/save-actions'
import { createEditJournal, recordSetRangeValues } from '../src/renderer/edit-journal'
import type { WorkbookSaveRequest } from '../src/shared/desktop-api'

const HOST_PATH = '/tmp/web/upload-1/dataflare-s1.xlsx'
const SESSION = '11111111-1111-4111-8111-111111111111'

describe('saveWorkbookOverHttp', () => {
  const request = { sessionId: SESSION, mode: 'save' } as WorkbookSaveRequest

  it('reopens the written path and answers the desktop shape', async () => {
    const reopened = { sessionId: '22222222-2222-4222-8222-222222222222', path: HOST_PATH }
    const invoke = vi.fn(async (channel: string) =>
      channel === 'workbook:save'
        ? { ok: true, path: HOST_PATH, touchedEntries: ['xl/worksheets/sheet1.xml'] }
        : reopened,
    )
    const result = await saveWorkbookOverHttp({ invoke }, request)
    expect(invoke).toHaveBeenNthCalledWith(2, 'workbook:open-path', HOST_PATH)
    expect(result).toEqual({
      canceled: false,
      file: reopened,
      touchedEntries: ['xl/worksheets/sheet1.xml'],
    })
  })

  it('throws the gateway message on { ok: false } so save-actions can localize it', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: 'The save target is locked by another program' }))
    await expect(saveWorkbookOverHttp({ invoke }, request)).rejects.toThrow('locked by another program')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('passes desktop-shaped answers through untouched', async () => {
    const invoke = vi.fn(async () => ({ canceled: true }))
    await expect(saveWorkbookOverHttp({ invoke }, request)).resolves.toEqual({ canceled: true })
  })
})

describe('createHostDocumentSync', () => {
  const bytes = new Uint8Array([0x50, 0x4b]).buffer

  function build(saveToHost: Parameters<typeof createHostDocumentSync>[0]['saveToHost'], host = true) {
    const sync = createHostDocumentSync({
      readFileBytes: async () => bytes,
      saveToHost,
      isHostDocument: () => host,
    })
    sync.setHostDocumentPath(HOST_PATH)
    return sync
  }

  it('ignores files that are not the host document', async () => {
    const saveToHost = vi.fn(async () => ({ ok: true as const }))
    const sync = build(saveToHost)
    expect(await sync.sync('/tmp/other.xlsx')).toEqual({ status: 'not-host' })
    expect(await build(saveToHost, false).sync(HOST_PATH)).toEqual({ status: 'not-host' })
    expect(saveToHost).not.toHaveBeenCalled()
  })

  it('uploads the saved bytes and clears pending', async () => {
    const saveToHost = vi.fn(async () => ({ ok: true as const }))
    const sync = build(saveToHost)
    expect(await sync.sync(HOST_PATH)).toEqual({ status: 'synced' })
    expect(saveToHost).toHaveBeenCalledWith(HOST_PATH, bytes)
    expect(sync.hasPending()).toBe(false)
  })

  it('a failed upload stays pending; a conflict does not (a retry would 409 again)', async () => {
    const failing = build(async () => ({ ok: false, reason: 'save-failed', error: 'HTTP 502' }))
    expect(await failing.sync(HOST_PATH)).toEqual({ status: 'failed', error: 'HTTP 502', conflict: false })
    expect(failing.hasPending()).toBe(true)

    const conflicting = build(async () => ({ ok: false, reason: 'external-modified', error: 'stale' }))
    expect(await conflicting.sync(HOST_PATH)).toMatchObject({ status: 'failed', conflict: true })
    expect(conflicting.hasPending()).toBe(false)
  })

  it('a thrown read/upload error is a pending failure, never an exception', async () => {
    const sync = build(async () => {
      throw new Error('network down')
    })
    expect(await sync.sync(HOST_PATH)).toEqual({ status: 'failed', error: 'network down', conflict: false })
    expect(sync.hasPending()).toBe(true)
  })
})

describe('handleSave with a host document', () => {
  const saveWorkbookEdits = vi.fn()
  const syncHostDocument = vi.fn()
  const hasPendingHostSync = vi.fn()

  beforeEach(() => {
    saveWorkbookEdits.mockReset().mockResolvedValue({
      canceled: false,
      file: { sessionId: SESSION, path: HOST_PATH },
      touchedEntries: [],
    })
    syncHostDocument.mockReset().mockResolvedValue({ status: 'synced' })
    hasPendingHostSync.mockReset().mockReturnValue(false)
    ;(globalThis as unknown as { window: unknown }).window = {
      desktopApi: { saveWorkbookEdits, syncHostDocument, hasPendingHostSync },
    }
  })

  function ctxWith(dirty: boolean): { ctx: SaveContext; messages: string[]; opened: unknown[] } {
    const journal = createEditJournal()
    if (dirty) recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'edited' } } })
    const messages: string[] = []
    const opened: unknown[] = []
    return {
      messages,
      opened,
      ctx: {
        univerRef: { current: null },
        stashViewRestore: () => {},
        lazyWorkbookRef: {
          current: {
            editJournal: journal,
            recalc: { timer: null, generation: 0, failed: false, formulaCells: new Map(), overlay: new Map() },
            file: { sessionId: SESSION, path: HOST_PATH },
          },
        } as never,
        setMessage: (m: string) => messages.push(m),
        openLazyWorkbook: (file) => opened.push(file),
      },
    }
  }

  it('pushes the saved workbook to the host once and reports the new version', async () => {
    const { ctx, messages, opened } = ctxWith(true)
    await handleSave(ctx, 'save', true)
    expect(opened).toHaveLength(1)
    expect(syncHostDocument).toHaveBeenCalledTimes(1)
    expect(syncHostDocument).toHaveBeenCalledWith(HOST_PATH)
    expect(messages.at(-1)).toBe('已保存为新版本。')
  })

  it('keeps the plain "Saved." for files the host does not own', async () => {
    syncHostDocument.mockResolvedValue({ status: 'not-host' })
    const { ctx, messages } = ctxWith(true)
    await handleSave(ctx, 'save', true)
    expect(messages.at(-1)).toBe('已保存。')
  })

  it('reports a failed upload instead of claiming success', async () => {
    syncHostDocument.mockResolvedValue({ status: 'failed', error: 'HTTP 502', conflict: false })
    const { ctx, messages } = ctxWith(true)
    await handleSave(ctx, 'save', true)
    expect(messages.at(-1)).toContain('HTTP 502')
    expect(messages).not.toContain('已保存。')
  })

  it('re-sends a pending upload on Save even with an empty journal', async () => {
    hasPendingHostSync.mockReturnValue(true)
    const { ctx, messages } = ctxWith(false)
    await handleSave(ctx, 'save', true)
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
    expect(syncHostDocument).toHaveBeenCalledWith(HOST_PATH)
    expect(messages.at(-1)).toBe('已保存为新版本。')
  })

  it('an empty journal with nothing pending still says there is nothing to save', async () => {
    const { ctx, messages } = ctxWith(false)
    await handleSave(ctx, 'save', true)
    expect(syncHostDocument).not.toHaveBeenCalled()
    expect(messages.at(-1)).toBe('还没有可保存的编辑。')
  })
})

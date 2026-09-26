/**
 * Collab state disk persistence (plan §7 W5).
 *
 * The collab Maps (sessions, presence, permissions, versions, comments,
 * templates) live in process memory but are mirrored to disk so a
 * web-server restart does not wipe the document history.
 *
 * This probe restarts the module (`vi.resetModules()` + dynamic import)
 * so the real load path is exercised — not a mock that happens to look
 * right. Mirrors the audit-log-persistence probe's isolation strategy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'collab-store-'))
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

async function loadStore() {
  return await import('../src/common/collab-store')
}

async function loadState() {
  return await import('../src/common/state')
}

describe('collab store — disk persistence (W5)', () => {
  it('writes collab-sessions.json after saveCollabSessions()', async () => {
    const { saveCollabSessions } = await loadStore()
    const { COLLAB_SESSIONS } = await loadState()

    COLLAB_SESSIONS.set('doc-1', {
      docId: 'doc-1',
      users: new Set(['alice', 'bob']),
      lastActivity: 1700000000000,
      locks: new Map(),
      cursors: new Map(),
      changes: [],
    })
    saveCollabSessions()

    const path = join(TMP, 'collab-sessions.json')
    expect(existsSync(path)).toBe(true)
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    expect(Array.isArray(raw)).toBe(true)
    expect(raw[0][0]).toBe('doc-1')
    expect(raw[0][1].users.sort()).toEqual(['alice', 'bob'])
  })

  it('restores COLLAB_SESSIONS across simulated restart', async () => {
    const { saveCollabSessions, loadCollabStore } = await loadStore()
    const { COLLAB_SESSIONS } = await loadState()

    COLLAB_SESSIONS.set('doc-restart', {
      docId: 'doc-restart',
      users: new Set(['carol']),
      lastActivity: 1700000001111,
      locks: new Map([['document', { userId: 'carol', timestamp: 1700000002222 }]]),
      cursors: new Map(),
      changes: [{ id: 'c-1', docId: 'doc-restart', userId: 'carol', change: { type: 'insert' }, timestamp: 1700000003333, version: 0 }],
    })
    saveCollabSessions()

    // Simulate restart: drop the in-memory Map and re-import the loader.
    COLLAB_SESSIONS.clear()
    loadCollabStore()

    const session = COLLAB_SESSIONS.get('doc-restart')
    expect(session).toBeDefined()
    expect(session!.users.has('carol')).toBe(true)
    expect(session!.locks.get('document')?.userId).toBe('carol')
    expect(session!.changes[0].id).toBe('c-1')
  })

  it('persists doc comments across restart', async () => {
    const { saveDocComments, loadCollabStore } = await loadStore()
    const { DOC_COMMENTS } = await loadState()

    DOC_COMMENTS.set('doc-c', [
      {
        id: 'comment-1',
        userId: 'alice',
        userName: 'Alice',
        content: 'first review',
        timestamp: 1700000001000,
        resolved: false,
        replies: [],
      },
    ])
    saveDocComments()

    DOC_COMMENTS.clear()
    loadCollabStore()

    const comments = DOC_COMMENTS.get('doc-c')
    expect(comments).toBeDefined()
    expect(comments![0].content).toBe('first review')
  })

  it('persists templates across restart', async () => {
    const { saveTemplates, loadCollabStore } = await loadStore()
    const { TEMPLATES } = await loadState()

    TEMPLATES.set('tpl-1', {
      id: 'tpl-1',
      name: 'Weekly Report',
      type: 'docs',
      content: '<p>Weekly</p>',
      category: '自定义',
      tags: ['weekly'],
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    })
    saveTemplates()

    TEMPLATES.clear()
    loadCollabStore()

    expect(TEMPLATES.get('tpl-1')?.name).toBe('Weekly Report')
  })

  it('degrades to empty Maps when files are missing', async () => {
    const { loadCollabStore } = await loadStore()
    const { COLLAB_SESSIONS, DOC_COMMENTS } = await loadState()

    expect(existsSync(join(TMP, 'collab-sessions.json'))).toBe(false)
    loadCollabStore()
    expect(COLLAB_SESSIONS.size).toBe(0)
    expect(DOC_COMMENTS.size).toBe(0)
  })

  it('degrades to empty Maps on malformed JSON', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(TMP, 'collab-sessions.json'), '{ not valid json')
    const { loadCollabStore } = await loadStore()
    const { COLLAB_SESSIONS } = await loadState()
    loadCollabStore()
    expect(COLLAB_SESSIONS.size).toBe(0)
  })
})
/**
 * Server-side SDK command dispatch (sdk1.md §11.36).
 *
 * The embed bridge relays host SDK commands to `POST /api/ipc/sdk:command`.
 * This suite pins the dispatch contract of
 * `apps/web-server/src/embed/sdk-commands.ts`:
 *
 *   1. Server-backed commands (comments / versions / telemetry) hit the
 *      durable stores and return the SDK-shaped result.
 *   2. Renderer-owned commands (setContent, mountSidebar, …) reject with
 *      a structured `UNSUPPORTED` + remediation hint — never a hang and
 *      never a silent `{ok:true}`.
 *   3. docId resolution rejects path traversal and accepts both bare
 *      basenames and FILES_DIR-relative subpaths.
 *   4. Every response is either `{ok:true, result}` or
 *      `{ok:false, error:{code, message}}` — no third shape.
 *
 * Isolation: temp DATA_DIR so the comments.json / versions writes stay
 * hermetic and don't touch the developer's real store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sdk-command-'))
process.env.DATA_DIR = TMP
process.env.GENOFFICE_DATA_DIR = TMP
vi.stubEnv('DATA_DIR', TMP)

import {
  _resetUsageForTests,
  dispatchSdkCommand,
  getUsageTotals,
  resolveDocPath,
  SDK_COMMAND_CHANNEL,
  SDK_COMMAND_TABLE,
  registerSdkCommandHandlers,
  supportedSdkCommands,
  type SdkCommandResponse,
} from '../src/embed/sdk-commands'
import { _resetCommentsForTests, listComments } from '../src/common/comments-store'
import { _resetForTests as _resetVersions, listVersions } from '../src/common/version-history'
import { FILES_DIR } from '../src/common/state'
import { getHandler } from '../src/common/registry'

beforeEach(() => {
  _resetCommentsForTests()
  _resetVersions()
  _resetUsageForTests()
  mkdirSync(FILES_DIR, { recursive: true })
})

afterEach(() => {
  _resetCommentsForTests()
  _resetVersions()
  _resetUsageForTests()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

function expectOk(res: SdkCommandResponse): { ok: true; result: unknown } {
  expect(res.ok).toBe(true)
  return res as { ok: true; result: unknown }
}

function expectFail(res: SdkCommandResponse): { ok: false; error: { code: string; message: string } } {
  expect(res.ok).toBe(false)
  return res as { ok: false; error: { code: string; message: string } }
}

describe('sdk-commands dispatch (sdk1.md §11.36)', () => {
  it('exposes a single canonical IPC channel', () => {
    expect(SDK_COMMAND_CHANNEL).toBe('sdk:command')
  })

  it('registers the sdk:command handler on the shared registry', () => {
    // index.ts calls registerSdkCommandHandlers() at boot; importing the
    // module alone does not. Register explicitly so the assertion is
    // hermetic against test-file ordering.
    registerSdkCommandHandlers()
    expect(getHandler(SDK_COMMAND_CHANNEL)).toBeTypeOf('function')
  })

  it('lists the server-backed command surface', () => {
    expect(supportedSdkCommands()).toEqual([
      'addComment',
      'createSnapshot',
      'listComments',
      'listVersions',
      'removeComment',
      'reportUsage',
      'resolveComment',
      'restoreVersion',
    ])
  })

  // ── docId resolution ──────────────────────────────────────────────────────

  it('resolveDocPath accepts a bare basename', () => {
    const r = resolveDocPath('report.docx')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.key).toBe('report.docx')
      expect(r.abs.endsWith(join('files', 'report.docx'))).toBe(true)
    }
  })

  it('resolveDocPath accepts a FILES_DIR-relative subpath and keys on basename', () => {
    const r = resolveDocPath('projects/q3/report.docx')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.key).toBe('report.docx')
  })

  it('resolveDocPath rejects path traversal', () => {
    expect(resolveDocPath('../../etc/passwd').ok).toBe(false)
    expect(resolveDocPath('').ok).toBe(false)
  })

  // ── comments ──────────────────────────────────────────────────────────────

  it('addComment writes through to the durable store and returns the id', () => {
    const res = expectOk(
      dispatchSdkCommand({
        name: 'addComment',
        docId: 'doc-a.docx',
        args: { text: 'look here', anchor: { cell: 'B2' } },
      }),
    )
    const id = (res.result as { id: string }).id
    expect(id).toMatch(/^cm_/)
    const stored = listComments('doc-a.docx')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.text).toBe('look here')
    expect(stored[0]!.anchor).toEqual({ cell: 'B2' })
  })

  it('addComment rejects an empty text', () => {
    const res = expectFail(dispatchSdkCommand({ name: 'addComment', docId: 'd.docx', args: { text: '', anchor: {} } }))
    expect(res.error.code).toBe('INVALID_ARGUMENT')
  })

  it('addComment rejects a missing anchor', () => {
    const res = expectFail(dispatchSdkCommand({ name: 'addComment', docId: 'd.docx', args: { text: 'x' } }))
    expect(res.error.code).toBe('INVALID_ARGUMENT')
  })

  it('listComments returns the persisted comments for the doc', () => {
    dispatchSdkCommand({ name: 'addComment', docId: 'd.docx', args: { text: 'a', anchor: {} } })
    dispatchSdkCommand({ name: 'addComment', docId: 'd.docx', args: { text: 'b', anchor: {} } })
    const res = expectOk(dispatchSdkCommand({ name: 'listComments', docId: 'd.docx', args: {} }))
    const comments = (res.result as { comments: unknown[] }).comments
    expect(comments).toHaveLength(2)
  })

  it('resolveComment flips the flag and unknown ids 404', () => {
    const added = expectOk(dispatchSdkCommand({ name: 'addComment', docId: 'd.docx', args: { text: 'a', anchor: {} } }))
    const id = (added.result as { id: string }).id
    expectOk(dispatchSdkCommand({ name: 'resolveComment', docId: 'd.docx', args: { id, resolved: true } }))
    expect(listComments('d.docx')[0]!.resolved).toBe(true)
    const missing = expectFail(dispatchSdkCommand({ name: 'resolveComment', docId: 'd.docx', args: { id: 'nope' } }))
    expect(missing.error.code).toBe('NOT_FOUND')
  })

  it('removeComment deletes and unknown ids 404', () => {
    const added = expectOk(dispatchSdkCommand({ name: 'addComment', docId: 'd.docx', args: { text: 'a', anchor: {} } }))
    const id = (added.result as { id: string }).id
    expectOk(dispatchSdkCommand({ name: 'removeComment', docId: 'd.docx', args: { id } }))
    expect(listComments('d.docx')).toHaveLength(0)
    const missing = expectFail(dispatchSdkCommand({ name: 'removeComment', docId: 'd.docx', args: { id } }))
    expect(missing.error.code).toBe('NOT_FOUND')
  })

  // ── versions ──────────────────────────────────────────────────────────────

  it('createSnapshot captures the live file bytes into the version store', () => {
    writeFileSync(join(FILES_DIR, 'doc-b.docx'), Buffer.from('hello version'))
    const res = expectOk(dispatchSdkCommand({ name: 'createSnapshot', docId: 'doc-b.docx', args: { label: 'save point' } }))
    const id = (res.result as { id: string }).id
    expect(id).toMatch(/^v-/)
    const versions = listVersions('doc-b.docx')
    expect(versions).toHaveLength(1)
    expect(versions[0]!.message).toBe('save point')
  })

  it('createSnapshot 404s when the file does not exist', () => {
    const res = expectFail(dispatchSdkCommand({ name: 'createSnapshot', docId: 'missing.docx', args: {} }))
    expect(res.error.code).toBe('NOT_FOUND')
  })

  it('listVersions returns the SDK wire shape', () => {
    writeFileSync(join(FILES_DIR, 'doc-c.docx'), Buffer.from('v1'))
    dispatchSdkCommand({ name: 'createSnapshot', docId: 'doc-c.docx', args: {} })
    const res = expectOk(dispatchSdkCommand({ name: 'listVersions', docId: 'doc-c.docx', args: {} }))
    const versions = (res.result as { versions: Array<Record<string, unknown>> }).versions
    expect(versions).toHaveLength(1)
    // 'message' is only present when the snapshot carried a label, so
    // assert the always-present fields are a subset rather than an exact set.
    expect(Object.keys(versions[0]!)).toEqual(expect.arrayContaining(['docId', 'id', 'index', 'sha256', 'size', 'timestamp']))
  })

  it('restoreVersion rewrites the live file and reports the newest version id', () => {
    const target = join(FILES_DIR, 'doc-d.docx')
    writeFileSync(target, Buffer.from('original'))
    const snap = expectOk(dispatchSdkCommand({ name: 'createSnapshot', docId: 'doc-d.docx', args: {} }))
    const versionId = (snap.result as { id: string }).id
    writeFileSync(target, Buffer.from('mutated'))
    const res = expectOk(dispatchSdkCommand({ name: 'restoreVersion', docId: 'doc-d.docx', args: { versionId } }))
    expect((res.result as { version: string }).version).toMatch(/^v-/)
    // The restore captures a pre-restore snapshot, so we now have 2.
    expect(listVersions('doc-d.docx').length).toBe(2)
  })

  it('restoreVersion rejects an unknown version id', () => {
    writeFileSync(join(FILES_DIR, 'doc-e.docx'), Buffer.from('x'))
    const res = expectFail(
      dispatchSdkCommand({ name: 'restoreVersion', docId: 'doc-e.docx', args: { versionId: 'v-doc-e.docx-99' } }),
    )
    expect(res.error.code).toBe('NOT_FOUND')
  })

  // ── telemetry ─────────────────────────────────────────────────────────────

  it('reportUsage aggregates counters and distinct instances', () => {
    dispatchSdkCommand({
      name: 'reportUsage',
      docId: 'd.docx',
      args: { instanceId: 'inst-1', docBytesWritten: 100, aiCalls: 2, aiTokensIn: 30, aiTokensOut: 40, sessionDurationMs: 1000 },
    })
    dispatchSdkCommand({
      name: 'reportUsage',
      docId: 'd.docx',
      args: { instanceId: 'inst-1', docBytesWritten: 50, aiCalls: 1, aiTokensIn: 10, aiTokensOut: 20, sessionDurationMs: 500 },
    })
    dispatchSdkCommand({
      name: 'reportUsage',
      docId: 'd.docx',
      args: { instanceId: 'inst-2', docBytesWritten: 1, aiCalls: 0, aiTokensIn: 0, aiTokensOut: 0, sessionDurationMs: 1 },
    })
    const totals = getUsageTotals()
    expect(totals.samples).toBe(3)
    expect(totals.docBytesWritten).toBe(151)
    expect(totals.aiCalls).toBe(3)
    expect(totals.aiTokensIn).toBe(40)
    expect(totals.aiTokensOut).toBe(60)
    expect(totals.sessionDurationMs).toBe(1501)
    expect(totals.instances).toBe(2)
  })

  it('reportUsage tolerates missing / non-numeric fields', () => {
    expectOk(dispatchSdkCommand({ name: 'reportUsage', docId: 'd.docx', args: {} }))
    expectOk(dispatchSdkCommand({ name: 'reportUsage', docId: 'd.docx', args: { docBytesWritten: 'nope' } }))
    const totals = getUsageTotals()
    expect(totals.samples).toBe(2)
    expect(totals.docBytesWritten).toBe(0)
  })

  // ── unsupported + malformed ───────────────────────────────────────────────

  it('rejects renderer-owned commands with WEB_UNSUPPORTED + a remediation hint', () => {
    for (const name of ['setContent', 'insertText', 'undo', 'mountSidebar', 'openFileDialog', 'print']) {
      const res = expectFail(dispatchSdkCommand({ name, docId: 'd.docx', args: {} }))
      expect(res.error.code).toBe('WEB_UNSUPPORTED')
      expect(res.error.message).toContain('renderer bundle')
    }
  })

  it('rejects an empty / missing command name', () => {
    expect(expectFail(dispatchSdkCommand({ name: '', docId: 'd.docx' })).error.code).toBe('INVALID_ARGUMENT')
    expect(expectFail(dispatchSdkCommand({} as never)).error.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a missing docId for doc-scoped commands', () => {
    const res = expectFail(dispatchSdkCommand({ name: 'listComments', args: {} }))
    expect(res.error.code).toBe('INVALID_ARGUMENT')
    expect(res.error.message).toContain('docId')
  })

  it('never throws — a handler crash surfaces as INTERNAL', () => {
    const original = SDK_COMMAND_TABLE.listComments
    SDK_COMMAND_TABLE.listComments = () => {
      throw new Error('boom')
    }
    try {
      const res = expectFail(dispatchSdkCommand({ name: 'listComments', docId: 'd.docx', args: {} }))
      expect(res.error.code).toBe('INTERNAL')
      expect(res.error.message).toBe('boom')
    } finally {
      SDK_COMMAND_TABLE.listComments = original
    }
  })

  it('every response is either {ok:true,result} or {ok:false,error} — no third shape', () => {
    const samples = [
      dispatchSdkCommand({ name: 'listComments', docId: 'd.docx', args: {} }),
      dispatchSdkCommand({ name: 'setContent', docId: 'd.docx', args: {} }),
      dispatchSdkCommand({ name: 'nope', docId: 'd.docx', args: {} }),
    ]
    for (const res of samples) {
      if (res.ok) expect('result' in res).toBe(true)
      else {
        expect(typeof res.error.code).toBe('string')
        expect(typeof res.error.message).toBe('string')
      }
    }
  })
})

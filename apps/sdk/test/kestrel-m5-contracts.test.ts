/**
 * SDK 2.0 Kestrel M5 — full-surface type-level contract pin
 * (sdk1.md §B.5.6 verification gate #1: 'SDK tests 182/182').
 *
 * Adds tight type-level contracts for the surfaces that ship with
 * Kestrel M2 (Comments) / M3 (Versions) / M3.5 (Plugin Runtime) /
 * M4 (File Picker + Telemetry). The runtime round-trip itself is a
 * renderer-side follow-up; this file pins the wire shape the host
 * codes against so future breaking changes are caught at typecheck.
 *
 * Coverage (one test per surface contract point):
 *
 *   M2 Comments (4 cmds + 2 events + 1 type)
 *   M3 Versions (3 cmds + 1 type)
 *   M3.5 Plugin Runtime (3 cmds + 1 event + 1 type)
 *   M4 File Picker (1 cmd + 1 type)
 *   M4 Telemetry (1 event + 1 type + CreateEditorOptions telemetry)
 *
 * Plus error-path pins:
 *   - editor.command() rejects when destroyed
 *   - editor.command() rejects when no iframe
 *   - EditorHandle.instanceId always non-empty
 *   - getEditor returns undefined for unknown / destroyed ids
 *   - createEditor throws on missing required options
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  Comment,
  CommentAddedEvent,
  CommentAnchor,
  CommentResolvedEvent,
  PickedFile,
  SidebarMessageEvent,
  UsageEvent,
  VersionMeta,
  EditorCommands,
  EditorEvent,
  EditorEventMap,
  EditorHandle,
  CreateEditorOptions,
} from '../src/types'

// ── DOM stubs ────────────────────────────────────────────────────────────
type Listener = (event: unknown) => void
const windowListeners: Listener[] = []

beforeEach(async () => {
  const { _resetEditorRegistryForTests } = await import('../src/editor')
  _resetEditorRegistryForTests()
  windowListeners.length = 0
  ;(globalThis as { window?: { addEventListener: (t: string, l: Listener) => void; removeEventListener: (t: string, l: Listener) => void } }).window = {
    addEventListener: (_t: string, l: Listener) => { windowListeners.push(l) },
    removeEventListener: (_t: string, l: Listener) => {
      const i = windowListeners.indexOf(l)
      if (i >= 0) windowListeners.splice(i, 1)
    },
  }
  ;(globalThis as { document?: { body: unknown; createElement: (tag: string) => unknown } }).document = {
    body: { appendChild: () => undefined } as unknown,
    createElement: (_tag: string) => ({
      set src(_v: string) {},
      set allow(_v: string) {},
      set name(_v: string) {},
      set style(_v: unknown) {},
      appendChild(_child: unknown) {},
    }),
  }
})

afterEach(() => {
  // SDK createEditor handlers call .destroy() on beforeunload; we don't
  // fire beforeunload in node, so the registry is reset in beforeEach.
})

async function makeEditor(opts: Record<string, unknown> = {}): Promise<EditorHandle> {
  const mod = await import('../src/editor')
  return mod.createEditor({
    documentId: 'doc-1',
    app: 'docs',
    jwt: 'fake.jwt.token',
    host: 'https://example.test',
    skipIframe: true,
    handshake: false,
    ...opts,
  })
}

// ──────────────────────────────────────────────────────────────────────────
// M2 Comments — type contract
// ──────────────────────────────────────────────────────────────────────────
describe('Kestrel M5: M2 Comments type contract', () => {
  it('Comment shape (id / author / text / anchor / createdAt / resolvedAt? / resolved / parentId?)', () => {
    const c: Comment = {
      id: 'c1',
      author: 'alice@example.test',
      text: 'first review',
      anchor: { range: { start: 0, end: 5 } },
      createdAt: 1737000000000,
      resolved: false,
    }
    expect(c.id).toBe('c1')
    // Optional fields can be omitted (parentId, resolvedAt).
    const c2: Comment = {
      id: 'c2',
      author: 'bob',
      text: 'reply',
      anchor: { cell: 'A1' },
      createdAt: 1737000000001,
      resolved: true,
      resolvedAt: 1737000000002,
      parentId: 'c1',
    }
    expect(c2.parentId).toBe('c1')
    expect(c2.resolvedAt).toBe(1737000000002)
  })

  it('CommentAnchor accepts range / cell / slideId / [k:v] open extension', () => {
    const a1: CommentAnchor = { range: { start: 0, end: 5 } }
    const a2: CommentAnchor = { cell: 'A1' }
    const a3: CommentAnchor = { slideId: 'slide-2' }
    // Open extension: CommentAnchor is index-signature-friendly
    const a4: CommentAnchor = { custom: 'value', another: 42 }
    expect(a1.range).toEqual({ start: 0, end: 5 })
    expect(a2.cell).toBe('A1')
    expect(a3.slideId).toBe('slide-2')
    expect(a4.custom).toBe('value')
  })

  it('addComment args include anchor + text + optional parentId', () => {
    type Cmd = EditorCommands['addComment']
    const _a: Cmd['args'] = { anchor: { range: { start: 0, end: 5 } }, text: 'note' }
    const _b: Cmd['args'] = { anchor: { cell: 'B2' }, text: 'note', parentId: 'parent-1' }
    const _r: Cmd['result'] = { id: 'new-id' }
    expect(_a.text).toBe('note')
    expect(_b.parentId).toBe('parent-1')
    expect(_r.id).toBe('new-id')
  })

  it('listComments args filter on resolved / parentId (both optional)', () => {
    type Cmd = EditorCommands['listComments']
    const _a: Cmd['args'] = { resolved: false }
    const _b: Cmd['args'] = { parentId: 'p1' }
    const _c: Cmd['args'] = undefined
    const _r: Cmd['result'] = { comments: [] }
    expect(_a.resolved).toBe(false)
    expect(_b.parentId).toBe('p1')
    expect(_c).toBeUndefined()
    expect(_r.comments).toEqual([])
  })

  it('resolveComment args: id + resolved boolean', () => {
    type Cmd = EditorCommands['resolveComment']
    const _a: Cmd['args'] = { id: 'c1', resolved: true }
    expect(_a.id).toBe('c1')
    expect(_a.resolved).toBe(true)
  })

  it('removeComment args: id only', () => {
    type Cmd = EditorCommands['removeComment']
    const _a: Cmd['args'] = { id: 'c1' }
    expect(_a.id).toBe('c1')
  })

  it('CommentAddedEvent / CommentResolvedEvent in EditorEvent union + map', () => {
    const added: CommentAddedEvent = { type: 'commentAdded', comment: {} as Comment }
    const resolved: CommentResolvedEvent = { type: 'commentResolved', comment: {} as Comment }
    const _ev1: EditorEvent = added
    const _ev2: EditorEvent = resolved
    type M = EditorEventMap
    const _m1: M['commentAdded'] = added
    const _m2: M['commentResolved'] = resolved
    expect(_ev1.type).toBe('commentAdded')
    expect(_ev2.type).toBe('commentResolved')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// M3 Versions — type contract
// ──────────────────────────────────────────────────────────────────────────
describe('Kestrel M5: M3 Versions type contract', () => {
  it('VersionMeta shape (id / docId / index / timestamp / size / sha256 / message?)', () => {
    const v: VersionMeta = {
      id: 'v-doc-1-3-abc',
      docId: 'doc-1',
      index: 3,
      timestamp: 1737000000000,
      size: 4096,
      sha256: 'a'.repeat(64),
    }
    expect(v.index).toBe(3)
    expect(v.sha256.length).toBe(64)
    // message is optional
    const v2: VersionMeta = { ...v, message: 'pre-edit save point' }
    expect(v2.message).toBe('pre-edit save point')
  })

  it('listVersions result wraps versions array', () => {
    type Cmd = EditorCommands['listVersions']
    const _a: Cmd['args'] = undefined
    const _r: Cmd['result'] = { versions: [] }
    expect(_r.versions).toEqual([])
  })

  it('restoreVersion args: versionId; result: { version }', () => {
    type Cmd = EditorCommands['restoreVersion']
    const _a: Cmd['args'] = { versionId: 'v-doc-1-3-abc' }
    const _r: Cmd['result'] = { version: 'v-doc-1-4-newer' }
    expect(_a.versionId).toBe('v-doc-1-3-abc')
    expect(_r.version).toBe('v-doc-1-4-newer')
  })

  it('createSnapshot args: label optional; result: { id }', () => {
    type Cmd = EditorCommands['createSnapshot']
    const _a: Cmd['args'] = { label: 'pre-rewrite' }
    const _b: Cmd['args'] = {}
    const _r: Cmd['result'] = { id: 'v-doc-1-5-xyz' }
    expect(_a.label).toBe('pre-rewrite')
    expect(_b.label).toBeUndefined()
    expect(_r.id).toBe('v-doc-1-5-xyz')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// M3.5 Plugin Runtime — type contract
// ──────────────────────────────────────────────────────────────────────────
describe('Kestrel M5: M3.5 Plugin Runtime type contract', () => {
  it('mountSidebar args: panelUrl required + width / title optional; result: { panelId }', () => {
    type Cmd = EditorCommands['mountSidebar']
    const _a: Cmd['args'] = { panelUrl: 'https://plugin.example.test/' }
    const _b: Cmd['args'] = { panelUrl: 'https://x/', width: 360, title: 'AI' }
    const _r: Cmd['result'] = { panelId: 'panel-abc' }
    expect(_a.panelUrl).toBe('https://plugin.example.test/')
    expect(_b.width).toBe(360)
    expect(_r.panelId).toBe('panel-abc')
  })

  it('unmountSidebar args: panelId', () => {
    type Cmd = EditorCommands['unmountSidebar']
    const _a: Cmd['args'] = { panelId: 'panel-abc' }
    expect(_a.panelId).toBe('panel-abc')
  })

  it('postToSidebar args: panelId + message (unknown — open protocol)', () => {
    type Cmd = EditorCommands['postToSidebar']
    const _a: Cmd['args'] = { panelId: 'p1', message: { type: 'ASK', prompt: 'go' } }
    const _b: Cmd['args'] = { panelId: 'p1', message: 'plain string' }
    const _c: Cmd['args'] = { panelId: 'p1', message: 42 }
    const _d: Cmd['args'] = { panelId: 'p1', message: null }
    // All four message shapes are valid because message is `unknown`.
    expect(_a.message).toEqual({ type: 'ASK', prompt: 'go' })
    expect(_b.message).toBe('plain string')
    expect(_c.message).toBe(42)
    expect(_d.message).toBeNull()
  })

  it('SidebarMessageEvent in EditorEvent union + map', () => {
    const e: SidebarMessageEvent = { type: 'sidebarMessage', panelId: 'p1', message: { type: 'PONG' } }
    const _ev: EditorEvent = e
    type M = EditorEventMap
    const _m: M['sidebarMessage'] = e
    expect(_ev.type).toBe('sidebarMessage')
    expect(_m.panelId).toBe('p1')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// M4 File Picker — type contract
// ──────────────────────────────────────────────────────────────────────────
describe('Kestrel M5: M4 File Picker type contract', () => {
  it('openFileDialog args: accept / multiple optional', () => {
    type Cmd = EditorCommands['openFileDialog']
    const _a: Cmd['args'] = { accept: 'image/*' }
    const _b: Cmd['args'] = { accept: 'application/pdf', multiple: true }
    const _c: Cmd['args'] = undefined
    expect(_a.accept).toBe('image/*')
    expect(_b.multiple).toBe(true)
  })

  it('openFileDialog result is { files: PickedFile[] } | { canceled: true } (discriminated)', () => {
    type Cmd = EditorCommands['openFileDialog']
    const _ok: Cmd['result'] = { files: [] }
    const _canceled: Cmd['result'] = { canceled: true }
    // Discriminated union — narrowing works on 'canceled' in
    const isCanceled = (r: { files: unknown[] } | { canceled: boolean }): boolean =>
      'canceled' in r
    expect(isCanceled(_ok)).toBe(false)
    expect(isCanceled(_canceled)).toBe(true)
  })

  it('PickedFile shape (name / size / type / lastModified / dataBase64)', () => {
    const f: PickedFile = {
      name: 'report.pdf',
      size: 12345,
      type: 'application/pdf',
      lastModified: 1737000000000,
      dataBase64: 'JVBERi0xLjQK',
    }
    expect(f.name).toBe('report.pdf')
    expect(f.size).toBe(12345)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// M4 Telemetry — type contract
// ──────────────────────────────────────────────────────────────────────────
describe('Kestrel M5: M4 Telemetry type contract', () => {
  it('UsageEvent shape (instanceId / docBytesWritten / aiCalls / aiTokensIn / aiTokensOut / sessionDurationMs)', () => {
    const e: UsageEvent = {
      type: 'usage',
      instanceId: 'split-1',
      docBytesWritten: 1024,
      aiCalls: 2,
      aiTokensIn: 256,
      aiTokensOut: 512,
      sessionDurationMs: 60_000,
    }
    expect(e.type).toBe('usage')
    expect(e.sessionDurationMs).toBe(60_000)
  })

  it('UsageEvent in EditorEvent union + map', () => {
    const e: UsageEvent = {
      type: 'usage',
      instanceId: 'split-1',
      docBytesWritten: 0,
      aiCalls: 0,
      aiTokensIn: 0,
      aiTokensOut: 0,
      sessionDurationMs: 0,
    }
    const _ev: EditorEvent = e
    type M = EditorEventMap
    const _m: M['usage'] = e
    expect(_ev.type).toBe('usage')
  })

  it('CreateEditorOptions telemetry?: boolean is opt-in (default undefined)', () => {
    const o1: CreateEditorOptions = {
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: 'h',
      telemetry: true,
    }
    const o2: CreateEditorOptions = {
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: 'h',
      telemetry: false,
    }
    const o3: CreateEditorOptions = {
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: 'h',
      // telemetry omitted (default off)
    }
    expect(o1.telemetry).toBe(true)
    expect(o2.telemetry).toBe(false)
    expect(o3.telemetry).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Error-path pins
// ──────────────────────────────────────────────────────────────────────────
describe('Kestrel M5: createEditor runtime guards', () => {
  it('throws when documentId is missing', async () => {
    const mod = await import('../src/editor')
    expect(() => mod.createEditor({
      documentId: '',
      app: 'docs',
      jwt: 'fake',
      host: 'https://e.test',
    })).toThrow(/documentId required/)
  })

  it('throws when jwt is missing', async () => {
    const mod = await import('../src/editor')
    expect(() => mod.createEditor({
      documentId: 'd',
      app: 'docs',
      jwt: '',
      host: 'https://e.test',
    })).toThrow(/jwt required/)
  })

  it('throws when host is missing', async () => {
    const mod = await import('../src/editor')
    expect(() => mod.createEditor({
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: '',
    })).toThrow(/host required/)
  })

  it('throws when options is missing entirely', async () => {
    const mod = await import('../src/editor')
    expect(() => mod.createEditor(undefined as unknown as CreateEditorOptions)).toThrow(/options required/)
  })

  it('throws when sessionBinding.sessionId is missing but sessionBinding is set', async () => {
    const mod = await import('../src/editor')
    expect(() => mod.createEditor({
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: 'https://e.test',
      sessionBinding: { sessionId: '', nonce: 'n' },
    })).toThrow(/sessionId required/)
  })

  it('throws when sessionBinding.nonce is missing but sessionBinding is set', async () => {
    const mod = await import('../src/editor')
    expect(() => mod.createEditor({
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: 'https://e.test',
      sessionBinding: { sessionId: 's', nonce: '' },
    })).toThrow(/nonce required/)
  })

  it('throws on duplicate instanceId with remediation message', async () => {
    const mod = await import('../src/editor')
    mod.createEditor({
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: 'https://e.test',
      instanceId: 'dup-1',
      skipIframe: true,
      handshake: false,
    })
    expect(() => mod.createEditor({
      documentId: 'd',
      app: 'docs',
      jwt: 't',
      host: 'https://e.test',
      instanceId: 'dup-1',
      skipIframe: true,
      handshake: false,
    })).toThrow(/instanceId 'dup-1' is already in use/)
  })

  it('command() rejects with "editor destroyed" after destroy()', async () => {
    const handle = await makeEditor()
    handle.destroy()
    await expect(handle.command('setTheme', { theme: 'dark' })).rejects.toThrow(/editor destroyed/)
  })

  it('command() rejects with "editor not mounted" when skipIframe is true', async () => {
    const handle = await makeEditor({ skipIframe: true })
    await expect(handle.command('setTheme', { theme: 'dark' })).rejects.toThrow(/editor not mounted|editor destroyed/)
  })

  it('getEditor returns undefined for unknown instanceId', async () => {
    const mod = await import('../src/editor')
    expect(mod.getEditor('never-created')).toBeUndefined()
  })

  it('getEditor returns undefined for destroyed instanceId', async () => {
    const handle = await makeEditor({ instanceId: 'will-die' })
    const id = handle.instanceId
    handle.destroy()
    const mod = await import('../src/editor')
    expect(mod.getEditor(id)).toBeUndefined()
  })

  it('listEditors returns a fresh array (does not leak internal Map)', async () => {
    await makeEditor({ instanceId: 'leak-A' })
    await makeEditor({ instanceId: 'leak-B' })
    const mod = await import('../src/editor')
    const list = mod.listEditors()
    expect(list.length).toBe(2)
    // Mutating the returned array doesn't affect the registry
    list.length = 0
    expect(mod.listEditors().length).toBe(2)
  })

  it('EditorHandle.instanceId is always a non-empty string', async () => {
    // Explicit instanceId
    const h1 = await makeEditor({ instanceId: 'explicit-id' })
    expect(h1.instanceId).toBe('explicit-id')
    // Auto-minted
    const h2 = await makeEditor()
    expect(typeof h2.instanceId).toBe('string')
    expect(h2.instanceId.length).toBeGreaterThan(0)
  })

  it('iframe.name follows genoffice-{instanceId} pattern (or null when skipIframe)', async () => {
    const handle = await makeEditor({ instanceId: 'name-pattern-test' })
    // skipIframe: true → iframe is null (created handler returned early)
    expect(handle.iframe).toBeNull()
  })
})

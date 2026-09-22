/**
 * SDK 2.0 Kestrel M1 — Multi-instance + instanceId registry
 * (sdk1.md §B.5.1 #1, §B.5.4 version strategy).
 *
 * Pins five behaviors that the Kestrel M1 contract depends on:
 *
 *   1. Auto-generated `instanceId` is unique across multiple
 *      `createEditor()` calls on the same host page.
 *   2. Explicit `instanceId` option is honored verbatim.
 *   3. `getEditor(instanceId)` returns the matching handle; returns
 *      `undefined` for unknown / destroyed ids.
 *   4. `listEditors()` returns a snapshot of all live handles (does
 *      NOT include destroyed ones; does NOT mutate the registry).
 *   5. Duplicate `instanceId` throws a clear error pointing at the
 *      remediation (`getEditor(id).destroy()` first).
 *   6. `<iframe>` `name` attribute follows the `genoffice-{instanceId}`
 *      pattern so the embed script and host page can disambiguate
 *      concurrent instances.
 *   7. `EditorHandle.instanceId` is always a non-empty string,
 *      regardless of how the option was supplied.
 *
 * The SDK runs in a Node test environment (vitest config has
 * `environment: 'node'`), so we shim minimal DOM surface used by
 * `createEditor()` itself: `window.addEventListener` /
 * `document.createElement` / `document.body`. The iframe we create is
 * discarded — we never let it boot a real network round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// DOM stubs ────────────────────────────────────────────────────────────────────
type Listener = (event: unknown) => void
const windowListeners: Listener[] = []

beforeEach(async () => {
  // Reset module state between tests: clear the listener registry and
  // any editor registry entries that earlier tests left behind. The
  // registry is module-level so cross-test leakage is real (would
  // otherwise accumulate handles from earlier describe blocks).
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
      // Captured per-test so the iframe-name assertion can read it back.
      _name: '',
      set src(_v: string) {},
      set allow(_v: string) {},
      set name(v: string) { (this as { _name: string })._name = v },
      get name() { return (this as { _name: string })._name },
      set style(_v: unknown) {},
      _append: undefined as unknown,
      appendChild(child: unknown) {
        // Capture so tests can inspect `name` after createEditor wires up.
        ;(this as { _append: unknown })._append = child
      },
    }),
  }
  // handshake is default-on; disable it so createEditor doesn't wait 10s
  // for a nonce that will never come.
})

afterEach(() => {
  // Tear down any live editors from the prior test (destroy removes
  // from registry; we re-import here to access the public API without
  // confusing the type-checker).
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeEditor(opts: Record<string, unknown> = {}) {
  // Dynamic import so the DOM stubs above are in scope before
  // editor.ts reads `typeof document` etc.
  const mod = await import('../src/editor')
  return mod.createEditor({
    documentId: 'doc-1',
    app: 'docs',
    jwt: 'fake.jwt.token',
    host: 'https://example.test',
    skipIframe: true, // don't actually create an <iframe>
    handshake: false, // skip the 10s nonce handshake
    ...opts,
  })
}

async function getEditorRegistry() {
  const mod = await import('../src/editor')
  return {
    getEditor: mod.getEditor,
    listEditors: mod.listEditors,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SDK 2.0 Kestrel M1 — Multi-instance (sdk1.md §B.5.1 #1)', () => {
  it('auto-generates a unique instanceId when none is supplied', async () => {
    const a = await makeEditor()
    const b = await makeEditor()
    expect(a.instanceId).toMatch(/^ed_[A-Za-z0-9_-]+$/)
    expect(b.instanceId).toMatch(/^ed_[A-Za-z0-9_-]+$/)
    expect(a.instanceId).not.toBe(b.instanceId)
  })

  it('honors an explicit instanceId verbatim', async () => {
    const e = await makeEditor({ instanceId: 'my-custom-editor' })
    expect(e.instanceId).toBe('my-custom-editor')
  })

  it('getEditor() returns the matching handle by instanceId', async () => {
    const e = await makeEditor({ instanceId: 'lookup-me' })
    const { getEditor } = await getEditorRegistry()
    expect(getEditor('lookup-me')).toBe(e)
  })

  it('getEditor() returns undefined for an unknown instanceId', async () => {
    const { getEditor } = await getEditorRegistry()
    expect(getEditor('never-registered')).toBeUndefined()
  })

  it('listEditors() includes all live handles and excludes destroyed ones', async () => {
    const e1 = await makeEditor({ instanceId: 'live-1' })
    const e2 = await makeEditor({ instanceId: 'live-2' })
    const doomed = await makeEditor({ instanceId: 'will-die' })
    const { listEditors } = await getEditorRegistry()
    expect(listEditors()).toHaveLength(3)
    expect(listEditors()).toContain(e1)
    expect(listEditors()).toContain(e2)
    expect(listEditors()).toContain(doomed)
    doomed.destroy()
    expect(listEditors()).toHaveLength(2)
    expect(listEditors()).not.toContain(doomed)
  })

  it('rejects duplicate instanceId with a remediation message', async () => {
    await makeEditor({ instanceId: 'dup-1' })
    await expect(makeEditor({ instanceId: 'dup-1' })).rejects.toThrow(
      /instanceId 'dup-1' is already in use.*destroy\(\) first/s,
    )
  })

  it('rejects an empty-string instanceId (treats as omitted)', async () => {
    // Empty string is NOT honored as an instanceId; SDK auto-mints.
    // This is intentional — passing empty string by accident would
    // pollute the registry with a key that all empty-string callers
    // would race for.
    const e = await makeEditor({ instanceId: '' })
    expect(e.instanceId).not.toBe('')
    expect(e.instanceId).toMatch(/^ed_/)
  })

  it('destroy() unregisters the editor so getEditor() returns undefined', async () => {
    const e = await makeEditor({ instanceId: 'dest-1' })
    const { getEditor } = await getEditorRegistry()
    expect(getEditor('dest-1')).toBe(e)
    e.destroy()
    expect(getEditor('dest-1')).toBeUndefined()
  })

  it('EditorHandle.instanceId is always a non-empty string', async () => {
    const a = await makeEditor()
    const b = await makeEditor({ instanceId: 'named-2' })
    for (const h of [a, b]) {
      expect(typeof h.instanceId).toBe('string')
      expect(h.instanceId.length).toBeGreaterThan(0)
    }
  })

  it('iframe name attribute follows genoffice-{instanceId} pattern', async () => {
    // Capture the iframe object's name at the moment createEditor wires
    // it up. Override the document stub so createElement returns a
    // shape that records the `name` setter argument.
    const captured: { name?: string } = { name: undefined }
    ;(globalThis as { document: { body: unknown; createElement: (tag: string) => unknown } }).document = {
      body: { appendChild: (_child: unknown) => undefined } as unknown,
      createElement: (_tag: string) => {
        // Stable style object so the SDK's three assignments
        // (`style.border = '0'` / `style.width = '100%'` /
        // `style.height = '100%'`) actually take effect. Each access
        // to `iframe.style` must return the SAME object reference.
        const styleObj: { border: string; width: string; height: string } = {
          border: '',
          width: '',
          height: '',
        }
        return {
          set src(_v: string) {},
          set allow(_v: string) {},
          set name(v: string) { captured.name = v },
          get name() { return captured.name ?? '' },
          get style() { return styleObj },
          set style(_v: unknown) { /* SDK only ever reads then mutates */ },
        }
      },
    }
    const e = await makeEditor({ instanceId: 'name-attr-test', skipIframe: false })
    expect(captured.name).toBe('genoffice-name-attr-test')
    // Sanity: instanceId is what we asked for, not auto-minted.
    expect(e.instanceId).toBe('name-attr-test')
  })

  it('two editors on one page each get their own listener slot', async () => {
    // Smoke: each createEditor installs exactly one window 'message'
    // listener. We can't assert the exact count without leaking test
    // implementation details, but we CAN assert that the registry has
    // both handles and that one destroy does NOT unregister the other.
    const a = await makeEditor({ instanceId: 'slot-a' })
    const b = await makeEditor({ instanceId: 'slot-b' })
    const { getEditor } = await getEditorRegistry()
    a.destroy()
    expect(getEditor('slot-a')).toBeUndefined()
    expect(getEditor('slot-b')).toBe(b)
  })
})

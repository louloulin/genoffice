/**
 * SDK 2.0 Kestrel M4 — File Picker + Telemetry
 * (sdk1.md §B.5.1 #7 File picker, §B.5.1 #9 Telemetry).
 *
 * File Picker (#7):
 *   - `EditorCommands.openFileDialog({ accept?, multiple? })` resolves
 *     to `{ files: PickedFile[] }` or `{ canceled: true }`
 *   - `PickedFile` interface has name / size / type / lastModified /
 *     dataBase64 (renderer reads via FileReader, ships base64 back)
 *   - handle.command('openFileDialog', …) is type-correct
 *
 * Telemetry (#9):
 *   - `UsageEvent` interface shape pins: instanceId / docBytesWritten /
 *     aiCalls / aiTokensIn / aiTokensOut / sessionDurationMs
 *   - Default off: `createEditor({ telemetry: undefined })` does NOT
 *     schedule a 30 s ticker
 *   - Opt-in: `createEditor({ telemetry: true })` schedules a ticker
 *     and fires `editor.on('usage', cb)` on each tick
 *   - Counting: setContent / insertText / insertImage accumulate
 *     docBytesWritten; aiRewrite / aiTranslate / aiSummarize accumulate
 *     aiCalls + aiTokensIn (prompt chars)
 *   - destroy() clears the interval so no event fires after teardown
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PickedFile, UsageEvent } from '../src/types'

// ── DOM stubs ──────────────────────────────────────────────────────────────
type Listener = (event: unknown) => void
const windowListeners: Listener[] = []

beforeEach(async () => {
  // Default to fake timers so tests that schedule setInterval don't have
  // to wait the real 30 s. Tests that don't care about timers just call
  // useRealTimers / advanceTimersByTimeAsync 0 to bail out.
  vi.useFakeTimers()
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
  // _resetEditorRegistryForTests ran in beforeEach, but the createEditor
  // call inside the test may have scheduled a setInterval. The SDK
  // registers `beforeunload` to call destroy(), but in this Node test
  // environment we don't fire beforeunload. clearAllTimers ensures
  // we don't leak handles between tests.
  vi.useRealTimers()
})

async function makeEditor(opts: Record<string, unknown> = {}) {
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Kestrel M4: File Picker + Telemetry', () => {
  describe('§B.5.1 #7 File picker — type contract', () => {
    it('exposes openFileDialog on EditorCommands with spec args/result', async () => {
      const handle = await makeEditor()
      // Compile-time pin: result is `{ files: PickedFile[] } | { canceled: true }`
      const _typed = handle.command('openFileDialog', { accept: 'image/*', multiple: true })
      // Runtime: skipIframe so the call rejects — but the type contract
      // is what we care about here.
      await expect(_typed).rejects.toThrow(/editor not mounted|editor destroyed/)
    })

    it('openFileDialog accepts no args (all fields optional)', async () => {
      const handle = await makeEditor()
      const _typed = handle.command('openFileDialog')
      await expect(_typed).rejects.toThrow(/editor not mounted|editor destroyed/)
    })

    it('PickedFile interface pins name / size / type / lastModified / dataBase64', () => {
      const f: PickedFile = {
        name: 'report.pdf',
        size: 12345,
        type: 'application/pdf',
        lastModified: 1737000000000,
        dataBase64: 'JVBERi0xLjQKJeLjz9MK',
      }
      expect(f.name).toBe('report.pdf')
      expect(f.size).toBe(12345)
      expect(f.type).toBe('application/pdf')
      expect(f.lastModified).toBe(1737000000000)
      expect(f.dataBase64.startsWith('JVBER')).toBe(true)
    })
  })

  describe('§B.5.1 #9 Telemetry — opt-in semantics', () => {
    it('default (telemetry: undefined) does NOT schedule a 30 s interval', async () => {
      vi.useFakeTimers()
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      await makeEditor({ telemetry: undefined })
      // Look for any setInterval call with a 30_000 ms delay
      const has30s = setIntervalSpy.mock.calls.some(([, ms]) => ms === 30_000)
      expect(has30s).toBe(false)
      setIntervalSpy.mockRestore()
    })

    it('default (telemetry: false) does NOT schedule a 30 s interval', async () => {
      vi.useFakeTimers()
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      await makeEditor({ telemetry: false })
      const has30s = setIntervalSpy.mock.calls.some(([, ms]) => ms === 30_000)
      expect(has30s).toBe(false)
      setIntervalSpy.mockRestore()
    })

    it('telemetry: true DOES schedule a 30 s interval', async () => {
      vi.useFakeTimers()
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      await makeEditor({ telemetry: true })
      const has30s = setIntervalSpy.mock.calls.some(([, ms]) => ms === 30_000)
      expect(has30s).toBe(true)
      setIntervalSpy.mockRestore()
    })
  })

  describe('§B.5.1 #9 Telemetry — UsageEvent dispatch', () => {
    it('UsageEvent has the spec shape', () => {
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
      expect(e.instanceId).toBe('split-1')
      expect(e.docBytesWritten).toBe(1024)
      expect(e.aiCalls).toBe(2)
      expect(e.sessionDurationMs).toBe(60_000)
    })

    it('subscribe("usage", cb) registers without throwing', async () => {
      vi.useFakeTimers()
      const handle = await makeEditor({ telemetry: true })
      const events: UsageEvent[] = []
      const off = handle.on('usage', (e) => { events.push(e) })
      // Advance 30 s — should fire one usage event.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(events.length).toBe(1)
      expect(events[0]!.type).toBe('usage')
      expect(events[0]!.instanceId).toBe(handle.instanceId)
      expect(events[0]!.sessionDurationMs).toBeGreaterThanOrEqual(30_000)
      off()
      handle.destroy()
    })

    it('multiple intervals fire multiple events with growing sessionDurationMs', async () => {
      vi.useFakeTimers()
      const handle = await makeEditor({ telemetry: true })
      const events: UsageEvent[] = []
      const off = handle.on('usage', (e) => { events.push(e) })
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(events.length).toBe(3)
      expect(events[0]!.sessionDurationMs).toBeLessThan(events[2]!.sessionDurationMs)
      off()
      handle.destroy()
    })

    it('destroy() clears the telemetry interval — no events after teardown', async () => {
      vi.useFakeTimers()
      const handle = await makeEditor({ telemetry: true })
      const events: UsageEvent[] = []
      const off = handle.on('usage', (e) => { events.push(e) })
      handle.destroy()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(events.length).toBe(0)
      off()
    })

    it('off(…) returned by editor.on("usage", cb) unsubscribes', async () => {
      vi.useFakeTimers()
      const handle = await makeEditor({ telemetry: true })
      const events: UsageEvent[] = []
      const off = handle.on('usage', (e) => { events.push(e) })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(events.length).toBe(1)
      off()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(events.length).toBe(1) // still 1, off() worked
      handle.destroy()
    })
  })

  describe('§B.5.1 #9 Telemetry — counters (count via command hook)', () => {
    it('telemetry off: counters stay at 0 even when commands are issued', async () => {
      vi.useFakeTimers()
      const handle = await makeEditor({ telemetry: false })
      const events: UsageEvent[] = []
      const off = handle.on('usage', (e) => { events.push(e) })
      // Issue several commands (all reject because skipIframe, but the
      // counter hook fires before the rejection).
      const calls = [
        handle.command('setContent', { content: 'hello' }),
        handle.command('insertText', { text: ' world' }),
        handle.command('aiRewrite', { text: 'foo' }),
      ]
      const results = await Promise.allSettled(calls)
      // All rejected, but counters should still be at 0 since telemetry: false
      expect(results.every((r) => r.status === 'rejected')).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      // Telemetry off → no event fires (interval never scheduled)
      expect(events.length).toBe(0)
      off()
      handle.destroy()
    })

    it('telemetry on: setContent/insertText/insertImage accumulate docBytesWritten', async () => {
      vi.useFakeTimers()
      const handle = await makeEditor({ telemetry: true })
      const events: UsageEvent[] = []
      const off = handle.on('usage', (e) => { events.push(e) })
      // Issue content commands; all reject but the counter runs first.
      await Promise.allSettled([
        handle.command('setContent', { content: 'abcde' }),                          // 5
        handle.command('insertText', { text: 'fghi' }),                              // 4
        handle.command('insertImage', { dataUrl: 'data:image/png;base64,AA' }),      // 24
      ])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(events.length).toBe(1)
      // 5 + 4 + 24 = 33 bytes
      expect(events[0]!.docBytesWritten).toBe(33)
      off()
      handle.destroy()
    })

    it('telemetry on: aiRewrite / aiTranslate / aiSummarize accumulate aiCalls + aiTokensIn', async () => {
      vi.useFakeTimers()
      const handle = await makeEditor({ telemetry: true })
      const events: UsageEvent[] = []
      const off = handle.on('usage', (e) => { events.push(e) })
      // Each AI command has its own arg shape (see types.ts
      // AiRewriteArgs / AiTranslateArgs / AiSummarizeArgs). The counter
      // sums all string-typed fields in the args object.
      await Promise.allSettled([
        handle.command('aiRewrite', { instruction: 'rewrite this please' }), // 19
        handle.command('aiTranslate', { target: 'zh-CN', source: 'en-US' }), // 5 + 5 = 10
        handle.command('aiSummarize', { length: 'medium' }),                  // 6
      ])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(events.length).toBe(1)
      expect(events[0]!.aiCalls).toBe(3)
      // 19 + 5 + 5 + 6 = 35
      expect(events[0]!.aiTokensIn).toBe(19 + 5 + 5 + 6)
      // aiTokensOut is unknown to the SDK; always 0
      expect(events[0]!.aiTokensOut).toBe(0)
      off()
      handle.destroy()
    })
  })

  describe('isolation from earlier Kestrel surfaces', () => {
    it('createEditor({ telemetry: true }) does not break existing surfaces', async () => {
      const handle = await makeEditor({ telemetry: true })
      // Pin: previous surfaces still type-check + runtime wiring works.
      const listPromise = handle.command('listVersions')
      await expect(listPromise).rejects.toThrow(/editor not mounted|editor destroyed/)
      const mountPromise = handle.command('mountSidebar', {
        panelUrl: 'https://plugin.example.test/',
      })
      await expect(mountPromise).rejects.toThrow(/editor not mounted|editor destroyed/)
      handle.destroy()
    })
  })
})

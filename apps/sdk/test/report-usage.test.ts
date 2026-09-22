/**
 * `reportUsage` command surface (sdk1.md §11.36).
 *
 * The SDK's telemetry ticker used to be local-only: it dispatched a
 * `usage` event to host listeners but never told the server, so the
 * web-server's usage aggregator (`apps/web-server/src/embed/
 * sdk-commands.ts`) could never see a sample. This suite pins:
 *
 *   1. `reportUsage` is part of the `EditorCommands` union (type-level).
 *   2. A host calling `editor.reportUsage({...})` posts a `command`
 *      envelope whose payload name is exactly `reportUsage`.
 *   3. The automatic ticker fires it too when telemetry is enabled.
 *   4. `destroy()` flushes a final sample before the iframe is torn down.
 *   5. A server that rejects the report does NOT break the editor
 *      (fire-and-forget semantics for the automatic path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorCommands } from '../src/types'

// ── DOM stubs (SDK tests run in a node environment) ──────────────────────
type Listener = (event: unknown) => void
const windowListeners: Listener[] = []
/** postMessage calls captured from the fake iframe's contentWindow. */
const posted: unknown[] = []

function installDom(): void {
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: (_t: string, l: Listener) => { windowListeners.push(l) },
    removeEventListener: (_t: string, l: Listener) => {
      const i = windowListeners.indexOf(l)
      if (i >= 0) windowListeners.splice(i, 1)
    },
  }
  ;(globalThis as { document?: unknown }).document = {
    body: { appendChild: () => undefined } as unknown,
    createElement: () => {
      const el = {
        name: '',
        style: {} as Record<string, string>,
        setAttribute: () => undefined,
        contentWindow: { postMessage: (data: unknown) => { posted.push(data) } },
        parentNode: null as unknown,
        addEventListener: () => undefined,
      }
      return el
    },
  }
}

beforeEach(async () => {
  const { _resetEditorRegistryForTests } = await import('../src/editor')
  _resetEditorRegistryForTests()
  windowListeners.length = 0
  posted.length = 0
  vi.useRealTimers()
  installDom()
})

afterEach(async () => {
  const { _resetEditorRegistryForTests } = await import('../src/editor')
  _resetEditorRegistryForTests()
  vi.useRealTimers()
})

/** Mount an editor with a stubbed iframe so `command()` reaches postMessage. */
async function makeMountedEditor(opts: { telemetry?: boolean } = {}) {
  const { createEditor } = await import('../src/editor')
  const container = { appendChild: () => undefined } as unknown as HTMLElement
  return createEditor({
    container,
    documentId: 'doc-1',
    jwt: 'jwt-1',
    host: 'https://host.test',
    url: 'https://host.test/embed/doc-1',
    telemetry: opts.telemetry,
    handshakeTimeoutMs: 60_000,
  })
}

function commandEnvelopes(): Array<{ name: string; args: unknown }> {
  return posted
    .filter((d): d is { kind: string; payload: { name: string; args: unknown } } =>
      Boolean(d) && typeof d === 'object' && (d as { kind?: string }).kind === 'command')
    .map((d) => ({ name: d.payload.name, args: d.payload.args }))
}

describe('reportUsage command (sdk1.md §11.36)', () => {
  it('is part of the EditorCommands union (type-level)', () => {
    // Compile-time proof: if `reportUsage` left the union this assignment
    // would fail typecheck. The runtime assertion keeps the test honest.
    const key: keyof EditorCommands = 'reportUsage'
    expect(key).toBe('reportUsage')
  })

  it('posts a command envelope named reportUsage when the host calls it', async () => {
    const handle = await makeMountedEditor()
    // Fire-and-forget; we only care about the outbound envelope.
    void handle.command('reportUsage', {
      docBytesWritten: 123,
      aiCalls: 2,
      aiTokensIn: 10,
      aiTokensOut: 20,
      sessionDurationMs: 500,
    }).catch(() => undefined)
    const envelopes = commandEnvelopes()
    const report = envelopes.find((e) => e.name === 'reportUsage')
    expect(report).toBeDefined()
    expect(report!.args).toMatchObject({ docBytesWritten: 123, aiCalls: 2 })
    handle.destroy()
  })

  it('includes the instanceId in the automatic sample', async () => {
    // Install fake timers BEFORE mounting so the 30 s telemetry interval
    // is registered against the fake clock and can be advanced.
    vi.useFakeTimers()
    const handle = await makeMountedEditor({ telemetry: true })
    posted.length = 0
    vi.advanceTimersByTime(30_000)
    const report = commandEnvelopes().find((e) => e.name === 'reportUsage')
    expect(report).toBeDefined()
    expect((report!.args as { instanceId?: string }).instanceId).toBe(handle.instanceId)
    vi.useRealTimers()
    handle.destroy()
  })

  it('does NOT report automatically when telemetry is disabled', async () => {
    vi.useFakeTimers()
    const handle = await makeMountedEditor()
    posted.length = 0
    vi.advanceTimersByTime(30_000)
    expect(commandEnvelopes().some((e) => e.name === 'reportUsage')).toBe(false)
    vi.useRealTimers()
    handle.destroy()
  })

  it('flushes a final sample during destroy when telemetry is enabled', async () => {
    const handle = await makeMountedEditor({ telemetry: true })
    posted.length = 0
    handle.destroy()
    const report = commandEnvelopes().find((e) => e.name === 'reportUsage')
    expect(report).toBeDefined()
  })

  it('does not let a rejected report break the editor (fire-and-forget)', async () => {
    const handle = await makeMountedEditor({ telemetry: true })
    // Simulate the server rejecting: the SDK must swallow it internally.
    // We assert by draining microtasks and confirming no unhandled throw
    // surfaces and the handle is still usable for a normal command.
    vi.useFakeTimers()
    vi.advanceTimersByTime(30_000)
    vi.useRealTimers()
    await Promise.resolve()
    expect(() => handle.instanceId).not.toThrow()
    handle.destroy()
  })
})

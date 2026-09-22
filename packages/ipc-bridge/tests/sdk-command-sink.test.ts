/**
 * Renderer-side SDK command sink (sdk1.md §11.36).
 *
 * The web-server bridge prefers `window.__GENOFFICE_COMMAND_SINK__` over
 * the server-backed `sdk:command` IPC channel. This suite pins the
 * installer contract:
 *
 *   1. `installSdkCommandSink` writes the sink onto the target window.
 *   2. The sink dispatches by command name; unknown names throw
 *      `UnsupportedCommandError` with `code: 'UNSUPPORTED'`.
 *   3. Async handlers work; thrown errors keep their `code`.
 *   4. `uninstall()` restores a previous sink (hot-reload safe).
 *   5. `makeOpenFileDialogHandler` converts picked files to the SDK's
 *      `PickedFile` shape and reports `{canceled:true}` on dismissal.
 *   6. `bytesToBase64` / `guessMimeType` behave.
 *   7. No window → a no-op handle (no throw), so SSR callers are safe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  UnsupportedCommandError,
  bytesToBase64,
  guessMimeType,
  installSdkCommandSink,
  makeOpenFileDialogHandler,
  type SdkCommandSinkTarget,
} from '../src/sdk-command-sink'

const __dirname = dirname(fileURLToPath(import.meta.url))

function makeTarget(): SdkCommandSinkTarget {
  return {}
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('installSdkCommandSink (sdk1.md §11.36)', () => {
  it('installs the sink on the target window', () => {
    const target = makeTarget()
    const handle = installSdkCommandSink({ target, handlers: { print: () => 'printed' } })
    expect(typeof target.__GENOFFICE_COMMAND_SINK__).toBe('function')
    expect(handle.supported).toEqual(['print'])
  })

  it('dispatches by command name', () => {
    const target = makeTarget()
    installSdkCommandSink({
      target,
      handlers: {
        print: () => 'ok-print',
        setTheme: (args) => `theme:${(args as { theme: string }).theme}`,
      },
    })
    expect(target.__GENOFFICE_COMMAND_SINK__!('print', {})).toBe('ok-print')
    expect(target.__GENOFFICE_COMMAND_SINK__!('setTheme', { theme: 'dark' })).toBe('theme:dark')
  })

  it('throws UnsupportedCommandError (code UNSUPPORTED) for unknown commands', () => {
    const target = makeTarget()
    installSdkCommandSink({ target, handlers: {} })
    try {
      target.__GENOFFICE_COMMAND_SINK__!('notHandled', {})
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCommandError)
      expect((err as UnsupportedCommandError).code).toBe('UNSUPPORTED')
      expect((err as Error).message).toContain('installSdkCommandSink')
    }
  })

  it('supports async handlers through dispatch()', async () => {
    const target = makeTarget()
    const handle = installSdkCommandSink({
      target,
      handlers: { openFileDialog: async () => ({ canceled: true }) },
    })
    await expect(handle.dispatch('openFileDialog', {})).resolves.toEqual({ canceled: true })
  })

  it('dispatch() rejects with UnsupportedCommandError for unknown names', async () => {
    const target = makeTarget()
    const handle = installSdkCommandSink({ target, handlers: {} })
    await expect(handle.dispatch('nope', {})).rejects.toBeInstanceOf(UnsupportedCommandError)
  })

  it('preserves handler error codes when they throw', async () => {
    const target = makeTarget()
    const handle = installSdkCommandSink({
      target,
      handlers: {
        setContent: () => {
          const err = new Error('read-only') as Error & { code?: string }
          err.code = 'READ_ONLY'
          throw err
        },
      },
    })
    await expect(handle.dispatch('setContent', {})).rejects.toMatchObject({ code: 'READ_ONLY' })
  })

  it('uninstall() removes the sink and restores a previous one', () => {
    const target = makeTarget()
    const prev = (): string => 'previous'
    target.__GENOFFICE_COMMAND_SINK__ = prev
    const handle = installSdkCommandSink({ target, handlers: { print: () => 'x' } })
    expect(target.__GENOFFICE_COMMAND_SINK__).not.toBe(prev)
    handle.uninstall()
    expect(target.__GENOFFICE_COMMAND_SINK__).toBe(prev)
  })

  it('uninstall() deletes the sink when there was no previous one', () => {
    const target = makeTarget()
    const handle = installSdkCommandSink({ target, handlers: { print: () => 'x' } })
    handle.uninstall()
    expect(target.__GENOFFICE_COMMAND_SINK__).toBeUndefined()
  })

  it('uninstall() is idempotent', () => {
    const target = makeTarget()
    const handle = installSdkCommandSink({ target, handlers: { print: () => 'x' } })
    handle.uninstall()
    expect(() => handle.uninstall()).not.toThrow()
  })

  it('returns a no-op handle when there is no window (SSR safe)', () => {
    // Pass an explicit target of undefined AND clear globalThis.window so
    // resolveTarget falls through to null.
    const saved = (globalThis as { window?: unknown }).window
    delete (globalThis as { window?: unknown }).window
    try {
      const handle = installSdkCommandSink({
        handlers: { print: () => 'x' },
        // force the no-target path
        target: undefined,
      })
      expect(() => handle.uninstall()).not.toThrow()
    } finally {
      ;(globalThis as { window?: unknown }).window = saved
    }
  })
})

describe('makeOpenFileDialogHandler (Kestrel M4)', () => {
  it('reports {canceled:true} when the picker is dismissed', async () => {
    // Simulate the browser input flow: no files selected.
    const doc = {
      body: { appendChild: () => undefined } as unknown,
      createElement: () => {
        const listeners: Record<string, () => void> = {}
        return {
          type: '',
          accept: '',
          multiple: false,
          style: {} as Record<string, string>,
          files: [] as unknown,
          addEventListener: (evt: string, cb: () => void) => { listeners[evt] = cb },
          remove: () => undefined,
          click: () => { listeners['change']?.() },
        }
      },
    }
    const savedDoc = (globalThis as { document?: unknown }).document
    ;(globalThis as { document?: unknown }).document = doc
    try {
      const handler = makeOpenFileDialogHandler()
      await expect(handler({ accept: '.docx' })).resolves.toEqual({ canceled: true })
    } finally {
      ;(globalThis as { document?: unknown }).document = savedDoc
    }
  })

  it('converts picked files into the PickedFile wire shape', async () => {
    const fileBytes = new Uint8Array([104, 105]) // "hi"
    const doc = {
      body: { appendChild: () => undefined } as unknown,
      createElement: () => {
        const listeners: Record<string, () => void> = {}
        return {
          type: '',
          accept: '',
          multiple: false,
          style: {} as Record<string, string>,
          files: [{ name: 'note.docx' }] as unknown,
          addEventListener: (evt: string, cb: () => void) => { listeners[evt] = cb },
          remove: () => undefined,
          click: () => { listeners['change']?.() },
        }
      },
    }
    class FakeFileReader {
      result: ArrayBuffer | null = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsArrayBuffer() {
        this.result = fileBytes.buffer
        queueMicrotask(() => this.onload?.())
      }
    }
    const savedDoc = (globalThis as { document?: unknown }).document
    const savedReader = (globalThis as { FileReader?: unknown }).FileReader
    ;(globalThis as { document?: unknown }).document = doc
    ;(globalThis as { FileReader?: unknown }).FileReader = FakeFileReader
    try {
      const handler = makeOpenFileDialogHandler()
      const result = (await handler({ accept: '.docx' })) as {
        files: Array<{ name: string; size: number; type: string; dataBase64: string }>
      }
      expect(result.files).toHaveLength(1)
      expect(result.files[0]!.name).toBe('note.docx')
      expect(result.files[0]!.size).toBe(2)
      expect(result.files[0]!.type).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      expect(result.files[0]!.dataBase64).toBe(bytesToBase64(fileBytes))
    } finally {
      ;(globalThis as { document?: unknown }).document = savedDoc
      ;(globalThis as { FileReader?: unknown }).FileReader = savedReader
    }
  })
})

describe('bytesToBase64 / guessMimeType', () => {
  it('base64-encodes bytes', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=')
  })

  it('handles empty input', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
  })

  it('round-trips bytes larger than one fromCharCode chunk', () => {
    const big = new Uint8Array(70000)
    for (let i = 0; i < big.length; i++) big[i] = i % 256
    const b64 = bytesToBase64(big)
    const B = (globalThis as { Buffer?: typeof Buffer }).Buffer!
    expect(B.from(b64, 'base64').length).toBe(big.length)
  })

  it('guesses MIME from extension (case-insensitive) and falls back', () => {
    expect(guessMimeType('a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(guessMimeType('A.PPTX')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
    expect(guessMimeType('x.unknownext')).toBe('application/octet-stream')
    expect(guessMimeType('noext')).toBe('application/octet-stream')
  })
})

describe('all six renderers wire the sink (sdk1.md §11.36)', () => {
  // One DRY guard instead of six near-identical per-app test files. Each
  // renderer's web-bridge must (a) import the installer from this package
  // and (b) call it inside the non-Electron bootstrap, or a host's
  // `editor.command('openFileDialog')` silently regresses to a
  // WEB_UNSUPPORTED rejection on that app only.
  const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'] as const
  const repoRoot = resolve(__dirname, '..', '..', '..')

  for (const app of APPS) {
    it(`${app}/src/renderer/web-bridge.ts installs the sink inside the web-only branch`, () => {
      const source = readFileSync(
        resolve(repoRoot, 'apps', app, 'src', 'renderer', 'web-bridge.ts'),
        'utf8',
      )
      expect(source).toContain("from '@genoffice/ipc-bridge/sdk-command-sink'")
      expect(source).toContain(
        'installSdkCommandSink({ handlers: defaultSdkCommandHandlers() })',
      )
      const guardIdx = source.indexOf('if (!isElectronRuntime())')
      const installIdx = source.indexOf('installSdkCommandSink({')
      expect(guardIdx).toBeGreaterThan(-1)
      expect(installIdx).toBeGreaterThan(guardIdx)
    })
  }
})

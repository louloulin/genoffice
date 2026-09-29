/**
 * workbook:save with a real renderer-shaped edit, end to end through the
 * bundled server and the Rust xlsx-sidecar.
 *
 * The renderer addresses sheets by Univer id (`sheet-…`); the gateway patches
 * parts by file sheet name. The web build used to pass the renderer request to
 * the gateway unmapped, so every save carrying an actual edit failed with
 * 'Sheet "undefined" was not found in workbook.xml' — the existing
 * workbook-save-e2e suite only ever saved empty edit lists and never saw it.
 *
 * Covered here:
 *   - an edit addressed by sheet id lands in the file (read back after reopen);
 *   - the reopened session can save again (its sheet map is registered too);
 *   - a chunked-transfer save is refused rather than silently dropping edits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeTransportValue, encodeTransportValue } from '../src/common/codec'
import { buildEditFixture } from '../../sheets/tests/fixture-builder'
import { stopServer } from './helpers/server-process'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const sidecar = join(
  pkgRoot,
  '..',
  'sheets',
  'native',
  'xlsx-engine',
  'target',
  'release',
  process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar',
)
const skip = !existsSync(bundle) || !existsSync(sidecar)

/** Every part the renderer sends, empty — tests fill in what they exercise. */
const EMPTY_SAVE = {
  mode: 'save',
  edits: [],
  bulkConstantFills: [],
  structuralOps: [],
  chartEdits: [],
  visualEdits: [],
  visualAdditions: [],
  tableAdditions: [],
  pivotAdditions: [],
  sheetOps: [],
  sheetOrder: [],
  filterStates: [],
  hyperlinkEdits: [],
  cfStates: [],
  dvStates: [],
  pageSetupStates: [],
  noteStates: [],
  pivotCacheRefreshPaths: [],
  pivotRefreshUpdates: [],
  sheetProtections: [],
  sparklineAdditions: [],
  formulaValues: [],
  definedNamesState: null,
  themeState: null,
  workbookProtectionState: null,
  protectedRangeStates: [],
}

interface OpenedWorkbook {
  sessionId: string
  path: string
  sheets: { id: string; name: string }[]
}

describe.skipIf(skip)('workbook:save — renderer-shaped edits', () => {
  let server: ChildProcess | undefined
  let base = ''
  let dataDir = ''

  async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
    })
    const body = (await response.json()) as { result?: unknown; error?: unknown }
    if (!response.ok) throw new Error(`${channel} → ${response.status} ${JSON.stringify(body.error)}`)
    return decodeTransportValue(body.result)
  }

  async function readA1(opened: OpenedWorkbook): Promise<string> {
    const range = await invoke('workbook:read-range', {
      sessionId: opened.sessionId,
      sheetId: opened.sheets[0]!.id,
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })
    return JSON.stringify(range)
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-wb-edit-'))
    const port = 33000 + Math.floor(Math.random() * 4000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, XLSX_SIDECAR_PATH: sidecar },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        if ((await fetch(`${base}/health`)).ok) break
      } catch {
        /* keep polling */
      }
      if (Date.now() > deadline) throw new Error('web-server did not become healthy')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }, 30_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  async function openFixture(): Promise<OpenedWorkbook> {
    const fixture = await buildEditFixture()
    const bytes = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength)
    const path = (await invoke('web:write-temp-file', { name: 'roundtrip.xlsx', bytes })) as string
    return (await invoke('workbook:open-path', path)) as OpenedWorkbook
  }

  function editA1(opened: OpenedWorkbook, value: string): Record<string, unknown> {
    return {
      ...EMPTY_SAVE,
      sessionId: opened.sessionId,
      edits: [{ sheetId: opened.sheets[0]!.id, row: 0, column: 0, writeValue: true, value }],
    }
  }

  it('an edit addressed by sheet id lands in the file, and the reopened session saves again', async () => {
    const opened = await openFixture()
    const first = (await invoke('workbook:save', editA1(opened, 'first-edit'))) as { ok: boolean; error?: string }
    expect(first).toMatchObject({ ok: true })

    const reopened = (await invoke('workbook:open-path', opened.path)) as OpenedWorkbook & { readOnly?: unknown }
    // The renderer validates the reopened workbook (parseWorkbookFile) and
    // rejects it without this flag.
    expect(reopened.readOnly).toBe(false)
    expect(await readA1(reopened)).toContain('first-edit')

    const second = (await invoke('workbook:save', editA1(reopened, 'second-edit'))) as { ok: boolean }
    expect(second).toMatchObject({ ok: true })
    const again = (await invoke('workbook:open-path', opened.path)) as OpenedWorkbook
    expect(await readA1(again)).toContain('second-edit')
  }, 30_000)

  it('an unknown sheet id is a save error, not a crash', async () => {
    const opened = await openFixture()
    const result = (await invoke('workbook:save', {
      ...EMPTY_SAVE,
      sessionId: opened.sessionId,
      edits: [{ sheetId: 'sheet-missing', row: 0, column: 0, writeValue: true, value: 'x' }],
    })) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown worksheet sheet-missing')
  }, 30_000)

  it('refuses a chunked-transfer save instead of dropping its edits', async () => {
    const opened = await openFixture()
    const result = (await invoke('workbook:save', {
      ...EMPTY_SAVE,
      sessionId: opened.sessionId,
      editsTransferId: '33333333-3333-4333-8333-333333333333',
    })) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('chunked edit transfers')
  }, 30_000)
})

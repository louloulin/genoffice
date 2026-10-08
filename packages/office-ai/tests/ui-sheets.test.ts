import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { readBasicWorkbook } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { startUiHost, type UiHostHandle } from '../src/ui/host'

const SHEETS_RENDERER_DIR = fileURLToPath(new URL('../../../apps/sheets/out/renderer', import.meta.url))
const FIXTURE_XLSX = fileURLToPath(
  new URL('../../../apps/sheets/fixtures/generated/compatibility-basic.xlsx', import.meta.url),
)

let host: UiHostHandle | null = null

async function bootHost(): Promise<UiHostHandle> {
  const { mkdtempSync, symlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'office-ai-sheets-'))
  symlinkSync(SHEETS_RENDERER_DIR, join(root, 'sheets'), 'dir')
  host = await startUiHost({ assetsDir: root })
  return host
}

afterEach(async () => {
  if (host) {
    await host.close()
    host = null
  }
})

async function invoke(channel: string, args: unknown[] = []): Promise<{ status: number; body: any }> {
  const response = await fetch(`${host!.url}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ipc-session': 'sheets-session' },
    body: JSON.stringify({ args }),
  })
  return { status: response.status, body: await response.json() }
}

function stagedFixture(name = 'compatibility-basic.xlsx') {
  return host!.open('sheets', new Uint8Array(readFileSync(FIXTURE_XLSX)), { name })
}

/** Minimal renderer-shaped save request: only the fields the gateway save needs. */
function saveRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'save',
    edits: [],
    bulkConstantFills: [],
    structuralOps: [],
    chartEdits: [],
    visualEdits: [],
    sheetOps: [],
    sheetOrder: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    pageSetupStates: [],
    noteStates: [],
    visualAdditions: [],
    tableAdditions: [],
    pivotAdditions: [],
    sparklineAdditions: [],
    sheetProtections: [],
    protectedRangeStates: [],
    formulaValues: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    definedNamesState: null,
    themeState: null,
    workbookProtectionState: null,
    ...overrides,
  }
}

describe('shared formulas in the read model', () => {
  /** The real fixture with its first worksheet's sheetData replaced. */
  async function fixtureWithSharedFormulas(): Promise<Buffer> {
    const zip = await JSZip.loadAsync(readFileSync(FIXTURE_XLSX))
    const worksheetPath = Object.keys(zip.files).find((path) =>
      /^xl\/worksheets\/[^/]+\.xml$/.test(path),
    )
    if (!worksheetPath) throw new Error('fixture has no worksheet part')
    const xml = await zip.file(worksheetPath)!.async('string')
    const patched = xml.replace(
      /<sheetData\s*\/>|<sheetData>[\s\S]*?<\/sheetData>/,
      '<sheetData><row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:B1" si="0">SUM(1,2)</f><v>3</v></c>' +
        '<c r="B1"><f t="shared" si="0"/><v>3</v></c>' +
        '</row></sheetData>',
    )
    expect(patched).not.toBe(xml)
    zip.file(worksheetPath, patched)
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
  }

  it('reads a shared master with its cached value and a follower by its value', async () => {
    const imported = await readBasicWorkbook(await fixtureWithSharedFormulas())
    const cells = Object.assign({}, ...imported.snapshot.sheets.map((sheet) => sheet.cells))

    // Master: the formula is reported, and the cached value survives alongside
    // it — value-only consumers (CSV export, CLI) used to see a blank cell.
    expect(cells.A1).toMatchObject({ formula: '=SUM(1,2)', value: 3 })
    // Follower: the `<f/>` placeholder carries no formula text of its own, so
    // it reads as its cached value rather than a broken `=`.
    expect(cells.B1?.value).toBe(3)
    expect(cells.B1?.formula).toBeUndefined()
  })
})

describe('sheets handlers (M2)', () => {
  it('opens an xlsx into the renderer WorkbookFile shape', async () => {
    await bootHost()
    const staged = stagedFixture()
    const opened = await invoke('workbook:open-path', [staged.path])
    expect(opened.status).toBe(200)

    const file = opened.body.result
    expect(file.name).toBe('compatibility-basic.xlsx')
    expect(file.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(file.entryCount).toBeGreaterThan(0)
    expect(file.readOnly).toBe(false)
    expect(file.sheets.length).toBeGreaterThanOrEqual(1)
    for (const sheet of file.sheets) {
      // Every required worksheetMetadata field the renderer's parser checks.
      expect(sheet.rowCount).toBeGreaterThan(0)
      expect(sheet.columnCount).toBeGreaterThan(0)
      expect(sheet.columnWidths).toEqual([])
      expect(sheet.defaultRowHeight).toBeNull()
      expect(sheet.freeze).toBeNull()
      expect(sheet.hidden).toBe(false)
      expect(sheet.showGridLines).toBe(true)
      expect(sheet.tables).toEqual([])
      expect(sheet.pivotTables).toEqual([])
      expect(sheet.sparklines).toEqual([])
      expect(sheet.cellImages).toEqual([])
    }
  })

  it('rejects paths outside the workspace and .xls', async () => {
    await bootHost()
    const escaped = await invoke('workbook:open-path', ['/etc/hosts'])
    expect(escaped.status).toBe(400)
    expect(escaped.body.error.code).toBe('OFFICE_BAD_INPUT')

    const legacy = await invoke('workbook:open-path', [host!.context.workspace.stageBytes('old.xls', new Uint8Array([1]))])
    expect(legacy.status).toBe(501)
    expect(legacy.body.error.code).toBe('OFFICE_UNSUPPORTED')
  })

  it('serves cells for a viewport range in the renderer range shape', async () => {
    await bootHost()
    const staged = stagedFixture()
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    const sheetId = file.sheets[0].id

    const range = await invoke('workbook:read-range', [
      { sessionId: file.sessionId, sheetId, range: { startRow: 0, endRow: 20, startColumn: 0, endColumn: 10 } },
    ])
    expect(range.status).toBe(200)
    const result = range.body.result
    expect(Array.isArray(result.cells)).toBe(true)
    expect(result.cells.length).toBeGreaterThan(0)
    expect(result.indexedThroughRow).toBe(20)
    expect(result.indexingComplete).toBe(true)
    expect(result.autoFilter).toBeNull()
    expect(result.sheetProtection).toBeNull()
    for (const key of ['rows', 'merges', 'hyperlinks', 'conditionalRules', 'autoFilterColumns', 'dataValidations', 'rowBreaks', 'colBreaks', 'protectedRanges']) {
      expect(Array.isArray(result[key])).toBe(true)
    }
    const first = result.cells[0]
    expect(Number.isInteger(first.row)).toBe(true)
    expect(Number.isInteger(first.column)).toBe(true)
    // Every cell in range 0..20 x 0..10 must actually fall inside it.
    for (const cell of result.cells) {
      expect(cell.row).toBeGreaterThanOrEqual(0)
      expect(cell.row).toBeLessThanOrEqual(20)
      expect(cell.column).toBeLessThanOrEqual(10)
    }
  })

  it('rejects reversed and oversized ranges', async () => {
    await bootHost()
    const staged = stagedFixture()
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    const sheetId = file.sheets[0].id

    const reversed = await invoke('workbook:read-range', [
      { sessionId: file.sessionId, sheetId, range: { startRow: 9, endRow: 2, startColumn: 0, endColumn: 1 } },
    ])
    expect(reversed.status).toBe(400)

    const oversized = await invoke('workbook:read-range', [
      { sessionId: file.sessionId, sheetId, range: { startRow: 0, endRow: 5000, startColumn: 0, endColumn: 5000 } },
    ])
    expect(oversized.status).toBe(400)
  })

  it('writes a cell edit back into the xlsx package', async () => {
    await bootHost()
    const staged = stagedFixture()
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    const sheetId = file.sheets[0].id

    const saved = await invoke('workbook:save', [
      saveRequest({
        sessionId: file.sessionId,
        edits: [{ sheetId, row: 30, column: 3, writeValue: true, value: 'OFFICE-AI-WAS-HERE' }],
      }),
    ])
    expect(saved.status).toBe(200)
    expect(saved.body.result.ok).toBe(true)
    expect(saved.body.result.path).toBe(staged.path)
    expect(saved.body.result.touchedEntries.length).toBeGreaterThan(0)

    const reread = await readBasicWorkbook(Buffer.from(host!.readFile(staged.path)))
    const sheet = reread.snapshot.sheets.find((s) => s.id === sheetId) ?? reread.snapshot.sheets[0]
    // row 30 / column 3 are 0-based in the wire contract → A1 'D31'
    expect(sheet.cells.D31?.value).toBe('OFFICE-AI-WAS-HERE')
  })

  it('saves chunked edits and matches the inline save byte-for-byte in content', async () => {
    await bootHost()
    const staged = stagedFixture()
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    const sheetId = file.sheets[0].id

    const edits = [
      { sheetId, row: 40, column: 0, writeValue: true, value: 'chunk-a' },
      { sheetId, row: 41, column: 0, writeValue: true, value: 'chunk-b' },
    ]
    const begin = await invoke('workbook:save-edits-begin', [
      { sessionId: file.sessionId, transferId: '11111111-2222-4333-8444-555555555555', total: 2 },
    ])
    expect(begin.body.result.ok).toBe(true)
    await invoke('workbook:save-edits-chunk', [
      { sessionId: file.sessionId, transferId: '11111111-2222-4333-8444-555555555555', seq: 0, editsJson: JSON.stringify([edits[0]]) },
    ])
    await invoke('workbook:save-edits-chunk', [
      { sessionId: file.sessionId, transferId: '11111111-2222-4333-8444-555555555555', seq: 1, editsJson: JSON.stringify([edits[1]]) },
    ])
    const saved = await invoke('workbook:save', [
      saveRequest({ sessionId: file.sessionId, editsTransferId: '11111111-2222-4333-8444-555555555555', edits: [] }),
    ])
    expect(saved.status).toBe(200)

    const reread = await readBasicWorkbook(Buffer.from(host!.readFile(staged.path)))
    const sheet = reread.snapshot.sheets[0]
    expect(sheet.cells.A41?.value).toBe('chunk-a')
    expect(sheet.cells.A42?.value).toBe('chunk-b')
  })

  it('aborts a staged transfer without touching the workbook', async () => {
    await bootHost()
    const staged = stagedFixture()
    const before = host!.readFile(staged.path)

    await invoke('workbook:save-edits-begin', [
      { sessionId: (await invoke('workbook:open-path', [staged.path])).body.result.sessionId, transferId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', total: 1 },
    ])
    const aborted = await invoke('workbook:save-edits-abort', [{ transferId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }])
    expect(aborted.body.result.ok).toBe(true)
    expect(Array.from(host!.readFile(staged.path))).toEqual(Array.from(before))
  })

  it('adds and renames a worksheet through the sheet-ops save path', async () => {
    await bootHost()
    const staged = stagedFixture()
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    const firstId = file.sheets[0].id
    const addedId = 'sheet-added-by-office-ai'

    const saved = await invoke('workbook:save', [
      saveRequest({
        sessionId: file.sessionId,
        sheetOps: [{ kind: 'add-sheet', sheetId: addedId, name: 'Office AI' }],
        sheetOrder: [firstId, addedId],
      }),
    ])
    expect(saved.status).toBe(200)

    const reread = await readBasicWorkbook(Buffer.from(host!.readFile(staged.path)))
    expect(reread.snapshot.sheets.map((s) => s.name)).toContain('Office AI')
  })

  it('converts a csv upload into a real workbook the renderer can open', async () => {
    await bootHost()
    const csv = new Uint8Array(Buffer.from('name,qty\nwidget,3\ngadget,5\n', 'utf8'))
    const staged = host!.open('sheets', csv, { name: 'inventory.csv' })
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    expect(file.csvPath).toBe(staged.path)
    expect(file.sheets.length).toBe(1)

    const sheetId = file.sheets[0].id
    const range = await invoke('workbook:read-range', [
      { sessionId: file.sessionId, sheetId, range: { startRow: 0, endRow: 5, startColumn: 0, endColumn: 4 } },
    ])
    const values = range.body.result.cells.map((c: { column: number; value: unknown }) => `${c.column}:${c.value}`)
    expect(values).toContain('0:widget')
    expect(values).toContain('1:3')
  })

  it('saves a csv workbook back as csv text, never as xlsx bytes', async () => {
    await bootHost()
    const csv = new Uint8Array(Buffer.from('name,qty\nwidget,3\n', 'utf8'))
    const staged = host!.open('sheets', csv, { name: 'inventory.csv' })
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    // The session works on a staged workbook; the user's file stays CSV.
    expect(file.path).not.toBe(staged.path)
    expect(file.csvPath).toBe(staged.path)

    // Without csvContent there is nothing to write back to the CSV — say so
    // instead of silently leaving the user's edits unwritten.
    const noContent = await invoke('workbook:save', [
      { ...saveRequest(), sessionId: file.sessionId, mode: 'save' },
    ])
    expect(noContent.status).toBe(400)
    expect(JSON.stringify(noContent.body)).toContain('csvContent')

    const saved = await invoke('workbook:save', [
      { ...saveRequest(), sessionId: file.sessionId, mode: 'save', csvContent: 'name,qty\nwidget,9\n' },
    ])
    expect(saved.status).toBe(200)
    expect(saved.body.result.path).toBe(staged.path)

    const onDisk = Buffer.from(host!.readFile(staged.path))
    expect(onDisk.toString('utf8')).toBe('name,qty\nwidget,9\n')
    // The ZIP signature is the whole bug: this used to land in the user's file.
    expect(onDisk.subarray(0, 2).toString('latin1')).not.toBe('PK')

    // The next save still writes CSV (not xlsx) to the same file — the session
    // re-read after the first save carried the CSV binding forward.
    const again = await invoke('workbook:save', [
      { ...saveRequest(), sessionId: saved.body.result.sessionId ?? file.sessionId, mode: 'save', csvContent: 'name,qty\nwidget,11\n' },
    ])
    expect(again.status).toBe(200)
    expect(again.body.result.path).toBe(staged.path)
    expect(Buffer.from(host!.readFile(staged.path)).toString('utf8')).toBe('name,qty\nwidget,11\n')
  })

  it('exports the renderer-supplied csv to a workspace path', async () => {
    await bootHost()
    const target = host!.context.workspace.stageBytes('out.csv', new Uint8Array())
    const exported = await invoke('workbook:export-csv', [
      { fileName: 'out.csv', content: 'a,b\n1,2\n', hasFormulas: false, targetPath: target },
    ])
    expect(exported.body.result.canceled).toBe(false)
    expect(Buffer.from(host!.readFile(exported.body.result.path)).toString('utf8')).toBe('a,b\n1,2\n')

    const noTarget = await invoke('workbook:export-csv', [
      { fileName: 'out.csv', content: 'a,b\n', hasFormulas: false },
    ])
    expect(noTarget.body.result.canceled).toBe(true)
  })

  it('reports defined names at open so a later save cannot delete them', async () => {
    await bootHost()
    const staged = stagedFixture()
    const file = (await invoke('workbook:open-path', [staged.path])).body.result

    // Add a name through the declarative save, then reopen it.
    const added = await invoke('workbook:save', [
      {
        ...saveRequest(),
        sessionId: file.sessionId,
        definedNamesState: { names: [{ name: 'TaxRate', formula: '0.2' }], preserveNames: [] },
      },
    ])
    expect(added.status).toBe(200)

    const reopened = (await invoke('workbook:open-path', [added.body.result.path])).body.result
    expect(reopened.definedNames).toContainEqual(
      expect.objectContaining({ name: 'TaxRate', formula: '0.2' }),
    )

    // The renderer's next save models exactly what it was shown. Every name it
    // was not told about would be dropped here — the bug this guards.
    const saved = await invoke('workbook:save', [
      {
        ...saveRequest(),
        sessionId: reopened.sessionId,
        definedNamesState: { names: reopened.definedNames, preserveNames: [] },
      },
    ])
    expect(saved.status).toBe(200)

    const final = (await invoke('workbook:open-path', [saved.body.result.path])).body.result
    expect(final.definedNames).toContainEqual(
      expect.objectContaining({ name: 'TaxRate', formula: '0.2' }),
    )
  })

  it('closes a session so later reads 404', async () => {
    await bootHost()
    const staged = stagedFixture()
    const file = (await invoke('workbook:open-path', [staged.path])).body.result
    expect((await invoke('workbook:close', [file.sessionId])).body.result.ok).toBe(true)

    const after = await invoke('workbook:read-range', [
      { sessionId: file.sessionId, sheetId: file.sheets[0].id, range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 } },
    ])
    expect(after.status).toBe(404)
    expect(after.body.error.code).toBe('OFFICE_NOT_FOUND')
  })
})
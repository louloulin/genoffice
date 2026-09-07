/**
 * sheets/* — Workbook open/new + recent-sheets bookkeeping.
 *
 * Recent list lives at DATA_DIR/sheets-recent.json (max 10 entries).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { registerHandle } from '../common/registry.js'
import { DATA_DIR, FILES_DIR } from '../common/store.js'

const SHEETS_RECENT_FILE = join(DATA_DIR, 'sheets-recent.json')

interface SheetInfo {
  id: string
  path: string
  name: string
  openedAt: number
}

function loadRecentSheets(): SheetInfo[] {
  try {
    if (existsSync(SHEETS_RECENT_FILE)) {
      return JSON.parse(readFileSync(SHEETS_RECENT_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

function saveRecentSheets(sheets: SheetInfo[]): void {
  writeFileSync(SHEETS_RECENT_FILE, JSON.stringify(sheets.slice(0, 10), null, 2))
}

export function registerSheetsHandlers(): void {
  registerHandle('sheets:new-blank', async (_event: unknown, options: unknown) => {
    const opts = options as { xlsx?: ArrayBuffer; path?: string } | undefined
    const id = `sheet-${Date.now()}`
    const name = `表格-${new Date().toLocaleDateString()}.xlsx`
    const path = join(FILES_DIR, `${id}.xlsx`)

    if (opts?.xlsx) {
      writeFileSync(path, Buffer.from(opts.xlsx))
    }

    const recent = loadRecentSheets()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSheets(recent)

    return { id, path, name }
  })

  registerHandle('sheets:has-queued-workbook', () => false)

  registerHandle('workbook:open-path', async (_event: unknown, filePath: unknown) => {
    if (!existsSync(filePath as string)) {
      throw new Error(`File not found: ${filePath}`)
    }

    const bytes = readFileSync(filePath as string)
    const name = basename(filePath as string)
    const id = `sheet-${Date.now()}`

    const recent = loadRecentSheets()
    recent.unshift({ id, path: filePath as string, name, openedAt: Date.now() })
    saveRecentSheets(recent)

    return {
      id,
      path: filePath,
      name,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })

  registerHandle('sheets:consume-new-blank', () => ({ ok: true }))
}

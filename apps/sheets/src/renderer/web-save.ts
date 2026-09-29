/**
 * Web-build workbook save: adapts the web-server's workbook:save answer to the
 * desktop contract the renderer validates.
 *
 * The Electron main process saves and then reopens the written file, answering
 * `{ canceled: false, file, touchedEntries }`; the renderer swaps to that fresh
 * session (`openLazyWorkbook(result.file)`). The web-server only saves and
 * answers `{ ok, path, touchedEntries }`, so without this step every browser
 * Save failed response validation ("Invalid workbook save response.") after the
 * bytes had already been written. The reopen goes through the same
 * workbook:open-path the initial open used.
 */
import type { WorkbookSaveRequest } from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'

export interface WebSaveTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export async function saveWorkbookOverHttp(
  transport: WebSaveTransport,
  request: WorkbookSaveRequest,
): Promise<unknown> {
  const raw: unknown = await transport.invoke(IPC_CHANNELS.saveWorkbook, request)
  const result = (raw ?? {}) as {
    ok?: unknown
    canceled?: unknown
    error?: unknown
    path?: unknown
    touchedEntries?: unknown
  }
  // Already desktop-shaped (a cancel, or a server that reopens itself).
  if (result.canceled === true || result.canceled === false) return raw
  if (result.ok !== true || typeof result.path !== 'string' || result.path.length === 0) {
    // Thrown, not returned: save-actions localizes thrown gateway messages.
    throw new Error(typeof result.error === 'string' && result.error ? result.error : 'Workbook save failed.')
  }
  const file: unknown = await transport.invoke('workbook:open-path', result.path)
  return {
    canceled: false,
    file,
    touchedEntries: Array.isArray(result.touchedEntries) ? result.touchedEntries : [],
  }
}

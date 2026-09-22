/// Web-version bootstrap for the pdf renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.pdfApi` / `window.projectApi` objects the preload exposes in the
/// desktop app, but backed by the HTTP/SSE transport against the running
/// Electron main process. Inside Electron the preload has already exposed the
/// IPC-backed APIs and this module leaves them untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import { defaultSdkCommandHandlers, installSdkCommandSink } from '@genoffice/ipc-bridge/sdk-command-sink'
import { createPdfApi, createPdfProjectApi } from '../shared/pdf-api-factory'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the pdf renderer.
  installBackToHome({ label: '返回主页' })
  /* Editor tabs are opened by the shell with `window.open`, so the shell has
   * no window handle to watch. This announces the tab (and keeps beating) over
   * the shared tab protocol — without it the shell can only guess whether a
   * row in its TabBar still has a window behind it, and a wrong guess is what
   * made clicking a recent file do nothing (or open a duplicate). */
  installTabGuest()
  /* SDK 2.0 Kestrel command sink (sdk1.md §11.36). The embed bridge
   * dispatches host `editor.command(name, args)` envelopes to this sink
   * when it exists (falling back to the server-backed `sdk:command` IPC
   * channel otherwise). `defaultSdkCommandHandlers()` covers the two
   * commands that are pure browser operations — `openFileDialog` (file
   * input → base64 PickedFile[]) and `print`. App-specific commands that
   * need the live editor model are added here as the renderer wires them. */
  installSdkCommandSink({ handlers: defaultSdkCommandHandlers() })
  const transport = createHttpIpcTransport()
  // SAFETY: `window` has no `pdfApi` / `pdfFilesApi` / `pdfProjectApi` in
  // lib.dom. The bridge assigns those keys below and reads them back through
  // module-scoped helpers, so the cast is sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  // `#open=<path>` grants the path to the bridge sender and returns it as the
  // pending open, so the renderer's boot consumePending() opens it (the web
  // equivalent of the shell granting a path to a real PDF view).
  const hashOpen = new URLSearchParams(window.location.hash.slice(1)).get('open')
  bridgedWindow.pdfApi = createPdfApi(transport, {
    consumePending: async () => {
      if (hashOpen) {
        const granted: unknown = await transport.invoke('pdf:open-path', hashOpen)
        return granted ? hashOpen : null
      }
      return null
    },
    uploadFile: async (projectId?: string) => {
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return null
      const file = picked[0]
      if (!file) return null
      try {
        const uploaded = await uploadFileToServer(transport, file.name, file.bytes, projectId)
        window.dispatchEvent(new Event('genoffice:recents-changed'))
        return uploaded
      } catch (err) {
        console.error('pdf uploadFile failed', err)
        return null
      }
    },
  })
  bridgedWindow.projectApi = createPdfProjectApi(transport)
}

/// Web-version bootstrap for the sheets renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.desktopApi` / `window.projectApi` objects the preload exposes in
/// the desktop app, but backed by the HTTP/SSE transport against the running
/// Electron main process. Native-only channels (workbook open dialogs, CSV
/// save confirm, attachment picker, screen capture) get browser equivalents so
/// the web version keeps the full feature surface. Inside Electron the preload
/// has already exposed the IPC-backed APIs and this module leaves them
/// untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  createWebFileBridge,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import { defaultSdkCommandHandlers, installSdkCommandSink } from '@genoffice/ipc-bridge/sdk-command-sink'
import { installTextBufferSink } from '@genoffice/ipc-bridge/text-buffer-adapter'
import { createSidebarRuntime } from '@genoffice/ipc-bridge/sidebar-runtime'
import { createSheetsApi, createSheetsProjectApi } from '../shared/sheets-api-factory'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill — works even when the user landed on a deep
  // link like `/sheets/...` without ever visiting the home tab.
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
  installTextBufferSink({
    sidebar: createSidebarRuntime({
      // Auto-forward inbound panel messages to window.parent as a
      // sidebarMessage EditorEvent (sdk1.md §B.5.1 #8). Closes the
      // panel → host half of the round-trip so the host SDK's
      // `editor.on('sidebarMessage', cb)` fires without an app-side
      // shim. Degrades to a no-op when there's no parent window
      // (apps run standalone in the browser tab fall back silently).
      outboundToHost: true,

      // Lazy body-aside host: zero DOM cost until mountSidebar runs.
      // Each app owns its sidebar chrome via app-specific CSS in
      // apps/{app}/src/renderer/styles.css. The runtime also sets
      // data-* attributes on the inner iframe for app-side hooks.
      get host() {
        let el = document.getElementById('genoffice-sidebar')
        if (!el) {
          el = document.createElement('aside')
          el.id = 'genoffice-sidebar'
          el.setAttribute('aria-label', 'GenOffice plugin panels')
          el.style.position = 'fixed'
          el.style.top = '0'
          el.style.right = '0'
          el.style.bottom = '0'
          el.style.width = '320px'
          el.style.background = 'var(--bg, #fff)'
          el.style.borderLeft = '1px solid var(--border, #e0e0e0)'
          el.style.zIndex = '1000'
          el.style.display = 'none'
          document.body.appendChild(el)
        }
        return el as unknown as Parameters<typeof createSidebarRuntime>[0]['host']
      },
    }),
  })
  const transport = createHttpIpcTransport()
  const files = createWebFileBridge(transport)
  // SAFETY: lib.dom's `window` type has no `desktopApi` / `sheetsApi` /
  // `projectApi` properties. The bridge assigns those keys below and reads
  // them back through the same module-scoped helper closures, so the
  // double-cast is sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  bridgedWindow.desktopApi = createSheetsApi(transport, {
    hasQueuedWorkbook: async () => new URLSearchParams(window.location.search).has('open'),
    selectWorkbook: async () => {
      const pending = new URLSearchParams(window.location.search).get('open')
      if (pending) return await transport.invoke('workbook:open-path', pending)
      const picked = await pickFileBytes('.xlsx,.xlsm,.xls,.csv')
      if (!picked) return null
      const file = picked[0]
      if (!file) return null
      const { name, bytes } = file
      const path = await files.writeTempFile(name, bytes)
      return await transport.invoke('workbook:open-path', path)
    },
    selectWorkbooksForMerge: async () => {
      const picked = await pickFileBytes('.xlsx,.xlsm,.xls,.csv', true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        paths.push(await files.writeTempFile(file.name, file.bytes))
      }
      return await transport.invoke('workbook:open-for-merge', paths)
    },
    confirmCsvSave: async () => 'csv',
    pickAttachments: async () => {
      const picked = await pickFileBytes(undefined, true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        paths.push(await files.writeTempFile(file.name, file.bytes))
      }
      return await transport.invoke('sheets:files-add', paths)
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
        console.error('sheets uploadFile failed', err)
        return null
      }
    },
    captureScreenSources: async () => {
      return {
        status: 'ok',
        sources: [{ id: 'display', name: 'Screen', kind: 'screen', thumbnail: '' }],
      }
    },
    captureScreenSource: async () => {
      return await captureDisplayFrame()
    },
  })
  bridgedWindow.projectApi = createSheetsProjectApi(transport)
}

async function captureDisplayFrame(): Promise<{
  mediaType: 'image/png'
  base64: string
  width: number
  height: number
} | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    const video = document.createElement('video')
    video.srcObject = stream
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve()
      video.play()
    })
    const width = video.videoWidth
    const height = video.videoHeight
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      stream.getTracks().forEach((track) => track.stop())
      return null
    }
    context.drawImage(video, 0, 0, width, height)
    stream.getTracks().forEach((track) => track.stop())
    return {
      mediaType: 'image/png',
      base64: canvas.toDataURL('image/png').split(',')[1] ?? '',
      width,
      height,
    }
  } catch {
    return null
  }
}

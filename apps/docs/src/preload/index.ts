import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createElectronIpcTransport } from '@genoffice/ipc-bridge/client'
import { installDropOpenBridge } from '@genoffice/electron-utils/drop-open'
import { createDesktopApi, createProjectApi } from '../shared/desktop-api-factory'

// The API surface lives in the transport-agnostic factory (shared with the
// browser web-bridge); the preload only binds it to ipcRenderer.
const transport = createElectronIpcTransport(ipcRenderer)

contextBridge.exposeInMainWorld(
  'desktop',
  createDesktopApi(transport, { getPathForFile: (file: File) => webUtils.getPathForFile(file) }),
)
contextBridge.exposeInMainWorld('projectApi', createProjectApi(transport))

// open documents dragged from the OS onto this tab as a new shell tab
installDropOpenBridge()

// Runtime marker consumed by isElectronRuntime() in @genoffice/ipc-bridge:
// with contextIsolation the page world has no real `process`, so the preload
// publishes the flag the renderer-side detection expects.
contextBridge.exposeInMainWorld('process', { contextIsolated: true })

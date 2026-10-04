import { contextBridge, ipcRenderer } from 'electron'
import { installDropOpenBridge } from '@genoffice/electron-utils/drop-open'
import { createElectronIpcTransport } from '@genoffice/ipc-bridge/client'
import { createPdfApi, createPdfProjectApi } from '../shared/pdf-api-factory'

const transport = createElectronIpcTransport(ipcRenderer)
contextBridge.exposeInMainWorld('pdfApi', createPdfApi(transport))
contextBridge.exposeInMainWorld('projectApi', createPdfProjectApi(transport))

// open documents dragged from the OS onto this tab as a new shell tab
installDropOpenBridge()

// Runtime marker consumed by isElectronRuntime() in @genoffice/ipc-bridge:
// with contextIsolation the page world has no real `process`, so the preload
// publishes the flag the renderer-side detection expects.
contextBridge.exposeInMainWorld('process', { contextIsolated: true })

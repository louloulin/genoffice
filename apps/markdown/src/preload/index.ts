import { contextBridge, ipcRenderer } from 'electron'
import { createElectronIpcTransport } from '@genoffice/ipc-bridge/client'
import { installDropOpenBridge } from '@genoffice/electron-utils/drop-open'
import { createMarkdownApi, createMarkdownProjectApi } from '../shared/markdown-api-factory'

// The API surface lives in the transport-agnostic factory (shared with the
// browser web-bridge); the preload only binds it to ipcRenderer.
const transport = createElectronIpcTransport(ipcRenderer)

contextBridge.exposeInMainWorld('markdownApi', createMarkdownApi(transport))
contextBridge.exposeInMainWorld('projectApi', createMarkdownProjectApi(transport))

// open documents dragged from the OS onto this tab as a new shell tab
installDropOpenBridge()

// Runtime marker consumed by isElectronRuntime() in @genoffice/ipc-bridge:
// with contextIsolation the page world has no real `process`, so the preload
// publishes the flag the renderer-side detection expects.
contextBridge.exposeInMainWorld('process', { contextIsolated: true })

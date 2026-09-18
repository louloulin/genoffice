/// Electron preload for the html renderer.
///
/// Source of truth for `window.htmlApi` / `window.projectApi` is
/// `apps/html/src/shared/html-api-factory.ts`: the same factory the browser
/// web-bridge uses, just bound to the Electron IPC transport instead of
/// HTTP/SSE. Channel names, argument shapes, listener wrappers are
/// identical — only the transport differs. This keeps the desktop and web
/// builds in lock-step.
import { contextBridge, ipcRenderer } from 'electron'
import { createElectronIpcTransport } from '@genoffice/ipc-bridge/client'
import { installDropOpenBridge } from '@genoffice/electron-utils/drop-open'
import { createHtmlApi, createHtmlProjectApi } from '../shared/html-api-factory'

const transport = createElectronIpcTransport(ipcRenderer)

const api = createHtmlApi(transport, {
  getPathForFile: (file) => {
    try {
      // webUtils is exposed by Electron >= 30; lazy-import to keep older
      // installs working
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { webUtils } = require('electron') as typeof import('electron')
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
})

contextBridge.exposeInMainWorld('htmlApi', api)
contextBridge.exposeInMainWorld('projectApi', createHtmlProjectApi(transport))

// open documents dragged from the OS onto this tab as a new shell tab
installDropOpenBridge()

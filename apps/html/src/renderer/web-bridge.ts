/// Web-version bootstrap for the html renderer.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import { createHtmlApi } from '../shared/html-api-factory'

if (!isElectronRuntime()) {
  const transport = createHttpIpcTransport()
  const bridgedWindow = window as unknown as Record<string, unknown>
  const hashOpen = new URLSearchParams(window.location.hash.slice(1)).get('open')

  // honour close requests from the shell (which is the only thing that can
  // find this child window by id and call tabsClose)
  const myId = bridgedWindow.__genofficeTabId as string | undefined
  if (myId) {
    const ch = new BroadcastChannel('genoffice:tabs')
    ch.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'close-request' && e.data?.id === myId) {
        try {
          window.close()
        } catch {}
      }
    }
    window.addEventListener('beforeunload', () => {
      ch.postMessage({ type: 'child-closing', id: myId })
    })
  }

  bridgedWindow.htmlApi = createHtmlApi(transport, {
    consumePending: async () => {
      if (hashOpen) return hashOpen
      return null
    },
  })
}

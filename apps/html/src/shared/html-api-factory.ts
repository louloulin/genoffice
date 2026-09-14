import type { IpcTransport } from '@genoffice/ipc-bridge/client'
import { HTML_CHANNELS, type HtmlApi } from './ipc'

export interface HtmlApiOverrides {
  consumePending?: () => Promise<string | null>
}

export function createHtmlApi(t: IpcTransport, overrides: HtmlApiOverrides = {}): HtmlApi {
  return {
    readFile: (path) => t.invoke(HTML_CHANNELS.readFile, path) as Promise<string>,
    saveFile: (path, content) =>
      t.invoke(HTML_CHANNELS.saveFile, path, content) as Promise<{ ok: boolean; path?: string }>,
    consumePending:
      overrides.consumePending ??
      (() => t.invoke(HTML_CHANNELS.consumePending) as Promise<string | null>),
    getLanguage: () => t.invoke(HTML_CHANNELS.getLanguage) as Promise<string>,
    getTheme: () => t.invoke(HTML_CHANNELS.getTheme) as Promise<string>,
  }
}

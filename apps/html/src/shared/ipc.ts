export interface HtmlApi {
  readFile(path: string): Promise<string>
  saveFile(path: string, content: string): Promise<{ ok: boolean; path?: string }>
  consumePending(): Promise<string | null>
  getLanguage?(): Promise<string>
  getTheme?(): Promise<string>
}

export const HTML_CHANNELS = {
  readFile: 'html:read-file',
  saveFile: 'html:save-file',
  consumePending: 'html:consume-pending',
  getLanguage: 'app:get-language',
  getTheme: 'app:get-theme',
} as const

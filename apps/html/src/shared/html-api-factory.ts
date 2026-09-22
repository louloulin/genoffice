/// Transport-agnostic construction of the html renderer bridge APIs.
///
/// One source of truth for the `window.htmlApi` / `window.projectApi`
/// surface: the sandboxed preload binds it to ipcRenderer (Electron), the
/// browser web-bridge binds the exact same object to the HTTP/SSE transport
/// (web version). Channel names, argument shapes and listener wrappers are
/// identical to what the preload has always exposed — only the transport
/// differs.
import type { IpcTransport } from '@genoffice/ipc-bridge/client'
import type { Lang } from '@genoffice/i18n'
import type {
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  GenSparkAccountStatus,
} from '@genoffice/ai-provider'
import type { AiPanelPrefs } from '@genoffice/ui'
import type { ProjectApi } from '@genoffice/project-store'
import type { HeadlessExportTarget } from '@genoffice/electron-utils/headless-export'
import { AI_CHANNELS, HTML_CHANNELS } from './ipc'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentReadResult,
  AutoSaveDefault,
  ExportDocxRequest,
  ExportHtmlRequest,
  ExportPdfRequest,
  ExportResult,
  HtmlApi,
  ImageData,
  SaveHtmlRequest,
  SaveHtmlResult,
  SaveMode,
  UiTheme,
} from './ipc'

export interface HtmlApiOverrides {
  /** Read the file path the shell pre-loaded this view with. Web reads `#open=` */
  consumePending?: () => Promise<string | null>
  /** Web-native image picker (browser file input + saveImage). */
  pickImage?: () => Promise<string | null>
  /**
   * Web-native file upload: pick a file via the browser and land it in
   * FILES_DIR via `web:save-file`. The factory default returns null
   * because the base transport has no DOM access for a file picker;
   * the web-bridge.ts override wires it.
   */
  uploadFile?: () => Promise<{ id: string; path: string; name: string } | null>
  /** Web-native export (browser download/print). */
  exportDocx?: (request: ExportDocxRequest) => Promise<ExportResult>
  exportPdf?: (request: ExportPdfRequest) => Promise<ExportResult>
  exportHtml?: (request: ExportHtmlRequest) => Promise<ExportResult>
  /** Web-native export-to-path (SDK `downloadAs` with a savePath). */
  writeExportBytes?: (
    path: string,
    bytes: ArrayBuffer,
  ) => Promise<{ ok: true; path: string; size: number } | null>
  /** Web-native file pick for chat attachments. */
  pickAttachments?: () => Promise<AttachmentAddResult | null>
  /** Web-native paste-image attachment (browser temp file + files:add-pasted-image). */
  addPastedImage?: (data: ArrayBuffer, ext: string) => Promise<AttachmentAddResult>
  /** The preview URL bound to this view. */
  getPreviewInfo?: () => Promise<{ url: string }>
  /** Push the current buffer so the preview iframe reloads. */
  updatePreview?: (text: string) => void
  /** Cover the screen for Present -> Fullscreen. */
  setPresentFullScreen?: (on: boolean) => Promise<void>
  /** Open a chrome-less tab (Present -> New tab) showing the preview. */
  presentInNewTab?: (title: string) => Promise<boolean>
  /** Browser has no local path for a dropped File. */
  getPathForFile?: (file: File) => string
}

export function createHtmlApi(t: IpcTransport, overrides: HtmlApiOverrides = {}): HtmlApi {
  const api: HtmlApi = {
    consumePending:
      overrides.consumePending ?? (() => t.invoke(HTML_CHANNELS.consumePending) as Promise<string | null>),
    consumeHeadlessExport: () => t.invoke(HTML_CHANNELS.consumeHeadlessExport) as Promise<HeadlessExportTarget | null>,
    headlessExportDone: (result) => t.send(HTML_CHANNELS.headlessExportDone, result),
    readFile: (path) => t.invoke(HTML_CHANNELS.readFile, path) as Promise<string>,
    updatePreview: overrides.updatePreview ?? ((text) => t.send(HTML_CHANNELS.previewUpdate, text)),
    getPreviewInfo: overrides.getPreviewInfo ?? (() => t.invoke(HTML_CHANNELS.previewInfo) as Promise<{ url: string }>),
    setPresentFullScreen:
      overrides.setPresentFullScreen ?? ((on) => t.invoke(HTML_CHANNELS.presentFullScreen, on) as Promise<void>),
    presentInNewTab:
      overrides.presentInNewTab ?? ((title) => t.invoke(HTML_CHANNELS.presentNewTab, title) as Promise<boolean>),
    save: (request: SaveHtmlRequest) => t.invoke(HTML_CHANNELS.save, request) as Promise<SaveHtmlResult>,
    setDirty: (dirty) => t.send(HTML_CHANNELS.dirtyChanged, dirty),
    onSaveRequest: (handler) =>
      t.on(HTML_CHANNELS.saveRequest, (mode) => handler(mode as SaveMode)),
    sendSaveRequestAck: (ok) => t.send(HTML_CHANNELS.saveRequestAck, ok),
    onCloseSaveRequest: (handler) => t.on(HTML_CHANNELS.closeSaveRequest, () => handler()),
    sendCloseSaveResult: (ok) => t.send(HTML_CHANNELS.closeSaveResult, ok),
    onFileRenamed: (handler) =>
      t.on(HTML_CHANNELS.fileRenamed, (newPath) => handler(newPath as string)),
    setProvisionalTitle: (title) => t.send(HTML_CHANNELS.provisionalTitle, title),
    pickImage: overrides.pickImage ?? (() => t.invoke(HTML_CHANNELS.pickImage) as Promise<string | null>),
    uploadFile: overrides.uploadFile ?? (() => Promise.resolve(null)),
    saveImage: (data) => t.invoke(HTML_CHANNELS.saveImage, data) as Promise<string | null>,
    readImage: (src) => t.invoke(HTML_CHANNELS.readImage, src) as Promise<ImageData | null>,
    pickAttachments:
      overrides.pickAttachments ?? (() => t.invoke(HTML_CHANNELS.filesPick) as Promise<AttachmentAddResult | null>),
    addAttachmentPaths: (paths) => t.invoke(HTML_CHANNELS.filesAdd, paths) as Promise<AttachmentAddResult>,
    addPastedImage:
      overrides.addPastedImage ?? ((data, ext) => t.invoke(HTML_CHANNELS.filesAddPastedImage, data, ext) as Promise<AttachmentAddResult>),
    readAttachment: (path, offset, maxChars) =>
      t.invoke(HTML_CHANNELS.filesRead, path, offset, maxChars) as Promise<AttachmentReadResult>,
    readAttachmentImage: (path) =>
      t.invoke(HTML_CHANNELS.filesReadImage, path) as Promise<AttachmentImageResult>,
    getPathForFile: overrides.getPathForFile ?? (() => ''),
    onExportRequest: (handler) =>
      t.on(HTML_CHANNELS.exportRequest, (format) => handler(format as 'pdf' | 'docx' | 'html')),
    onPrintRequest: (handler) => t.on(HTML_CHANNELS.printRequest, () => handler()),
    exportDocx: overrides.exportDocx ?? ((request) => t.invoke(HTML_CHANNELS.exportDocx, request) as Promise<ExportResult>),
    exportPdf: overrides.exportPdf ?? ((request) => t.invoke(HTML_CHANNELS.exportPdf, request) as Promise<ExportResult>),
    exportHtml: overrides.exportHtml ?? ((request) => t.invoke(HTML_CHANNELS.exportHtml, request) as Promise<ExportResult>),
    writeExportBytes:
      overrides.writeExportBytes ??
      (async (path, bytes) => {
        try {
          const result: unknown = await t.invoke(HTML_CHANNELS.writeExportBytes, { path, bytes })
          return (result ?? null) as { ok: true; path: string; size: number } | null
        } catch {
          // The server answers 4xx for a path outside managed storage or a
          // 0-byte payload — a caller bug, not a transport fault. Null lets
          // the SDK layer raise an error the host can act on.
          return null
        }
      }),
    getLanguage: () => t.invoke(HTML_CHANNELS.getLanguage) as Promise<Lang>,
    onLanguageChanged: (handler) => t.on(HTML_CHANNELS.languageChanged, (lang) => handler(lang as Lang)),
    getTheme: () => t.invoke(HTML_CHANNELS.getTheme) as Promise<UiTheme>,
    onThemeChanged: (handler) => t.on(HTML_CHANNELS.themeChanged, (theme) => handler(theme as UiTheme)),
    getAutoSaveDefault: () => t.invoke(HTML_CHANNELS.getAutoSaveDefault) as Promise<AutoSaveDefault>,
    onAutoSaveDefaultChanged: (handler) =>
      t.on(HTML_CHANNELS.autoSaveDefaultChanged, (value) => handler(value as AutoSaveDefault)),
    getAiPanelPrefs: () => t.invoke(HTML_CHANNELS.getAiPanelPrefs) as Promise<AiPanelPrefs>,
    onAiPanelPrefsChanged: (handler) =>
      t.on(HTML_CHANNELS.aiPanelPrefsChanged, (prefs) => handler(prefs as AiPanelPrefs)),
    onChromePressed: (handler) => t.on('app:chrome-pressed', () => handler()),
    getAiSettings: () => t.invoke(AI_CHANNELS.getSettings) as Promise<AiSettings>,
    aiGskStatus: () => t.invoke(AI_CHANNELS.gskStatus) as Promise<GenSparkAccountStatus>,
    aiStream: (request: AiStreamRequest) => t.invoke(AI_CHANNELS.stream, request) as Promise<void>,
    aiStreamCancel: (requestId) => t.invoke(AI_CHANNELS.streamCancel, requestId) as Promise<void>,
    onAiStream: (handler) => t.on(AI_CHANNELS.streamChunk, (chunk) => handler(chunk as AiStreamChunk)),
    webSearch: (query, maxResults) => t.invoke(AI_CHANNELS.webSearch, query, maxResults) as Promise<{ answer?: string; results: Array<{ title: string; url: string; snippet: string }>; method: string; error?: string }>,
    imageSearch: (query, maxResults) => t.invoke(AI_CHANNELS.imageSearch, query, maxResults) as Promise<{ images: Array<{ title?: string; imageUrl: string; width?: number; height?: number }>; method: string; error?: string }>,
    fetchImage: (url) => t.invoke(HTML_CHANNELS.fetchImage, url) as Promise<ImageData | null>,
    aiGenerateImage: (op) => t.invoke(HTML_CHANNELS.aiGenerateImage, op) as Promise<{ url?: string; error?: string }>,
  }
  return api
}

export function createHtmlProjectApi(
  t: IpcTransport,
): Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'> {
  return {
    resolveChat: (args) => t.invoke('project:resolveChat', args),
    appendChat: (args) => t.invoke('project:appendChat', args),
    loadChat: (args) => t.invoke('project:loadChat', args),
    rebindChat: (args) => t.invoke('project:rebindChat', args),
  }
}

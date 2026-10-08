/**
 * Public surface of the office-ai UI host tier. Consumed from Node as
 * `require('@genoffice/office-ai/host')` (dist/host.cjs build).
 */
export { startUiHost, attachUi, createHostContext, handleUiRequest } from './host'
export type {
  UiHostHandle,
  StagedDocument,
  StartUiHostOptions,
  AttachUiOptions,
  UiHostContext,
  CreateHostContextOptions,
} from './host'
export { createRegistry } from './registry'
export type { Registry, IpcHandler } from './registry'
export { SseHub } from './sse-hub'
export { UI_APPS } from './assets'
export type { UiApp } from './assets'
export { createWorkspace, safeFileStem } from './workspace'
export type { Workspace, WorkspaceOptions, PathAccess } from './workspace'
export { registerAppChannels, type AppChannelState } from './handlers/app-channels'
export { resolveAiHostSettings, aiConfigProblem, redactAiSettings } from './ai-settings'
export type { AiHostSettings } from './ai-settings'
export { handleAiStream } from './ai-stream'
export { registerDocsHandlers, createDocsState } from './handlers/docs'
export type { DocsHandlerState } from './handlers/docs'
export { registerSheetsHandlers, createSheetsState } from './handlers/sheets'
export type { SheetsHandlerState, SheetSession } from './handlers/sheets'
export { toGatewaySaveFields } from './handlers/sheets-save-map'
export type { RendererSaveRequest, GatewaySaveFields } from './handlers/sheets-save-map'
export { registerSlidesHandlers, createSlidesState, STUBBED_SLIDES_CHANNELS } from './handlers/slides'
export type { SlidesState } from './handlers/slides'
export { registerPdfHandlers, STUBBED_PDF_CHANNELS } from './handlers/pdf'
export { MIME_TYPES } from './mime'
export { buildChannelsView, CHANNELS_MAX_BYTES } from './channels-view'
export { MAX_HTTP_BODY_BYTES, readBodyWithCap } from './read-body'
export { encodeTransportValue, decodeTransportValue, BYTES_TAG } from './codec'
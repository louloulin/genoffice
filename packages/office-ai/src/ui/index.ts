/**
 * Public surface of the office-ai UI host tier. Consumed from Node as
 * `require('@genoffice/office-ai/host')` (dist/host.cjs build).
 */
export { startUiHost, attachUi, createHostContext, handleUiRequest } from './host'
export type {
  UiHostHandle,
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
export { registerAppChannels, type AppChannelState } from './handlers/app-channels'
export { MIME_TYPES } from './mime'
export { buildChannelsView, CHANNELS_MAX_BYTES } from './channels-view'
export { MAX_HTTP_BODY_BYTES, readBodyWithCap } from './read-body'
export { encodeTransportValue, decodeTransportValue, BYTES_TAG } from './codec'
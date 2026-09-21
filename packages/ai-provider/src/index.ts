export type { AgentMessage, AgentToolCall, AgentToolDef, AgentToolResult, AgentImage } from './agent-protocol'

export type {
  AiChatRequest,
  AiChatResponse,
  AiMediaProviderConfig,
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiMediaSettings,
  AiAnalysisProtocol,
  AiImageProtocol,
  AiSearchProviderId,
  AiSearchProviderMeta,
  AiSearchSettings,
  CodexModelCatalog,
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  GenSparkAccountStatus,
  LegacyAiSettings,
} from './types'
export {
  AI_PROVIDERS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  GENSPARK_LLM_BASE_URLS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  activeProvider,
  clampMaxOutputTokens,
  cloudToolsEnabled,
  defaultAiSettings,
  maxOutputTokensOf,
  resolveAiSettings,
} from './providers'
export {
  AI_MEDIA_PROVIDERS,
  GEMINI_MEDIA_BASE_URL,
  OPENAI_IMAGES_BASE_URL,
  activeMediaConfig,
  activeMediaProvider,
  defaultAiMediaSettings,
  getMediaProviderMeta,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
  mediaConfigUsable,
  providerHasCapability,
  resolveAiMediaSettings,
  videoAnalysisAvailable,
} from './media'
export type { MediaCapability } from './media'
export {
  AI_SEARCH_PROVIDERS,
  activeSearchProvider,
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from './search-settings'
export {
  analyzeMediaWithProvider,
  generateImageWithProvider,
  sniffImageMime,
  testMediaProvider,
} from './media-protocols'
export type {
  AnalyzeMediaInput,
  ByokMediaProviderId,
  GenerateImageInput,
  MediaBlob,
} from './media-protocols'
export { AI_PROVIDER_ADAPTERS, getProviderAdapter, modelLacksVision } from './registry'
export type {
  AiProtocol,
  ProviderAdapter,
  ProviderCapabilities,
  ResolvedEndpoint,
} from './registry'
export { chatForProvider, type ChatCallOptions } from './chat'
export { setAiUserAgent, setRescueFetch } from './fetch'
export { isAiNetworkError } from './network-error'
export { isAiOverloadedError, isAiQuotaExhaustedError } from './overload-error'
export { parseOutputCapRejection } from './output-cap'
export { AiCreditsError, sseLines, streamForProvider } from './stream'
export type { StreamCallbacks } from './stream'
export {
  AI_CHAT_RESPONSE_TIMEOUT_MS,
  AI_CONNECT_TIMEOUT_MS,
  AI_IDLE_TIMEOUT_MS,
  AiTimeoutError,
  createStreamWatchdog,
} from './watchdog'
export type { StreamWatchdog } from './watchdog'

// Codex CLI bridge — Node-only, import via subpath to keep the browser-safe
// main entry small: `@genoffice/ai-provider/codex-app-server`.
//
// Web consumers should use `chatCodexAppServer` / `streamCodexAppServer`
// from the browser stub (auto-selected by `./chat` / `./stream`).

// ── Provider Plugin API (sdk1.md §3.1) ──
export {
  createProviderRegistry,
  createMediaRegistry,
  createSearchRegistry,
  getDefaultProviderRegistry,
  resetDefaultProviderRegistry,
} from './provider-plugin'
export type {
  AiProviderPlugin,
  AiMediaPlugin,
  AiSearchPlugin,
  ProviderMeta,
  ProviderRegistry,
  MediaRegistry,
  SearchRegistry,
} from './provider-plugin'

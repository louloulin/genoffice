export type {
  AgentImage,
  AgentMessage,
  AgentStreamCallbacks,
  AgentStreamHandle,
  AgentStreamRequest,
  AgentToolCall,
  AgentToolDef,
  AgentToolResult,
  AgentTransport,
  ToolDisplay,
  ToolExecution,
} from './types'
export { composeSkills } from './skill'
export type { AgentSkill, ExecutedToolCall } from './skill'
export {
  AgentLoop,
  COMPLETED_VIA_TOOLS_TEXT,
  DEFAULT_MAX_TURNS,
  runtimePreamble,
  sanitizeAgentPayload,
} from './loop'
export type {
  AgentLoopEvents,
  AgentLoopOptions,
  AgentRunResult,
  CompactionOptions,
  ToolExecutedEvent,
} from './loop'
export { createIpcTransport, IPC_STREAM_SILENCE_TIMEOUT_MS } from './electron-transport'
export { streamText } from './stream-text'
export type { StreamTextOptions, StreamTextOutcome } from './stream-text'
export type { IpcStreamChunk, IpcStreamStart, IpcTransportOptions } from './electron-transport'
export { createHttpTransport, httpRequest } from './http-transport'
export type { HttpStreamChunk, HttpTransportOptions } from './http-transport'
export {
  createWebTransport,
  createWebIpcClient,
  isWebEnvironment,
  type WebTransportOptions,
  type WebAiSettings,
} from './web-transport'
export { WebIpcClient } from './web-transport'

// ── Agent Loop Protocol (sdk1.md §3.4) ──
export {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolError,
  validateAgentRequest,
} from './agent-protocol'
export type {
  AgentContext,
  AgentFileRef,
  AgentRequest,
  AgentResult,
  AgentRunner,
  AgentStep,
  AgentStopReason,
  AgentToolName,
} from './agent-protocol'

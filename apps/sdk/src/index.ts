/**
 * `@genoffice/web-sdk` — public surface.
 *
 *   import { createEditor, buildEmbedUrl, signJwtRequest } from '@genoffice/web-sdk'
 *
 * Re-exports the typed surface from `types.ts`, the embed URL builder, and
 * `createEditor` (the main entry). JWT signing itself lives in the web-server
 * REST API; the SDK only consumes the resulting token.
 */

export { createEditor } from './editor'
export { buildEmbedUrl } from './embed-url'
export type { EmbedUrlInput } from './embed-url'

export { ENVELOPE_VERSION, isEnvelope } from './envelope'
export type {
  CreateEditorOptions,
  EditorApp,
  EditorCommands,
  EditorError,
  EditorEvent,
  EditorEventMap,
  EditorEventName,
  EditorHandle,
  EditorLang,
  EditorMode,
  EditorTheme,
  EditorToolbar,
  GetContentResult,
  InsertImageArgs,
  SetContentArgs,
  AiRewriteArgs,
  AiTranslateArgs,
  AiSummarizeArgs,
  ReadyEvent,
  SavedEvent,
  DirtyChangedEvent,
  SelectionChangeEvent,
  ErrorEvent,
  ClosedEvent,
} from './types'

/** UMD global name for `<script>` consumers — see `dist/index.umd.js`. */
export const UMD_GLOBAL = 'GenOffice' as const

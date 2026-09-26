/**
 * Re-export shim for the Dataflare embed bridge.
 *
 * The bridge was originally implemented here in `apps/docs/src/shared/` and
 * was only used inside apps/docs. With W1 of the SDK consolidation plan it
 * moved to `@genoffice/web-sdk/dataflare/guest` (and `./host` for the parent
 * shell). This file exists only so existing imports keep working without
 * churn — renderer code is migrated to consume the SDK directly in W4
 * (when `apps/sdk/src/ai/translation` ships).
 *
 *   import { installDataflareEmbedBridge } from '../shared/embed-bridge'
 *
 * After W4 this shim will be deleted and renderer imports will point at
 *   @genoffice/web-sdk/dataflare/guest
 * directly.
 */
export {
  DATAFLARE_EMBED_PROTOCOL,
  installDataflareEmbedBridge,
  postToEmbedParent,
  requestDataflareParent,
  requestDataflareStreamParent,
  getDataflareEmbedSessionId,
  isEmbeddedInHost,
  isStreamEventEnvelope,
} from '@genoffice/web-sdk/dataflare/guest'

export type {
  DataflareOfficeContext,
  DataflareGlobalState,
  DataflareEmbedCommand,
  GenOfficeEmbedEvent,
  DataflareParentRequest,
  DataflareParentResponse,
  DataflareParentStreamRequest,
  DataflareParentStreamEvent,
  DataflareParentStreamClose,
  DataflareEmbedBridgeHandlers,
} from '@genoffice/web-sdk/dataflare/guest'
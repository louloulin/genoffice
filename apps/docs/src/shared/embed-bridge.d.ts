/**
 * Re-export shim for the Dataflare embed bridge type declarations.
 *
 * The SDK now owns the `window.dataflareOfficeBridge` global type and the
 * stream envelope types. This file exists only so legacy imports keep
 * resolving; consumers should import from `@genoffice/web-sdk/dataflare/guest`.
 */

import type {
  GenOfficeEmbedEvent,
  DataflareParentStreamEvent,
  DataflareParentStreamRequest,
} from '@genoffice/web-sdk/dataflare/guest'

declare global {
  interface Window {
    /**
     * 由 web-bridge 注入，供 GenOffice 内部模块访问宿主集成状态。
     * 当 isEmbedded=true 时表示运行在 Dataflare iframe 内。
     */
    dataflareOfficeBridge?: {
      postEvent(event: GenOfficeEmbedEvent): void
      isEmbedded: boolean
      getRevision(): string
    }
  }
}

/**
 * 重新导出给消费者使用，避免深路径 import：
 * import { requestDataflareStreamParent } from '../shared/embed-bridge'
 */
export type { DataflareParentStreamEvent, DataflareParentStreamRequest }

export {}
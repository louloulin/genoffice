/**
 * One progress relay for every pdf translation report.
 *
 * Two consumers need the same payload: the Dataflare host (over the postMessage
 * bridge, only when embedded) and the in-editor Translate ribbon tab (a
 * `window` CustomEvent, always). Routing every report through one function
 * keeps them in lock-step — a run from the desktop shell used to report
 * nothing locally, so the band stayed at "idle" while the dialog translated.
 *
 * `postToEmbedParent` is a no-op outside the iframe and
 * `publishTranslationStatus` is a no-op with no listeners, so both calls are
 * unconditional and neither branch has to know which host it runs under.
 */
import { postToEmbedParent } from '@genoffice/web-sdk/dataflare/guest'
import { publishTranslationStatus } from '@genoffice/ui'

export function emitTranslateProgress(payload: Parameters<typeof postToEmbedParent>[0]): void {
  postToEmbedParent(payload)
  // Only `ai-progress` carries translation state; the narrow keeps the relay
  // honest about what it forwards to the ribbon tab.
  if (payload.type === 'ai-progress') {
    publishTranslationStatus(payload)
  }
}

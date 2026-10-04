/**
 * One progress relay for every slides translation report.
 *
 * Two consumers need the same payload and they live in different places: the
 * Dataflare host (over the postMessage bridge, only when embedded) and the
 * in-editor Translate ribbon tab (a `window` CustomEvent, always). Routing
 * every report through one function is what keeps them in lock-step — before
 * this, a run started from the desktop shell reported nothing locally and the
 * ribbon band stayed at "idle" while the dialog was translating, and a run
 * started from the ribbon reported nothing to the host if the tab forgot its
 * own `postToEmbedParent`.
 *
 * `postToEmbedParent` is a no-op outside the iframe; `publishTranslationStatus`
 * is a no-op with no listeners. So both calls are unconditional and neither
 * needs to know which kind of host it is running under.
 */
import { postToEmbedParent } from '@genoffice/web-sdk/dataflare/guest'
import { publishTranslationStatus } from '@genoffice/ui'

export function emitTranslateProgress(payload: Parameters<typeof postToEmbedParent>[0]): void {
  postToEmbedParent(payload)
  // Only `ai-progress` carries translation state; the other event kinds never
  // reach this relay, but the narrow keeps the relay honest about its input.
  if (payload.type === 'ai-progress') {
    publishTranslationStatus(payload)
  }
}

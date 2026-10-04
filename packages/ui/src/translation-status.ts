/**
 * In-window status channel for the standalone Translate ribbon tab.
 *
 * The tab and the translation run live in different components: the run is
 * owned by the AI panel (or the per-app translate dialog), the tab is owned by
 * the ribbon band. `postToEmbedParent` only reaches the Dataflare host when the
 * editor *is* embedded, so a run started in the desktop shell had no way to
 * report progress to the band — the tab sat at "idle" while the dialog was
 * translating.
 *
 * The channel is deliberately a `CustomEvent` on `window` and not a store:
 * every app already keeps the run's state in its own component, the event
 * carries the same `ai-progress` payload that goes to the host, and an app
 * that never mounts the tab simply never listens. One payload, two consumers
 * (host iframe + ribbon band), no second source of truth.
 *
 * `TranslationTabStatus` is the tab's view of that payload; the narrowing
 * lives here so four apps cannot drift into four different state machines.
 */
import { useEffect, useState } from 'react'
import type { TranslationTabState, TranslationTabStatus } from './TranslationRibbonTab'

export const TRANSLATION_STATUS_EVENT = 'genoffice:translation-status'

/** The status a host renders before any run has been reported. */
export const IDLE_TRANSLATION_STATUS: TranslationTabStatus = { state: 'idle', progress: 0 }

const STATES: readonly TranslationTabState[] = [
  'idle',
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]

/**
 * Wire shape of an `ai-progress` event, mirrored structurally.
 *
 * Spelled out rather than imported from the web SDK: `@genoffice/ui` must stay
 * free of the SDK (the SDK depends on the UI, not the other way round), and
 * this is the only part of the payload the tab reads.
 */
export interface TranslationProgressDetail {
  status?: string
  progress?: number
  completedUnits?: number
  totalUnits?: number
  quality?: { overallScore?: number } | null
  error?: string | null
}

/**
 * Narrow an unknown status to the tab's closed vocabulary.
 *
 * The wire vocabulary is not the tab's: hosts and the shared pipeline emit
 * `started` for the first frame of a run (see `DataflareAiProgressStatus`),
 * while the band only has `pending` / `running`. Mapping `started` onto
 * `pending` is what keeps a just-started run from rendering as `idle` — the
 * band used to sit on "idle" until the first `running` frame, so a slow first
 * batch looked like the button had not registered the click at all.
 */
const WIRE_ALIASES: Record<string, TranslationTabState> = { started: 'pending' }

export function translationTabStateOf(status: unknown): TranslationTabState {
  if (typeof status !== 'string') return 'idle'
  const aliased = WIRE_ALIASES[status]
  if (aliased) return aliased
  return (STATES as readonly string[]).includes(status) ? (status as TranslationTabState) : 'idle'
}

/** Map a progress payload onto the tab's status shape. */
export function toTranslationTabStatus(detail: TranslationProgressDetail | undefined): TranslationTabStatus {
  return {
    state: translationTabStateOf(detail?.status),
    progress: typeof detail?.progress === 'number' ? detail.progress : 0,
    ...(detail?.completedUnits !== undefined ? { completedUnits: detail.completedUnits } : {}),
    ...(detail?.totalUnits !== undefined ? { totalUnits: detail.totalUnits } : {}),
    qualityScore: detail?.quality?.overallScore ?? null,
    message: detail?.error ?? null,
  }
}

/**
 * Publish a run update to the in-window channel.
 *
 * Callers that are embedded must still call `postToEmbedParent` themselves —
 * this only fans out to the local listeners, so the two destinations stay
 * independent and neither can silently replace the other.
 */
export function publishTranslationStatus(detail: TranslationProgressDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(TRANSLATION_STATUS_EVENT, { detail }))
}

/** Subscribe the ribbon band to the in-window channel. */
export function useTranslationTabStatus(initial: TranslationTabStatus = IDLE_TRANSLATION_STATUS): TranslationTabStatus {
  const [status, setStatus] = useState<TranslationTabStatus>(initial)
  useEffect(() => {
    const onStatus = (event: Event) => {
      setStatus(toTranslationTabStatus((event as CustomEvent<TranslationProgressDetail>).detail))
    }
    window.addEventListener(TRANSLATION_STATUS_EVENT, onStatus)
    return () => window.removeEventListener(TRANSLATION_STATUS_EVENT, onStatus)
  }, [])
  return status
}

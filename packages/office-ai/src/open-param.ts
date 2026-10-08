/**
 * Where each renderer reads its initial-document path from.
 *
 * docs/sheets/slides receive it from `consume-pending-open`, which the web
 * bridge parses out of `location.search`. The pdf renderer never reads the
 * query: `apps/pdf/src/renderer/web-bridge.ts` parses `location.hash`, because
 * its host page also carries `?app=`/`?mode=`/`?theme=` embed parameters that
 * must not be confused with a document path.
 *
 * The mismatch fails silently — a `?open=` URL boots the pdf app into its
 * "no document" empty state with no console error — so both URL builders go
 * through here instead of hand-rolling the parameter.
 */
export function setOpenParam(url: URL, app: string, openPath: string): void {
  if (app === 'pdf') url.hash = new URLSearchParams({ open: openPath }).toString()
  else url.searchParams.set('open', openPath)
}

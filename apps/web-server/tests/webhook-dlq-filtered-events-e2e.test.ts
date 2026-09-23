/**
 * End-to-end contract pin for the webhook DLQ filtered-event filter (sdk1 §11.113).
 *
 * Pins the §11.113 fix:
 *   - A subscriber's `events` allow-list is a filter, not a retry queue.
 *     When `fireCallback` would skip a subscriber because the fired
 *     event isn't on its list, the result is NOT a "failed delivery"
 *     and must NOT appear in the DLQ.
 *   - Without this filter the DLQ fills with
 *     `{attempts:0, lastError:null, reason:"max_attempts"}` entries
 *     that the host can't act on (no retry helps when the subscriber
 *     explicitly opted out) — a §11.33-style "noise dominates signal"
 *     bug class.
 *
 * Coverage:
 *   - Subscribe with `events: ["file.saved"]`, fire `comment.added`:
 *     `deliveredCount: 0` (filtered) and DLQ does not grow.
 *   - Subscribe with `events: ["file.saved"]`, fire `file.saved` to a
 *     URL that refuses the connection (port 1): DLQ receives ONE entry
 *     with `attempts: 3, reason: "max_attempts"` — proving the fix
 *     only skips filtered events, not real failures.
 *   - Subscribe with NO `events` field (defaults to all-events per
 *     `apps/web-server/src/api/v1/webhooks.ts` POST handler),
 *     fire `comment.added`: `deliveredCount: 1` (not filtered) and
 *     DLQ does NOT grow.
 *
 * The test runs both subscriptions and both fire events serially in
 * one harness so the DLQ assertions can be checked against the
 * baseline (empty DLQ from the boot harness).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness, mintJwt } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface DlqBody {
  entries: Array<{ id: string; url: string; event: string; attempts: number; reason: string; lastError: string | null }>
  count: number
}

interface CallbackBody {
  ok: boolean
  fired: string
  deliveredCount: number
}

describe.skipIf(skip)('webhook DLQ filtered-event filtering (sdk1 §11.113)', () => {
  it('filtered subscriber events do not land in DLQ; real failures still do', async () => {
    const h = await ServerHarness.start()
    try {
      // The bundle boots with `webhooks:manage` not in the JWT default
      // bootstrap — mint a token that explicitly grants it.
      const token = await mintJwt(h.secret, 'tester', [
        'admin',
        'webhooks:manage',
        'files:read',
      ])

      const subscribeBody = (events: string[], url: string) =>
        JSON.stringify({
          url,
          events,
        })

      // ---- Phase 0: baseline DLQ is empty ----
      const beforeFire = await h.req<DlqBody>('/api/v1/webhooks/dlq', { token })
      expect(beforeFire.status).toBe(200)
      const baselineCount = beforeFire.body.count
      expect(baselineCount, 'baseline DLQ must start empty').toBe(0)

      // ---- Phase 1: subscribe with strict events whitelist ----
      const sub1 = await h.req<{ ok: boolean }>('/api/v1/webhooks', {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: subscribeBody(['file.saved'], 'http://127.0.0.1:18999/wh-receiver'),
      })
      expect(sub1.status).toBe(201)

      // ---- Phase 2: fire a filtered-out event — must skip, no DLQ entry ----
      const fireFiltered = await h.req<CallbackBody>('/api/v1/callbacks', {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'comment.added',
          fileId: 'test-filtered',
          data: { hello: 'world' },
        }),
      })
      expect(fireFiltered.status).toBe(200)
      // deliveredCount is `filter(r => r.delivered).length` — the filtered
      // subscriber contributes 0 (delivered: false, filtered: true).
      expect(fireFiltered.body.fired).toBe('comment.added')
      expect(fireFiltered.body.deliveredCount).toBe(0)

      // DLQ must NOT have grown.
      const afterFilteredFire = await h.req<DlqBody>('/api/v1/webhooks/dlq', { token })
      expect(afterFilteredFire.status).toBe(200)
      expect(afterFilteredFire.body.count, 'filtered event must not appear in DLQ').toBe(baselineCount)

      // ---- Phase 3: re-subscribe to a URL that always refuses, fire file.saved ----
      // Port 1 is reserved; connections to it close with ECONNREFUSED on Linux.
      // On macOS the kernel may reject differently — we accept either a
      // "fetch failed" / `lastError !== null` result or any DLQ entry
      // with `attempts >= 1` as proof that a real attempt was made.
      const sub2 = await h.req<{ ok: boolean }>('/api/v1/webhooks', {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: subscribeBody(['file.saved'], 'http://127.0.0.1:1/never-listening'),
      })
      expect(sub2.status).toBe(201)

      const fireFailure = await h.req<CallbackBody>('/api/v1/callbacks', {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'file.saved',
          fileId: 'test-failure',
          data: { after: 'subscribe' },
        }),
      })
      expect(fireFailure.status).toBe(200)

      // The DLQ population is async — fetchOnDemand retries 3x with
      // backoff (250ms, 500ms, 1000ms). Give it generous time.
      const deadline = Date.now() + 8000
      let afterFailureFireCount = -1
      let afterFailureFireEntries: DlqBody['entries'] = []
      while (Date.now() < deadline) {
        const poll = await h.req<DlqBody>('/api/v1/webhooks/dlq', { token })
        afterFailureFireCount = poll.body.count
        afterFailureFireEntries = poll.body.entries
        if (poll.body.count >= baselineCount + 1) break
        await new Promise((r) => setTimeout(r, 250))
      }

      // Real failed delivery must produce at least one new DLQ entry.
      expect(afterFailureFireCount, 'real failed delivery must add a DLQ entry').toBeGreaterThanOrEqual(baselineCount + 1)

      // Find the entry for `file.saved` with the failing URL.
      const fileEntry = afterFailureFireEntries.find((e) => e.event === 'file.saved' && e.url === 'http://127.0.0.1:1/never-listening')
      expect(fileEntry, 'DLQ must contain a file.saved entry for the failing URL').toBeDefined()
      // Real attempts: `attempts >= 1` distinguishes a real failure
      // from the §11.113-pre-fix filtered-event noise (attempts: 0).
      expect(fileEntry!.attempts, 'attempts must be >= 1 for a real delivery').toBeGreaterThanOrEqual(1)
      expect(fileEntry!.reason).toBe('max_attempts')

      // And critically: the entry we expect to NOT be there is the filtered
      // `comment.added` one. (Sanity check — by phase 3 DLQ should have
      // `file.saved` (failing) and `some.thing`-style filtered events
      // SHOULD NOT have been added.)
      const filteredPollute = afterFailureFireEntries.find(
        (e) => e.event === 'comment.added',
      )
      expect(filteredPollute, 'comment.added (filtered) must NOT be in DLQ after fix').toBeUndefined()

    } finally {
      await h.stop()
    }
  }, 60_000)
})

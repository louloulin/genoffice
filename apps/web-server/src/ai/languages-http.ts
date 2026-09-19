/**
 * HTTP surface for the AI translation language catalogue.
 *
 *   GET /api/ai/languages
 *
 * Returns the canonical `LanguageOption[]` shipped by `@genoffice/translation-core`,
 * the same list the docs / sheets / slides editors render in their language
 * pickers. Dataflare's `frontend/src/utils/translationLanguages.ts` is a
 * hand-maintained mirror of this list; previously the only way to keep the
 * two in lock-step was a comment pointing at the other side, and a stray edit
 * (e.g. adding `zh-HK`) would silently disagree with the GenOffice side and
 * drop glossary terms on the floor.
 *
 * Dataflare's `TranslationLanguagesRefresher` (see Phase 3 of the integration
 * plan in `genoffice-ai-translation-dataflarework-integration.md`) reads this
 * endpoint at build / boot time and overwrites its local mirror; in CI a
 * parity test asserts the two files agree. The endpoint answers with a tiny
 * payload (≈ 700 bytes), no auth required — it is a static catalogue.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LANGUAGES, type LanguageOption } from '@genoffice/translation-core'

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

interface LanguagePayload extends LanguageOption {
  /** True when the value may be used as a target language. `auto` is the only
   *  source-only entry; consumers that want to drive a target select from the
   *  same list need this flag rather than having to filter 'auto' themselves. */
  isTarget: boolean
}

const PAYLOAD: LanguagePayload[] = LANGUAGES.map((option) => ({
  ...option,
  isTarget: option.value !== 'auto',
}))

/**
 * Handle `GET /api/ai/languages`. Only GET is supported — POST / PUT are
 * answered with 405 so a future caller that forgets the verb sees a clean
 * status instead of an empty body.
 */
export function handleLanguagesHttp(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET') {
    sendJson(response, 405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required' },
    })
    return
  }
  sendJson(response, 200, {
    ok: true,
    languages: PAYLOAD,
    /** Schema version bumped when the shape changes. Consumers should
     *  refuse to render unknown major versions. */
    schemaVersion: 1,
    /** Source-of-truth identifier; useful for the CI parity test. */
    source: '@genoffice/translation-core',
  })
}

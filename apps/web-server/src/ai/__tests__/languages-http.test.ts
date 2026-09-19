/**
 * HTTP integration tests for `GET /api/ai/languages`.
 *
 * The endpoint returns the canonical language catalogue shipped by
 * `@genoffice/translation-core`, plus an `isTarget` flag so callers can
 * drive a target-only picker without re-filtering `auto` themselves.
 *
 * Dataflare's `frontend/src/utils/translationLanguages.ts` is supposed to
 * mirror this list at build time (see Phase 3 of the integration plan);
 * keeping the response stable lets that refresher stay a one-liner.
 *
 * Run with: `tsx --test src/ai/__tests__/languages-http.test.ts`
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { LANGUAGES } from '@genoffice/translation-core'

import { handleLanguagesHttp } from '../languages-http'

function makeServer(): Promise<{ server: Server; port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/api/ai/languages') {
        handleLanguagesHttp(req, res)
        return
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ server, port: addr.port, close: () => server.close() })
      }
    })
  })
}

interface LanguagePayload {
  value: string
  label: string
  englishLabel: string
  isTarget: boolean
}

test('GET /api/ai/languages — returns canonical catalogue with isTarget flags', async () => {
  const { port, close } = await makeServer()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/languages`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    const body = (await response.json()) as {
      ok: boolean
      schemaVersion: number
      source: string
      languages: LanguagePayload[]
    }
    assert.equal(body.ok, true)
    assert.equal(body.source, '@genoffice/translation-core')
    assert.equal(typeof body.schemaVersion, 'number')
    // Every entry in LANGUAGES must show up — a missing entry would mean a
    // future contributor trimmed the core list and forgot to surface the
    // change here. Failing fast keeps Dataflare's mirror honest.
    assert.equal(body.languages.length, LANGUAGES.length)
    for (const expected of LANGUAGES) {
      const actual = body.languages.find((l) => l.value === expected.value)
      assert.ok(actual, `missing language ${expected.value}`)
      assert.equal(actual.label, expected.label)
      assert.equal(actual.englishLabel, expected.englishLabel)
    }
    const auto = body.languages.find((l) => l.value === 'auto')
    assert.equal(auto?.isTarget, false, 'auto must not be a target')
    const zhCN = body.languages.find((l) => l.value === 'zh-CN')
    assert.equal(zhCN?.isTarget, true, 'zh-CN must be a target')
  } finally {
    close()
  }
})

test('GET /api/ai/languages — wrong method returns 405', async () => {
  const { port, close } = await makeServer()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/languages`, { method: 'POST' })
    assert.equal(response.status, 405)
    const body = (await response.json()) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'METHOD_NOT_ALLOWED')
  } finally {
    close()
  }
})

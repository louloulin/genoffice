/**
 * Live probe: exercise the built SDK collab clients against a real
 * web-server.
 *
 * Run after `pnpm -F @genoffice/web-sdk build`, with a server listening:
 *
 *     PROBE_BASE=http://127.0.0.1:18081 node apps/sdk/scripts/live-probe.mjs
 *
 * This is the check the mocked unit tests structurally cannot make. The
 * clients once read IPC payloads off the envelope's top level, which passed
 * every mock because the mocks served bare payloads — while against a real
 * server `list()` returned `[]` forever and `add()` threw. Keep this passing
 * whenever the IPC envelope or a collab handler's return shape changes.
 */
import { CollabCursorClient } from '../dist/collab-cursor.mjs'
import { CollabPresenceClient } from '../dist/collab-presence.mjs'
import { CollabLockClient } from '../dist/collab-lock.mjs'
import { CollabCommentsClient } from '../dist/collab-comments.mjs'
import { EmbedNonceClient } from '../dist/embed-nonce.mjs'
import { openEmbedSession, isRetryable } from '../dist/file-embed.mjs'
import { TranslationClient } from '../dist/ai-translation.mjs'

const baseUrl = process.env.PROBE_BASE ?? 'http://127.0.0.1:18081'
const docId = `sdk-live-probe-${Date.now()}`
const config = { baseUrl }

let failures = 0
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}
const expectReject = async (name, code, fn) => {
  try {
    await fn()
    check(name, false, 'resolved but should have rejected')
  } catch (err) {
    check(name, err?.code === code, { code: err?.code, message: err?.message })
  }
}

// Seed a session the way the editor would.
const join = await fetch(`${baseUrl}/api/ipc/collab:join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ args: [{ docId, userId: 'u-seed' }] }),
}).then((r) => r.json())
console.log(`session ${docId}: ${JSON.stringify(join)}\n`)

// The web-server serves the SDK bundle off a hard-coded entry allowlist
// (`SDK_ENTRY_PATTERN` in `apps/web-server/src/index.ts`). No test pins that
// regex, and a missing entry is invisible locally — the SDK tests import
// `dist/` directly — while a CDN-hosted host gets a 404. Probe it here.
console.log('static sdk allowlist')
for (const entry of ['file-embed', 'ai-translation', 'embed-nonce']) {
  const res = await fetch(`${baseUrl}/static/sdk/${entry}.mjs`)
  check(`/static/sdk/${entry}.mjs is served`, res.status === 200, res.status)
}

const cursor = new CollabCursorClient(config)
const presence = new CollabPresenceClient(config)
const lock = new CollabLockClient(config)
const comments = new CollabCommentsClient(config)

console.log('cursor')
await cursor.update({ docId, userId: 'u1', position: { x: 10, y: 20, offset: 5 } })
const cursors = await cursor.list(docId)
check('update then list sees the cursor', cursors.length === 1 && cursors[0].userId === 'u1', cursors)
check('cursor carries a server-assigned colour', typeof cursors[0]?.color === 'string', cursors[0])
await expectReject('update on an unknown doc is NOT_FOUND', 'NOT_FOUND', () =>
  cursor.update({ docId: 'nope', userId: 'u1', position: { x: 0, y: 0, offset: 0 } }),
)

console.log('\npresence')
await presence.update({ docId, userId: 'u1', userName: 'Alice', status: 'active' })
const people = await presence.list(docId)
check('update then list sees the user', people.length === 1 && people[0].userName === 'Alice', people)

console.log('\nlock')
const acquired = await lock.acquire({ docId, userId: 'u1', sectionId: 'header' })
check(
  'acquire returns { lockKey, acquiredAt }',
  acquired.ok === true && acquired.lockKey === 'header' && typeof acquired.acquiredAt === 'number',
  acquired,
)
await expectReject('a second holder gets CONFLICT', 'CONFLICT', () =>
  lock.acquire({ docId, userId: 'u2', sectionId: 'header' }),
)
const held = await lock.status(docId, 'header')
check(
  'status reports the holder',
  held.locks.length === 1 && held.locks[0].userId === 'u1' && held.locks[0].expired === false,
  held,
)
await lock.release({ docId, userId: 'u1', sectionId: 'header' })
const free = await lock.status(docId, 'header')
check('release empties status', free.locks.length === 0, free)

console.log('\ncomments')
const added = await comments.add({
  docId,
  userId: 'u1',
  userName: 'Alice',
  content: 'live probe comment',
  selection: { start: 0, end: 5, text: 'hello' },
})
check('add returns a commentId', typeof added.commentId === 'string' && added.commentId.startsWith('comment-'), added)
const list = await comments.list(docId)
check('list sees the comment', list.length === 1 && list[0].id === added.commentId, list)
const replied = await comments.reply({
  docId,
  commentId: added.commentId,
  userId: 'u2',
  userName: 'Bob',
  content: 'ack',
})
check('reply returns a replyId', typeof replied.replyId === 'string', replied)
const afterReply = await comments.list(docId)
check('the reply is nested under its parent', afterReply[0]?.replies?.length === 1, afterReply)
await comments.resolve(docId, added.commentId)
const resolved = await comments.list(docId)
check('resolve flips resolved', resolved[0]?.resolved === true, resolved)
await comments.delete(docId, added.commentId)
check('delete empties the thread', (await comments.list(docId)).length === 0)
await expectReject('resolve on a missing comment is NOT_FOUND', 'NOT_FOUND', () =>
  comments.resolve(docId, 'comment-does-not-exist'),
)

// Collect up to `limit` events (or stop on error/complete/timeout) so the
// probe can never hang on a stream that stays open.
async function collect(stream, { limit = 1, timeoutMs = 15_000 } = {}) {
  const events = []
  return await new Promise((resolveProm) => {
    let settled = false
    let timer
    let sub
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sub?.unsubscribe()
      resolveProm(events)
    }
    timer = setTimeout(finish, timeoutMs)
    sub = stream.subscribe({
      next: (e) => {
        events.push(e)
        if (events.length >= limit) finish()
      },
      error: () => finish(),
      complete: () => finish(),
    })
  })
}

// ── v1 groups ───────────────────────────────────────────────────────────────
// These need a signed JWT (v1 scope gates), which the standalone invocation
// can't mint. `probe-live-server.mjs` supplies one; without it we say so
// loudly rather than reporting a pass we didn't earn.
const bearer = process.env.PROBE_BEARER ?? ''
if (!bearer) {
  console.log('\nSKIP  embed + translation v1 groups (PROBE_BEARER unset)')
  console.log('      run `npm run verify:sdk` from the repo root to include them')
}

if (bearer) {
  // The mint endpoints are scope-gated AND the JWT mint 404s for an unknown
  // file, so the probe needs a real file to point at.
  const upload = await fetch(`${baseUrl}/api/v1/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ name: 'sdk-probe.txt', bytes: Buffer.from('sdk live probe').toString('base64') }),
  })
  const uploadBody = await upload.json().catch(() => ({}))
  const fileId = uploadBody?.id
  check('POST /api/v1/files creates the probe file', upload.status === 201 && typeof fileId === 'string', {
    status: upload.status,
    body: uploadBody,
  })

  console.log('\nembed session (openEmbedSession)')
  const session = await openEmbedSession({ baseUrl, documentId: fileId, bearer })
  const embedUrl = new URL(session.url)
  // Assert the contract the server actually serves — `parseEmbedQuery` in
  // `apps/web-server/src/embed/index.ts`: the document id is a **path** segment
  // and the credential parameter is named **`token`** (anything else answers
  // `400 missing ?token=`). This probe previously asserted
  // `/apps/docs/embedded?embed=1&doc=&jwt=`, a shape no route serves, so it
  // reported a green embed session for a URL that could never load.
  check(
    'url targets /embed/<docId> with the id in the path',
    embedUrl.pathname === `/embed/${encodeURIComponent(fileId)}`,
    session.url,
  )
  check('url carries app=docs', embedUrl.searchParams.get('app') === 'docs', session.url)
  check(
    'url carries token + sessionId + nonce',
    embedUrl.searchParams.get('token') === session.jwt &&
      embedUrl.searchParams.get('sessionId') === session.sessionId &&
      embedUrl.searchParams.get('nonce') === session.nonce,
    Object.fromEntries(embedUrl.searchParams),
  )
  check('jwt is unexpired', session.jwtExp * 1000 > Date.now(), session.jwtExp)

  const nonceClient = new EmbedNonceClient({ baseUrl, bearer })
  // `open()` already verified this pair; a second lookup must also succeed.
  // If verify-nonce ever became consuming, every embed would break on mount
  // and no mock would notice.
  const reverified = await nonceClient.verify({ sessionId: session.sessionId, nonce: session.nonce })
  check('re-verifying the minted pair still succeeds (verify is non-consuming)', reverified.valid === true, reverified)

  const firstCleanup = await session.cleanup()
  check('cleanup() releases the server-side session', firstCleanup.released === true, firstCleanup)
  const secondCleanup = await session.cleanup()
  check('cleanup() is idempotent', secondCleanup.released === true, secondCleanup)
  const afterRelease = await nonceClient.verify({ sessionId: session.sessionId, nonce: session.nonce })
  check('a released session no longer verifies', afterRelease.valid === false, afterRelease)

  check(
    'isRetryable classifies transport faults but never a spent nonce',
    typeof isRetryable === 'function' &&
      isRetryable('NETWORK') === true &&
      isRetryable('INTERNAL') === true &&
      isRetryable('EMBED_NONCE_INVALID') === false,
  )

  console.log('\ntranslation (v1)')
  // A recording fetch pins which paths the client actually calls — the whole
  // point of the migration, and invisible to the mocked unit tests.
  const seen = []
  const recordingFetch = (input, init) => {
    seen.push(typeof input === 'string' ? input : String(input))
    return fetch(input, init)
  }
  const translation = new TranslationClient({ baseUrl, bearer, fetch: recordingFetch })

  let batch = null
  let batchErr = null
  try {
    batch = await translation.translateBatch({ units: [{ sourceText: 'hello', order: 0 }], targetLanguage: 'zh' })
  } catch (err) {
    batchErr = err
  }
  check(
    'batch is not rejected as the wrong body shape',
    !(batchErr && batchErr.code === 'INVALID_ARGUMENT'),
    batchErr ? { code: batchErr.code, message: batchErr.message } : undefined,
  )
  check('batch returns the units[] pipeline result', Array.isArray(batch?.units), batch)

  // Inline memory + glossary, asserted without involving a provider: an inline
  // memory hit short-circuits before the provider call, so `status` and the
  // resulting text are deterministic no matter which model (if any) the server
  // has configured. The seeded target deliberately still carries the source
  // term — the "model left the term untranslated" case the enforcement pass
  // exists for — so a server that dropped `glossary` returns the term verbatim
  // and this check goes red.
  //
  // The term is probe-scoped on purpose. A realistic one ("fabric weight")
  // silently collides with whatever the server's KB already says, and the KB
  // wins on an equal-length match, which makes the assertion a statement about
  // the KB rather than about the wire fields under test.
  let hitBatch = null
  let hitErr = null
  try {
    hitBatch = await translation.translateBatch({
      units: [{ sourceText: 'probe term alpha', order: 0 }],
      targetLanguage: 'zh',
      glossary: [{ source: 'probe term alpha', target: '探针甲' }],
      memory: [{ sourceText: 'probe term alpha', targetText: 'the probe term alpha value' }],
      cacheScope: 'probe-scope',
    })
  } catch (err) {
    hitErr = err
  }
  const hitUnit = hitBatch?.units?.[0]
  const hitDetail = hitErr ? { code: hitErr.code, message: hitErr.message } : hitUnit
  check('inline memory is served without a provider call', hitUnit?.status === 'memory-hit', hitDetail)
  check('inline glossary is enforced on the memory hit', hitUnit?.translatedText === 'the 探针甲 value', hitDetail)
  check(
    'inline glossary is reported in matchedTerms',
    (hitUnit?.matchedTerms ?? []).includes('probe term alpha'),
    hitDetail,
  )

  const stream = translation.translate({ units: [{ sourceText: 'hello', order: 0 }], targetLanguage: 'zh' })
  const events = await collect(stream, { limit: 1 })
  const startEvent = events.find((e) => e.type === 'start')
  check('stream opens over v1 and emits a start event', !!startEvent && typeof startEvent.requestId === 'string', events.map((e) => e.type))
  await stream.cancel()

  check('every translation call targets /api/v1/ai/translate*', seen.length > 0 && seen.every((u) => u.includes('/api/v1/ai/')), seen)
  check('no translation call still targets the legacy /api/ai/translate path', !seen.some((u) => /\/api\/ai\//.test(u)), seen)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

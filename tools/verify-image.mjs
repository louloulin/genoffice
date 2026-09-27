// Assert that a built image can actually serve.
//
// Every defect this gate exists for was invisible from inside the repo. The
// released image carried no `/static/sdk/*` and one renderer out of seven, so
// embed hosts got a 404 for the host bridge while every local test stayed
// green; and the paths it did ship resolved to the wrong place inside the
// container, so even present files answered 404 (sdk1.md §11.125). Statements
// about the repository cannot catch that. This gate runs the image and asks
// for the bytes over HTTP.
//
// The destructive arms carry as much weight as the happy path: an image whose
// `WEB_SDK_BUNDLE_DIR` points at nothing, or that binds a public interface
// with no shared secret, must EXIT rather than serve something broken. A gate
// that cannot go red is not a gate.
//
// Usage: node tools/verify-image.mjs <image-ref> [--keep]

import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const image = argv.find((a) => !a.startsWith('--'))
const keep = argv.includes('--keep')
if (!image) {
  console.error('usage: node tools/verify-image.mjs <image-ref> [--keep]')
  process.exit(2)
}

/** Unique-ish suffix so concurrent runs on one machine do not collide. */
const runId = `${process.pid}-${Date.now().toString(36)}`
const TOKEN = 'verify-image-' + runId

const failures = []
const checks = []

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`)
}

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, ...opts })
}

function startContainer(name, env = {}, extra = []) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const res = docker(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1:0:8080', ...envArgs, ...extra, image])
  if (res.status !== 0) {
    throw new Error(`docker run ${name} failed (${res.status}): ${res.stderr || res.stdout}`)
  }
  const portRes = docker(['port', name, '8080/tcp'])
  const port = /:(\d+)\s*$/.exec(portRes.stdout || '')?.[1]
  if (!port) throw new Error(`could not read the published port for ${name}: ${portRes.stdout}`)
  return `http://127.0.0.1:${port}`
}

/** Poll /health until the server answers, or give up. Returns the status. */
async function waitForHealth(base, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return 200
      last = `status ${res.status}`
    } catch (err) {
      last = err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code ?? err.message)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return last
}

async function status(base, path, headers = {}) {
  try {
    const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(15_000), redirect: 'manual' })
    return { code: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
  } catch (err) {
    return { code: 0, type: '', body: String(err.cause?.code ?? err.message) }
  }
}

function stop(name) {
  if (!keep) docker(['rm', '-f', name])
}

/** Run a container that must NOT stay up, and return its exit code + output. */
function expectExit(name, env, extra = []) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const res = docker(['run', '--rm', '--name', name, ...envArgs, ...extra, image], { timeout: 60_000 })
  return {
    code: res.status,
    // Docker exits the client with the container's code; a client-side timeout
    // leaves status null, which must not be mistaken for a clean refusal.
    output: `${res.stdout || ''}${res.stderr || ''}`.trim(),
  }
}

// ── Happy path ──────────────────────────────────────────────────────────────
console.log(`\n[verify-image] ${image}`)
console.log('\nserving image (HOST=0.0.0.0 + WEB_TOKEN):')

const main = `genoffice-verify-${runId}`
let base
try {
  base = startContainer(main, { WEB_TOKEN: TOKEN })
  const health = await waitForHealth(base)
  if (health !== 200) {
    throw new Error(`container never became healthy at ${base}/health (${health})`)
  }

  // The seven renderer bundles. The server routes /docs/, /sheets/, … into
  // `<app>/out/renderer/`; a missing one is a 404 for that editor, and the
  // startup check refuses to boot without all seven, so they are all asserted.
  for (const app of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell']) {
    const r = await status(base, `/${app}/`)
    check(`GET /${app}/ → 200`, r.code === 200, `got ${r.code}`)
  }

  // /favicon.ico is served from the shell app's build assets — proof that the
  // non-renderer assets travelled too. The route answers 204 when the icon is
  // absent, so require 200 specifically.
  const favicon = await status(base, '/favicon.ico')
  check('GET /favicon.ico → 200 (shell build assets travelled)', favicon.code === 200, `got ${favicon.code}`)

  // /static/sdk/* — the distribution channel Dataflarework loads the host
  // bridge from. This is the route that was 404 in every released image.
  for (const file of ['dataflare-host.umd.js', 'dataflare-guest.umd.js', 'index.mjs', 'index.cjs']) {
    const r = await status(base, `/static/sdk/${file}`)
    check(`GET /static/sdk/${file} → 200`, r.code === 200, `got ${r.code}`)
  }

  // The entry manifest travels with the bundles for the startup check's use;
  // it is not a distributable, and the allow-list is derived from it.
  for (const path of ['/static/sdk/sdk-entries.json', '/static/sdk/not-an-entry.mjs']) {
    const r = await status(base, path)
    check(`GET ${path} → 404 (not in the manifest-derived allow-list)`, r.code === 404, `got ${r.code}`)
  }

  // Auth posture. `/api/*` must be closed to anonymous callers once WEB_TOKEN
  // is armed — the image binds 0.0.0.0, so this is the difference between a
  // shared secret and an open AI-execution surface. A bogus path keeps the
  // assertion free of side effects: it is refused at the gate (401) before
  // routing could 404 it.
  const anon = await status(base, '/api/__verify_image__')
  check('GET /api/* anonymously → 401', anon.code === 401, `got ${anon.code}`)
  // A *wrong* secret must also be refused: presence of the header is not the
  // check, its value is. Without this arm a gate that only tested `header !=
  // undefined` would pass every other check here.
  const wrong = await status(base, '/api/__verify_image__', { 'x-genoffice-token': `${TOKEN}-not-it` })
  check('GET /api/* with a wrong secret → 401', wrong.code === 401, `got ${wrong.code}`)
  // And the right secret must get past the gate. Asserted as "not 401" rather
  // than "404": routing sends unknown paths to the SPA fallback, which serves
  // the shell's index.html with 200, so 404 is not what "unrouted" looks like
  // here. 401 vs anything-else is exactly the gate's contract.
  const authd = await status(base, '/api/__verify_image__', { 'x-genoffice-token': TOKEN })
  check('GET /api/* with the shared secret → past the gate (not 401)', authd.code !== 401, `got ${authd.code}`)
} catch (err) {
  check('container serves at all', false, String(err.message ?? err))
  if (!keep) {
    const logs = docker(['logs', main])
    if (logs.stdout || logs.stderr) console.error(`--- container logs ---\n${logs.stdout}${logs.stderr}`)
  }
} finally {
  stop(main)
}

// ── Prefix arm ──────────────────────────────────────────────────────────────
// The production topology mounts the server behind /office-engine. Routing is
// a property of the image too: WEB_PATH_PREFIX has to work in the same process
// that ships the bundles.
console.log('\nserving image behind WEB_PATH_PREFIX=/office-engine:')
const prefixed = `genoffice-verify-prefix-${runId}`
try {
  const pbase = startContainer(prefixed, { WEB_TOKEN: TOKEN, WEB_PATH_PREFIX: '/office-engine' })
  const health = await waitForHealth(pbase)
  if (health !== 200) throw new Error(`container never became healthy (${health})`)
  for (const app of ['docs', 'sheets']) {
    const r = await status(pbase, `/office-engine/${app}/`)
    check(`GET /office-engine/${app}/ → 200`, r.code === 200, `got ${r.code}`)
  }
  const embed = await status(pbase, `/office-engine/embed/d?token=${TOKEN}&app=docs`)
  check(
    'GET /office-engine/embed/d → 200 HTML',
    embed.code === 200 && embed.type.includes('text/html'),
    `got ${embed.code} ${embed.type}`,
  )
} catch (err) {
  check('prefixed container serves at all', false, String(err.message ?? err))
} finally {
  stop(prefixed)
}

// ── Destructive arms ────────────────────────────────────────────────────────
// These assert the image refuses to serve when its inputs are wrong. They are
// the reason this gate is worth running: a mis-wired path must be a startup
// failure, not a page of 404s discovered by a user.
console.log('\nrefusing to serve when misconfigured:')

{
  const { code, output } = expectExit(`genoffice-verify-badpath-${runId}`, {
    WEB_TOKEN: TOKEN,
    WEB_SDK_BUNDLE_DIR: '/app/this-path-does-not-exist',
  })
  check(
    'wrong WEB_SDK_BUNDLE_DIR → non-zero exit',
    code !== 0 && code !== null,
    code === null ? 'container did not exit (killed by timeout)' : `exit ${code}`,
  )
  check(
    'the refusal names the SDK path',
    output.includes('sdk') || output.includes('SDK'),
    output.split('\n').find((l) => l.includes('what:')) ?? 'no "what:" line in output',
  )
}

{
  const { code, output } = expectExit(`genoffice-verify-notoken-${runId}`, {
    HOST: '0.0.0.0',
    WEB_TOKEN: '',
  })
  check(
    'public bind with no WEB_TOKEN → non-zero exit',
    code !== 0 && code !== null,
    code === null ? 'container did not exit (killed by timeout)' : `exit ${code}`,
  )
  check(
    'the refusal names the auth posture',
    output.toLowerCase().includes('auth posture'),
    output.split('\n').find((l) => l.includes('what:')) ?? 'no "what:" line in output',
  )
}

// ── Report ──────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok).length
console.log(`\n[verify-image] ${checks.length - failed}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.error(`[verify-image] FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('[verify-image] the image serves every artefact it claims to.')

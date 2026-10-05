/**
 * Contract gate: build the SDK + web-server, boot a throwaway server on a
 * free port, and run `live-probe.mjs` against it.
 *
 *     npm run verify:sdk          # from the repo root
 *
 * Why this exists: the mocked unit tests once passed 410/410 while seven
 * SDK methods failed against a real server, because the mocks served a
 * payload shape the server never emits. Only a live probe catches that
 * class of contract drift, and until now there was no way to run one
 * without hand-starting a server on port 18081.
 *
 * The server is disposable: random free port, temp DATA_DIR, generated JWT
 * secret, killed + cleaned up on every exit path. Nothing here touches a
 * developer's running instance or their real data directory.
 *
 * Env knobs (all optional):
 *   PROBE_SKIP_BUILD=1   reuse the existing dist/ instead of rebuilding
 *   PROBE_VERBOSE=1      stream the child server's stdout/stderr
 *   PROBE_KEEP=1         leave the temp data dir in place for inspection
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sdkRoot = resolve(__dirname, '..')
const repoRoot = resolve(sdkRoot, '..', '..')
const serverBundle = join(repoRoot, 'apps', 'web-server', 'dist', 'bundle', 'index.js')

const HEALTH_TIMEOUT_MS = 20_000
/** Cap on a single child command (build steps). */
const BUILD_TIMEOUT_MS = 300_000

function run(command, args, opts = {}) {
  return new Promise((resolveProm, rejectProm) => {
    // `shell: true` is needed for `npm` on Windows, where npm is a .cmd shim.
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectProm(new Error(`${command} ${args.join(' ')} timed out after ${BUILD_TIMEOUT_MS}ms`))
    }, BUILD_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectProm(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolveProm()
      } else {
        const err = new Error(`${command} ${args.join(' ')} exited ${code}`)
        err.exitCode = code
        rejectProm(err)
      }
    })
  })
}

/**
 * Ask the kernel for an unused port by binding to :0 and reading it back.
 *
 * `PORT=0` is not usable here: `apps/web-server/src/common/paths.ts` computes
 * `Number(process.env.PORT) || 18081`, and `0` is falsy, so the server would
 * fall back to 18081 and collide with any concurrent run.
 *
 * There is an unavoidable TOCTOU window between close() and the child's
 * listen(); a lost race surfaces as the server failing its own health check,
 * and the retry below covers it.
 */
function reservePort() {
  return new Promise((resolveProm, rejectProm) => {
    const probe = createServer()
    probe.once('error', rejectProm)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolveProm(port))
    })
  })
}

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

/** HS256 JWT, matching `apps/web-server/tests/helpers/v1-smoke.ts#mintJwt`. */
function mintJwt(secret, sub, scope) {
  const now = Math.floor(Date.now() / 1000)
  const data = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ sub, scope, iat: now, exp: now + 3600, iss: 'genoffice', aud: 'genoffice-web' }),
  )}`
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`
}

async function waitForHealth(base, child, getLog) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`web-server exited early (code ${child.exitCode})\n${getLog()}`)
    }
    try {
      const res = await fetch(`${base}/api/v1/health`)
      if (res.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`web-server never became healthy at ${base} within ${HEALTH_TIMEOUT_MS}ms\n${getLog()}`)
}

let port = await reservePort()
const secret = randomBytes(32).toString('hex')
const dataDir = mkdtempSync(join(tmpdir(), 'genoffice-sdk-probe-'))
// Assigned by start() — the port can change on a retry, so this is not
// computed once up front.
let base = ''

let serverLog = ''
const keep = process.env.PROBE_KEEP === '1'
const verbose = process.env.PROBE_VERBOSE === '1'

const env = {
  ...process.env,
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  GENOFFICE_JWT_SECRET: secret,
  // DATA_DIR alone does not isolate translation. The KB resolves to
  // `~/.genoffice/translation-kb.json` unless this is set
  // (`knowledge-base.ts#defaultFilePath`), so without it the gate's result
  // depends on the developer's personal glossary: an entry that happens to
  // cover a probed term rewrites the output and flips the assertion. Passed
  // by the in-tree e2e suites for the same reason.
  GENOFFICE_TRANSLATION_KB: join(dataDir, 'translation-kb.json'),
}
// WEB_TOKEN is stripped to exercise the credential-free collab surface this
// file spawns a throwaway 127.0.0.1 server with a temp DATA_DIR for — the
// exact "local development" deployment GENOFFICE_ALLOW_OPEN exists for. Since
// the fail-closed auth posture (route-policy.ts: locked when WEB_TOKEN is
// unset) a bare strip alone answers 401 on every /api/ipc/* call and the
// collab section could never pass.
delete env.WEB_TOKEN
delete env.PROBE_BEARER
delete env.PROBE_BASE
env.GENOFFICE_ALLOW_OPEN = '1'

let server = null
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  if (server && server.exitCode === null) server.kill('SIGTERM')
  if (keep) {
    console.log(`\n[probe] temp data dir kept: ${dataDir}`)
    return
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // The child may still be flushing on the way out; a leftover temp dir
    // under the OS temp root is not worth failing the gate over.
  }
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup()
    process.exit(1)
  })
}

function start() {
  base = `http://127.0.0.1:${port}`
  env.PORT = String(port)
  server = spawn(process.execPath, [serverBundle], { cwd: dirname(serverBundle), env, stdio: ['ignore', 'pipe', 'pipe'] })
  const absorb = (chunk) => {
    const text = String(chunk)
    serverLog += text
    if (verbose) process.stdout.write(text)
  }
  server.stdout.on('data', absorb)
  server.stderr.on('data', absorb)
}

try {
  // 1. Fresh artifacts. The probe imports `apps/sdk/dist/*.mjs`, so a stale
  //    dist would test code that no longer exists — rebuild by default.
  if (process.env.PROBE_SKIP_BUILD !== '1') {
    console.log('[probe] building SDK …')
    await run('npm', ['run', 'build', '-w', '@genoffice/web-sdk'], { cwd: repoRoot })
    console.log('[probe] bundling web-server …')
    await run('npm', ['run', 'bundle:esbuild', '-w', '@genoffice/web-server'], { cwd: repoRoot })
  }
  if (!existsSync(serverBundle)) {
    throw new Error(
      `web-server bundle missing at ${serverBundle}\n  build it with: npm run build -w @genoffice/web-server`,
    )
  }

  start()
  try {
    await waitForHealth(base, server, () => serverLog)
  } catch (err) {
    // One retry: the only realistic failure is losing the port race.
    server.kill('SIGKILL')
    serverLog = ''
    port = await reservePort()
    console.log(`[probe] health check failed, retrying on port ${port} …`)
    start()
    await waitForHealth(base, server, () => serverLog)
  }
  console.log(`[probe] web-server healthy on ${base} (data dir ${dataDir})`)

  // 2. One token carrying every scope the v1 groups need: `files:read` +
  //    `files:write` for the embed bootstrap (the probe creates its own file
  //    because the JWT mint 404s for an unknown one), `ai:translate` for
  //    translation.
  const bearer = mintJwt(secret, 'sdk-probe', ['files:read', 'files:write', 'ai:translate'])

  console.log('[probe] running live-probe.mjs …\n')
  await run(process.execPath, [join(sdkRoot, 'scripts', 'live-probe.mjs')], {
    cwd: sdkRoot,
    env: { ...process.env, PROBE_BASE: base, PROBE_BEARER: bearer },
  })
  console.log('\n[probe] contract gate PASSED')
  cleanup()
  process.exit(0)
} catch (err) {
  cleanup()
  console.error(`\n[probe] contract gate FAILED\n${err?.message ?? err}`)
  if (!verbose && serverLog) {
    console.error('\n--- web-server log (tail) ---')
    console.error(serverLog.split('\n').slice(-40).join('\n'))
  }
  process.exit(typeof err?.exitCode === 'number' && err.exitCode > 0 ? err.exitCode : 1)
}

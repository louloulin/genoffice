/**
 * Boot-time self-checks.
 *
 * The web build is assembled from several independent build outputs: six app
 * renderer bundles, the server bundle, and the SDK bundles. When one of them
 * is missing — a fresh clone that never ran `build:all`, a container whose
 * COPY pointed at the wrong path, an SDK build that was skipped — the server
 * used to start anyway and answer 404, or serve a shell with no editor. That
 * is the "green locally, dead in the deployment" shape this project keeps
 * re-discovering (sdk1.md §11.125), so these checks turn it into a refusal to
 * start that names the missing artefact and the command that produces it.
 *
 * Fail-closed by design: `runStartupChecks()` prints every problem and calls
 * `process.exit(1)`. There is deliberately no "skip when absent" branch — a
 * missing artefact is always a broken build, never a supported configuration.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { APPS, HOST, SDK_BUNDLE_ROOT, STATIC_ROOT } from './paths'

/** One declared SDK entry, as written by `apps/sdk/scripts/build.mjs`. */
export interface SdkEntry {
  entry: string
  out: string
  umd: boolean
}

export interface StartupProblem {
  /** Short label for the thing that is wrong. */
  check: string
  detail: string
  /** The exact command or setting that fixes it. */
  fix: string
}

export const SDK_MANIFEST_FILENAME = 'sdk-entries.json'

/**
 * Read the SDK entry manifest that travels with the SDK bundles.
 *
 * Exported because `src/index.ts` derives its `/static/sdk/*` allow-list from
 * the same list: one source of truth instead of a hand-maintained regex that
 * silently 404s the moment an entry is added to the build.
 *
 * @throws Error when the manifest is missing or malformed — callers that can
 *   abort the boot should let `runStartupChecks()` do it; the route-level
 *   caller runs after the check has already passed.
 */
export function readSdkEntries(): SdkEntry[] {
  const path = join(SDK_BUNDLE_ROOT, SDK_MANIFEST_FILENAME)
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as { entries?: unknown }
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`${path} has no "entries" array`)
  }
  return parsed.entries.map((e) => {
    const entry = e as { entry?: unknown; out?: unknown; umd?: unknown }
    if (typeof entry.out !== 'string' || !entry.out) {
      throw new Error(`${path} contains an entry without a string "out"`)
    }
    return {
      entry: typeof entry.entry === 'string' ? entry.entry : '',
      out: entry.out,
      umd: entry.umd === true,
    }
  })
}

/** The filenames a declared entry is expected to have produced. */
export function sdkEntryFileNames(entry: SdkEntry): string[] {
  const files = [`${entry.out}.mjs`, `${entry.out}.cjs`]
  if (entry.umd) files.push(`${entry.out}.umd.js`)
  return files
}

/**
 * Every `/static/sdk/<file>` the server is willing to serve. Built from the
 * manifest so adding an entry to `apps/sdk/scripts/build.mjs` is enough.
 */
export function sdkServedFilenames(): Set<string> {
  const out = new Set<string>()
  for (const entry of readSdkEntries()) {
    for (const file of sdkEntryFileNames(entry)) out.add(file)
  }
  return out
}

/**
 * True for bind addresses that are only reachable from this machine. Anything
 * else (`0.0.0.0`, `::`, a LAN address, a hostname) means the server is
 * reachable by someone other than the operator, so the shared-secret gate in
 * `src/auth` has to be armed.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.')
}

/** Collect every problem that should stop the process from serving. */
export function collectStartupProblems(): StartupProblem[] {
  const problems: StartupProblem[] = []

  // 1. SDK bundles. Without these, `/static/sdk/*` — the distribution channel
  //    hosts use to mount the editor — answers 404 for every entry.
  let entries: SdkEntry[] | null = null
  try {
    entries = readSdkEntries()
  } catch (err) {
    problems.push({
      check: 'sdk manifest',
      detail: `${join(SDK_BUNDLE_ROOT, SDK_MANIFEST_FILENAME)} is missing or unreadable (${
        err instanceof Error ? err.message : String(err)
      })`,
      fix: 'pnpm --filter @genoffice/web-server bundle   (builds the SDK and stages it next to the server)',
    })
  }
  if (entries) {
    const missing = entries
      .flatMap(sdkEntryFileNames)
      .filter((file) => !existsSync(join(SDK_BUNDLE_ROOT, file)))
    if (missing.length > 0) {
      problems.push({
        check: 'sdk bundle files',
        detail: `${missing.length} declared SDK file(s) absent from ${SDK_BUNDLE_ROOT}: ${missing
          .slice(0, 6)
          .join(', ')}${missing.length > 6 ? ', …' : ''}`,
        fix: 'pnpm --filter @genoffice/web-server bundle   (or point WEB_SDK_BUNDLE_DIR at the staged SDK)',
      })
    }
  }

  // 2. Renderer bundles. A missing `index.html` is a routing 404 for that app;
  //    a missing sibling asset is a blank page.
  const missingApps = APPS.filter(
    (app) => !existsSync(resolve(STATIC_ROOT, app, 'out', 'renderer', 'index.html')),
  )
  if (missingApps.length > 0) {
    problems.push({
      check: 'renderer bundles',
      detail: `no out/renderer/index.html under ${STATIC_ROOT} for: ${missingApps.join(', ')}`,
      fix: `npm run build:all   (or point WEB_STATIC_ROOT at a directory holding <app>/out/renderer/)`,
    })
  }

  // 3. Auth posture. `isAuthorised` is open when WEB_TOKEN is unset, which is
  //    the right default for a loopback-only dev server and a wide-open door
  //    for anything reachable from the network.
  const token = process.env.WEB_TOKEN
  if (!isLoopbackHost(HOST) && (!token || token.length === 0)) {
    problems.push({
      check: 'auth posture',
      detail: `HOST=${HOST} is reachable from outside this machine but WEB_TOKEN is unset, so every IPC channel and AI endpoint is unauthenticated`,
      fix: 'set WEB_TOKEN=<random secret> (embed callers must send it as ?token=, the x-genoffice-token header, or a Bearer token), or bind HOST=127.0.0.1',
    })
  }

  return problems
}

/**
 * Refuse to serve when the build is incomplete or the bind is wide open.
 * Prints every problem with its fix, then exits non-zero.
 */
export function runStartupChecks(): void {
  const problems = collectStartupProblems()
  if (problems.length === 0) return
  const lines = [
    '',
    '╔═══════════════════════════════════════════════════════════╗',
    '║  genoffice web-server cannot start                        ║',
    '╚═══════════════════════════════════════════════════════════╝',
  ]
  for (const p of problems) {
    lines.push('', `✗ ${p.check}`, `  what: ${p.detail}`, `  fix:  ${p.fix}`)
  }
  lines.push('')
  console.error(lines.join('\n'))
  process.exit(1)
}

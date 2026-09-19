/**
 * Path containment regression test — two layers, because the bug had two
 * shapes.
 *
 * The bug: the web build has no Electron path-grant map, and the default `HOST`
 * binds every interface (`common/paths.ts`), so any renderer-supplied path given
 * to an IPC channel was used verbatim. `pdf:read-file ["/etc/passwd"]` returned
 * the password database as bytes; `home:delete-files` unlinked any path handed
 * to it; `html:save-file` wrote anywhere; `cloud:upload` escaped FILES_DIR by
 * giving its file a `../../` name. One bug class, a dozen channels.
 *
 * Layer 1 (`source scan`) is the net for channels that do not exist yet: a
 * handler that calls fs with one of its own parameters — or with a value
 * destructured out of a parameter — must also mention the guard. It is a
 * syntactic check on purpose: it cannot see through a helper such as
 * `statAttachment(p)` or a nested `forEach((path) => …)`, so it is a net for the
 * common shape, not a proof. Layer 2 is the proof.
 *
 * Layer 2 (`running bundle`) boots the real bundle against a temp `DATA_DIR` and
 * probes every path-taking channel with a canary file outside managed storage.
 * It asserts the canary is never disclosed and never mutated, that the
 * traversal-prone paths are refused, and — crucially — that a managed twin of
 * the same probe still works, so a blanket "refuse everything" cannot pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const SRC_DIR = join(__dirname, '..', 'src')
const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
const haveBundle = existsSync(bundle)

/** Marker in the canary; its appearance in a response means a real leak. */
const CANARY_MARKER = 'CANARY-SECRET-VALUE-3f9a1c'
/** Marker in the host file that the pre-fix code disclosed. */
const HOST_SECRET_MARKER = 'root:'

// ---------------------------------------------------------------------------
// Layer 1 — source scan
// ---------------------------------------------------------------------------

/** Every `.ts` file under `apps/web-server/src`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : []
  })
}

/** Text from the `(` after `registerHandle` to its matching `)`. */
function handlerBody(source: string, openParen: number): string {
  let depth = 0
  for (let i = openParen; i < source.length; i++) {
    const char = source[i]
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) return source.slice(openParen, i + 1)
    }
  }
  return source.slice(openParen)
}

/** Parameter names of the first arrow function in a handler body. */
function callbackParams(body: string): string[] {
  const match = body.match(/\(([^)]*)\)\s*=>/)
  if (!match) return []
  return match[1]
    .split(',')
    .map((param) => param.split(':')[0].split('=')[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
}

/** Names bound by destructuring one of `params`, e.g. `const { filePath } = args`. */
function destructuredFrom(body: string, params: string[]): string[] {
  const names: string[] = []
  for (const param of params) {
    const pattern = new RegExp(`const\\s*\\{([^}]*)\\}\\s*=[^;\\n]*\\b${param}\\b`, 'g')
    for (const match of body.matchAll(pattern)) {
      for (const binding of match[1].split(',')) {
        const name = binding.split(':')[0].split('=')[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
      }
    }
  }
  return names
}

const FS_CALLS = 'existsSync|readFileSync|writeFileSync|unlinkSync|renameSync|statSync|readdirSync|copyFileSync'

/** fs calls in `body` that take `name` directly as an argument. */
function unguardedCalls(body: string, name: string): string[] {
  const pattern = new RegExp(`\\b(${FS_CALLS})\\(\\s*${name}\\s*[,)]`, 'g')
  return [...body.matchAll(pattern)].map((match) => match[1])
}

/** True when `body` runs `name` through a containment check. */
function guarded(body: string, name: string): boolean {
  // Accepts the shared helpers and the per-app predicates built on them
  // (`isManagedDocPath`, `isManagedPdfPath`): docs and pdf wrap the shared
  // check with their own extension rule, and that is still a guard.
  return (
    new RegExp(`\\bis[A-Za-z]*Managed[A-Za-z]*Path\\(\\s*${name}\\s*\\)`).test(body) ||
    new RegExp(`requireManagedPath\\([^)]*\\b${name}\\b`).test(body)
  )
}

describe('every path-taking handler contains its renderer-supplied path', () => {
  it('mentions the guard wherever fs is called with a handler parameter', () => {
    const violations: string[] = []

    for (const file of sourceFiles(SRC_DIR)) {
      const source = readFileSync(file, 'utf8')
      for (const occurrence of source.matchAll(/registerHandle\(/g)) {
        const openParen = occurrence.index + occurrence[0].length - 1
        const body = handlerBody(source, openParen)
        const channel = body.match(/'([^']+)'/)?.[1] ?? '(dynamic channel)'
        const params = callbackParams(body)
        const untrusted = [...params, ...destructuredFrom(body, params)]

        for (const name of untrusted) {
          // `_event` and friends are never paths; skip names nothing calls fs with.
          const calls = unguardedCalls(body, name)
          if (calls.length === 0) continue
          if (guarded(body, name)) continue
          violations.push(
            `${file.slice(SRC_DIR.length + 1)} → ${channel}: ${calls.join(', ')}(${name}) without isManagedPath/requireManagedPath`,
          )
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('scans more than a handful of handlers, so the net is actually wired up', () => {
    // A silent no-op scan would make the test above vacuous: assert the scan
    // sees the real handler surface.
    let handlers = 0
    for (const file of sourceFiles(SRC_DIR)) {
      handlers += [...readFileSync(file, 'utf8').matchAll(/registerHandle\(/g)].length
    }
    expect(handlers).toBeGreaterThan(200)
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — the running bundle
// ---------------------------------------------------------------------------

/** Channels that take a renderer-supplied path and must refuse an outside one. */
const READ_PROBES: Array<[string, unknown[]]> = [
  ['pdf:read-file', ['OUTSIDE']],
  ['pdf:open-path', ['OUTSIDE']],
  ['workbook:open-path', ['OUTSIDE']],
  ['slides:open-path', ['OUTSIDE']],
  ['web:read-file-bytes', ['OUTSIDE']],
  ['files:add', [['OUTSIDE']]],
  ['files:read', ['OUTSIDE']],
  ['files:read-image', ['OUTSIDE']],
  ['preview:get', [{ filePath: 'OUTSIDE' }]],
  ['markdown:read-file', ['OUTSIDE']],
  ['md-asset', ['OUTSIDE', 'read']],
  ['anydoc:recognize', [{ filePath: 'OUTSIDE' }]],
  ['anydoc:convert', [{ filePath: 'OUTSIDE', targetFormat: 'pdf' }]],
  ['anydoc:extract-text', ['OUTSIDE']],
  ['anydoc:extract-tables', ['OUTSIDE']],
  ['anydoc:extract-images', ['OUTSIDE']],
  ['anydoc:render-preview', [{ filePath: 'OUTSIDE' }]],
  ['html:read-file', ['OUTSIDE']],
  ['html:files-add', [['OUTSIDE']]],
  ['html:files-read', ['OUTSIDE']],
  ['html:files-read-image', ['OUTSIDE']],
  ['slides:files-add', [['OUTSIDE']]],
  ['slides:files-read', ['OUTSIDE']],
  ['slides:files-read-image', ['OUTSIDE']],
  ['sheets:files-add', [['OUTSIDE']]],
  ['sheets:files-read', ['OUTSIDE']],
  ['sheets:files-read-image', ['OUTSIDE']],
  ['workbook:open-for-merge', [['OUTSIDE']]],
]

/** Channels where a broken guard would destroy the target, not just read it. */
const DESTRUCTIVE_PROBES: Array<[string, unknown[]]> = [
  ['html:save-file', ['OUTSIDE', 'PWNED']],
  ['home:delete-files', [['OUTSIDE']]],
  ['home:rename-file', ['OUTSIDE', 'renamed-by-probe']],
  ['home:duplicate-file', ['OUTSIDE']],
]

describe.skipIf(!haveBundle)('the running server refuses outside paths', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let filesDir: string
  let canary: string

  const invoke = async (channel: string, args: unknown[]) => {
    const response = await fetch(`${base}/api/ipc/${channel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    })
    return { status: response.status, text: await response.text() }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-guard-e2e-'))
    filesDir = join(dataDir, 'files')
    // The canary lives OUTSIDE managed storage and is what the destructive
    // probes target: a regression must not be able to damage a real host file
    // while the test is running.
    canary = join(dataDir, '..', `genoffice-canary-${process.pid}.txt`)
    writeFileSync(canary, `${CANARY_MARKER}\n`)

    const port = 24000 + Math.floor(Math.random() * 5000)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        GENOFFICE_DATA_DIR: dataDir,
        TMPDIR: join(dataDir, 'tmp'),
      },
      stdio: 'ignore',
    })

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${base}/health`)).ok) return
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('web-server did not become healthy')
  })

  afterAll(() => {
    server?.kill()
    rmSync(canary, { force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it.each(READ_PROBES)('%s does not disclose an outside file', async (channel, args) => {
    const resolved = JSON.parse(JSON.stringify(args).replace(/OUTSIDE/g, canary))
    const { text } = await invoke(channel, resolved)
    expect(text).not.toContain(CANARY_MARKER)
  })

  it.each(DESTRUCTIVE_PROBES)('%s does not mutate an outside file', async (channel, args) => {
    const resolved = JSON.parse(JSON.stringify(args).replace(/OUTSIDE/g, canary))
    await invoke(channel, resolved)
    expect(existsSync(canary)).toBe(true)
    expect(readFileSync(canary, 'utf8')).toContain(CANARY_MARKER)
  })

  it('does not disclose the host password database', async () => {
    // The empirical proof that opened this investigation. Read-only probe, so
    // using the real file here is safe.
    const { text } = await invoke('pdf:read-file', ['/etc/passwd'])
    expect(text).not.toContain(HOST_SECRET_MARKER)
  })

  it('refuses an outside path as a client error, not an unhandled throw', async () => {
    // docs:open-path already answered 400 before the fix; workbook:open-path and
    // slides:open-path answered 500 because the bad value reached fs and threw.
    // A rejected argument is a 400 on every channel now.
    for (const channel of ['pdf:read-file', 'workbook:open-path', 'slides:open-path', 'anydoc:recognize']) {
      const args = channel === 'pdf:read-file' ? [canary] : [{ filePath: canary }]
      const { status } = await invoke(channel, args)
      expect(`${channel}=${status}`).toBe(`${channel}=400`)
    }
  })

  it('cannot climb out of FILES_DIR through an upload file name', async () => {
    // `cloud:upload` built its stored name from the renderer-supplied `name`,
    // so `../../etc/pwn.txt` wrote above FILES_DIR.
    await invoke('cloud:upload', [
      { name: '../../escaped.txt', bytes: { __ipcBytes: 'ab', b64: Buffer.from('pwn').toString('base64') }, mimeType: 'text/plain' },
    ])
    expect(existsSync(join(dataDir, 'escaped.txt'))).toBe(false)
    expect(existsSync(join(resolve(dataDir, '..'), 'escaped.txt'))).toBe(false)
  })

  it('reports an unmanaged path as absent rather than probing it', async () => {
    const { text } = await invoke('home:stat-paths', [[canary, '/etc/passwd']])
    const entries = JSON.parse(text).result as Array<{ exists: boolean; size: number }>
    expect(entries.map((e) => e.exists)).toEqual([false, false])
    expect(entries.map((e) => e.size)).toEqual([0, 0])
  })

  it('still works for a path inside managed storage', async () => {
    // The falsification guard for this whole suite: a "refuse everything" fix
    // would pass every assertion above, so prove the guarded channels still do
    // their job on a legitimate path.
    const managed = join(filesDir, 'managed-twin.md')
    writeFileSync(managed, `${CANARY_MARKER} managed\n`)
    const read = await invoke('markdown:read-file', [managed])
    expect(read.status).toBe(200)
    expect(read.text).toContain(CANARY_MARKER)

    const stats = await invoke('home:stat-paths', [[managed]])
    expect(JSON.parse(stats.text).result[0].exists).toBe(true)

    // …and the same probe that was refused above still writes here.
    const saved = join(filesDir, 'managed-write.md')
    const write = await invoke('html:save-file', [saved, 'ok'])
    expect(write.status).toBe(200)
    expect(readFileSync(saved, 'utf8')).toBe('ok')

    const added = await invoke('files:add', [[managed]])
    const accepted = JSON.parse(added.text).result as Array<{ path?: string }>
    expect(accepted.length).toBe(1)
    expect(statSync(join(filesDir, accepted[0].path?.split('/').pop() ?? 'missing')).isFile()).toBe(true)
  })
})

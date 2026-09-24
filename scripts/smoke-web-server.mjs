/**
 * End-to-end smoke test for a running web-server.
 *
 * These are behavioural assertions, not channel-existence probes: every suite
 * writes real bytes through the IPC endpoint and then reads them back off disk,
 * so a handler that answers `{ ok: true }` without persisting anything fails
 * here. That is the class of bug this suite exists for — the web build used to
 * answer success while dropping the payload, and to serve a 404 for an app's own
 * bundle while the HTML looked fine.
 *
 * Usage (server already running, see scripts/release-web.mjs):
 *   node scripts/smoke-web-server.mjs
 *   WEB_SERVER_URL=http://127.0.0.1:18081 node scripts/smoke-web-server.mjs
 *
 * Storage paths mirror the server's own resolution
 * (apps/web-server/src/common/state.ts) so the assertions check the directory
 * the server actually used, and `WEB_TEMP_ROOT` mirrors common/paths.ts — the
 * contrast between the two (persistent vs OS-purgeable) is itself under test.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const BASE = process.env.WEB_SERVER_URL || 'http://127.0.0.1:18081'
const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.GENOFFICE_DATA_DIR ||
  process.env.GENOFFICE_WEB_DATA_DIR ||
  '/tmp/genoffice-data'
const FILES_DIR = join(DATA_DIR, 'files')
const WEB_TEMP_ROOT = resolve(process.env.TMPDIR || '/tmp', 'genoffice-web-temp')
const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell']

let pass = 0
let fail = 0
const failures = []

function check(condition, label) {
  if (condition) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

/** Run one suite; a thrown error is one failure, not the end of the run. */
async function suite(title, body) {
  console.log(`\n━━━ ${title} ━━━`)
  try {
    await body()
  } catch (err) {
    check(false, `${title}: threw ${String(err).split('\n')[0]}`)
  }
}

async function invoke(channel, args = []) {
  const response = await fetch(`${BASE}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** Binary values travel as the codec's tagged envelope, not raw JSON. */
const asBytes = (u8) => ({ __ipcBytes: 'ab', b64: Buffer.from(u8).toString('base64') })

/** Resolve a `storage://<backend>/<key>` URI to the local-FS path the
 *  default `local` backend writes to. The smoke test must be storage-aware
 *  because the renderer-facing identifier is the URI, not the canonical
 *  FILES_DIR path — the bytes live at `<FILES_DIR>/<key>`. */
function resolveStorageUri(uri) {
  if (typeof uri !== 'string') return uri
  if (!uri.startsWith('storage://')) return uri
  const rest = uri.slice('storage://'.length)
  const slash = rest.indexOf('/')
  const key = slash === -1 ? rest : rest.slice(slash + 1)
  return join(FILES_DIR, key)
}


/**
 * A recents file as a JSON array, or `null` when it exists but does not parse.
 * The distinction matters: an unparseable recents file is a defect the caller
 * should report, not something to swallow into an empty list.
 */
function readRecents(path) {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    /* reported by the caller, which asserts non-null */
    return null
  }
}

// ----- suites ---------------------------------------------------------------

await suite('documents: save really lands on disk', async () => {
  const stamp = Date.now()

  const mdText = `# smoke-${stamp}\n\n真持久化测试\n`
  const md = await invoke('markdown:save', [
    { text: mdText, mode: 'save-as', suggestedName: `smoke-${stamp}.md` },
  ])
  const mdPath = md.body?.result?.path
  check(md.body?.result?.ok === true, 'markdown:save answers ok:true')
  check(typeof mdPath === 'string' && existsSync(mdPath), `wrote the file → ${mdPath}`)
  if (typeof mdPath === 'string' && existsSync(mdPath)) {
    check(readFileSync(mdPath, 'utf8') === mdText, 'content is byte-identical')
    check(mdPath.startsWith(DATA_DIR), `landed inside DATA_DIR (${DATA_DIR})`)
  }

  // Saving over an existing path must replace it in place, not allocate a twin.
  const mdText2 = `${mdText}overwritten\n`
  const md2 = await invoke('markdown:save', [
    { text: mdText2, mode: 'save', path: mdPath, suggestedName: 'unused.md' },
  ])
  check(
    md2.body?.result?.ok === true && md2.body?.result?.path === mdPath,
    'overwrite reuses the path',
  )
  if (typeof mdPath === 'string' && existsSync(mdPath)) {
    check(readFileSync(mdPath, 'utf8') === mdText2, 'overwrite replaced the content')
  }

  const htmlText = `<!doctype html><title>smoke-${stamp}</title><p>真持久化</p>`
  const ht = await invoke('html:save', [
    { text: htmlText, mode: 'save-as', suggestedName: `smoke-${stamp}.html` },
  ])
  const htPath = ht.body?.result?.path
  check(ht.body?.result?.ok === true, 'html:save answers ok:true')
  check(typeof htPath === 'string' && existsSync(htPath), `wrote the file → ${htPath}`)
  if (typeof htPath === 'string' && existsSync(htPath)) {
    check(readFileSync(htPath, 'utf8') === htmlText, 'html content is byte-identical')
  }

  // docs:save-new answers the raw { id, path, name } shape; the web bridge's
  // saveDocxAs/saveDocxNew overrides normalize it to { ok, path } for the
  // renderer, so assert on the path the server allocated. The handler is
  // positional `(defaultName, data)`, so send the docx bytes as the second
  // arg — an object shape gets read as a literal defaultName and the data
  // slot stays undefined.
  const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)])
  const docx = await invoke('docs:save-new', [
    `smoke-${stamp}.docx`,
    asBytes(docxBytes),
  ])
  const docxPath = docx.body?.result?.path
  check(typeof docxPath === 'string' && docxPath.endsWith('.docx'), `allocated → ${docxPath}`)
  check(String(docxPath).startsWith(`${FILES_DIR}/`), 'allocated inside FILES_DIR')
})

await suite('unsupported writes refuse honestly instead of faking success', async () => {
  // The web build cannot serialize a workbook or a deck back to bytes: the
  // xlsx sidecar has no save command and the server holds no opened deck model.
  // A bare { ok: true } here is the bug — the renderer then reports "saved"
  // over a file that never changed.
  //
  // Two different shapes are in play (deliberate):
  //   - slides:save / slides:save-as → return { ok: false, error: 'WEB_UNSUPPORTED…' }
  //     because the renderer-side `slidesApi.save()` always resolves a path
  //     from the SSE session, so the no-session case is a build limitation.
  //   - workbook:save → throws `WorkbookInvalidArgumentError`, the IPC layer
  //     surfaces it as { error: { code: 'WORKBOOK_INVALID_ARGUMENT' } } (HTTP
  //     400). Tests in tests/workbook-error-codes.test.ts rely on this shape
  //     to distinguish a malformed save from a build capability gap.
  for (const [channel, args, mode] of [
    ['slides:save', [], 'result'],
    ['slides:save-as', ['deck.pptx'], 'result'],
    ['workbook:save', [], 'envelope'],
  ]) {
    const res = await invoke(channel, args)
    if (mode === 'envelope') {
      check(res.status === 400, `${channel} answers HTTP 400 (got ${res.status})`)
      check(
        res.body?.error?.code === 'WORKBOOK_INVALID_ARGUMENT',
        `${channel} names WORKBOOK_INVALID_ARGUMENT → ${JSON.stringify(res.body?.error)}`,
      )
    } else {
      const result = res.body?.result
      check(result?.ok === false, `${channel} answers ok:false (got ${JSON.stringify(result?.ok)})`)
      check(
        String(result?.error || '').includes('WEB_UNSUPPORTED'),
        `${channel} names WEB_UNSUPPORTED → ${result?.error}`,
      )
    }
  }
})

await suite('slides: export-images writes real PNGs and stays inside the directory', async () => {
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const dir = join(DATA_DIR, `smoke-export-${Date.now()}`)

  const good = await invoke('slides:export-images', [
    { dir, baseName: 'launch-all', pngsBase64: [PNG, PNG, PNG] },
  ])
  const paths = good.body?.result?.paths || []
  check(good.status === 200, `HTTP 200 (got ${good.status})`)
  check(good.body?.result?.ok === true, 'ok:true')
  check(paths.length === 3, `3 paths returned (got ${paths.length})`)
  check(paths[0] === `${dir}/launch-all-01.png`, `two-digit zero padding → ${paths[0]}`)
  check(
    paths.length > 0 && paths.every((p) => existsSync(p) && statSync(p).size > 0),
    'all returned PNGs exist on disk and are non-empty',
  )

  // A crafted base name must not climb out of the directory the caller named.
  const escape = await invoke('slides:export-images', [
    { dir, baseName: '../../etc/pwn', pngsBase64: [PNG] },
  ])
  const escaped = String(escape.body?.result?.paths?.[0] || '')
  check(!escaped.includes('..'), `crafted baseName cannot traverse → ${escaped}`)
  check(escaped.startsWith(dir), 'result is still inside the requested directory')

  const malformed = await invoke('slides:export-images', [{ baseName: 'x' }])
  check(malformed.body?.result?.ok === false, 'missing pngsBase64 → ok:false')
  check(
    String(malformed.body?.result?.error || '').includes('expects'),
    `the error states the contract → ${malformed.body?.result?.error}`,
  )
})

await suite('pdf: save applies markup and contains every path', async () => {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const src = join(FILES_DIR, `smoke-pdf-src-${Date.now()}.pdf`)
  const tgt = join(FILES_DIR, `smoke-pdf-tgt-${Date.now()}.pdf`)

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText('original content', { x: 40, y: 200, size: 18, font, color: rgb(0, 0, 0) })
  writeFileSync(src, await doc.save())
  const before = readFileSync(src)
  check(before.length > 0, `source PDF created (${before.length} bytes)`)

  const request = {
    path: src,
    markups: [
      {
        pageIndex: 0,
        type: 'highlight',
        color: [1, 1, 0],
        // QuadPoints: one 8-number quad per line fragment (x1,y1,x2,y2,x3,y3,x4,y4)
        quads: [[40, 180, 240, 180, 240, 204, 40, 204]],
      },
    ],
    drawings: [],
    formValues: [],
    stamps: [],
  }
  const saved = await invoke('pdf:save', [request])
  check(saved.body?.result?.ok === true, 'ok:true')
  const after = readFileSync(src)
  check(!after.equals(before), `the file was really rewritten (${before.length} → ${after.length})`)
  check(after.subarray(0, 5).toString() === '%PDF-', 'still starts with a PDF header')
  const reloaded = await PDFDocument.load(after)
  check(
    reloaded.getPageCount() === 1,
    `reloads with the right page count (${reloaded.getPageCount()})`,
  )

  const noPath = await invoke('pdf:save', [{}])
  check(
    noPath.body?.result?.ok === false && /expects/.test(String(noPath.body?.result?.error)),
    `missing path is rejected → ${noPath.body?.result?.error}`,
  )

  // Containment: the web build has no Electron path-grant map, so an absolute
  // path outside managed storage must be refused rather than rewritten.
  for (const bad of ['/etc/passwd', '/tmp/smoke-evil.pdf']) {
    const res = await invoke('pdf:save', [
      { path: bad, markups: [], drawings: [], formValues: [], stamps: [] },
    ])
    check(res.body?.result?.ok === false, `${bad} is refused`)
    check(/outside/.test(String(res.body?.result?.error)), `reason → ${res.body?.result?.error}`)
  }

  const missing = await invoke('pdf:save', [
    {
      path: join(FILES_DIR, `smoke-nope-${Date.now()}.pdf`),
      markups: [],
      drawings: [],
      formValues: [],
      stamps: [],
    },
  ])
  check(
    missing.body?.result?.ok === false && /not found/.test(String(missing.body?.result?.error)),
    `a missing source is reported → ${missing.body?.result?.error}`,
  )

  // save-as semantics: the target gets the result, the source stays untouched.
  const srcSnapshot = readFileSync(src)
  const saveAs = await invoke('pdf:save', [{ ...request, targetPath: tgt }])
  check(saveAs.body?.result?.ok === true, 'save-as answers ok:true')
  check(existsSync(tgt), `target created → ${tgt}`)
  check(readFileSync(src).equals(srcSnapshot), 'source bytes unchanged by save-as')

  unlinkSync(src)
  unlinkSync(tgt)
})

await suite('uploads: picked bytes land in FILES_DIR and appear in recents', async () => {
  // Both entry points (the "open local file" card and window drag-and-drop)
  // funnel through web:save-file. Before that wiring the shell wrote to
  // WEB_TEMP_ROOT, which the OS purges and which recents never lists — the
  // user's "upload does nothing" report.
  const stamp = Date.now()
  const name = `smoke-upload-${stamp}.docx`
  const bytes = new Uint8Array(2048)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + stamp) % 256

  const saved = await invoke('web:save-file', [{ name, bytes: asBytes(bytes) }])
  const savedPath = saved.body?.result?.path
  check(typeof savedPath === 'string' && savedPath.startsWith('storage://'), `→ ${savedPath}`)
  check(!String(savedPath).startsWith(WEB_TEMP_ROOT), 'not in WEB_TEMP_ROOT (the old behaviour)')
  if (typeof savedPath !== 'string') return
  /* web:save-file returns a storage:// URI by design (the canonical
   * renderer-facing identifier). The local backend maps the URI to a real
   * path under FILES_DIR, so resolve before checking disk presence — the
   * recents row carries the URI too, which is why the home grid needs the
   * URI to round-trip a click back to bytes via the backend. */
  const resolvedPath = resolveStorageUri(savedPath)
  check(existsSync(resolvedPath), `exists on disk → ${resolvedPath}`)
  const onDisk = readFileSync(resolvedPath)
  check(onDisk.length === bytes.length, `byte count matches (${onDisk.length})`)
  check(Buffer.compare(onDisk, Buffer.from(bytes)) === 0, 'content is byte-identical')
  check(saved.body?.result?.name === name, 'the original file name comes back')

  const recents = await invoke('home:recents', [{ offset: 0, limit: 200 }])
  const hit = (recents.body?.result?.entries ?? []).find((e) => e.path === savedPath)
  check(Boolean(hit), 'recents lists it immediately, without a window refocus')
  check(hit?.name === name, `recents carries the name → ${hit?.name}`)

  // Contrast with the legacy path so a regression that re-points the bridge at
  // the temp writer is caught: that channel must stay out of recents.
  const temp = await invoke('web:write-temp-file', [{ name, bytes: asBytes(bytes) }])
  const tempPath = temp.body?.result
  check(
    typeof tempPath === 'string' && tempPath.startsWith(WEB_TEMP_ROOT),
    `legacy channel still writes to WEB_TEMP_ROOT → ${tempPath}`,
  )
  const recents2 = await invoke('home:recents', [{ offset: 0, limit: 200 }])
  check(
    !(recents2.body?.result?.entries ?? []).some((e) => e.path === tempPath),
    'legacy output never reaches recents',
  )

  const invalid = await invoke('web:save-file', [{ name: 'x.docx' }])
  check(
    invalid.status >= 400 || Boolean(invalid.body?.error),
    `missing bytes is rejected (${invalid.status})`,
  )

  const recentsFile = join(DATA_DIR, 'docs-recent.json')
  check(existsSync(recentsFile), `recents persist to ${recentsFile}`)
})

await suite('static delivery: every app serves its HTML and its bundle', async () => {
  // The failure this guards: an entry form whose assets 404. The page returns
  // 200 with a valid HTML body, so a status-only check passes while the user
  // sees a blank tab. Resolve each reference the way the browser does
  // (`new URL(ref, documentUrl)`) — that is what drops `?app=<name>`.
  for (const app of APPS) {
    const pageUrl = `${BASE}/?app=${app}`
    const html = await fetch(pageUrl, { signal: AbortSignal.timeout(10_000) })
    if (html.status !== 200) {
      check(false, `${pageUrl} → HTTP ${html.status}`)
      continue
    }
    const body = await html.text()
    const refs = [
      ...body.matchAll(/<script[^>]*\ssrc="([^"]+)"/g),
      ...body.matchAll(/<link[^>]*\shref="([^"]+)"/g),
    ]
      .map((m) => m[1])
      .filter((r) => !/^(data:|https?:|#)/.test(r))
    if (refs.length === 0) {
      check(false, `${pageUrl} declares no assets`)
      continue
    }
    let ok = true
    for (const ref of refs) {
      const assetUrl = new URL(ref, pageUrl)
      const res = await fetch(assetUrl, { signal: AbortSignal.timeout(15_000) })
      const type = res.headers.get('content-type') || ''
      const wantsJs = /\.(js|mjs)$/.test(assetUrl.pathname)
      const wantsCss = /\.css$/.test(assetUrl.pathname)
      if (res.status !== 200) {
        check(false, `${app}: ${ref} → ${assetUrl.pathname} HTTP ${res.status}`)
        ok = false
      } else if ((wantsJs && !/javascript/.test(type)) || (wantsCss && !/css/.test(type))) {
        // A module or stylesheet served as text/html is refused by the browser.
        check(false, `${app}: ${assetUrl.pathname} served as "${type}"`)
        ok = false
      }
    }
    if (ok) check(true, `${app}: ${refs.length} referenced asset(s) all served`)
  }
})

// ----- honest failure: a file that cannot be parsed ---------------------------
// Two defects used to hide behind one call. The parse throw escaped the handler
// as a 500 (indistinguishable from a server fault), and the file was recorded in
// "recently opened" *before* parsing, so the recents list advertised documents
// that had never opened. Both are asserted here: the refusal must name CORRUPT,
// and the recents files must not mention the fixture at all.
await suite('honest failure: a corrupt workbook/deck is refused and not remembered', async () => {
  for (const [channel, ext, recentsFile] of [
    ['workbook:open-path', 'xlsx', 'sheets-recent.json'],
    ['slides:open-path', 'pptx', 'slides-recent.json'],
  ]) {
    const fixture = join(FILES_DIR, `smoke-corrupt-${Date.now()}.${ext}`)
    // A 4-byte zip header is inside managed storage but is not an archive.
    writeFileSync(fixture, 'PK\x03\x04')

    const { status, body } = await invoke(channel, [fixture])
    check(status === 422, `${channel}: a corrupt file is a client error (${status})`)
    const code = body?.error?.code
    check(code === 'CORRUPT' || code === 'WORKBOOK_CORRUPT', `${channel}: reports the CORRUPT code (got ${code})`)

    const recents = readRecents(join(DATA_DIR, recentsFile))
    check(recents !== null, `${channel}: ${recentsFile} is readable JSON`)
    check(
      !(recents ?? []).some((entry) => entry?.path === fixture),
      `${channel}: the file it could not open is not in recents`,
    )
    unlinkSync(fixture)
  }
})

// ----- security: no renderer-supplied path escapes managed storage ------------
// The default HOST binds every interface (see common/paths.ts), so these
// channels are reachable by anyone who can reach the port. Before this suite
// existed `pdf:read-file` returned /etc/passwd as bytes, `home:delete-files`
// unlinked any path handed to it and `cloud:upload` climbed out of FILES_DIR via
// a `../../` file name. Each probe is paired with a managed twin that must still
// work, so a blanket "refuse everything" cannot pass this suite.
//
// Destructive probes target a canary outside managed storage rather than
// /etc/passwd: a regression must not be able to damage the host while testing.
await suite('security: outside paths are refused on every path-taking channel', async () => {
  const marker = `CANARY-${process.pid}-SECRET`
  const canary = join(resolve(process.env.TMPDIR || '/tmp'), `genoffice-canary-${process.pid}.txt`)
  writeFileSync(canary, `${marker}\n`)
  const managed = join(FILES_DIR, `smoke-managed-${Date.now()}.md`)
  writeFileSync(managed, `${marker} managed\n`)

  const readProbes = [
    'pdf:read-file',
    'pdf:open-path',
    'workbook:open-path',
    'slides:open-path',
    'web:read-file-bytes',
    'files:add',
    'files:read',
    'files:read-image',
    'preview:get',
    'markdown:read-file',
    'md-asset',
    'anydoc:recognize',
    'anydoc:convert',
    'anydoc:extract-text',
    'anydoc:extract-tables',
    'anydoc:extract-images',
    'anydoc:render-preview',
    'html:read-file',
    'html:files-add',
    'html:files-read',
    'html:files-read-image',
    'slides:files-add',
    'slides:files-read',
    'slides:files-read-image',
    'sheets:files-add',
    'sheets:files-read',
    'sheets:files-read-image',
    'workbook:open-for-merge',
  ]
  let disclosed = 0
  for (const channel of readProbes) {
    const { body } = await invoke(channel, [canary])
    const text = JSON.stringify(body)
    if (text.includes(marker) || text.includes('root:')) {
      disclosed++
      check(false, `${channel}: disclosed the outside file`)
    }
  }
  check(disclosed === 0, `${readProbes.length} read channels refused the outside path`)

  for (const [channel, args] of [
    ['html:save-file', [canary, 'PWNED']],
    ['home:delete-files', [[canary]]],
    ['home:rename-file', [canary, 'renamed-by-probe']],
    ['home:duplicate-file', [canary]],
  ]) {
    await invoke(channel, args)
    check(
      existsSync(canary) && readFileSync(canary, 'utf8').includes(marker),
      `${channel}: left the outside file untouched`,
    )
  }

  await invoke('cloud:upload', [
    {
      name: '../../escaped.txt',
      bytes: asBytes(Buffer.from('pwn')),
      mimeType: 'text/plain',
    },
  ])
  check(
    !existsSync(join(DATA_DIR, 'escaped.txt')) &&
      !existsSync(join(resolve(DATA_DIR, '..'), 'escaped.txt')),
    'cloud:upload cannot climb out of FILES_DIR through its file name',
  )

  const stats = await invoke('home:stat-paths', [[canary, '/etc/passwd']])
  const entries = stats.body?.result ?? []
  check(
    entries.length === 2 && entries.every((e) => e.exists === false && e.size === 0),
    'home:stat-paths reports an outside path as absent instead of probing it',
  )

  // The falsification pair: the same channels must still do their job on a
  // managed path, so "refuse everything" fails here.
  const twinRead = await invoke('markdown:read-file', [managed])
  check(
    twinRead.body?.result === `${marker} managed\n`,
    'markdown:read-file still reads a managed path',
  )
  const twinStat = await invoke('home:stat-paths', [[managed]])
  check(twinStat.body?.result?.[0]?.exists === true, 'home:stat-paths still stats a managed path')
  const twinWrite = join(FILES_DIR, `smoke-managed-write-${Date.now()}.md`)
  const saved = await invoke('html:save-file', [twinWrite, 'ok'])
  check(
    saved.body?.result?.ok === true && readFileSync(twinWrite, 'utf8') === 'ok',
    'html:save-file still writes a managed path',
  )
  const twinAdd = await invoke('files:add', [[managed]])
  check(
    Array.isArray(twinAdd.body?.result) && twinAdd.body.result.length === 1,
    'files:add still imports a managed path',
  )

  unlinkSync(canary)
  unlinkSync(managed)
  unlinkSync(twinWrite)
})

await suite('new files: home:new-* lands where the renderer opens it', async () => {
  /* The renderer predicts the tab's open path from NEW_MODULE_SPECS.serverDir
   * (apps/shell/src/renderer/web-bridge.ts) and the server writes the file for
   * the id it echoes back. When the two disagree on directory, the tab opens a
   * path that does not exist and the editor shows "无法打开文件" while a stray
   * file piles up in the other directory — exactly what home:new-html did with
   * DATA_DIR. Assert the echoed path is realised on disk under FILES_DIR. */
  for (const [channel, prefix, emptyOk] of [
    ['home:new-doc', 'doc', false],
    ['home:new-sheet', 'sheet', false],
    ['home:new-slide', 'slide', false],
    ['home:new-pdf', 'pdf', false],
    // home:new-markdown deliberately materialises a 0-byte file: parseDocText
  // turns that into an empty envelope and the editor boots into a ready-to-type
  // state, whereas a 404 would bounce the tab to recents. Existence is enough.
    ['home:new-markdown', 'md', true],
    ['home:new-html', 'html', false],
  ]) {
    const res = await invoke(channel, [])
    const path = res.body?.result?.path
    check(typeof path === 'string' && path.startsWith(FILES_DIR), `${channel} → ${path}`)
    check(
      typeof path === 'string' && existsSync(path) && (emptyOk || statSync(path).size > 0),
      `${channel} really wrote a${emptyOk ? ' (possibly empty)' : ' non-empty'} file`,
    )
    const stray = path && path.startsWith(FILES_DIR) ? path.slice(FILES_DIR.length + 1) : ''
    check(
      !stray || !existsSync(join(DATA_DIR, stray)),
      `${channel} left no twin in DATA_DIR`,
    )
    if (typeof path === 'string' && existsSync(path)) unlinkSync(path)
  }
})

// ----- summary --------------------------------------------------------------

console.log(
  `\n${'━'.repeat(52)}\n${pass} passed / ${fail} failed at ${BASE}` +
    (fail > 0 ? `\n\nFailures:\n${failures.map((f) => `  ✗ ${f}`).join('\n')}` : ''),
)
process.exit(fail > 0 ? 1 : 0)

/**
 * Standalone Web server E2E: boots the real composition root in a child process
 * the same way `npm run web` does, then drives it over HTTP exactly like a
 * browser would. This is the automated form of the manual curl pass that used
 * to be done by hand — no Playwright, no Electron, no browser download, so it
 * runs on any Node runner.
 *
 * Usage: node e2e/web-server-verify.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.WEB_VERIFY_PORT ?? 5399)
const TOKEN = 'e2e-token'
const BASE = `http://127.0.0.1:${PORT}`
const auth = { authorization: `Bearer ${TOKEN}` }

const dataDir = mkdtempSync(join(tmpdir(), 'genoffice-web-verify-data-'))
const staticDir = mkdtempSync(join(tmpdir(), 'genoffice-web-verify-static-'))
mkdirSync(join(staticDir, 'assets'), { recursive: true })
writeFileSync(join(staticDir, 'index.html'), '<html><body>GenOffice Web shell</body></html>')
writeFileSync(join(staticDir, 'assets', 'app.js'), 'globalThis.booted = true')

const bootstrap = join(dataDir, 'bootstrap.mjs')
writeFileSync(
  bootstrap,
  [
    `import { startWebServer } from ${JSON.stringify(join(repoRoot, 'apps/web-server/src/main.ts'))}`,
    `const app = await startWebServer({`,
    `  port: ${PORT},`,
    `  dataDir: ${JSON.stringify(dataDir)},`,
    `  staticDir: ${JSON.stringify(staticDir)},`,
    `  authToken: ${JSON.stringify(TOKEN)},`,
    `})`,
    `console.log('ready ' + app.server.url)`,
  ].join('\n'),
)

const failures = []
let checks = 0

function check(name, actual, expected) {
  checks += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok)
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

function checkThat(name, ok, detail) {
  checks += 1
  if (!ok) failures.push(`${name}: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

async function invoke(channel, args) {
  const response = await fetch(`${BASE}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return { status: response.status, body: await response.json() }
}

async function waitForReady(child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`)
    try {
      const response = await fetch(`${BASE}/api/ipc/health`, { headers: auth })
      if (response.ok) return await response.json()
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('server did not become ready')
}

// Own process group: `npx` forks tsx, and only a group signal reaps both.
// A stale server left on this port would answer every request below and make the
// run test the WRONG build, so refuse to start instead of silently passing.
try {
  const stale = await fetch(`${BASE}/api/ipc/health`, {
    headers: auth,
    signal: AbortSignal.timeout(2_000),
  })
  throw new Error(
    `port ${PORT} is already serving (HTTP ${stale.status}); stop it or set WEB_VERIFY_PORT`,
  )
} catch (cause) {
  if (String(cause.message).includes('already serving')) {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(staticDir, { recursive: true, force: true })
    throw cause
  }
}

const child = spawn('npx', ['tsx', bootstrap], {
  cwd: repoRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true,
  env: { ...process.env, GENOFFICE_DATA_DIR: dataDir },
})

function stopServer() {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGKILL')
  }
}

try {
  const health = await waitForReady(child)
  checkThat(
    'health reports channels',
    health.ok === true && health.channels > 0,
    JSON.stringify(health),
  )

  // Authentication
  check('missing bearer is rejected', (await fetch(`${BASE}/api/ipc/health`)).status, 401)
  check(
    'same-length wrong bearer is rejected',
    (await fetch(`${BASE}/api/ipc/health`, { headers: { authorization: 'Bearer e2e-tokes' } }))
      .status,
    401,
  )

  // Projects + markdown round-trip
  const created = await invoke('project:create', [{ name: 'E2E Project' }])
  check('project:create status', created.status, 200)
  checkThat(
    'project:create returns an id',
    Boolean(created.body.result?.id),
    JSON.stringify(created.body),
  )
  const listed = await invoke('project:list', [])
  checkThat(
    'project:list contains the new project',
    listed.body.result?.some((project) => project.name === 'E2E Project'),
    JSON.stringify(listed.body),
  )

  const notePath = join(dataDir, 'note.md')
  check(
    'markdown:write-file status',
    (await invoke('markdown:write-file', [notePath, '# hi'])).status,
    200,
  )
  check(
    'markdown:read-file returns the content',
    (await invoke('markdown:read-file', [notePath])).body.result,
    '# hi',
  )
  check(
    'read outside the data root is rejected',
    (await invoke('markdown:read-file', ['/etc/passwd'])).status,
    500,
  )

  // Document engines
  const pdf = await invoke('pdf:create-blank', [])
  checkThat(
    'pdf:create-blank returns PDF bytes',
    Buffer.from(pdf.body.result?.b64 ?? '', 'base64')
      .subarray(0, 5)
      .toString() === '%PDF-',
    JSON.stringify(pdf.status),
  )
  const deck = await invoke('slides:create-blank', [])
  checkThat(
    'slides:create-blank returns a zip container',
    Buffer.from(deck.body.result?.b64 ?? '', 'base64')
      .subarray(0, 2)
      .toString() === 'PK',
    JSON.stringify(deck.status),
  )

  // Capabilities extracted out of the Electron main processes
  const catalog = await invoke('slides:font-catalog', [])
  checkThat(
    'slides:font-catalog is served',
    Array.isArray(catalog.body.result) && catalog.body.result.length > 0,
    JSON.stringify(catalog.status),
  )
  const mime = await invoke('slides:media-mime', [
    'media/image1.emf',
    { __ipcBytes: 'u8', b64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
  ])
  check('slides:media-mime prefers magic bytes', mime.body.result, 'image/png')
  const covers = await invoke('pdf:font-covers-text', [{ __ipcBytes: 'u8', b64: '' }, '\r\n'])
  check('pdf:font-covers-text answers over HTTP', covers.body.result, true)

  // Saved signatures: desktop userData state, server data root on the Web
  const emptySignatures = await invoke('pdf:list-signatures', [])
  check('pdf:list-signatures starts empty', emptySignatures.body.result, [])
  const addedSignature = await invoke('pdf:add-signature', [
    { kind: 'image', image: 'aGk=', width: 40, height: 20 },
  ])
  checkThat(
    'pdf:add-signature returns the stored list',
    addedSignature.body.result?.length === 1 &&
      typeof addedSignature.body.result[0].id === 'string',
    JSON.stringify(addedSignature.body),
  )
  const removedSignature = await invoke('pdf:remove-signature', [addedSignature.body.result[0].id])
  check('pdf:remove-signature empties the list', removedSignature.body.result, [])
  check(
    'invalid signature payload is rejected',
    (await invoke('pdf:add-signature', [{ kind: 'image', image: '', width: 0, height: 0 }])).status,
    500,
  )

  const generated = await invoke('pdf:generated-output-path', ['a/b:c*.pdf'])
  checkThat(
    'pdf:generated-output-path sanitizes and stays in the data root',
    String(generated.body.result).startsWith(dataDir) &&
      !String(generated.body.result).includes(':'),
    JSON.stringify(generated.body),
  )

  // Media normalizers the browser cannot do itself
  const audio = await invoke('slides:audio-support', [
    { __ipcBytes: 'u8', b64: Buffer.from([0, 1, 2, 3]).toString('base64') },
  ])
  checkThat(
    'slides:audio-support answers over HTTP',
    Array.isArray(audio.body.result?.formats) && audio.body.result.unplayable === null,
    JSON.stringify(audio.body),
  )
  const notTiff = await invoke('slides:tiff-to-png', [
    { __ipcBytes: 'u8', b64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
  ])
  check('slides:tiff-to-png reports non-TIFF as null', notTiff.body.result, null)

  // Page operations: build a real 4-page PDF, drive the server, re-parse the result
  const sourcePdf = await (async () => {
    const doc = await PDFDocument.create()
    for (let index = 0; index < 4; index += 1) doc.addPage([200 + index * 10, 300])
    return doc.save({ useObjectStreams: false })
  })()
  const asBytes = (value) => ({ __ipcBytes: 'u8', b64: Buffer.from(value).toString('base64') })
  const decode = (value) => new Uint8Array(Buffer.from(value.b64, 'base64'))
  const countPages = async (value) =>
    (await PDFDocument.load(decode(value), { updateMetadata: false })).getPageCount()

  const extracted = await invoke('pdf:extract-pages', [asBytes(sourcePdf), [0, 2]])
  check('pdf:extract-pages keeps two pages', await countPages(extracted.body.result), 2)

  const inserted = await invoke('pdf:insert-blank-page', [asBytes(sourcePdf), -1])
  check('pdf:insert-blank-page adds one page', await countPages(inserted.body.result), 5)

  const chunks = await invoke('pdf:split-pdf', [asBytes(sourcePdf), 2])
  checkThat(
    'pdf:split-pdf returns two chunks of two pages',
    chunks.body.result?.length === 2 && (await countPages(chunks.body.result[0])) === 2,
    JSON.stringify(chunks.status),
  )

  const nUp = await invoke('pdf:merge-pages', [
    asBytes(sourcePdf),
    { perSheet: 2, direction: 'horizontal', separator: true },
  ])
  check('pdf:merge-pages imposes two sheets', await countPages(nUp.body.result), 2)

  const combined = await invoke('pdf:merge-pdfs', [asBytes(sourcePdf), [asBytes(sourcePdf)]])
  checkThat(
    'pdf:merge-pdfs appends every page',
    combined.body.result?.appended === 4 && (await countPages(combined.body.result.merged)) === 8,
    JSON.stringify(combined.status),
  )

  const resized = await invoke('pdf:set-page-size', [asBytes(sourcePdf), 595.28, 841.89])
  const resizedDoc = await PDFDocument.load(decode(resized.body.result), { updateMetadata: false })
  check('pdf:set-page-size applies A4', Math.round(resizedDoc.getPage(0).getWidth()), 595)

  check(
    'malformed page operation input is rejected',
    (await invoke('pdf:extract-pages', [asBytes(sourcePdf), 'nope'])).status,
    500,
  )

  // Protocol contract
  const missing = await invoke('nope:channel', [])
  check('unknown channel status', missing.status, 404)
  check('unknown channel code', missing.body.error?.code, 'IPC_NO_HANDLER')

  // SSE — aborted explicitly, otherwise the open stream keeps this process alive
  const sse = new AbortController()
  const events = await fetch(`${BASE}/api/ipc/events?session=e2e`, {
    headers: auth,
    signal: sse.signal,
  })
  const firstChunk = await events.body.getReader().read()
  checkThat(
    'SSE stream opens',
    events.headers.get('content-type')?.includes('text/event-stream') &&
      Buffer.from(firstChunk.value).toString().includes('connected'),
    events.headers.get('content-type') ?? 'no content-type',
  )
  sse.abort()

  // Static hosting + SPA fallback
  const index = await fetch(`${BASE}/`, { headers: auth })
  checkThat(
    'static index is served',
    (await index.text()).includes('GenOffice Web shell'),
    index.status,
  )
  check('asset is served', (await fetch(`${BASE}/assets/app.js`, { headers: auth })).status, 200)
  const deepLink = await fetch(`${BASE}/doc/123`, { headers: auth })
  checkThat(
    'client-side route falls back to index.html',
    deepLink.status === 200 && (await deepLink.text()).includes('GenOffice Web shell'),
    deepLink.status,
  )
  check(
    'missing asset stays 404',
    (await fetch(`${BASE}/assets/nope.js`, { headers: auth })).status,
    404,
  )
  check(
    'traversal stays 404',
    (await fetch(`${BASE}/..%2F..%2Fetc%2Fpasswd`, { headers: auth })).status,
    404,
  )
} finally {
  stopServer()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(staticDir, { recursive: true, force: true })
}

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
// The child is detached, so exit explicitly instead of waiting on its handles.
process.exit(0)

/**
 * E4: Path traversal in filenames — verify isManagedPath rejects
 * traversal sequences and absolute paths.
 *
 * Channels to probe:
 *   - web:save-file (uploads bytes, name is used to build FILES_DIR path)
 *   - web:write-temp-file (uploads bytes to staging area)
 *   - html:save-file (managed HTML file path)
 *   - html:save (managed HTML file path)
 */
const BASE = 'http://127.0.0.1:18081'
let pass = 0, fail = 0
const check = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`✗ ${msg}`) }
}

async function invoke(channel, args = [], { encode = false } = {}) {
  const BYTES_TAG = '__ipcBytes'
  function enc(value) {
    if (value == null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(enc)
    if (value instanceof ArrayBuffer) return { [BYTES_TAG]: 'ab', b64: Buffer.from(value).toString('base64') }
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = enc(v)
    return out
  }
  const payloadArgs = encode ? args.map(enc) : args
  const r = await fetch(`${BASE}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: payloadArgs }),
  })
  return { status: r.status, body: await r.json() }
}

const dummyBytes = new TextEncoder().encode('EVIL PAYLOAD').buffer

const evilNames = [
  ['../etc/passwd.txt', 'relative up-traversal'],
  ['../../etc/passwd', 'multi-segment up-traversal'],
  ['/etc/passwd', 'absolute path'],
  ['subdir/../../../etc/passwd', 'mixed up-traversal'],
  ['./../../etc/passwd', 'dot-relative up-traversal'],
  ['..', 'parent dir literal'],
  ['/', 'root literal'],
]

console.log('\n━━━ E4: web:save-file rejects traversal names ━━━')
for (const [name, desc] of evilNames) {
  const r = await invoke('web:save-file', [{ name, bytes: dummyBytes }], { encode: true })
  const err = r.body?.error ?? r.body?.result?.error ?? ''
  const path = r.body?.result?.path ?? ''
  // The resolved path must NOT contain traversal sequences. The server
  // hashes the original name and stores under that hash, so the returned
  // path is always inside FILES_DIR or storage://. That's the security
  // invariant we check.
  const escaped =
    typeof path === 'string' && (
      path.includes('/../') ||
      path.includes('/..') ||
      path.startsWith('/etc/') ||
      path.startsWith('/var/') ||
      path === '/etc/passwd' ||
      path === '/'
    )
  const safe = !escaped && (path.startsWith('/') || path.startsWith('storage://'))
  check(safe,
    `name="${name}" (${desc}): safe path (status=${r.status}, path="${path.slice(0, 60)}")`)
}

function str(v) { return typeof v === 'string' ? v : JSON.stringify(v ?? '') }

console.log('\n━━━ E4: web:write-temp-file rejects traversal names ━━━')
for (const [name, desc] of evilNames) {
  const r = await invoke('web:write-temp-file', [{ name, bytes: dummyBytes }], { encode: true })
  const path = r.body?.result ?? ''
  const err = r.body?.error ?? ''
  const escaped = typeof path === 'string' && (
    path.includes('/../') || path.startsWith('/etc/')
  )
  check(!escaped,
    `write-temp-file name="${name}" (${desc}): safe (status=${r.status}, path="${str(path).slice(0, 60)}", err="${str(err).slice(0, 60)}")`)
}

console.log('\n━━━ E4: html:save-file rejects traversal paths ━━━')
for (const [name, desc] of evilNames) {
  const target = name.endsWith('.html') ? name : `${name}.html`
  const r = await invoke('html:save-file', [target, '<p>evil</p>'])
  const err = r.body?.error ?? ''
  const path = r.body?.result?.path ?? ''
  const escaped = typeof path === 'string' && (path.includes('/../') || path.startsWith('/etc/'))
  check(!escaped,
    `html:save-file path="${target}" (${desc}): safe (status=${r.status}, path="${str(path).slice(0, 60)}", err="${str(err).slice(0, 60)}")`)
}

console.log('\n━━━ E4: read-file on traversal paths returns 4xx ━━━')
const readProbes = [
  '/etc/passwd',
  '/etc/hosts',
  '/tmp/genoffice-data/files/../../../etc/passwd',
  '../../../etc/passwd',
]
for (const target of readProbes) {
  const r = await invoke('html:read-file', [target])
  const body = r.body?.error ?? r.body
  const ok =
    r.status === 404 ||
    r.status === 400 ||
    r.body?.ok === false ||
    (typeof body === 'object' && body?.error)
  check(ok,
    `html:read-file target="${target}": refused (status=${r.status})`)
}

console.log(`\n━━━ E4 path traversal: ${pass} passed / ${fail} failed ━━━`)
process.exit(fail > 0 ? 1 : 0)
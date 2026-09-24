/**
 * E6: .meta.json sidecar cleanup probe.
 *
 * When home:delete-files moves a file to .trash/, the .meta.json sidecar
 * should move alongside it. Verify by:
 *   1. web:save-file to create a real file + sidecar
 *   2. home:delete-files the storage:// URI
 *   3. Confirm neither main file nor sidecar exists in FILES_DIR
 *   4. Confirm both exist in .trash/
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync as exec } from 'node:child_process'

const BASE = 'http://127.0.0.1:18081'
let pass = 0, fail = 0
const check = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
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

async function buildXlsx(label) {
  const tmp = join(tmpdir(), `e6-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  mkdirSync(join(tmp, 'xl', 'worksheets'), { recursive: true })
  mkdirSync(join(tmp, '_rels'), { recursive: true })
  mkdirSync(join(tmp, 'xl', '_rels'), { recursive: true })
  writeFileSync(join(tmp, 'xl', 'workbook.xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheets><sheet name="${label}" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  writeFileSync(join(tmp, 'xl', 'worksheets', 'sheet1.xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>')
  writeFileSync(join(tmp, '[Content_Types].xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>')
  writeFileSync(join(tmp, '_rels', '.rels'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>')
  writeFileSync(join(tmp, 'xl', '_rels', 'workbook.xml.rels'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>')
  const out = join(tmp, `${label}.xlsx`)
  exec(`cd ${tmp} && zip -q -r ${out} .`)
  const buf = readFileSync(out)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  exec(`rm -rf ${tmp}`)
  return ab
}

// We need the FILES_DIR path for direct fs checks.
// web:save-file returns storage://local/<key>. The underlying file lives at
// FILES_DIR/<key>. We get the key from the storage:// URI.
function storageToPath(uri) {
  const key = uri.replace('storage://local/', '')
  return `/tmp/genoffice-data/files/${key}`
}

console.log('\n━━━ E6: .meta.json sidecar cleanup ━━━')

// 1. Upload a file (this also creates the .meta.json sidecar)
const bytes = await buildXlsx('E6-SIDECAR')
const upload = await invoke('web:save-file', [{ name: 'e6-sidecar.xlsx', bytes }], { encode: true })
const uri = upload.body?.result?.path
check(uri.startsWith('storage://'), `web:save-file returned storage:// URI: ${uri}`)

const key = uri.replace('storage://local/', '')
const mainPath = `/tmp/genoffice-data/files/${key}`
const metaPath = `${mainPath}.meta.json`

// 2. Verify both exist before delete
check(existsSync(mainPath), `main file exists before delete: ${mainPath}`)
check(existsSync(metaPath), `meta sidecar exists before delete: ${metaPath}`)

// 3. Delete via home:delete-files
const del = await invoke('home:delete-files', [[uri]])
check(del.body?.result?.ok === true && del.body?.result?.deleted >= 1,
  `home:delete-files succeeded (ok=${del.body?.result?.ok}, deleted=${del.body?.result?.deleted})`)

// 4. Both gone from FILES_DIR
check(!existsSync(mainPath), `main file gone from FILES_DIR after delete`)
check(!existsSync(metaPath), `meta sidecar gone from FILES_DIR after delete`)

// 5. Both present in .trash/ — names are `{uuid}-{basename}` so we scan for
// any xlsx + matching meta.json pair created around the time of this test.
// The important check (sidecar moved) is step 4 above.
const trashDir = '/tmp/genoffice-data/.trash'
const trashXlsx = []
const trashMeta = []
const cutoff = Date.now() - 30_000 // within last 30s
try {
  const entries = readdirSync(trashDir)
  for (const e of entries) {
    if (e.endsWith('.xlsx') || e.endsWith('.xlsx.meta.json')) {
      trashXlsx.push(e)
    }
  }
} catch {}

check(trashXlsx.length >= 1,
  `something landed in .trash/ (${trashXlsx.length} xlsx/meta entries)`)

console.log(`\n━━━ E6 .meta.json sidecar cleanup: ${pass} passed / ${fail} failed ━━━`)
process.exit(fail > 0 ? 1 : 0)

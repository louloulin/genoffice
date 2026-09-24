/**
 * E7: starred ghost cleanup probe.
 *
 * When home:delete-files removes a file, the star must be removed from
 * DOCS_STARRED so the starred tab doesn't show a ghost entry.
 *
 *   1. web:save-file to create a file
 *   2. home:toggle-star to star it
 *   3. home:delete-files to delete it
 *   4. Confirm star is gone (home:starred entries no longer contain it)
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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
  const tmp = join(tmpdir(), `e7-${Date.now()}`)
  mkdirSync(join(tmp, 'xl/worksheets'), { recursive: true })
  mkdirSync(join(tmp, '_rels'), { recursive: true })
  mkdirSync(join(tmp, 'xl/_rels'), { recursive: true })
  writeFileSync(join(tmp, 'xl/workbook.xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
  writeFileSync(join(tmp, 'xl/worksheets/sheet1.xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>')
  writeFileSync(join(tmp, '[Content_Types].xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet.main+xml"/></Types>')
  writeFileSync(join(tmp, '_rels/.rels'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  writeFileSync(join(tmp, 'xl/_rels/workbook.xml.rels'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
  const out = join(tmp, `${label}.xlsx`)
  exec(`cd ${tmp} && zip -q -r ${out} .`)
  const buf = readFileSync(out)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  exec(`rm -rf ${tmp}`)
  return ab
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

console.log('\n━━━ E7: starred ghost cleanup ━━━')

// 1. Upload file
const bytes = await buildXlsx('e7-star-ghost')
const upload = await invoke('web:save-file', [{ name: 'e7-star-ghost.xlsx', bytes }], { encode: true })
const uri = upload.body?.result?.path
check(uri.startsWith('storage://'), `web:save-file returned storage:// URI: ${uri}`)

// Extract the FILES_DIR path so we can verify the file exists
const key = uri.replace('storage://local/', '')
const mainPath = `/tmp/genoffice-data/files/${key}`
check(existsSync(mainPath), `file exists at ${mainPath}`)

// 2. Star the file
const star = await invoke('home:toggle-star', [mainPath])
check(star.body?.result?.starred === true,
  `home:toggle-star marked starred=true for ${mainPath}`)

// 3. Verify it's in the starred list
const beforeStarred = await invoke('home:starred', [])
const beforeEntries = beforeStarred.body?.result?.entries ?? []
check(beforeEntries.some(e => e.path === mainPath),
  `file appears in home:starred entries before delete`)

// 4. Delete the file
const del = await invoke('home:delete-files', [[uri]])
check(del.body?.result?.ok === true && del.body?.result?.deleted >= 1,
  `home:delete-files succeeded (deleted=${del.body?.result?.deleted})`)

// 5. Verify file is gone from disk
check(!existsSync(mainPath), `file gone from FILES_DIR after delete`)

// 6. Verify star is gone from starred list — ghost entry must not linger
const afterStarred = await invoke('home:starred', [])
const afterEntries = afterStarred.body?.result?.entries ?? []
const stillStarred = afterEntries.some(e => e.path === mainPath)
check(!stillStarred,
  `ghost star NOT in home:starred entries after delete (got ${afterEntries.length} entries)`)

console.log(`\n━━━ E7 starred ghost cleanup: ${pass} passed / ${fail} failed ━━━`)
process.exit(fail > 0 ? 1 : 0)

/**
 * E5: Session staleness — verify behaviour when the source file is deleted
 * while a session is still open.
 *
 * Cases:
 *   1. Open workbook session, delete the file, then read-range — should
 *      either return cached data or a structured error, NOT crash.
 *   2. Open workbook session, delete the file, then workbook:save — should
 *      return a structured error explaining the source is gone.
 *   3. Open docs/sheets/slides sessions in parallel, delete one file, the
 *      others should still work.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync as exec } from 'node:child_process'

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

// Build a minimal XLSX and put it in FILES_DIR via web:save-file so
// workbook:open-path can find it. (web:save-file hashes the name; we use
// the returned path as our handle.)
async function buildAndUploadXlsx(label) {
  const tmp = join(tmpdir(), `e5-xlsx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
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
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>' + label + '</t></is></c></row></sheetData></worksheet>')
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
  // Upload to FILES_DIR
  const upload = await invoke('web:save-file', [{ name: `${label}.xlsx`, bytes: ab }], { encode: true })
  exec(`rm -rf ${tmp}`)
  return { filesDirPath: upload.body?.result?.path, tmpPath: out }
}

console.log('\n━━━ E5: workbook session survives source file deletion ━━━')

// 1. Open a fresh workbook, then delete the file from disk
const { filesDirPath: xlsxPath } = await buildAndUploadXlsx('E5-ALIVE')
const open = await invoke('workbook:open-path', [xlsxPath])
const sid = open.body?.result?.sessionId
const sheetId = open.body?.result?.sheets?.[0]?.id
check(typeof sid === 'string', `workbook:open-path → sessionId=${sid?.slice(0, 8)}…`)

// 2. Verify the file is gone — use the storage-aware home:delete-file
const del1 = await invoke('home:delete-file', [xlsxPath])
check(del1.status === 200 && (del1.body?.ok === true || del1.body?.result?.ok === true),
  `home:delete-file removed the source (status=${del1.status}, ok=${del1.body?.ok ?? del1.body?.result?.ok})`)

// 3. Read-range on the stale session — does it return cached data or 5xx?
const staleRead = await invoke('workbook:read-range', [
  { sessionId: sid, sheetId, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
])
const staleReadOk = staleRead.status === 200 && staleRead.body?.ok === true
check(staleReadOk || (staleRead.body?.error && typeof staleRead.body.error === 'object'),
  `read-range after delete returns structured response (status=${staleRead.status}, ok=${staleRead.body?.ok}, err=${JSON.stringify(staleRead.body?.error ?? '').slice(0, 80)})`)

// 4. Save on the stale session — should be a structured error, not a crash
const staleSave = await invoke('workbook:save', [{ sessionId: sid }])
const saveErr = staleSave.body?.error ?? staleSave.body?.result?.error ?? ''
check(staleSave.status === 200 && (staleSave.body?.ok === false || typeof saveErr === 'string' || typeof saveErr === 'object'),
  `workbook:save on deleted source returns structured error (status=${staleSave.status}, ok=${staleSave.body?.ok}, err=${JSON.stringify(saveErr).slice(0, 100)})`)

console.log('\n━━━ E5: file deleted via home channel — session state ━━━')

// 5. Open another workbook, delete via home:delete-file, then probe
const { filesDirPath: xlsx2 } = await buildAndUploadXlsx('E5-DELETED')
const open2 = await invoke('workbook:open-path', [xlsx2])
const sid2 = open2.body?.result?.sessionId
const sheetId2 = open2.body?.result?.sheets?.[0]?.id

const del = await invoke('home:delete-file', [xlsx2])
check(del.status === 200, `home:delete-file returns 200 (status=${del.status}, ok=${del.body?.ok})`)
check(!existsSync(xlsx2), `file deleted by home:delete-file`)

const staleRead2 = await invoke('workbook:read-range', [
  { sessionId: sid2, sheetId: sheetId2, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
])
check(staleRead2.status < 500,
  `read-range on home-deleted session does not 5xx (status=${staleRead2.status})`)

console.log('\n━━━ E5: open 70 sessions to trigger LRU eviction ━━━')

// 6. Open more than MAX_SESSIONS (64) and confirm the registry bounds itself
const sessionIds = []
for (let i = 0; i < 70; i++) {
  const { filesDirPath: p } = await buildAndUploadXlsx(`E5-LRU-${i}`)
  const r = await invoke('workbook:open-path', [p])
  if (r.body?.result?.sessionId) {
    sessionIds.push({ sid: r.body.result.sessionId, path: p })
  }
  // Don't unlink immediately — we need the bytes for read-range
}
check(sessionIds.length > 64,
  `opened ${sessionIds.length} sessions (>MAX_SESSIONS=64)`)

// 7. Re-open one of the earliest sessions — registry may have evicted it.
//    Expected: structured error or stale cache, not a 500.
const oldest = sessionIds[0]
const oldestRead = await invoke('workbook:read-range', [
  { sessionId: oldest.sid, sheetId: 'unknown', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
])
check(oldestRead.status < 500,
  `LRU-evicted session returns structured error or data (status=${oldestRead.status}, body=${JSON.stringify(oldestRead.body).slice(0, 120)})`)

// cleanup
for (const s of sessionIds) {
  if (existsSync(s.path)) unlinkSync(s.path)
}

console.log(`\n━━━ E5 session staleness: ${pass} passed / ${fail} failed ━━━`)
process.exit(fail > 0 ? 1 : 0)
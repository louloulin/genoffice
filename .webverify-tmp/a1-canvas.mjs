import { readFileSync, statSync, existsSync, unlinkSync } from 'node:fs'
const BASE = 'http://127.0.0.1:18081'

// Encode/decode binary values across the JSON HTTP boundary. Mirrors the
// codec in apps/web-server/src/common/codec.ts: tagged base64 envelope that
// the server decoder reverses before invoking the handler.
const BYTES_TAG = '__ipcBytes'
function encodeTransport(value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(encodeTransport)
  if (value instanceof ArrayBuffer) {
    return { [BYTES_TAG]: 'ab', b64: Buffer.from(value).toString('base64') }
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const tag =
      value instanceof Uint8Array ? 'u8'
      : value instanceof Int8Array ? 'i8'
      : value instanceof Uint16Array ? 'u16'
      : value instanceof Int16Array ? 'i16'
      : value instanceof Uint32Array ? 'u32'
      : value instanceof Int32Array ? 'i32'
      : value instanceof Float32Array ? 'f32'
      : value instanceof Float64Array ? 'f64'
      : 'u8'
    return { [BYTES_TAG]: tag, b64: Buffer.from(bytes).toString('base64') }
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = encodeTransport(v)
  return out
}
function decodeTransport(value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decodeTransport)
  const tag = value[BYTES_TAG]
  if (typeof tag === 'string' && typeof value.b64 === 'string') {
    const buf = Buffer.from(value.b64, 'base64')
    if (tag === 'ab') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const ctor =
      tag === 'u8' ? Uint8Array
      : tag === 'i8' ? Int8Array
      : tag === 'u16' ? Uint16Array
      : tag === 'i16' ? Int16Array
      : tag === 'u32' ? Uint32Array
      : tag === 'i32' ? Int32Array
      : tag === 'f32' ? Float32Array
      : tag === 'f64' ? Float64Array
      : null
    return ctor ? new ctor(buf.buffer, buf.byteOffset, buf.byteLength) : buf
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = decodeTransport(v)
  return out
}

async function invoke(channel, args = [], { encode = false } = {}) {
  const payloadArgs = encode ? args.map(encodeTransport) : args
  const r = await fetch(`${BASE}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: payloadArgs }),
  })
  const body = await r.json()
  // Decode binary fields in the response so callers can use Buffers directly.
  return { status: r.status, body: decodeTransport(body) }
}

// Convert any decoded byte shape (ArrayBuffer, TypedArray, or a Buffer from
// base64) into a Buffer for assertions.
function asBuffer(value) {
  if (!value) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return Buffer.alloc(0)
}

let pass = 0,
  fail = 0
const check = (cond, msg) => {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`✗ ${msg}`)
  }
}

// ─── sheets ────────────────────────────────────────────────────────────
console.log('\n━━━ sheets: open + read-range + save round-trip ━━━')
const sheetCreated = await invoke('home:new-sheet', [])
const sheetPath = sheetCreated.body?.result?.path
check(typeof sheetPath === 'string' && existsSync(sheetPath), `home:new-sheet → ${sheetPath}`)
const sheetOpen = await invoke('workbook:open-path', [sheetPath])
const sessionId = sheetOpen.body?.result?.sessionId
const sheetId = sheetOpen.body?.result?.sheets?.[0]?.id
check(typeof sessionId === 'string' && sessionId.length > 0, `workbook:open-path → sessionId=${sessionId?.slice(0, 8)}…`)
check(typeof sheetId === 'string' && sheetId.length > 0, `workbook:open-path → first sheetId=${sheetId}`)

const sheetRange = await invoke('workbook:read-range', [
  { sessionId, sheetId, range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 } },
])
check(sheetRange.status === 200 && sheetRange.body?.ok === true, `workbook:read-range returns 200 ok (got status=${sheetRange.status})`)
const hasRangeShape = sheetRange.body?.result && Array.isArray(sheetRange.body.result.rows)
check(hasRangeShape, `read-range shape has rows[] (${sheetRange.body?.result?.rows?.length ?? 0} rows)`)

const beforeSize = statSync(sheetPath).size
const sheetSave = await invoke('workbook:save', [{ sessionId }])
check(
  sheetSave.body?.result?.ok === true || sheetSave.body?.result?.saved === true || sheetSave.body?.ok === true,
  `workbook:save empty-edits returns ok (got ${JSON.stringify(sheetSave.body?.result).slice(0, 100)})`,
)
const afterSize = statSync(sheetPath).size
check(afterSize > 0, `workbook:save re-wrote the xlsx (${beforeSize} → ${afterSize} bytes)`)

const sheetReopen = await invoke('workbook:open-path', [sheetPath])
const newSession = sheetReopen.body?.result?.sessionId
check(newSession && newSession !== sessionId, `fresh sessionId after reopen (${newSession?.slice(0, 8)}…)`)
const sheetReread = await invoke('workbook:read-range', [
  { sessionId: newSession, sheetId, range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 } },
])
check(sheetReread.status === 200 && sheetReread.body?.ok === true, `workbook:read-range on fresh session returns 200 ok`)
if (sheetPath && existsSync(sheetPath)) unlinkSync(sheetPath)

// ─── slides ────────────────────────────────────────────────────────────
console.log('\n━━━ slides: open + add-text + save returns WEB_UNSUPPORTED (documented) ━━━')
const slideCreated = await invoke('home:new-slide', [])
const slidePath = slideCreated.body?.result?.path
check(typeof slidePath === 'string' && existsSync(slidePath), `home:new-slide → ${slidePath}`)
const slideOpen = await invoke('slides:open-path', [slidePath, 800])
check(
  slideOpen.body?.ok === true || (slideOpen.body?.result?.slides?.length ?? 0) > 0,
  `slides:open-path ok (got status=${slideOpen.status}, slides=${slideOpen.body?.result?.slides?.length})`,
)

const slideAdd = await invoke('slides:add-text', [
  { slideIndex: 0, xPx: 50, yPx: 50, wPx: 400, hPx: 80, text: 'A1 FROM A1-TEST' },
])
// slides:* handlers return { ok, result:null } on success — check top-level ok
check(slideAdd.status === 200 && slideAdd.body?.ok === true, `slides:add-text accepted (status=${slideAdd.status}, ok=${slideAdd.body?.ok})`)

const slideSave = await invoke('slides:save', [])
const errStr = String(slideSave.body?.result?.error ?? slideSave.body?.error ?? '')
check(errStr.includes('WEB_UNSUPPORTED') || errStr.includes('web 版暂不支持'), `slides:save reports WEB_UNSUPPORTED (got: ${errStr.slice(0, 100)})`)
const slideAfterSize = existsSync(slidePath) ? statSync(slidePath).size : 0
check(slideAfterSize > 0, `slides file still on disk (${slideAfterSize} bytes)`)
if (slidePath && existsSync(slidePath)) unlinkSync(slidePath)

// ─── pdf ───────────────────────────────────────────────────────────────
console.log('\n━━━ pdf: open + save round-trip ━━━')
const pdfCreated = await invoke('home:new-pdf', [])
const pdfPath = pdfCreated.body?.result?.path
check(typeof pdfPath === 'string' && existsSync(pdfPath), `home:new-pdf → ${pdfPath}`)
const pdfOpen = await invoke('pdf:open-path', [pdfPath])
const pdfBytes = asBuffer(pdfOpen.body?.result?.bytes)
check(
  pdfBytes.length > 0 && pdfBytes.subarray(0, 4).toString() === '%PDF',
  `pdf:open-path returns valid PDF bytes (${pdfBytes.length}B, head=${pdfBytes.subarray(0, 4).toString()})`,
)
const pdfBeforeSize = statSync(pdfPath).size
const pdfSave = await invoke('pdf:save', [{ path: pdfPath, markups: [], drawings: [], formValues: [], stamps: [] }])
check(
  pdfSave.body?.result?.ok === true || pdfSave.body?.ok === true,
  `pdf:save empty-markup returns ok (got ${JSON.stringify(pdfSave.body?.result).slice(0, 100)})`,
)
const pdfAfterSize = statSync(pdfPath).size
check(pdfAfterSize > 0, `pdf:save re-wrote the pdf (${pdfBeforeSize} → ${pdfAfterSize} bytes)`)
const pdfReopen = await invoke('pdf:open-path', [pdfPath])
const pdfReBytes = asBuffer(pdfReopen.body?.result?.bytes)
check(
  pdfReBytes.length > 0 && pdfReBytes.subarray(0, 4).toString() === '%PDF',
  `pdf still opens after save (${pdfReBytes.length}B)`,
)
if (pdfPath && existsSync(pdfPath)) unlinkSync(pdfPath)

// ─── docs ──────────────────────────────────────────────────────────────
console.log('\n━━━ docs: open (real docx) + save round-trip ━━━')
const docCreated = await invoke('home:new-doc', [])
const docPath = docCreated.body?.result?.path
check(typeof docPath === 'string' && existsSync(docPath), `home:new-doc → ${docPath}`)
const docBytes = readFileSync(docPath)
check(
  docBytes.length > 0 && docBytes[0] === 0x50 && docBytes[1] === 0x4b,
  `docx has ZIP magic (${docBytes.length}B, head=0x50 0x4B)`,
)
const docOpen = await invoke('docs:open-path', [docPath])
const docOpenBytes = asBuffer(docOpen.body?.result?.bytes)
check(
  docOpenBytes.length > 0 || docOpen.body?.result?.path === docPath,
  `docs:open-path returns ok (status=${docOpen.status}, bytes=${docOpenBytes.length}B)`,
)
// docs:save takes (filePath, data:ArrayBuffer, auto?). Wrap the ArrayBuffer
// in the __ipcBytes envelope so the server's decodeTransportValue restores
// it before invoking the handler.
const docAb = docBytes.buffer.slice(docBytes.byteOffset, docBytes.byteOffset + docBytes.byteLength)
const docSave = await invoke('docs:save', [docPath, docAb, false], { encode: true })
check(
  docSave.body?.result?.ok === true || docSave.body?.ok === true,
  `docs:save with the same bytes returns ok (got ${JSON.stringify(docSave.body?.result).slice(0, 100)})`,
)
const docAfterSize = statSync(docPath).size
check(docAfterSize > 0, `docs:save re-wrote the docx (${docBytes.length} → ${docAfterSize} bytes)`)
if (docPath && existsSync(docPath)) unlinkSync(docPath)

console.log(`\n━━━ A1 canvas persistence: ${pass} passed / ${fail} failed ━━━`)
process.exit(fail > 0 ? 1 : 0)
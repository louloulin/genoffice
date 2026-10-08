/**
 * `@genoffice/office-ai` 真实运行示例 — 无头 Office 文档引擎的进程内用法。
 *
 * 直接 `node run.mjs` 即可，全部操作在本 Node 进程内完成：无 Electron、无 HTTP、
 * 无 SaaS、无模型调用。输入是仓库中已存在的真实文件（含真实加密 PDF），
 * 输出写到 `out/` 下（渲染的 PNG、编辑后的 docx/xlsx、转换的 csv/md）。
 *
 * 在 aiwork 里的用法与此完全一致：`import { readDocument, ... } from '@genoffice/office-ai'`。
 * 本示例为了在仓库内直接可跑，优先走包名导入，失败时回退到仓库构建产物。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const OUT = join(HERE, 'out')
mkdirSync(OUT, { recursive: true })

// ── import：包名优先（宿主项目的真实用法），仓库内回退到构建产物 ──────────
let lib
try {
  lib = await import('@genoffice/office-ai')
} catch {
  lib = await import(pathToFileURL(join(REPO, 'packages/office-ai/dist/office-ai.mjs')).href)
}
const {
  readDocument,
  writeDocument,
  convert,
  render,
  openDocsFile,
  openSheetsFile,
  officeTools,
  isOfficeError,
} = lib

// ── 真实输入：仓库既有文件，逐个校验存在并记录哈希 ──────────────────────────

const F = {
  pdfEnc: 'apps/shell/tests/fixtures/testPassword4Spaces.pdf', // 真实加密 PDF（密码为 4 个空格）
  docx: 'fixtures/generated/kitchen-sink.docx', // 生成的真实 Word 文档
  xlsx: 'apps/sheets/fixtures/generated/compatibility-kitchen-sink.xlsx', // 生成的真实工作簿
  pptx: 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx', // 真实演示文稿
  md: 'README.md', // 仓库根 README，作为 md→docx 的真实输入
}
const read = (p) => new Uint8Array(readFileSync(join(REPO, p)))
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)
const kb = (b) => `${(b.byteLength / 1024).toFixed(1)} KB`
const save = (name, bytes) => {
  writeFileSync(join(OUT, name), bytes)
  return `out/${name} (${kb(bytes)})`
}

let step = 0
const section = (t) => console.log(`\n${++step}. ${t}\n${'─'.repeat(66)}`)

// ════════════════════════════════════════════════════════════════════════
console.log('@genoffice/office-ai 真实运行示例')
console.log(`输入: ${Object.values(F).map((p) => p.split('/').pop()).join(', ')}`)

// ── 1. 读取：四种格式统一 readDocument ────────────────────────────────────
section('读取真实文件（pdf / docx / xlsx / pptx）→ 统一 DocumentView')

const pdfBytes = read(F.pdfEnc)
const locked = await readDocument(pdfBytes, { format: 'pdf' })
console.log(`加密 PDF 无密码: pages=${locked.pdf.pages} encrypted=${locked.pdf.encrypted}`)
const opened = await readDocument(pdfBytes, { format: 'pdf', password: '    ' })
console.log(`加密 PDF 带密码: pages=${opened.pdf.pages} encrypted=${opened.pdf.encrypted}`)

const docxView = await readDocument(read(F.docx), { full: true })
console.log(`Word: ${docxView.blocks.length} 个块, ${docxView.comments.length} 条批注, ${docxView.revisions.length} 条修订`)

const xlsxView = await readDocument(read(F.xlsx))
console.log(`Excel: 工作表 [${xlsxView.workbook.sheets.map((s) => s.name).join(', ')}]`)

const pptxView = await readDocument(read(F.pptx), { format: 'pptx' })
console.log(`PPT: ${pptxView.deck.slides} 页, ${pptxView.deck.pages.reduce((n, s) => n + s.elements.length, 0)} 个元素`)

// ── 2. 编辑：docx 追加段落 + xlsx 写单元格，保存后重开验证 ──────────────────
section('编辑真实文件 → 保存 → 重新打开验证')

const docsFile = await openDocsFile(read(F.docx))
docsFile.editor.insertBlocks(docsFile.editor.getBlockCount() - 1, '<p>审计批注：由 @genoffice/office-ai 进程内追加。</p>')
const editedDocx = await docsFile.save()
docsFile.close()
const reOpen = await readDocument(editedDocx, { full: true })
const appended = reOpen.text.includes('审计批注')
console.log(`Word 追加段落: ${docxView.blocks.length} → ${reOpen.blocks.length} 块, 新内容可读回: ${appended ? '是' : '否'}`)
console.log(`  ${save('edited-kitchen-sink.docx', editedDocx)}`)

const editedXlsx = await writeDocument(read(F.xlsx), [{ op: 'set_cell', sheet: 'Data', address: 'A1', value: '由 office-ai 写入' }], { format: 'xlsx' })
const xlsxAfter = await readDocument(editedXlsx)
console.log(`Excel 写入 A1: 工作表数保持 ${xlsxAfter.workbook.sheets.length === xlsxView.workbook.sheets.length ? '是' : '否'}`)
console.log(`  ${save('edited-kitchen-sink.xlsx', editedXlsx)}`)

// ── 3. 转换：进程内可直接跑的路由 ──────────────────────────────────────────
section('格式转换（进程内路由: xlsx→csv, docx→md, md→docx, csv→xlsx）')

const csv = await convert(read(F.xlsx), 'xlsx', 'csv')
console.log(`xlsx→csv: ${save('converted.csv', csv)}, 前 60 字符: ${JSON.stringify(new TextDecoder().decode(csv).slice(0, 60))}`)

const md = await convert(editedDocx, 'docx', 'md')
console.log(`docx→md:  ${save('converted.md', md)}`)

const mdDocx = await convert(read(F.md), 'md', 'docx', { title: 'README' })
console.log(`md→docx:  ${save('converted.docx', mdDocx)}`)

const csvBytes = new TextEncoder().encode('name,qty\nApple,3\nPear,7\n')
const csvXlsx = await convert(csvBytes, 'csv', 'xlsx', { title: 'Stock' })
console.log(`csv→xlsx: ${save('converted-stock.xlsx', csvXlsx)}`)

// ── 4. 渲染：pdfium 在进程内把 PDF 光栅化为 PNG ───────────────────────────
section('PDF 渲染（pdfium wasm，进程内，含加密文档）')

const pngs = await render(pdfBytes, { format: 'pdf', password: '    ', scale: 2 })
console.log(`渲染出 ${pngs.length} 张 PNG, 第一张 ${kb(pngs[0])}`)
console.log(`  ${save('encrypted-page.png', pngs[0])}`)

// ── 5. Agent 工具面：officeTools 是给 LLM agent 用的 14 个工具 ─────────────
section('Agent 工具面（officeTools → 本进程 MCP 服务器，aiwork 挂给专家用）')

const box = officeTools()
const names = box.tools.map((t) => t.name)
console.log(`工具数: ${names.length}: ${names.join(', ')}`)

await box.open(read(F.xlsx))
const ctx = await box.tools.find((t) => t.name === 'get_document_context').execute()
console.log(`get_document_context → ${ctx.text.split('\n')[0]}`)
const agg = await box.tools.find((t) => t.name === 'aggregate_range').execute({ sheet: 'Data', op: 'sum', range: 'B2:B3' })
console.log(`aggregate_range(sum) → ${agg.text.trim()}`)
const bad = await box.tools.find((t) => t.name === 'set_cells').execute({ cells: [{ sheet: 'Data', address: 'ZZZZ99', value: 1 }] })
console.log(`set_cells(坏参数) → isError=${bad.data?.error !== undefined ? 'true（不抛异常，返回错误结果给 agent 自行修正）' : 'false'}`)

// ── 6. 错误面：类型化 code，宿主可分支 ─────────────────────────────────────
section('错误面：类型化 OfficeError，宿主按 code 分支')

try {
  await readDocument(new Uint8Array(), { format: 'docx' })
} catch (e) {
  console.log(`空文档 → isOfficeError=${isOfficeError(e)}, code=${e.code}`)
}
try {
  await render(pdfBytes, { format: 'pdf' })
} catch (e) {
  console.log(`加密 PDF 无密码渲染 → code=${e.code}, cause=${e.cause?.code ?? e.cause?.message}`)
}
try {
  await convert(new TextEncoder().encode('a,b\n1,2\n'), 'csv', 'pdf')
} catch (e) {
  console.log(`csv→pdf（需要应用渲染器）→ code=${e.code}`)
}

console.log(`\n全部产物已写入 ${OUT}`)
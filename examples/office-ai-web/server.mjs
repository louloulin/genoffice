/**
 * `@genoffice/office-ai` 交互式网站示例 — 浏览器里真实体验"GenOffice 作为库"。
 *
 * `node server.mjs` 后打开 http://localhost:18085 。服务器就是一个普通 Node
 * http 进程：所有文档能力（读取/编辑/转换/PDF 渲染/agent 工具）都由
 * `@genoffice/office-ai` 在本进程内完成 — 无 Electron、无 SaaS、无模型调用。
 * 浏览器与库之间的协议就是 `officeTools` 的 14 个工具，与 aiwork 挂给专家的
 * 是同一套。
 *
 * 每个浏览器标签页一个独立会话（`sid` cookie → 自己的 toolbox），多个标签/
 * 多个人同时用互不覆盖。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const PORT = process.env.PORT ?? 18085

let lib
try {
  lib = await import('@genoffice/office-ai')
} catch {
  lib = await import(pathToFileURL(join(REPO, 'packages/office-ai/dist/office-ai.mjs')).href)
}
const { officeTools, NODE_ROUTES, isOfficeError } = lib

/** 仓库既有真实文件，作为一键样例。 */
const SAMPLES = [
  { key: 'docx', label: 'Word 示例（真实 kitchen-sink）', path: 'fixtures/generated/kitchen-sink.docx', name: 'kitchen-sink.docx' },
  { key: 'xlsx', label: 'Excel 示例（真实工作簿）', path: 'apps/sheets/fixtures/generated/compatibility-kitchen-sink.xlsx', name: 'compatibility-kitchen-sink.xlsx' },
  { key: 'pdf', label: 'PDF 示例（真实文档）', path: '.upload-test/verify-doc.pdf', name: 'verify-doc.pdf' },
  { key: 'pptx', label: 'PPT 示例（真实演示文稿）', path: 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx', name: '01_standard_business.pptx' },
  { key: 'md', label: 'Markdown 示例（仓库 README）', path: 'README.md', name: 'README.md' },
]

const MIME = { '.html': 'text/html; charset=utf-8' }

// ── 会话：sid cookie → { box, name }；数量上限防内存增长 ──────────────────
const SESSIONS = new Map()
const MAX_SESSIONS = 50

function sessionOf(req, res) {
  const raw = req.headers.cookie ?? ''
  const existing = /(?:^|;\s*)sid=([\w-]+)/.exec(raw)?.[1]
  const sid = existing ?? randomUUID()
  if (!existing) res.setHeader('set-cookie', `sid=${sid}; Path=/; SameSite=Lax`)
  let session = SESSIONS.get(sid)
  if (!session) {
    session = { box: officeTools(), name: '' }
    SESSIONS.set(sid, session)
    if (SESSIONS.size > MAX_SESSIONS) {
      SESSIONS.delete(SESSIONS.keys().next().value)
    }
  }
  return session
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type })
  res.end(body)
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj))
const fail = (res, err) => {
  const typed = isOfficeError(err)
  json(res, typed ? 400 : 500, { error: { code: typed ? err.code : 'OFFICE_INTERNAL', message: err.message, cause: err.cause?.code ?? err.cause?.message } })
}
const body = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

/** 打开文档并返回给 UI 的精简视图（大文档截断，保持响应小）。 */
async function openDocument(session, bytes, name) {
  const view = await session.box.open(bytes)
  session.name = name
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const brief = { name, kind: view.kind, targets: NODE_ROUTES[view.kind] ?? NODE_ROUTES[ext] ?? [] }
  if (view.kind === 'pdf') {
    brief.pdf = { ...view.pdf, text: view.text.slice(0, 2000) }
  } else if (view.kind === 'docx') {
    brief.blocks = view.blocks.slice(0, 200).map((b) => ({ ...b, text: b.text?.slice(0, 300) }))
    brief.truncated = view.blocks.length - brief.blocks.length
    brief.comments = view.comments.length
    brief.revisions = view.revisions.length
  } else if (view.kind === 'sheet') {
    const grid = view.sheet?.cells ?? {}
    brief.workbook = {
      sheetNames: view.workbook.sheets.map((x) => x.name),
      activeSheet: view.workbook.activeSheet,
      totalCells: Object.keys(grid).length,
    }
    brief.grid = grid
  } else if (view.kind === 'deck') {
    brief.deck = {
      slides: view.deck.slides,
      size: view.deck.size,
      pages: view.deck.pages.map((p, i) => ({
        index: i,
        elements: p.elements.slice(0, 30).map((e) => ({ ...e, text: e.text?.slice(0, 120) })),
      })),
    }
  } else {
    brief.text = view.text.slice(0, 4000)
  }
  return brief
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, readFileSync(join(HERE, 'public/index.html')), MIME['.html'])
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      return res.writeHead(204).end()
    }
    if (req.method === 'GET' && url.pathname === '/api/samples') {
      return json(res, 200, SAMPLES.map(({ key, label, name }) => ({ key, label, name })))
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      return json(res, 200, officeTools().tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))
    }
    const session = sessionOf(req, res)
    if (req.method === 'POST' && url.pathname === '/api/open/sample') {
      const s = SAMPLES.find((x) => x.key === url.searchParams.get('key'))
      if (!s) return json(res, 404, { error: { code: 'OFFICE_BAD_INPUT', message: 'unknown sample' } })
      return json(res, 200, await openDocument(session, new Uint8Array(readFileSync(join(REPO, s.path))), s.name))
    }
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const bytes = new Uint8Array(await body(req))
      const name = decodeURIComponent(req.headers['x-filename'] ?? 'document')
      return json(res, 200, await openDocument(session, bytes, name))
    }
    if (req.method === 'POST' && url.pathname === '/api/tool') {
      const { name, args } = JSON.parse((await body(req)).toString() || '{}')
      const tool = session.box.tools.find((t) => t.name === name)
      if (!tool) return json(res, 400, { error: { code: 'OFFICE_BAD_INPUT', message: `未知的 Office 工具：${name}` } })
      const result = await tool.execute(args)
      return json(res, 200, {
        text: result.text,
        data: result.data,
        files: result.files?.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: Buffer.from(f.bytes).toString('base64') })),
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/save') {
      const name = url.searchParams.get('name') || session.name || 'document'
      const bytes = await session.box.save(name)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      })
      return res.end(Buffer.from(bytes))
    }
    return json(res, 404, { error: { code: 'OFFICE_BAD_INPUT', message: `no route: ${req.method} ${url.pathname}` } })
  } catch (err) {
    return fail(res, err)
  }
})

server.listen(PORT, () => {
  console.log(`@genoffice/office-ai 交互示例已启动: http://localhost:${PORT}`)
  console.log('每个浏览器标签一个独立会话；能力全部由 @genoffice/office-ai 进程内提供')
})
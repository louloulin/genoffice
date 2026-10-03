/**
 * check-pdf-editable-docx.mjs — 「PDF 原地替换不可用时回退为可编辑 DOCX」的门禁。
 *
 * ## 为什么需要它
 *
 * 原地替换是 PDF 整篇翻译的主路径，回退是它的兜底。兜底链路横跨三处，而且
 * **每一处坏掉都不报错**：
 *
 *   web-server  anydoc:pdf-to-docx-bytes  →  apps/pdf  pdfApi.pdfToDocx
 *     →  createEditableDocx 编排  →  saveDocument({ saveAsFileName, contentType })
 *
 * 坏掉之后的形态全都是「成功」：
 *   - 通道名写错        → 桌面壳没有 anydoc，invoke 抛错（能看见，但只在桌面端）
 *   - 忘记传 contentType → DOCX 被云盘按 application/pdf 归档（能打开，但类型错）
 *   - 转换返回空字节    → 云盘里多一个 0 字节的 .docx，用户点开才发现
 *   - 扫描件不标记      → 用户以为拿到可编辑文字，实际是页面图片
 *   - 入口不做能力判断  → 桌面构建 / 知识库来源也渲染按钮，点了必然失败
 *
 * 所以它们必须是门禁。
 *
 * ## 门禁形态与它的边界
 *
 * 作用域化的结构断言：用括号配平把「某个 handler / 某个函数体」切出来，只在那一段里
 * 查，而不是在整份文件里查字符串。后者会被 `false &&`、注释、或另一个函数里的同名
 * 调用绕过。本门禁覆盖的是**重构与新增代码顺手破坏语义**这一类真实风险；覆盖不了
 * 「有人故意在分支里写 if (false) 再放错误代码」—— 那种改动会被人为藏起来。
 *
 * 用法：node scripts/check-pdf-editable-docx.mjs [--json]
 * 退出码：0 = 不变量都成立；1 = 有被破坏；2 = 目标文件/锚点缺失。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const PATHS = {
  anydoc: resolve(REPO_DIR, 'apps/web-server/src/anydoc/index.ts'),
  factory: resolve(REPO_DIR, 'apps/pdf/src/shared/pdf-api-factory.ts'),
  ipc: resolve(REPO_DIR, 'apps/pdf/src/shared/ipc.ts'),
  editable: resolve(REPO_DIR, 'apps/pdf/src/renderer/ai/editable-docx.ts'),
  bridge: resolve(REPO_DIR, 'apps/pdf/src/renderer/web-bridge.ts'),
  app: resolve(REPO_DIR, 'apps/pdf/src/renderer/App.tsx'),
  panel: resolve(REPO_DIR, 'apps/pdf/src/renderer/ai/AiPanel.tsx'),
  strings: resolve(REPO_DIR, 'apps/pdf/src/renderer/i18n/strings.ts'),
  sdk: resolve(REPO_DIR, 'apps/sdk/src/dataflare/integration.ts'),
}

const checks = []
const record = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail })

/** 切出 `registerHandle('<channel>', …)` 的整个调用体（括号配平，跳过注释与字符串）。 */
function handlerBody(source, channel) {
  const marker = `registerHandle('${channel}'`
  const start = source.indexOf(marker)
  if (start < 0) return null
  const open = source.indexOf('(', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

/**
 * 切出一个函数体。名字会出现在四种位置上，本门禁要查的恰好横跨全部四种：
 *
 *   const <name> = async (…) => {}          （模块级函数）
 *   function <name>(…) {}                   （声明）
 *   <name>: async (…) => {}                 （返回对象的字面量属性，如 api 工厂）
 *   obj.<name> = async (…) => {}            （给既有对象挂方法，如 window.pdfApi）
 *
 * 只认前两种会让门禁在对象字面量与属性赋值上**静默返回 null**，而 `null` 在下面
 * 被当成「找不到」而不是「断言失败」—— 那正是本门禁要防的那类假绿。
 */
function fnBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const at = source.search(
    new RegExp(
      `(?:const\\s+${escaped}\\s*=|function\\s+${escaped}\\b|${escaped}\\s*:\\s*(?:async\\s*)?\\(|[.\\/]${escaped}\\s*=\\s*(?:async\\s*)?\\()`,
    ),
  )
  if (at < 0) return null
  // An arrow function's parameters can themselves be destructured
  // (`async ({ path }) => { … }`), so the first `{` after the match is the
  // parameter list, not the body. Take the first `{` **after** the `=>` when
  // there is one; a `function` declaration has no arrow, so it falls through
  // to the first brace as before.
  const arrow = source.indexOf('=>', at)
  const from = arrow >= 0 && arrow < source.indexOf('\n', at) + 400 ? arrow : at
  const open = source.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

const read = (key) => {
  const file = PATHS[key]
  if (!existsSync(file)) {
    console.error(`[pdf-editable-docx] target missing: ${file}`)
    process.exit(2)
  }
  return readFileSync(file, 'utf8')
}

const anydoc = read('anydoc')
const factory = read('factory')
const ipc = read('ipc')
const editable = read('editable')
const bridge = read('bridge')
const app = read('app')
const panel = read('panel')
const strings = read('strings')
const sdk = read('sdk')

// ── 1) 服务端通道：委派真转换器，且不碰文件系统 ──────────────────────────
const channel = handlerBody(anydoc, 'anydoc:pdf-to-docx-bytes')
record('server-channel-exists', channel !== null, '找不到 anydoc:pdf-to-docx-bytes 的注册')
if (channel) {
  record(
    'server-channel-delegates',
    channel.includes('convertPdfToDocxBytes'),
    '通道必须委派给 anydoc/convert 里那个真实转换器，不能另写一份',
  )
  // 字节进字节出。落盘会把用户文档写到一台不是权威存储的机器上。
  for (const call of ['writeFileSync', 'atomicWriteFile', 'mkdirSync', 'requireManagedPath']) {
    record(`server-channel-no-fs-${call}`, !channel.includes(call), `通道里出现了 ${call}()`)
  }
  record(
    'server-channel-returns-bytes',
    /docx:\s*outcome\.docx/.test(channel),
    '成功结果必须带转换出的 docx 字节',
  )
  record(
    'server-channel-flags-scans',
    channel.includes('scannedDocument'),
    '扫描件必须被标记：DOCX 里是页面图片，不是可编辑文字',
  )
}

// ── 2) 渲染进程：地址必须是 anydoc 通道，不是 ai:/pdf: 通道 ────────────────
const pdfToDocx = fnBody(factory, 'pdfToDocx')
record('api-pdfToDocx-exists', pdfToDocx !== null, 'pdf-api-factory 里没有 pdfToDocx')
if (pdfToDocx) {
  record(
    'api-addresses-anydoc',
    pdfToDocx.includes('ANYDOC_CHANNELS.pdfToDocxBytes'),
    '必须走 ANYDOC_CHANNELS（web-server 注册），桌面壳只注册 ai:* 通道',
  )
  record(
    'api-missing-handler-is-failure',
    /catch[\s\S]*ok:\s*false/.test(pdfToDocx),
    '通道不存在（桌面构建）时必须返回 ok:false，不能让 invoke 的 reject 逃逸',
  )
}
record(
  'channel-constant-is-bytes',
  /pdfToDocxBytes:\s*'anydoc:pdf-to-docx-bytes'/.test(ipc),
  '通道名必须落在 ANYDOC_CHANNELS 上',
)

// ── 3) 不许凭空造出文件 ─────────────────────────────────────────────────
const create = fnBody(editable, 'createEditableDocx')
record('orchestrator-exists', create !== null, 'editable-docx.ts 里没有 createEditableDocx')
if (create) {
  const noSourceAt = create.indexOf('no-source')
  const convertAt = create.indexOf('deps.convert')
  record(
    'no-convert-without-source',
    noSourceAt >= 0 && convertAt > noSourceAt,
    '必须先确认有源字节再调用转换',
  )
  // 第一版写成 `saveAt > create.indexOf('bytes.byteLength === 0')`。删掉那句
  // 检查时 indexOf 返回 -1，比较反而成立 —— 门禁在**最该红的那种改动上绿了**。
  // 所以改成直接要求：保存之前必须出现字节长度判断。
  const saveAt = create.indexOf('deps.saveAsDocx')
  const beforeSave = saveAt >= 0 ? create.slice(0, saveAt) : ''
  record(
    'no-save-before-bytes-exist',
    // 锚在 `bytes.byteLength` 而不是 `byteLength`：源字节检查里也有一个
    // `source.byteLength === 0`，宽松匹配会拿它顶替真正的产物检查。
    saveAt > 0 && /\bbytes\.byteLength/.test(beforeSave) && /empty-output/.test(beforeSave),
    '保存前必须检查产出字节的长度并拒绝空产物：0 字节的 .docx 是这条路径最坏的产物',
  )
  record(
    'scanned-flag-survives',
    /scannedDocument:\s*converted\.scannedDocument\s*===\s*true/.test(create),
    '扫描件标记必须来自转换结果，不能恒为 false',
  )
}
record(
  'name-changes-extension',
  /\.docx`/.test(editable) && /NAME_SUFFIX\s*=\s*'editable'/.test(editable),
  '兄弟文件名必须换成 .docx —— 共用 deriveTranslatedName 会保留 .pdf，那是错的',
)

// ── 4) DOCX 必须按 Word 文档归档，而不是按打开着的 PDF ───────────────────
const bridgeCreate = fnBody(bridge, 'createEditableDocx')
record('bridge-wires-orchestrator', bridgeCreate !== null, 'web-bridge 没有接 createEditableDocx')
if (bridgeCreate) {
  record(
    'bridge-sets-docx-content-type',
    bridgeCreate.includes('contentType: DOCX_CONTENT_TYPE'),
    '另存时必须显式声明 Word MIME，否则云盘会把可编辑文档归档成 application/pdf',
  )
}
const saveHost = fnBody(sdk, 'saveHostDocument')
record('sdk-has-save-as-gate', saveHost !== null, 'SDK 里找不到 saveHostDocument')
if (saveHost) {
  record(
    'content-type-override-is-save-as-only',
    /saveAsFileName\s*\?\s*contentTypeOverride\s*:\s*undefined/.test(saveHost),
    'contentType 覆盖只能作用于另存；版本推进必须沿用文档自身类型',
  )
}

// ── 5) 入口必须按能力判断，桌面/知识库来源不渲染 ────────────────────────
record(
  'panel-gates-on-prop',
  /\{onCreateEditableDocx\s*&&\s*\(/.test(panel),
  'AiPanel 必须在回调缺失时整个不渲染按钮',
)
record(
  'app-gates-on-capability',
  /onCreateEditableDocx=\{[\s\S]{0,200}supportsEditableDocx\?\.\(\)/.test(app),
  'App 必须在 supportsEditableDocx() 为真时才传这个回调',
)
record(
  'capability-reads-context-at-call-time',
  /getContext\(\)/.test(bridge) && /supportsEditableDocx\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,200}getContext\(\)/.test(bridge),
  '能力判定必须在调用时读上下文：init 晚于桥安装，安装时判定会永远是 no',
)

// ── 6) 扫描件与失败原因必须各说各的话 ───────────────────────────────────
const appHandler = fnBody(app, 'createEditableDocx')
record('app-reports-each-failure', appHandler !== null, 'App 里没有 createEditableDocx 处理函数')
if (appHandler) {
  for (const reason of ['password-required', 'no-source', 'empty-output', 'save-failed']) {
    record(
      `app-distinguishes-${reason}`,
      appHandler.includes(reason),
      `App 必须单独处理 ${reason}，不能并成一句「转换失败」`,
    )
  }
  record(
    'app-surfaces-scanned-copy',
    appHandler.includes('aiPdfEditableDocxScanned'),
    '扫描件必须单独提示，否则用户以为拿到的是可编辑文字',
  )
}

// ── 7) 20 语言键集完整（createI18n 要求完全一致，漏一个即编译错） ─────────
const NEW_KEYS = [
  'aiPdfEditableDocx',
  'aiPdfEditableDocxTip',
  'aiPdfEditableDocxRunning',
  'aiPdfEditableDocxDone',
  'aiPdfEditableDocxScanned',
  'aiPdfEditableDocxNoSource',
  'aiPdfEditableDocxPassword',
  'aiPdfEditableDocxFailed',
  'aiPdfEditableDocxEmpty',
  'aiPdfEditableDocxSaveFailed',
]
const dicts = strings.slice(strings.indexOf('export const strings = {'))
const langs = [...dicts.matchAll(/^ {2}'?([a-zA-Z-]+)'?: \{$/gm)].map((m) => m[1])
record('i18n-has-20-languages', langs.length === 20, `语言数 ${langs.length}，应为 20`)
for (const key of NEW_KEYS) {
  const occurrences = strings.split(`${key}:`).length - 1
  record(
    `i18n-key-${key}`,
    occurrences === langs.length,
    `${key} 出现 ${occurrences} 次，应为 ${langs.length} 次（每语言一次）`,
  )
}

const failed = checks.filter((c) => !c.ok)
if (asJson) {
  console.log(JSON.stringify({ total: checks.length, failed: failed.length, checks }, null, 2))
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}`)
    if (!check.ok) console.log(`      ${check.detail}`)
  }
  console.log(
    `[pdf-editable-docx] ${checks.length - failed.length}/${checks.length} invariants hold`,
  )
}
process.exit(failed.length === 0 ? 0 : 1)

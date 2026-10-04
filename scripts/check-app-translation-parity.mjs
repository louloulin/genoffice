/**
 * check-app-translation-parity.mjs — 各应用整篇翻译能力对等门禁。
 *
 * 背景：计划《GenOffice × DataflareWork 文档翻译生产化计划 v2》要求
 * “各应用 `translate` 命令存在性 + 应用回写路径”成为门禁。此前只有 docx 有整篇
 * 翻译。docs/sheets/slides/pdf/markdown/html 现已全部接入共享管线；本门禁核对的是**声明与源码是否一致**，
 * 命令 —— 宿主点“翻译全文”在未接线的应用里毫无反应，也不报错。
 *
 * 这个门禁**不是**“四个都必须已实现”——那会让 CI 长期红、然后被加豁免、
 * 最后什么也拦不住。它是**声明驱动**的：
 *   1. `TRANSLATION_APPS` 显式声明每个应用当前真实具备哪些能力；
 *   2. 逐条回到源码里验证声明（`translateDocument` 调用、宿主命令注册、回写路径）；
 *   3. 声明与源码矛盾 → 失败（例如声明了整篇翻译却没有 `translateDocument`）；
 *   4. 覆盖率打印在输出里，缺口是可见的既定事实，而不是被门禁掩盖。
 *
 * 用法：node scripts/check-app-translation-parity.mjs [--json] [--require=whole-document,host-command]
 * 退出码：0 = 声明与源码一致；1 = 有声明不实；2 = 目标文件缺失无法校验。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')
const requireArg = process.argv.find((arg) => arg.startsWith('--require='))
const required = new Set(
  requireArg
    ? requireArg.slice('--require='.length).split(',').map((item) => item.trim()).filter(Boolean)
    : [],
)

/**
 * 能力矩阵。**改这里之前先改代码** —— 门禁会核对。
 *
 * `writeBack` 的取值说明回写落点，读者不必去翻每个应用的实现：
 *   'in-place'  原地覆盖（docx 段落 / xlsx 单元格）
 *   'adjacent'  写到旁边（xlsx 双语写右侧新列）
 *   'in-frame'  同一文本框内追加（pptx 双语，原文在上译文在下）
 */
const TRANSLATION_APPS = [
  {
    app: 'docs',
    documentType: 'docx',
    wholeDocument: true,
    hostCommand: true,
    bilingual: true,
    writeBack: 'in-place',
    // ProseMirror transaction chain — the docx write is `chain.insertContentAt`,
    // which is why a generic "setValue/editText" probe would miss it.
    writePrimitives: ['insertContentAt('],
    adapter: 'apps/docs/src/renderer/ai/AiPanel.tsx',
    hostHandler: 'apps/docs/src/renderer/App.tsx',
    hostBridge: 'apps/docs/src/renderer/web-bridge.ts',
    ribbonTab: { binding: 'apps/docs/src/renderer/components/ribbon-translate-tab.tsx', host: 'apps/docs/src/renderer/components/Ribbon.tsx', id: 'translate', hostImport: 'apps/docs/src/renderer/App.tsx' },
  },
  {
    app: 'sheets',
    documentType: 'xlsx',
    wholeDocument: true,
    hostCommand: true,
    bilingual: true,
    writeBack: 'adjacent',
    writePrimitives: ['setValue(', 'applySheetTranslations'],
    adapter: 'apps/sheets/src/renderer/ai/document-translate.ts',
    hostHandler: 'apps/sheets/src/renderer/App.tsx',
    hostBridge: 'apps/sheets/src/renderer/web-bridge.ts',
    ribbonTab: { binding: 'apps/sheets/src/renderer/ribbon-translate-tab.tsx', host: 'apps/sheets/src/renderer/ExcelShell.tsx', id: 'Translate', hostImport: 'apps/sheets/src/renderer/App.tsx' },
  },
  {
    app: 'slides',
    documentType: 'pptx',
    wholeDocument: true,
    hostCommand: true,
    bilingual: true,
    // Bilingual renders inside the same text frame ("原文段落 + 译文段落"):
    // the slides API has no shape-insert op, so a second box beside the
    // original is not available. Recorded as `in-frame` so the trade-off is
    // visible here rather than discovered by a user.
    writeBack: 'in-frame',
    // `editText` is the renderer's call into the `slides:edit-text` op, which
    // re-runs layout; `applyDeckTranslations` is the reviewed-write entry point.
    writePrimitives: ['editText(', 'applyDeckTranslations'],
    adapter: 'apps/slides/src/renderer/ai/document-translate.ts',
    hostHandler: 'apps/slides/src/renderer/App.tsx',
    hostBridge: 'apps/slides/src/renderer/web-bridge.ts',
    ribbonTab: { binding: 'apps/slides/src/renderer/components/ribbon-translate-tab.tsx', host: 'apps/slides/src/renderer/components/Ribbon.tsx', id: 'translate', hostImport: 'apps/slides/src/renderer/App.tsx' },
  },
  {
    app: 'pdf',
    documentType: 'pdf',
    wholeDocument: true,
    hostCommand: true,
    bilingual: true,
    // A PDF has no editable document model in the renderer, so "replace" is a
    // content-stream rebuild queued as a pending edit and "bilingual" is a
    // stacked text insert below the original — the same two ops the manual
    // text editor produces, replayed by `pdf:save` in the main process.
    writeBack: 'pending-edit',
    writePrimitives: [
      'buildPdfReplaceInput',
      'buildPdfBilingualInput',
      'applyPdfTranslations',
      'applyTextEdits',
      'commitTextInserts',
    ],
    adapter: 'apps/pdf/src/renderer/ai/document-translate.ts',
    hostHandler: 'apps/pdf/src/renderer/App.tsx',
    hostBridge: 'apps/pdf/src/renderer/web-bridge.ts',
    ribbonTab: { binding: 'apps/pdf/src/renderer/components-ribbon-translate-tab.tsx', host: 'apps/pdf/src/renderer/App.tsx', id: 'translate', hostImport: 'apps/pdf/src/renderer/App.tsx' },
  },
  {
    app: 'markdown',
    documentType: 'markdown',
    wholeDocument: true,
    hostCommand: true,
    bilingual: true,
    // ProseMirror text blocks rewritten through the app's own op vocabulary:
    // `replaceText` / `insertContent` are compiled by `applyMarkdownTranslations`,
    // the same entry point the AI's `apply_ops` tool and the review dialog use.
    writeBack: 'in-place',
    writePrimitives: ['applyMarkdownTranslations', 'replaceText', 'insertContent'],
    adapter: 'apps/markdown/src/renderer/ai/document-translate.ts',
    hostHandler: 'apps/markdown/src/renderer/App.tsx',
    hostBridge: 'apps/markdown/src/renderer/web-bridge.ts',
    // 未保存广播在桥里（save 落盘后翻 dirty），不在 App.tsx 里。
    dirtyBroadcast: 'apps/markdown/src/renderer/web-bridge.ts',
  },
  {
    app: 'html',
    documentType: 'html',
    wholeDocument: true,
    hostCommand: true,
    bilingual: true,
    // The parse map's text nodes are rewritten through the shared `HtmlOp`
    // vocabulary: `set_text_node` in place, `insert_html` for the bilingual
    // sibling block, compiled by `applyHtmlTranslations` into the app's own
    // dispatcher (`applyOps` → `compileOps` → patches).
    writeBack: 'in-place',
    writePrimitives: ['applyHtmlTranslations', 'set_text_node', 'insert_html'],
    adapter: 'apps/html/src/renderer/ai/document-translate.ts',
    hostHandler: 'apps/html/src/renderer/App.tsx',
    hostBridge: 'apps/html/src/renderer/web-bridge.ts',
    // 未保存广播在桥里（html:save 落盘后翻 dirty），不在 App.tsx 里。
    dirtyBroadcast: 'apps/html/src/renderer/web-bridge.ts',
  },
]

const failures = []
const coverage = []

/** 从 `marker` 处的 `(` 起做圆括号配平，切出调用实参（不含最外层括号）。 */
function sliceCallArgsAt(src, at) {
  const open = at
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

/**
 * 全部 `marker` 调用点的实参。**取全部而不是第一个**：四个 web-bridge 的注释里都
 * 写着 `dataflare.install()`（解释为什么 context 要在调用时才读），`indexOf` 会先
 * 命中那处注释，配平出一个空串，于是三个真接线的应用被判红（第一版就假红过）。
 * 注释里的 `install()` 紧跟 `)`，切出空串，天然不匹配；真调用点才带实参。
 */
function sliceCallArgs(src, marker) {
  const out = []
  let at = src.indexOf(marker)
  while (at >= 0) {
    const args = sliceCallArgsAt(src, at + marker.length - 1)
    if (args !== null) out.push(args)
    at = src.indexOf(marker, at + marker.length)
  }
  return out
}

/**
 * 监听注册是否落在组件的 `return` 之前。
 *
 * sheets 的宿主命令 `useEffect` 曾整块写在 `App()` 的 `return ( … )` **之后**：
 * TypeScript 不报（`tsc` 不做可达性分析）、单测不红、门禁前两段也全绿（文件里
 * 确实有监听字样、确实有 `translate` 分支），而运行期那段代码根本不执行 ——
 * minifier 直接把它当死代码丢掉，于是产物里连 `cancel-translation` 字面量都没有。
 * 症状是宿主「翻译全文」对 xlsx 完全静默失效。
 *
 * 判据：定位包含监听的最外层函数，检查它的首个顶层 `return` 是否在监听之前。
 * `return` 必须匹配行首两空格 —— 文件里排在前面的其它函数（各自有自己的 return）
 * 不该被算进组件。
 */
function listenerBeforeComponentReturn(src, needle) {
  const lines = src.split('\n')
  const listenAt = lines.findIndex((line) => line.includes(needle) && line.includes('addEventListener'))
  if (listenAt < 0) return null
  let fnStart = -1
  for (let i = listenAt; i >= 0; i--) {
    if (/^(export\s+)?(default\s+)?(function|const|async function)\s/.test(lines[i])) {
      fnStart = i
      break
    }
  }
  if (fnStart < 0) return null
  for (let i = fnStart + 1; i < listenAt; i++) {
    if (/^  return\b/.test(lines[i])) return false
  }
  return true
}

function read(rel) {
  const file = resolve(REPO_DIR, rel)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

for (const entry of TRANSLATION_APPS) {
  const checks = []
  const adapter = entry.adapter ? read(entry.adapter) : null
  if (entry.adapter && adapter === null) {
    failures.push(`${entry.app}: 找不到声明的抽取/回写模块 ${entry.adapter}`)
    continue
  }
  const handler = entry.hostHandler ? read(entry.hostHandler) : null
  if (entry.hostHandler && handler === null) {
    failures.push(`${entry.app}: 找不到声明的宿主命令宿主文件 ${entry.hostHandler}`)
    continue
  }
  const bridge = entry.hostBridge ? read(entry.hostBridge) : null
  if (entry.hostBridge && bridge === null) {
    failures.push(`${entry.app}: 找不到声明的宿主命令桥文件 ${entry.hostBridge}`)
    continue
  }

  // 1) 整篇翻译：必须真的走共享管线
  if (entry.wholeDocument) {
    const usesPipeline = (adapter ?? '').includes('translateDocument(')
    checks.push({ name: '整篇翻译走 translateDocument', ok: usesPipeline })
    if (!usesPipeline) failures.push(`${entry.app}: 声明 wholeDocument，但抽取/回写模块没有调用 translateDocument(`)
  } else {
    checks.push({ name: '整篇翻译（未声明）', ok: true })
  }

  // 2) 宿主 translate 命令：**三段**都要在 —— 应用监听、应用有分支、桥真的转发。
  //
  // 第三段（桥）曾长期缺失而门禁全绿：pdf 的 `dataflare.install({})` 是空字面量，
  // 于是 `App.tsx` 里那份完整的 translate / cancel-translation 处理永远收不到事件，
  // Dataflare 头部的「翻译全文」对 PDF **完全失效** —— 对话框不出现、不报错、
  // 零 console error。文档能打开很容易让人判为「接线通了」，因为 `init` 由
  // integration 自己消费、不经过 handlers.onCommand，只有宿主主动下发的命令走桥。
  // 前两段只覆盖应用侧，等于把接缝的一半钉住，另一半开着。
  if (entry.hostCommand) {
    const listens = (handler ?? '').includes('dataflare:office-command')
    const branches = /command\.type\s*===\s*'translate'/.test(handler ?? '')
    // 限定在某个 `dataflare.install(...)` 的实参范围内，避免文件别处恰好出现一次
    // dispatch 就假绿。
    const installArgs = sliceCallArgs(bridge ?? '', 'dataflare.install(')
    const forwards =
      installArgs.length > 0 &&
      installArgs.some((args) =>
        /dispatchEvent\s*\(\s*new CustomEvent\s*\(\s*'dataflare:office-command'/.test(args),
      )
    checks.push({ name: '监听 dataflare:office-command', ok: listens })
    checks.push({ name: '处理 translate 命令', ok: branches })
    checks.push({ name: '桥转发宿主命令（dataflare.install 实参）', ok: forwards })
    const reachable = listenerBeforeComponentReturn(
      handler ?? '',
      "addEventListener('dataflare:office-command'",
    )
    checks.push({ name: '监听在组件 return 之前（不是死代码）', ok: reachable !== false })
    if (reachable === false) {
      failures.push(
        `${entry.app}: dataflare:office-command 的监听写在组件的 return 之后 —— 整段是不可达的死代码，运行期从不执行，「翻译全文」静默失效`,
      )
    }
    if (!listens) failures.push(`${entry.app}: 声明 hostCommand，但宿主文件没有监听 dataflare:office-command`)
    if (!branches) failures.push(`${entry.app}: 声明 hostCommand，但宿主文件没有 translate 命令分支`)
    if (!forwards) {
      failures.push(
        `${entry.app}: 声明 hostCommand，但 web-bridge.ts 的 dataflare.install({...}) 实参里没有把命令 dispatch 成 dataflare:office-command —— 宿主下发的命令到不了应用，「翻译全文」静默失效`,
      )
    }
  } else {
    checks.push({ name: '宿主 translate 命令（未声明）', ok: true })
  }

  // 3) 回写落点：逐条核对声明里点名的写入原语
  //
  // 这里刻意**不用**一把通用正则。每个宿主的写回原语不同（ProseMirror 的
  // `insertContentAt`、Univer 的 `setValue`、slides 的 `slides:edit-text`），
  // 用通用词表的结果是「找不到就当没有」——门禁会在真缺回写时也变绿。
  if (entry.writeBack !== 'none') {
    const haystack = `${adapter ?? ''}\n${handler ?? ''}`
    for (const primitive of entry.writePrimitives) {
      const found = haystack.includes(primitive)
      checks.push({ name: `回写原语 ${primitive}`, ok: found })
      if (!found) {
        failures.push(`${entry.app}: 声明 writeBack=${entry.writeBack}，但源码里找不到写入原语 ${primitive}`)
      }
    }
  } else {
    checks.push({ name: '回写路径（未声明）', ok: true })
  }

  // 4) 独立翻译页签：必须真的挂在 ribbon 上，而不是只有一个孤立组件
  //
  // 上一段只钉「宿主命令能不能到应用」。这一段钉反向的入口：用户自己点 ribbon 里的
  // 「翻译」页签。少任何一环的症状都极其安静 —— 组件建好了但没 import，页签列表里
  // 没有那个 id，或者 App 没把 `onTranslateStart` 传下去：类型检查在 pages 里全绿
  // （Ribbon 的 props 都是可选的），真机点下去是「翻译」两个字都找不到。
  if (entry.ribbonTab) {
    const binding = read(entry.ribbonTab.binding)
    const ribbon = read(entry.ribbonTab.host)
    const app = read(entry.ribbonTab.hostImport)
    const hasBinding = binding !== null && /export function TranslateTab\b/.test(binding)
    const wiredInRibbon = ribbon !== null && /<TranslateTab[\s>]/.test(ribbon)
    // 页签 id 必须真的进列表：匹配引号包起来的 `'translate'` / `'Translate'`，
    // 避免注释或字符串字面量里出现过就判绿。
    const idListed = ribbon !== null && new RegExp(`['"\`]${entry.ribbonTab.id}['"\`]`).test(ribbon)
    // App 侧必须把入口回调传下去，否则点「翻译全文」是死的。两种写法都算数：
    // docs 把整组回调收在 `ribbonActions` 里用 `{...ribbonActions}` 展开，
    // pdf 直接写 `onStart=`。只认其中一种会把另外两个应用判红。
    const appWired =
      app !== null && (/onTranslateStart[=:]/.test(app) || /onStart=\{?onTranslateStart/.test(app))
    checks.push({ name: '独立翻译页签绑定', ok: hasBinding })
    checks.push({ name: 'ribbon 渲染 <TranslateTab>', ok: wiredInRibbon })
    checks.push({ name: `ribbon 页签 id ${entry.ribbonTab.id} 已登记`, ok: idListed })
    checks.push({ name: 'App 传入 onTranslateStart', ok: appWired })
    if (binding === null) failures.push(`${entry.app}: 找不到声明的翻译页签绑定 ${entry.ribbonTab.binding}`)
    if (!hasBinding) failures.push(`${entry.app}: 翻译页签绑定没有导出 TranslateTab 组件`)
    if (!wiredInRibbon) failures.push(`${entry.app}: ribbon 里没有渲染 <TranslateTab> —— 独立翻译页签是死代码`)
    if (!idListed) failures.push(`${entry.app}: ribbon 页签列表里没有 '${entry.ribbonTab.id}'，用户找不到翻译入口`)
    if (!appWired) failures.push(`${entry.app}: App 没有向 ribbon 传 onTranslateStart，页签里的「翻译全文」点了没反应`)
  }

  // 5) --require：把“待办”升级成硬门禁
  for (const key of ['whole-document', 'host-command']) {
    if (!required.has(key)) continue
    const declared = key === 'whole-document' ? entry.wholeDocument : entry.hostCommand
    const field = key === 'whole-document' ? 'wholeDocument' : 'hostCommand'
    if (!declared) failures.push(`${entry.app}: --require=${key} 要求该能力，但 ${field} 声明为 false`)
  }

  coverage.push({ app: entry.app, documentType: entry.documentType, ...entry, checks })
}

// 6) 四应用翻译主按钮（scopeDocument）译文一致 —— M2-2 防漂移。
// 四应用 ribbon 共享 packages/ui/src/TranslationRibbonTab.tsx，主按钮文案来自各应用
// binding 传入的 i18n key：docs/slides/pdf = aiChipTranslate，sheets = appTranslate。
// 值层一旦漂移（某应用某语言换了叫法），用户在四个编辑器里看到四个不同的主按钮 ——
// 这正是 2026-10 收口前 docs/pdf 长句（「翻译全文」）、sheets/slides 短词（「翻译」）并存的样式。
// 结构性存在性由上面第 4 步管；这里钉**值一致**。
const LANGS = ['zh', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it', 'ru', 'ar', 'he', 'hi', 'th', 'id', 'ms', 'nl', 'pl', 'cs']
const BTN_KEY = {
  docs: { dir: 'apps/docs/src/renderer/i18n/ai', key: 'aiChipTranslate' },
  sheets: { dir: 'apps/sheets/src/renderer/i18n/app', key: 'appTranslate' },
  slides: { dir: 'apps/slides/src/renderer/i18n/ai', key: 'aiChipTranslate' },
}
const btnValues = { docs: {}, sheets: {}, slides: {}, pdf: {} }
for (const [app, cfg] of Object.entries(BTN_KEY)) {
  for (const lang of LANGS) {
    const p = resolve(REPO_DIR, cfg.dir, `${lang}.ts`)
    const m = existsSync(p) ? readFileSync(p, 'utf8').match(new RegExp(`${cfg.key}: '([^']+)'`)) : null
    if (m) btnValues[app][lang] = m[1]
    else failures.push(`${app}: 翻译主按钮 key ${cfg.key} 在 ${lang}.ts 缺失`)
  }
}
// pdf 的文案在单文件 strings.ts 的 20 个语言块里，块顺序固定（zh,en,ja,ko,fr,de,es,
// th,id,ru,ar,pt,it,pl,cs,nl,ms,he,hi,zh-TW）—— 按出现顺序对号。
const PDF_LANG_ORDER = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'th', 'id', 'ru', 'ar', 'pt', 'it', 'pl', 'cs', 'nl', 'ms', 'he', 'hi', 'zh-TW']
{
  const src = readFileSync(resolve(REPO_DIR, 'apps/pdf/src/renderer/i18n/strings.ts'), 'utf8')
  const vals = [...src.matchAll(/aiChipTranslate: '([^']+)'/g)].map((m) => m[1])
  if (vals.length !== PDF_LANG_ORDER.length) {
    failures.push(`pdf: strings.ts 的 aiChipTranslate 有 ${vals.length} 处，期望 ${PDF_LANG_ORDER.length} 处`)
  }
  PDF_LANG_ORDER.forEach((lang, i) => { if (vals[i] !== undefined) btnValues.pdf[lang] = vals[i] })
}
for (const lang of LANGS) {
  const vals = ['docs', 'sheets', 'slides', 'pdf'].map((app) => btnValues[app][lang])
  if (vals.some((v) => v === undefined)) continue // 缺失已在上面积累，不再重复报
  if (new Set(vals).size !== 1) {
    failures.push(
      `翻译主按钮文案漂移 @${lang}: docs='${btnValues.docs[lang]}' sheets='${btnValues.sheets[lang]}' slides='${btnValues.slides[lang]}' pdf='${btnValues.pdf[lang]}'`,
    )
  }
}

// 7) document-dirty 广播六应用齐备 —— M2-1 防漂移。
// 嵌入宿主时，标题栏的「未保存」标记依赖编辑器向宿主广播 document-dirty
// （只报 dirty=true，宿主在 document-saved 时清除）。docs 曾是唯一广播者，
// sheets/slides/pdf 缺席时宿主对三个格式永远不显示未保存状态。这里钉
// 「广播调用存在」，dirty 的触发语义由各 App.tsx 的实现注释自述。
//
// 广播的落点各应用不同：docs/sheets/slides/pdf 在 App.tsx，markdown/html 在桥里
// （save 落盘后翻 dirty）。`dirtyBroadcast` 声明后者，缺省仍看 hostHandler。
for (const entry of TRANSLATION_APPS) {
  const target = entry.dirtyBroadcast ?? entry.hostHandler
  const src = read(target)
  const broadcasts = src !== null && /postToEmbedParent\(\{\s*type: 'document-dirty'/.test(src)
  if (!broadcasts) {
    failures.push(
      `${entry.app}: ${target} 没有 postToEmbedParent({ type: 'document-dirty' ... }) —— 嵌入宿主的未保存标记对该格式静默失效`,
    )
  }
}

if (asJson) {
  console.log(JSON.stringify({ failures, coverage }, null, 2))
} else {
  console.log('\n=== 应用整篇翻译能力对等（声明 vs 源码）===')
  for (const entry of coverage) {
    const flags = [
      entry.wholeDocument ? '整篇' : '仅选区',
      entry.hostCommand ? '宿主命令' : '无宿主命令',
      entry.writeBack === 'none' ? '无回写' : `回写=${entry.writeBack}`,
    ].join(' · ')
    console.log(`  ${entry.app} (${entry.documentType}): ${flags}`)
    for (const check of entry.checks) {
      console.log(`    ${check.ok ? 'ok ' : '✗  '} ${check.name}`)
    }
  }
  const done = coverage.filter((entry) => entry.wholeDocument && entry.hostCommand).map((entry) => entry.app)
  console.log(`\n  完整覆盖：${done.length ? done.join(', ') : '(无)'}；缺口：${
    coverage.filter((entry) => !(entry.wholeDocument && entry.hostCommand)).map((entry) => entry.app).join(', ') || '(无)'
  }`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  console.log(
    `\n${failures.length === 0 ? '✓' : '✗'} APP TRANSLATION PARITY ${failures.length === 0 ? 'OK（声明与源码一致）' : `FAILED（${failures.length} 项）`}`,
  )
}

process.exit(failures.length === 0 ? 0 : 1)

/**
 * check-translation-apply-hardening.mjs — 「整篇翻译写回 + 交互」这一层的门禁。
 *
 * ## 为什么需要它
 *
 * 云盘整篇翻译在真机上跑通之后，又暴露出**一批界面完全正常、控制台零报错、
 * 既有门禁全绿**的缺陷。它们全部落在「译文算出来了 → 用户点应用 → 写进文档 →
 * 落盘」这条链路的缝里：
 *
 *   S/Y/Z/AA  双语应用**一段都没写进文档**，宿主仍报「翻译完成」——
 *             `insertContentAt` 用了 docs schema 里不存在的节点名 `paragraph`
 *             （真名 `docParagraph`，Tiptap 只 warn 不抛），末段 `range.to + 1`
 *             越界，且译文被塞进原文同一段而不是独立块。
 *   V         翻译步的 `completed` 被直接转发给宿主，用户还没点「应用」就
 *             看到「翻译完成」。
 *   W         `TranslateDialog.onApply` 声明为 `void`，写回失败被吞掉。
 *   X         错误只渲染在「非预览」分支里，而整篇翻译**永远走预览分支** ——
 *             红字在最需要它的模式下不显示。
 *   缺 range  计划里少一条就被静默过滤，产出半译文却报成功。
 *
 * 这些判据的共同点是**没有一条是运行时异常**，静态门禁是唯一能在 CI 里
 * 拦住「重构顺手改坏」的手段。用法：node scripts/check-translation-apply-hardening.mjs [--json]
 * 退出码：0 = 全部不变量成立；1 = 有不变量被破坏；2 = 目标文件/锚点缺失。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const AI_PANEL = resolve(REPO_DIR, 'apps/docs/src/renderer/ai/AiPanel.tsx')
const DIALOG = resolve(REPO_DIR, 'packages/ui/src/TranslateDialog.tsx')
const I18N_DIR = resolve(REPO_DIR, 'apps/docs/src/renderer/i18n/ai')

/** 注释里把正确写法抄一遍不算数，所以先剥注释再做结构断言。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`\\])\/\/[^\n]*$/gm, '$1')
}

/** 从 `anchor` 处的 `{` 起做括号配平，切出整个分支/函数体（跳过字符串与注释）。 */
function sliceBlock(source, anchor) {
  const start = source.indexOf(anchor)
  if (start < 0) return null
  const open = source.indexOf('{', start + anchor.length - 1)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
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

const checks = []
const record = (id, ok, detail) => checks.push({ id, ok, detail })

for (const [label, path] of [['AiPanel', AI_PANEL], ['TranslateDialog', DIALOG]]) {
  if (!existsSync(path)) {
    console.error(`[apply-hardening] target missing (${label}): ${path}`)
    process.exit(2)
  }
}

const aiPanelRaw = readFileSync(AI_PANEL, 'utf8')
const aiPanel = stripComments(aiPanelRaw)
const dialog = stripComments(readFileSync(DIALOG, 'utf8'))

// ── 1. 双语的落点：独立块 + 正确节点名 ────────────────────────────────────────
const applyImpl = sliceBlock(aiPanel, 'const applyTranslateImpl = useCallback(')
if (!applyImpl) {
  record('bilingual-insert-uses-docparagraph', false, '找不到 applyTranslateImpl 函数体')
  record('bilingual-insert-clamped', false, '函数体缺失')
  record('apply-aborts-on-missing-range', false, '函数体缺失')
} else {
  record(
    'bilingual-insert-uses-docparagraph',
    /insertContentAt\(\s*at,\s*\{\s*type:\s*'docParagraph'/.test(applyImpl) &&
      !/type:\s*'paragraph'/.test(applyImpl),
    '双语插入必须插 docs schema 的段落节点 `docParagraph`（真名，不是 `paragraph`）；写 `paragraph` 时 Tiptap 只 warn 不抛，译文一段都进不去',
  )
  record(
    'bilingual-insert-clamped',
    /Math\.min\(\s*entry\.range!\.to,\s*Math\.max\(\s*1,\s*size\s*-\s*1\s*\)\s*\)/.test(applyImpl),
    '双语插入位置必须夹到 `size - 1`：`range.to + 1` 对文档最后一段越界，末段译文永远丢失且静默',
  )
  record(
    'apply-aborts-on-missing-range',
    /appliedItems\.length\s*<\s*items\.length/.test(applyImpl) &&
      /throw new Error/.test(applyImpl),
    'applyTranslateImpl 必须在 `appliedItems.length < items.length`（有段落缺 range）时抛错，不能静默过滤后假装成功',
  )
}

// ── 2. 翻译步的 `completed` 不得抢先转发（用户还没点应用） ─────────────────────
record(
  'no-premature-completed-to-host',
  /if\s*\(event\.status\s*===\s*'completed'\)\s*return/.test(aiPanel),
  "AiPanel 的 onProgress 必须在 event.status === 'completed' 时提前 return —— 翻译步的 completed 只代表「译文算好了」，写回是弹窗的应用步",
)

// ── 3. 弹窗必须 await 应用结果，并在两种模式下都渲染错误 ───────────────────────
record(
  'apply-prop-promise-returning',
  /onApply:\s*\([^)]*\)\s*=>\s*void\s*\|\s*Promise<void>/.test(dialog),
  'TranslateDialog 的 onApply 必须声明为 `void | Promise<void>`；声明成 `void` 时写回失败被吞掉，进度条永挂',
)
record(
  'apply-handler-awaited',
  /await onApply\(/.test(dialog),
  'handleApply 必须 `await onApply(...)` 并把异常落到 setError',
)
{
  const bannerAt = dialog.indexOf('ai-translate-dialog-error-banner')
  const previewAt = dialog.indexOf('ai-translate-dialog-preview')
  record(
    'error-banner-rendered-before-preview',
    bannerAt >= 0 && previewAt >= 0 && bannerAt < previewAt,
    '错误红字必须渲染在 `ai-translate-dialog-preview` **之前**（整篇翻译永远走预览分支，挂在非预览分支里的 error 永远不显示）',
  )
}

// ── 4. 五个翻译期 i18n key 必须每个语言包都有（漏一个就是一个硬编码英文） ───────
if (!existsSync(I18N_DIR)) {
  console.error(`[apply-hardening] i18n dir missing: ${I18N_DIR}`)
  process.exit(2)
}
const REQUIRED_KEYS = [
  'aiTranslateCancel',
  'aiTranslateSaveMemory',
  'aiTranslateSavingMemory',
  'aiTranslateMemorySavedCount',
  'aiTranslateMemorySaved',
]
{
  const locales = readdirSync(I18N_DIR).filter((f) => f.endsWith('.ts'))
  const missing = []
  for (const file of locales) {
    const body = readFileSync(resolve(I18N_DIR, file), 'utf8')
    for (const key of REQUIRED_KEYS) {
      if (!new RegExp(`\\b${key}\\s*:`).test(body)) missing.push(`${file}:${key}`)
    }
  }
  record(
    'translation-i18n-key-parity',
    locales.length >= 19 && missing.length === 0,
    `五个翻译期 key 必须出现在每个语言包（共 ${locales.length} 个语言包）；缺失：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` … 共 ${missing.length} 处` : ''}`,
  )
}

const failed = checks.filter((check) => !check.ok)
if (asJson) {
  console.log(JSON.stringify({ total: checks.length, failed: failed.length, checks }, null, 2))
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}`)
    if (!check.ok) console.log(`      ${check.detail}`)
  }
  console.log(`[apply-hardening] ${checks.length - failed.length}/${checks.length} invariants hold`)
}
process.exit(failed.length === 0 ? 0 : 1)

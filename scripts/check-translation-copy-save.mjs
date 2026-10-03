/**
 * check-translation-copy-save.mjs — 「译文另存为翻译副本」这条路径的门禁。
 *
 * ## 为什么需要它
 *
 * 整篇翻译的产物落云盘有两条路：覆盖当前版本（非破坏性存新版本）或另存为同目录的
 * 翻译副本。这两条路的差别是**「磁盘上的原文还在不在」**，而这个差别在代码里只由
 * 三件事决定，全部藏在 `file-actions.ts` 的一个分支和 `save()` 的一个判据里：
 *
 *   1. 副本分支必须真的把 `saveAsFileName` 传下去（否则 SDK 会当普通保存处理，
 *      直接把译文写进原文条目）；
 *   2. 副本分支**不能**清 `dirtyRef`（写出去的是另一个条目，磁盘上的原文仍是未翻译
 *      那份；清了就等于告诉关闭守卫「没有待保存改动」，用户再按一次 Ctrl+S 就直接
 *      覆盖原文 —— 恰好是这个选项承诺不做的事）；
 *   3. `save()` 的「复用上一次结果」判据必须排除副本保存（否则一次队列里的
 *      Ctrl+S 可能复用副本保存的结果，当成已经落盘）。
 *
 * 这三条**任何一条不成立都不报错**：没有异常、没有红字，译文安静地盖掉原文。宿主
 * 面板那边也看不出区别（两边都是 `ok: true`）。所以它们必须是门禁。
 *
 * ## 门禁形态与它的边界
 *
 * 这是**作用域化的结构断言**：脚本用括号配平把「副本分支」的函数体切出来，只在
 * 这段里查上面的三条，而不是在整份文件里查字符串是否存在。后者会被 `false &&`、
 * 注释、或者另一个函数里的同名调用绕过 —— 那样的门禁看起来在跑，实际什么都拦不
 * 住。这里仍然拦不住「有人故意在分支里写 `if (false)` 再放一段错误代码」，
 * 但那种改动会被人为藏起来，不在静态门禁能覆盖的范围内；本门禁覆盖的是
 * **重构与新增代码顺手破坏语义**这一类真实风险。
 *
 * 用法：node scripts/check-translation-copy-save.mjs [--json]
 * 退出码：0 = 三条不变量都成立；1 = 有不变量被破坏；2 = 目标文件/锚点缺失。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const FILE_ACTIONS = resolve(REPO_DIR, 'apps/docs/src/renderer/file-actions.ts')
const AI_PANEL = resolve(REPO_DIR, 'apps/docs/src/renderer/ai/AiPanel.tsx')
const APP_TSX = resolve(REPO_DIR, 'apps/docs/src/renderer/App.tsx')

/**
 * 从 `anchor` 处的 `{` 起做括号配平，切出整个分支体。
 * 配平会跳过字符串与注释，否则分支里一句带括号的注释就能让切出来的范围整个偏移。
 */
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

if (!existsSync(FILE_ACTIONS)) {
  console.error(`[copy-save] target missing: ${FILE_ACTIONS}`)
  process.exit(2)
}
const fileActions = readFileSync(FILE_ACTIONS, 'utf8')

// 1. 副本分支把文件名一路传到了 saveDocx
const branch = sliceBlock(fileActions, 'if (saveAsCopyFileName && savedPath)')
if (!branch) {
  record('copy-branch-present', false, 'file-actions.ts 里找不到 `if (saveAsCopyFileName && savedPath)` 分支')
  record('copy-save-passes-filename', false, '分支缺失，无法校验')
  record('copy-branch-keeps-dirty', false, '分支缺失，无法校验')
} else {
  record('copy-branch-present', true, '副本分支存在')
  record(
    'copy-save-passes-filename',
    /window\.desktop\.saveDocx\(\s*savedPath,\s*buffer,\s*auto,\s*\{\s*saveAsFileName:\s*saveAsCopyFileName,?\s*\}\s*\)/.test(
      branch,
    ),
    '副本分支必须调用 saveDocx(savedPath, buffer, auto, { saveAsFileName: saveAsCopyFileName })',
  )
  record(
    'copy-branch-keeps-dirty',
    !branch.includes('dirtyRef.current = false'),
    '副本分支里出现 `dirtyRef.current = false`：写出去的是另一个条目，清 dirty 会让下一次 Ctrl+S 覆盖原文',
  )
}

// 2. save() 的复用判据排除副本保存
const saveBody = sliceBlock(fileActions, 'export function save(')
record(
  'reuse-predicate-excludes-copy',
  Boolean(saveBody) && /!\s*saveAsCopyFileName/.test(saveBody),
  'save() 的复用判据必须含 `!saveAsCopyFileName`，否则队列里的 Ctrl+S 可能复用副本保存的结果',
)

// 3. AiPanel 只在用户真的选了 copy 时才落副本
if (!existsSync(AI_PANEL)) {
  console.error(`[copy-save] target missing: ${AI_PANEL}`)
  process.exit(2)
}
const aiPanel = readFileSync(AI_PANEL, 'utf8')
record(
  'copy-save-gated-on-choice',
  /applySaveTarget === 'copy'/.test(aiPanel) && /onSaveTranslatedCopy\(translatedFileName\)/.test(aiPanel),
  'AiPanel 必须以 `applySaveTarget === \'copy\'` 为前提调用 onSaveTranslatedCopy(translatedFileName)',
)

// 4. 桌面构建（无云盘）不提供副本入口：saveDocx 在 Electron 侧忽略 saveAsFileName，
//    传下去等于悄悄改成覆盖原文，所以入口必须整个不存在。
if (!existsSync(APP_TSX)) {
  console.error(`[copy-save] target missing: ${APP_TSX}`)
  process.exit(2)
}
const appTsx = readFileSync(APP_TSX, 'utf8')
record(
  'copy-save-embedded-only',
  /dataflareOfficeBridge\?\.isEmbedded/.test(appTsx) &&
    /saveImpl\(fileCtxRef\.current,\s*false,\s*false,\s*undefined,\s*fileName\)/.test(appTsx),
  'App.tsx 的副本保存入口必须以 dataflareOfficeBridge.isEmbedded 为前提（桌面构建的 saveDocx 会忽略 saveAsFileName）',
)

const failed = checks.filter((check) => !check.ok)
if (asJson) {
  console.log(JSON.stringify({ total: checks.length, failed: failed.length, checks }, null, 2))
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}`)
    if (!check.ok) console.log(`      ${check.detail}`)
  }
  console.log(`[copy-save] ${checks.length - failed.length}/${checks.length} invariants hold`)
}
process.exit(failed.length === 0 ? 0 : 1)

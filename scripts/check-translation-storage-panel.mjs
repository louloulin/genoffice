/**
 * check-translation-storage-panel.mjs — 术语库 / 翻译记忆面板的三应用接入门禁。
 *
 * ## 这个门禁拦的是哪一类事故
 *
 * 面板的数据不在应用里，在云盘空间里（宿主 `/crmapi/drive/translation/*`）。因此
 * 「有没有面板」和「面板能不能读到数据」是两件独立的事，而**后者失败时完全静默**：
 * 客户端是 `null` 时面板渲染的是一句「术语在云盘里，这里读不到」——一个合理的解释，
 * 不是错误提示。用户看到一个功能完整、点开告诉你功能不可用的界面，日志里什么都没有。
 *
 * 真实踩过一次：三个 web-bridge 都写成
 *
 *     translationStorage: dataflareContext() ? createDataflareTranslationStorage({...}) : null
 *
 * 而 `createDesktopApi(...)` 的对象字面量在 `dataflare.install()` **之前**求值，宿主
 * 的 `init` 命令又只能在 `install()` 之后才到 —— 于是每一次加载这里都答 `null`，客户端
 * 被永久钉死。编译绿、单测绿（单测里确实没有宿主，`null` 正是期望值）、生产全挂。
 *
 * 所以门禁钉的是**构造时机的判据**（必须是同步可得的 `isEmbeddedInHost()`，不能是
 * 运行期才有的 context），以及「三应用一个都不能少」的对等性。
 *
 * 用法：node scripts/check-translation-storage-panel.mjs [--json]
 * 退出码：0 = 声明与源码一致；1 = 有声明不实；2 = 目标文件缺失。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

/** 面板在源码里用到的文案键。少一个就会在某个语言下渲染成 key 名本身。 */
const PANEL_KEYS = [
  'aiGlossaryPanelTitle', 'aiGlossaryTab', 'aiMemoryTab', 'aiGlossarySource',
  'aiGlossaryTarget', 'aiGlossaryAdd', 'aiGlossaryRemove', 'aiGlossaryEmpty',
  'aiMemoryEmpty', 'aiScopeShared', 'aiScopeSpace', 'aiGlossaryRetry',
  'aiStorageUnavailable',
]
const LANGS = [
  'ar', 'cs', 'de', 'en', 'es', 'fr', 'he', 'hi', 'id', 'it', 'ja', 'ko', 'ms',
  'nl', 'pl', 'pt', 'ru', 'th', 'zh-TW', 'zh',
]

/**
 * 能力矩阵。**声明驱动**：改这里之前先改代码。
 *
 * `apiGlobal` 是该应用挂 `window` 上的全局名（sheets 是 `desktopApi`，
 * 其余是 `desktop`）—— 三者不一致是历史事实，门禁照实记录而不是强行统一。
 */
const APPS = [
  { app: 'docs', webBridge: 'apps/docs/src/renderer/web-bridge.ts', apiGlobal: 'desktop', panel: 'apps/docs/src/renderer/ai/AiPanel.tsx' },
  { app: 'sheets', webBridge: 'apps/sheets/src/renderer/web-bridge.ts', apiGlobal: 'desktopApi', panel: 'apps/sheets/src/renderer/ai/AiChatPanel.tsx' },
  { app: 'slides', webBridge: 'apps/slides/src/renderer/web-bridge.ts', apiGlobal: 'desktop', panel: 'apps/slides/src/renderer/ai/AiPanel.tsx' },
]

const checks = []
const record = (id, ok, detail) => checks.push({ id, ok, detail })
const read = (rel) => {
  const file = resolve(REPO_DIR, rel)
  if (!existsSync(file)) {
    console.error(`[storage-panel] target missing: ${file}`)
    process.exit(2)
  }
  return readFileSync(file, 'utf8')
}

for (const { app, webBridge, apiGlobal, panel } of APPS) {
  const bridge = read(webBridge)

  // 1. 构造时机的判据：必须是同步可得的嵌入检测，不能是运行期才有的 context。
  //    这两条要一起查：只有 `isEmbeddedInHost` 而没有 import，或只有 import 而
  //    仍然按 context 判定，都是半修。
  record(
    `${app}/gate-on-isEmbedded`,
    /translationStorage:\s*isEmbeddedInHost\(\)/.test(bridge),
    `${webBridge}: translationStorage 必须以 isEmbeddedInHost() 判定（context 在 install() 之后才有）`,
  )
  record(
    `${app}/no-context-gate`,
    !/translationStorage:[\s\S]{0,40}?(getContext\(\)|Context\(\))/.test(bridge),
    `${webBridge}: translationStorage 不得以 getContext() / dataflareContext() 判定`,
  )
  // 2. 空间 id 必须按调用时读取，否则用户换空间后面板还写在上一个空间里。
  record(
    `${app}/space-read-per-call`,
    // docs 走本地别名 `dataflareContext()`，sheets / slides 直接用
    // `dataflare.getContext()` —— 两种写法都算「每次调用现读」。
    /getSpaceId:\s*\(\)\s*=>\s*(?:dataflare\.)?(?:getContext|dataflareContext)\(\)\?\.spaceId/.test(bridge),
    `${webBridge}: getSpaceId 必须是每次调用现读 context 的箭头函数`,
  )

  // 3. AI 面板真的渲染了这个面板，且客户端取自该应用自己的全局名。
  const panelSrc = read(panel)
  record(
    `${app}/panel-rendered`,
    /<TranslationStoragePanel[\s\S]{0,400}?client=\{window\.(?:desktop|desktopApi)\?\.translationStorage \?\? null\}/.test(
      panelSrc,
    ),
    `${panel}: 必须渲染 <TranslationStoragePanel client={window.${apiGlobal}?.translationStorage ?? null}>`,
  )
  record(
    `${app}/panel-entry`,
    /onClick=\{\(\)\s*=>\s*setStoragePanelOpen\(true\)\}/.test(panelSrc) &&
      /aria-label=\{t\('aiGlossaryPanelTitle'\)\}/.test(panelSrc),
    `${panel}: 面板入口按钮缺失（打开动作或 aria-label）`,
  )

  // 4. 20 种语言一个键都不能少。defineStrings 会在**类型**上抓缺键，抓不到的是
  //    「某个语言文件忘了同步」这种只在运行时渲染成 key 名的情况。
  const missing = []
  for (const lang of LANGS) {
    const file = resolve(REPO_DIR, `apps/${app}/src/renderer/i18n/ai/${lang}.ts`)
    if (!existsSync(file)) { missing.push(`${lang}(文件缺失)`); continue }
    const src = readFileSync(file, 'utf8')
    for (const key of PANEL_KEYS) {
      if (!new RegExp(`^  ${key}: `, 'm').test(src)) missing.push(`${lang}.${key}`)
    }
  }
  record(
    `${app}/i18n-complete`,
    missing.length === 0,
    `${app}: 面板文案键缺失 → ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` …共 ${missing.length}` : ''}`,
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
  console.log(`[storage-panel] ${checks.length - failed.length}/${checks.length} invariants hold`)
}
process.exit(failed.length === 0 ? 0 : 1)

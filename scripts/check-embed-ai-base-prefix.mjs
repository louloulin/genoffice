/**
 * check-embed-ai-base-prefix.mjs — 嵌入宿主时 AI base URL 必须带部署路径前缀。
 *
 * ## 为什么需要它
 *
 * 四个应用（docs / sheets / slides / pdf）的 AI 面板都通过
 * `getWebServerUrl()` 算出 web-server 的基址，再拼 `/api/ai/stream`。
 * 嵌进 Dataflare 时整个 SPA 挂在 `/office-engine/` 下，于是基址也必须是
 * `/office-engine`；漏掉前缀时请求会打到**宿主根路径**上的别的服务
 * （Dataflare 根路径是 WeKnora 的 `/api/`），表现为 401 / 404，
 * 而不是一条可读的 AI 报错 —— 用户和排障的人都会往「模型配错了」上找。
 *
 * 真实踩过的形态是**分支覆盖不全**：`url.hostname` 的两个分支（localhost 与
 * 「否则使用当前域名」）里，只有后者记得拼 `resolveEmbedPathPrefix(url.pathname)`，
 * localhost 分支图省事写了 `return url.origin`。本机开发（localhost）恰好
 * 一路绿灯，等到真的嵌进宿主、在 localhost 上打开，才 404。
 * slides 更彻底：四个分支一个都没拼。
 *
 * 这类缺陷**编译不报错、单测不红、运行时只在特定部署形态下 404**，所以只能
 * 靠门禁。
 *
 * 同一个成因在 IPC 通道上又咬了一次：slides 的 `web-bridge.ts` 调
 * `createHttpIpcTransport()` 时没传 `pathPrefix`，于是满屏 `404 /api/ipc/*`，
 * 幻灯片永远停在「正在打开…」。而 docs / sheets / pdf 三家都传了。所以门禁覆盖
 * **两处**基址：AI 流（`getWebServerUrl` 的 return）与 IPC 传输
 * （`createHttpIpcTransport(...)` 的实参）。
 *
 * ## 门禁形态
 *
 * 作用域化结构断言：把 `getWebServerUrl` 的函数体切出来，只在它的 `return`
 * 语句上判定 —— 而不是全文 grep `resolveEmbedPathPrefix`（那会被注释里的
 * 一次出现骗过，实际每个分支都漏）。IPC 那一半则按「每个
 * `createHttpIpcTransport(` 调用点都必须带 `pathPrefix` 实参」判定。
 *
 * 判据：凡是**从 `url.` 派生**的 return（即依赖 `window.location`）都必须带
 * `resolveEmbedPathPrefix`；唯一豁免是 vite 开发代理分支，它返回写死的
 * `:8080` 开发服、不经过宿主。每个文件只允许有一个这样的豁免。
 *
 * 用法：node scripts/check-embed-ai-base-prefix.mjs [--json]
 * 退出码：0 = 四个应用都不变量成立；1 = 有分支漏前缀；2 = 目标文件/锚点缺失。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const APPS = ['docs', 'sheets', 'slides', 'pdf']

/** 从 `function getWebServerUrl` 处的 `{` 起做花括号配平，切出整个函数体。 */
function sliceFunction(src, name) {
  const decl = src.indexOf(`function ${name}(`)
  if (decl < 0) return null
  const open = src.indexOf('{', decl)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

const failures = []
const details = []

for (const app of APPS) {
  const file = resolve(REPO_DIR, `apps/${app}/src/renderer/ai/transports.ts`)
  if (!existsSync(file)) {
    failures.push(`${app}: 找不到 ${file}`)
    continue
  }
  const src = readFileSync(file, 'utf8')

  const body = sliceFunction(src, 'getWebServerUrl')
  if (body === null) {
    failures.push(`${app}: transports.ts 里没有 getWebServerUrl 函数`)
    continue
  }

  if (!/import\s*\{[^}]*resolveEmbedPathPrefix[^}]*\}\s*from/.test(src)) {
    failures.push(`${app}: transports.ts 没有 import resolveEmbedPathPrefix`)
  }

  // 逐条 return 判定。只看顶层 return（本函数体里没有嵌套函数/回调，
  // 若将来引入，`return` 计数会与下面的分类对不上，届时门禁会红，需要人来看）。
  const returns = [...body.matchAll(/^\s*return\s+(.+?)\s*$/gm)].map((m) => m[1])
  if (returns.length === 0) {
    failures.push(`${app}: getWebServerUrl 里一条 return 都没解析到（门禁自身可能失效）`)
    continue
  }

  let derived = 0
  let exempt = 0
  for (const expr of returns) {
    // 与 window.location 无关的兜底（SSR / node 下 `http://localhost:8080`）不参与判定。
    if (!expr.includes('url.')) continue
    derived++
    if (expr.includes('resolveEmbedPathPrefix')) continue
    // vite 开发代理分支：写死开发端口，不经宿主。
    if (/\$\{url\.protocol\}\/\/\$\{url\.hostname\}:\d+/.test(expr)) {
      exempt++
      continue
    }
    failures.push(`${app}: getWebServerUrl 有一条从 url. 派生的 return 漏了 resolveEmbedPathPrefix —— ${expr}`)
  }

  if (derived === 0) {
    failures.push(`${app}: getWebServerUrl 里没有从 url. 派生的 return（门禁自身可能失效）`)
  }
  if (exempt > 1) {
    failures.push(`${app}: 出现 ${exempt} 个 vite 开发代理豁免分支，预期至多 1 个 —— 判据需要人来看`)
  }

  details.push({ app, returns: returns.length, derived, exempt })

  // ── IPC 传输基址 ────────────────────────────────────────────────────────
  const wbFile = resolve(REPO_DIR, `apps/${app}/src/renderer/web-bridge.ts`)
  if (!existsSync(wbFile)) {
    failures.push(`${app}: 找不到 ${wbFile}`)
    continue
  }
  const wbSrc = readFileSync(wbFile, 'utf8')
  const calls = [...wbSrc.matchAll(/createHttpIpcTransport\s*\(([\s\S]*?)\)/g)]
  if (calls.length === 0) {
    failures.push(`${app}: web-bridge.ts 里没有 createHttpIpcTransport 调用（门禁自身可能失效）`)
    continue
  }
  for (const [, args] of calls) {
    if (!args.trim()) {
      failures.push(`${app}: createHttpIpcTransport() 没传任何实参 —— 嵌入时 IPC 会打到宿主根路径`)
    } else if (!/pathPrefix\s*:/.test(args)) {
      failures.push(`${app}: createHttpIpcTransport(...) 缺 pathPrefix 实参 —— 嵌入时 IPC 会打到宿主根路径`)
    }
  }
}

const report = { ok: failures.length === 0, apps: details, failures }
if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('=== 嵌入 AI base URL 前缀门禁 ===')
  for (const d of details) {
    console.log(`  ok  ${d.app}：AI 基址 ${d.returns} 条 return（${d.derived} 条从 url. 派生、${d.exempt} 条开发代理豁免）；IPC 基址已钉前缀`)
  }
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(failures.length === 0
    ? '\n✓ EMBED AI BASE PREFIX OK'
    : `\n✗ EMBED AI BASE PREFIX FAILED（${failures.length} 项）`)
}

process.exit(failures.length === 0 ? 0 : 1)

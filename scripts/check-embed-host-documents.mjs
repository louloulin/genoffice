/**
 * check-embed-host-documents.mjs — 嵌入宿主时，宿主文档必须「真的被打开」且
 * 保存必须「真的推回云盘」。两个方向各对应一个实测过的静默缺陷。
 *
 * ## 为什么需要它
 *
 * 宿主的 `init` 命令把文档字节交给 web-bridge，web-bridge 落成临时文件后
 * **只能通过一个 DOM 事件**把路径告诉应用本体 —— 它拿不到应用的 React 状态。
 * 于是这条链路上有一个必然的接缝：bridge `dispatchEvent`，App `addEventListener`。
 * 任何一端漏掉，症状都不是报错，而是**静默的空文档**：
 *
 *   - **打开方向**：bridge 写完临时文件就 `return path`，宿主认为文档已打开，
 *     编辑器停在空白页（slides 停在「正在打开…」）。此时任何整篇翻译、任何保存
 *     都作用在一份空白/未加载的文档上，用户看到的仍是「翻译成功」。
 *   - **保存方向**：`slides:save` 只重写 web-server 磁盘上的临时副本并返回
 *     `{ok:true}`，应用清掉 dirty 标记，**云盘里的文件一个字节都没变**。
 *
 * 两个方向都不报错、都不进失败分支，只有端到端走查能看出来；这正是门禁的位置。
 *
 * ## 判据（作用域化，不是全文 grep）
 *
 * 打开方向：
 *   1. `web-bridge.ts` 里 `createDataflareEmbedIntegration({...})` 的**实参对象**内
 *      必须有活的 `dispatchEvent(new CustomEvent('dataflare:open-document'`
 *      （docs/sheets/pdf 写在 `onDocumentOpened`，slides 写在 `openBytes` —— 两处都算，
 *      门禁只要求「集成实参里有一个活的 dispatch」）。
 *   2. `App.tsx` 必须同时有 `addEventListener('dataflare:open-document'` 和
 *      配对的 `removeEventListener(...)` —— 只加不移会在 StrictMode/重挂载下叠加监听。
 *   3. 该监听的 **handler 函数体**内必须有一个打开入口调用
 *      （`loadFile(` / `handleInspectWorkbook(` / `consumePendingOpen(` / `openPath(`）。
 *      只注册一个空 handler 会让 1、2 都绿而文档仍然不打开。判据必须落在 handler
 *      而不是它所在的 effect 上 —— effect 里还有 mount 期的一次消费，判 effect 会假绿。
 *
 * 保存方向：
 *   4. `web-bridge.ts` 必须有活的 `dataflare.saveDocument(` 调用点。
 *
 * 全文 grep 会被注释骗过（这几处缺陷的修复说明本身就写着这些词），所以先剥行首
 * 注释再判定；第 1 条还额外限定在集成实参对象的括号范围内。
 *
 * 用法：node scripts/check-embed-host-documents.mjs [--json]
 * 退出码：0 = 四个应用两向都接通；1 = 有断点；2 = 目标文件/锚点缺失。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const APPS = ['docs', 'sheets', 'slides', 'pdf']

/**
 * 剥掉**行首**注释（`//`、连续 `*` 续行、`/* … *\/` 块），避免「修复说明里写着
 * 这个词」把门禁骗绿。
 *
 * 只处理行首是刻意的：正则式地全局剥注释在 JS 源码上**不安全** —— 本仓
 * `apps/sheets/src/renderer/App.tsx` 里就有 `text.replace(/\* padding, …/)` 这种
 * 正则字面量，一个 `'/\*[\s\S]*?\*\//g'` 会从那里一路吞掉 6 万字符的真实代码，
 * 把「监听存在」判成 false（本门禁第一版就是这么假红的）。
 * 行尾注释保留：已逐应用核过，四个 App.tsx / web-bridge.ts 里没有任何注释含有下面
 * 四条判据的记号，尾随注释骗不了这四条。
 */
function stripLeadingComments(src) {
  const out = []
  let inBlock = false
  for (const line of src.split('\n')) {
    const trimmed = line.trimStart()
    if (inBlock) {
      const end = trimmed.indexOf('*/')
      if (end < 0) {
        out.push('')
        continue
      }
      inBlock = false
      out.push(trimmed.slice(end + 2))
      continue
    }
    if (trimmed.startsWith('//')) {
      out.push('')
      continue
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/', 2)
      if (end < 0) {
        inBlock = true
        out.push('')
        continue
      }
      out.push(trimmed.slice(end + 2))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** 从 `marker` 处的 `(` 起做圆括号配平，切出调用实参（不含最外层括号）。 */
function sliceCallArgs(src, marker) {
  const at = src.indexOf(marker)
  if (at < 0) return null
  const open = src.indexOf('(', at + marker.length - 1)
  if (open < 0) return null
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
 * 切出一个具名函数的函数体。支持 `const f = (…) => {…}` / `function f(…) {…}`。
 * 箭头函数同时处理块体与简洁体。
 */
function sliceFunctionBody(src, name) {
  if (!name) return null
  const decl = new RegExp(`(?:const|let)\\s+${name}\\b`).exec(src)
  let arrow = null
  let braceStart = null
  if (decl) {
    arrow = src.indexOf('=>', decl.index)
    if (arrow < 0) return null
  } else {
    const fn = new RegExp(`function\\s+${name}\\s*\\(`).exec(src)
    if (!fn) return null
    braceStart = src.indexOf('{', fn.index)
    if (braceStart < 0) return null
  }
  if (braceStart !== null) return scanBraces(src, braceStart)
  // 箭头函数：块体与简洁体都在箭头之后的切片里判定，索引基准是那个切片。
  const after = src.slice(arrow + 2)
  const lead = after.match(/^\s*/)[0].length
  return after[lead] === '{' ? scanBraces(after, lead) : scanConcise(after, lead)
}

function scanBraces(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

/** 简洁体（`() => void f(x)`）：扫到括号深度归零后的第一个换行 / 分号。 */
function scanConcise(after, lead) {
  let depth = 0
  for (let i = lead; i < after.length; i++) {
    const ch = after[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return after.slice(lead, i)
      depth--
    } else if ((ch === '\n' || ch === ';') && depth === 0) {
      return after.slice(lead, i)
    }
  }
  return null
}

const OPEN_ENTRY_POINTS = [
  'loadFile(',
  'handleInspectWorkbook(',
  'consumePendingOpen(',
  'openPath(',
]

/**
 * 函数体是否（经至多两跳本地委派）走到打开入口。
 *
 * 必须跟委派：pdf 的监听 handler 是 `() => open(event.detail)`，打开发生在本地
 * `open()` 里；只判 handler 体会把一个真接通的实现判成红的（第一版就假红过）。
 * 跟的深度封顶 2、且带 visited 集合，避免顺着任意调用链爬穿整个 App.tsx。
 */
function opensDocument(src, body, seen, depth = 2) {
  if (OPEN_ENTRY_POINTS.some((fn) => body.includes(fn))) return true
  if (depth === 0) return false
  for (const call of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = call[1]
    if (OPEN_ENTRY_POINTS.includes(`${name}(`)) return true
    if (seen.has(name)) continue
    seen.add(name)
    const inner = sliceFunctionBody(src, name)
    if (inner && opensDocument(src, inner, seen, depth - 1)) return true
  }
  return false
}

const failures = []
const details = []

for (const app of APPS) {
  const bridgeFile = resolve(REPO_DIR, `apps/${app}/src/renderer/web-bridge.ts`)
  const appFile = resolve(REPO_DIR, `apps/${app}/src/renderer/App.tsx`)
  for (const f of [bridgeFile, appFile]) {
    if (!existsSync(f)) {
      failures.push(`${app}: 找不到 ${f}`)
      continue
    }
  }
  if (failures.some((f) => f.startsWith(`${app}:`))) continue

  const bridge = stripLeadingComments(readFileSync(bridgeFile, 'utf8'))
  const host = stripLeadingComments(readFileSync(appFile, 'utf8'))

  // ── 打开方向 1：bridge 必须真的 announce ───────────────────────────────
  const options = sliceCallArgs(bridge, 'createDataflareEmbedIntegration(')
  if (options === null) {
    failures.push(`${app}: web-bridge.ts 里没有 createDataflareEmbedIntegration(...) 调用（门禁自身可能失效）`)
    continue
  }
  const announces = /dispatchEvent\s*\(\s*new CustomEvent\s*\(\s*'dataflare:open-document'/.test(options)
  if (!announces) {
    failures.push(
      `${app}: createDataflareEmbedIntegration({...}) 实参里没有活的 dispatchEvent(new CustomEvent('dataflare:open-document'...) —— 宿主文档被下载到临时文件后永远不会到达应用`,
    )
  }

  // ── 打开方向 2：App 必须成对监听 ───────────────────────────────────────
  const listens = /addEventListener\s*\(\s*'dataflare:open-document'/.test(host)
  const unlistens = /removeEventListener\s*\(\s*'dataflare:open-document'/.test(host)
  if (!listens) {
    failures.push(`${app}: App.tsx 没有 addEventListener('dataflare:open-document', ...) —— 宿主文档不会被打开`)
  }
  if (!unlistens) {
    failures.push(`${app}: App.tsx 注册了宿主文档监听但没有配对的 removeEventListener —— 重挂载会叠加监听`)
  }

  // ── 打开方向 3：监听 handler 自己必须走打开入口 ───────────────────────
  // 判据落在 handler 体内而不是它所在的 effect 上：effect 里还有 mount 期的一次
  // 消费，判 effect 会让「handler 是空的」假绿（实测过：第一版判 effect，那条变异
  // 是假绿的）。同时跟一跳本地委派 —— pdf 的 handler 是
  // `() => open(detail)`，真正打开在本地 `open()` 里。
  const add = /addEventListener\s*\(\s*'dataflare:open-document'\s*,\s*([A-Za-z_$][\w$]*)/.exec(host)
  let opened = false
  let handler = null
  if (add) {
    handler = add[1]
    const body = sliceFunctionBody(host, handler)
    if (body === null) {
      failures.push(
        `${app}: 定位不到 dataflare:open-document 监听 handler \`${handler}\` 的函数体（门禁自身可能失效）`,
      )
    } else {
      opened = opensDocument(host, body, new Set([handler]))
      if (!opened) {
        failures.push(
          `${app}: 宿主文档监听 handler \`${handler}\` 里没有任何打开入口调用（${OPEN_ENTRY_POINTS.join(' / ')}）—— handler 是空的，文档仍然打不开`,
        )
      }
    }
  }

  // ── 保存方向 ───────────────────────────────────────────────────────────
  const savePushes = (bridge.match(/dataflare\s*\.\s*saveDocument\s*\(/g) ?? []).length
  if (savePushes === 0) {
    failures.push(
      `${app}: web-bridge.ts 没有 dataflare.saveDocument(...) 调用点 —— 编辑器只写 web-server 磁盘上的临时副本，云盘文件永远不变`,
    )
  }

  details.push({ app, announces, listens, unlistens, handler, opened, savePushes })
}

const report = { ok: failures.length === 0, apps: details, failures }
if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('=== 嵌入宿主文档往返门禁 ===')
  for (const d of details) {
    console.log(
      `  ${d.announces && d.listens && d.unlistens && d.opened ? 'ok ' : '✗  '} ${d.app}：announce=${d.announces} add=${d.listens} remove=${d.unlistens} handler=${d.handler}:打开入口=${d.opened} saveDocument×${d.savePushes}`,
    )
  }
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(failures.length === 0
    ? '\n✓ EMBED HOST DOCUMENTS OK'
    : `\n✗ EMBED HOST DOCUMENTS FAILED（${failures.length} 项）`)
}

process.exit(failures.length === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 发布版本号链路门禁 —— GenOffice。
 *
 * 与 dataflarework 的同名脚本成对（`scripts/verify-version-wiring.mjs`）。
 * 那个管 Dataflare 侧的四处同步，这个管 GenOffice 的三处。
 *
 * # 治的病
 *
 * 本仓库的病灶是「版本号没有机制阻止它继续漂」：`version.ts` 写死 `0.8.0`，
 * git tag 早已 `v0.8.1360`，而打 tag 的 `scripts/release-web.mjs` 收一个手填参数、
 * 不校验它与代码里的号是否一致。三者之间没有任何东西会失败。
 *
 * 而 Dataflare Work 的设置页**正是**从上游 `/health` 读这个号显示给人看的 ——
 * 号是假的，排查线上问题时就有一条假线索。
 *
 * # 判据
 *
 * 静态跨文件检查：VERSION → 两个 package.json → version.ts 常量，四者逐字相等。
 * 断任何一段的失败形态都是静默的（不报错，只是对外报告了一个不对的号），
 * 所以它值得一个门禁。
 *
 * 用法：
 *   node scripts/verify-version-wiring.mjs
 *   node scripts/verify-version-wiring.mjs --root <repo>
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseVersion } from './lib/calver.mjs'

const args = process.argv.slice(2)
let root = process.cwd()
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = resolve(args[++i])
}
root = resolve(root)

const checks = []
function check(name, fn) {
  try {
    const detail = fn()
    checks.push({ name, ok: true, detail })
  } catch (e) {
    checks.push({ name, ok: false, detail: e.message })
  }
}

function read(rel) {
  const p = join(root, rel)
  if (!existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(p, 'utf8')
}

function mustHave(text, needle, where) {
  if (!text.includes(needle)) throw new Error(`${where} 里找不到 ${JSON.stringify(needle)}`)
  return needle
}

function pkgVersion(rel) {
  const text = read(rel)
  const m = /"version"\s*:\s*"([^"]*)"/.exec(text)
  if (!m) throw new Error(`${rel} 没有 version 字段`)
  return m[1]
}

/** VERSION 允许注释行；取第一条非空非注释行。 */
function readVersion() {
  for (const line of read('VERSION').split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) return t
  }
  throw new Error('VERSION 里没有非注释行')
}

// ------------------------------------------------------------ 一致性

const version = readVersion()

check('VERSION 是合法 CalVer', () => {
  if (!parseVersion(version)) {
    throw new Error(`"${version}" 不是 YYYY.MM.DD 或 YYYY.MM.DD.N`)
  }
  return version
})

check('apps/web-server/package.json 与 VERSION 一致', () => {
  // 这一处是运行时真正对外报告的来源 —— /health 的 version 字段最终来自
  // version.ts 的 WEB_SERVER_VERSION，而它必须与本文件逐字相等。
  const actual = pkgVersion('apps/web-server/package.json')
  if (actual !== version) {
    throw new Error(`是 "${actual}"，VERSION 是 "${version}" —— 用 node scripts/bump-version.mjs 同步`)
  }
  return actual
})

check('根 package.json 与 VERSION 一致', () => {
  const actual = pkgVersion('package.json')
  if (actual !== version) {
    throw new Error(`是 "${actual}"，VERSION 是 "${version}" —— 用 node scripts/bump-version.mjs 同步`)
  }
  return actual
})

check('version.ts 的 WEB_SERVER_VERSION 与 VERSION 一致', () => {
  const src = read('apps/web-server/src/common/version.ts')
  const m = /WEB_SERVER_VERSION\s*=\s*'([^']+)'/.exec(src)
  if (!m) throw new Error('找不到 WEB_SERVER_VERSION 常量')
  if (m[1] !== version) {
    throw new Error(
      `是 "${m[1]}"，VERSION 是 "${version}" —— 运行时对外报告的是这个常量，改 VERSION 不会自动传播到它`
    )
  }
  return m[1]
})

// ------------------------------------------------------------ 接线

check('/health 返回 version 字段', () => {
  // Dataflare Work 靠这一行读到真实版本；少一行它就永远显示「未知」。
  const src = read('apps/web-server/src/index.ts')
  mustHave(src, 'WEB_SERVER_VERSION', 'apps/web-server/src/index.ts')
  const healthIdx = src.indexOf("url.pathname === '/health'")
  if (healthIdx < 0) throw new Error('找不到 /health 路由')
  const block = src.slice(healthIdx, healthIdx + 1200)
  if (!/version:\s*WEB_SERVER_VERSION/.test(block)) {
    throw new Error('/health 的响应里没有 version: WEB_SERVER_VERSION')
  }
  return 'Dataflare 侧靠这一行拿到真实版本'
})

check('release 脚本不再收手填版本号', () => {
  // 旧的 release-web.mjs 收 process.argv[2] 当版本号直接打 tag，不校验 ——
  // 「打 tag 的人不必改代码」正是这个漂移的开始。
  const rel = read('scripts/release-web.mjs')
  const usesArgv = /process\.argv\[2\][^\n]*version|const\s+version\s*=\s*process\.argv\[2\]/.test(rel)
  if (usesArgv) {
    throw new Error('release-web.mjs 仍从命令行参数取版本号 —— 应改为读 VERSION 文件')
  }
  mustHave(rel, 'VERSION', 'scripts/release-web.mjs')
  return '版本号来自 VERSION 文件，不再手填'
})

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  —— ${c.detail}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length > 0) {
  console.error(
    '\n版本号链路断了。断了不会报错，只会让 Dataflare 设置页显示一个不对的版本号 —— ' +
    '而那是排查线上问题时人对外部署的第一句话。'
  )
  process.exit(1)
}

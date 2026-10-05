#!/usr/bin/env node
// 发布版本号自增 —— GenOffice。
//
// # 治的病
//
// 本仓库长期存在一个**没有任何机制阻止它继续恶化**的病灶：
//
//   apps/web-server/src/common/version.ts  写死  '0.8.0'
//   git tag                                早已  v0.8.1360
//
// 差三个数量级。而且 §11.23 建立的「单一真相来源」（WEB_SERVER_VERSION）只做到了
// 「代码里各处不再各写一份」—— 真相本身仍然靠人手改，于是**改 tag 的人不必改代码，
// 改代码的人不必改 tag**，两者之间没有任何东西会失败。`scripts/release-web.mjs` 收一个
// 手填的 `process.argv[2]` 打 tag，也不校验它和代码里的号是否一致。
//
// 后果不是「版本号不好看」，而是**对外报告的版本号是假的**：Dataflare Work 的设置页
// 从上游 `/health` 读的就是这个假号，排查线上问题时它指向一个根本不存在的发布。
//
// # 这个脚本做什么
//
// 权威坐标是仓库根的 `VERSION`（CalVer）。本脚本把它同步进运行时真正读的那一处 ——
// `apps/web-server/package.json` 的 `version`（`version.ts` 的 WEB_SERVER_VERSION 必须
// 与它逐字相等，由 tests/version-sot.test.ts 钉住），然后可选地打 tag。
//
// 顺带把根 `package.json` 也同步：release.yml 用 `npm version` 在 tag 触发时
// 覆盖各包版本，根包的号目前是 `0.1.0`，与实际发布节奏无关，留着只会误导。
//
// # 为什么 CalVer 不是 SemVer
//
// 见 scripts/lib/calver.mjs。要紧的一句：SemVer 每次都要人判断这次算不算破坏性变更，
// 而本仓库的发布节奏跟着「这批需求上不上线」走，不跟对外 API 兼容性承诺走。
//
// # 用法
//
//   node scripts/bump-version.mjs              # 自增并写回，不打 tag（默认）
//   node scripts/bump-version.mjs --set 2026.10.06  # 指定 CalVer（不许倒退）
//   node scripts/bump-version.mjs --tag        # 自增后打 tag v<版本> 并提示推送
//   node scripts/bump-version.mjs --dry-run    # 只打印将要发生的改动
//
// 退出码：0 成功；1 用法错 / 版本号非法 / 版本号倒退 / git 状态不干净 / tag 已存在。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { nextVersion, compareVersions, isValidVersion } from './lib/calver.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', blue: '\x1b[34m',
  yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m',
}
const log = (color, ...a) => console.log(`${color}${a.join(' ')}${c.reset}`)
const die = (msg) => { log(c.red, `✗ ${msg}`); process.exit(1) }

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const dryRun = flag('--dry-run')
const wantTag = flag('--tag')

if (flag('--help') || flag('-h')) {
  log(c.bold, '用法: node scripts/bump-version.mjs [--set <CalVer>] [--tag] [--dry-run]')
  process.exit(0)
}
if (opt('--set') === null && argv.includes('--set')) die('--set 后面缺版本号')

// ---------------------------------------------------------------- 读取

const readText = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')

/** VERSION 允许注释行；取第一条非空非注释行。 */
function readVersionFile() {
  for (const line of readText('VERSION').split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) return t
  }
  return ''
}

if (!existsSync(resolve(ROOT, 'VERSION'))) die('VERSION 文件不存在')

const currentRaw = readVersionFile()
if (!isValidVersion(currentRaw)) {
  die(`VERSION 内容不是合法 CalVer: "${currentRaw}"（期望 YYYY.MM.DD 或 YYYY.MM.DD.N）`)
}

const explicit = opt('--set')
if (explicit !== null) {
  if (!isValidVersion(explicit)) die(`--set 的值不是合法 CalVer: "${explicit}"`)
  if (compareVersions(explicit, currentRaw) < 0) {
    die(`--set 会让版本号倒退: ${currentRaw} -> ${explicit}。回滚请手工改 VERSION 并说明。`)
  }
}
const target = explicit !== null ? explicit : nextVersion(currentRaw)

// ---------------------------------------------------------------- 同步点

/**
 * 定点替换 package.json 顶层 "version"，保留其余字节。
 *
 * 不做 JSON.parse + stringify 重写：那会把整个文件重新排版，diff 里真正该看的
 * 只有一行版本号，却被几百行噪音淹没。
 */
function rewritePackageJson(text, from, to, label) {
  const key = new RegExp(`(^\\s*)"version"(\\s*:\\s*)"${from.replace(/\./g, '\\.')}"`, 'm')
  const m = key.exec(text)
  if (!m) {
    const found = /"version"\s*:\s*"([^"]*)"/.exec(text)
    throw new Error(
      `${label} 里找不到 version "${from}"` +
      (found ? `（实际是 "${found[1]}"）—— 有人绕过本脚本改过其中一处。` : ' —— 该文件没有 version 字段。')
    )
  }
  return text.slice(0, m.index) + `${m[1]}"version"${m[2]}"${to}"` + text.slice(m.index + m[0].length)
}

const syncPoints = [
  { path: 'VERSION', rewrite: (t) => t.replace(/^(\s*)[^\s#].*$/m, `$1${target}`) },
  // 运行时真正读的是 web-server 的 package.json —— version.ts 的 WEB_SERVER_VERSION
  // 必须与它逐字相等（tests/version-sot.test.ts 钉住这条），所以它是首要同步点。
  { path: 'apps/web-server/package.json', rewrite: (t) => rewritePackageJson(t, currentRaw, target, 'apps/web-server/package.json') },
  { path: 'package.json', rewrite: (t) => rewritePackageJson(t, currentRaw, target, 'package.json') },
]

// ---------------------------------------------------------------- git

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch (e) {
    if (allowFail) return null
    die(`git ${args.join(' ')} 失败: ${e.stderr || e.message}`)
  }
}

if (wantTag) {
  const status = git(['status', '--porcelain'])
  if (status) {
    die('工作区有未提交改动，先提交再打 tag —— 否则 tag 指向的 commit 里没有这个版本号。\n' + status)
  }
  if (git(['tag', '-l', `v${target}`], { allowFail: true })) {
    die(`tag v${target} 已存在。要复用它请用 --set ${target} --tag。`)
  }
}

// ---------------------------------------------------------------- 执行

log(c.bold, `\nGenOffice 版本 ${currentRaw} → ${c.green}${target}\n`)
if (currentRaw === target && explicit === null) die(`自增后版本号没变（仍是 ${currentRaw}）—— 异常，停止。`)

// 先全部改在内存里，任何一个点不匹配就整体放弃：半改的树比不改的树更难查
// —— VERSION 已是新号而 package.json 还是旧号，下一个人看不出这是「改了一半」。
const staged = []
for (const point of syncPoints) {
  const before = readText(point.path)
  let after
  try {
    after = point.rewrite(before)
  } catch (e) {
    die(`${point.path}: ${e.message}\n  （尚未写入任何文件）`)
  }
  if (after === before) {
    log(c.yellow, `  · ${point.path} 无变化`)
    continue
  }
  staged.push({ path: point.path, after })
  log(c.blue, `  ${dryRun ? '将改' : '已改'} ${point.path}`)
}

if (dryRun) {
  log(c.yellow, '\n--dry-run：未写入任何文件。\n')
  process.exit(0)
}
for (const { path, after } of staged) writeFileSync(resolve(ROOT, path), after)

if (wantTag) {
  git(['tag', '-a', `v${target}`, '-m', `GenOffice ${target}`])
  log(c.blue, `  已打 tag v${target}`)
  log(c.dim, `  未推送。要推：git push origin v${target}`)
}

log(c.green, `\n✓ ${staged.length} 个文件已更新到 ${target}`)
log(c.dim, '  下一步：跑 node --test apps/web-server/tests/version-sot.test.ts 确认未漂移')
process.exit(0)

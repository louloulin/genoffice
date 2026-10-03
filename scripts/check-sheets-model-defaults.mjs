/**
 * check-sheets-model-defaults.mjs — 打开工作簿时必须补齐 schema 默认的 sheet 数组。
 *
 * ## 为什么需要它
 *
 * `worksheetMetadataSchema` 给 `pivotTables` / `sparklines` / `cellImages` 写了
 * `.default([])`，而 TypeScript 类型是从 schema 推出来的，所以下游读
 * `sheet.sparklines.length` **编译期看不出任何风险**。但 `.default()` 只在真正跑了
 * 那段 schema 的路径上生效：一份从上传进来的、或由更老的写方产生的工作簿，进模型
 * 时这三个字段是**不存在**的。
 *
 * 代价不是「读不到数据」，而是崩在要命的位置：那行读取在 Univer 的命令处理器
 * **内部**，`FRange.setValue` 不拦异常，于是异常从调用方循环里逃出去 ——
 * 触发它的那次写入进了 journal，**同一循环里它之后的每一次写入都没发生**。
 * 实测：6 个单元格的整表翻译提示成功、落盘只剩 1 个译文。无报错、无部分标记，
 * 只是译文凭空少了几条。根因与判据见 `apps/sheets/src/renderer/workbook-normalize.ts`。
 *
 * 门禁只钉**接线**（`openLazyWorkbook` 必须调用归一化函数）：补齐逻辑本身由
 * `apps/sheets/tests/workbook-normalize.test.ts` 覆盖（4 例，含变异验证）。
 *
 * 用法：node scripts/check-sheets-model-defaults.mjs [--json]
 * 退出码：0 = 接线成立；1 = 断点；2 = 目标文件缺失。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const failures = []

const moduleFile = resolve(REPO_DIR, 'apps/sheets/src/renderer/workbook-normalize.ts')
if (!existsSync(moduleFile)) {
  failures.push(`找不到 ${moduleFile}`)
} else {
  const src = readFileSync(moduleFile, 'utf8')
  if (!/export function withSheetMetaDefaults\b/.test(src)) {
    failures.push('workbook-normalize.ts 没有导出 withSheetMetaDefaults')
  }
  for (const field of ['pivotTables', 'sparklines', 'cellImages']) {
    if (!src.includes(`'${field}'`)) {
      failures.push(`workbook-normalize.ts 的 DEFAULTED_SHEET_ARRAYS 里没有 ${field}`)
    }
  }
}

const appFile = resolve(REPO_DIR, 'apps/sheets/src/renderer/App.tsx')
if (!existsSync(appFile)) {
  failures.push(`找不到 ${appFile}`)
} else {
  const src = readFileSync(appFile, 'utf8')
  // 限定在 openLazyWorkbook 的函数体内：文件里别处出现一次同名字符串不算数。
  const decl = src.indexOf('function openLazyWorkbook(')
  if (decl < 0) {
    failures.push('App.tsx 里没有 openLazyWorkbook')
  } else {
    const open = src.indexOf('{', decl)
    let depth = 0
    let body = null
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) { body = src.slice(open, i); break }
      }
    }
    if (body === null) failures.push('切不出 openLazyWorkbook 的函数体（门禁自身可能失效）')
    else if (!/withSheetMetaDefaults\s*\(/.test(body)) {
      failures.push(
        'openLazyWorkbook 没有调用 withSheetMetaDefaults(...) —— 打开的工作簿不会补齐 schema 默认的 sheet 数组，下游 sheet.<field>.length 会在 Univer 命令处理器里抛错并截断同一批次的后续写入',
      )
    }
  }
}

const report = { ok: failures.length === 0, failures }
if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('=== sheets 工作簿模型默认值门禁 ===')
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(failures.length === 0
    ? '\n✓ SHEETS MODEL DEFAULTS OK'
    : `\n✗ SHEETS MODEL DEFAULTS FAILED（${failures.length} 项）`)
}

process.exit(failures.length === 0 ? 0 : 1)

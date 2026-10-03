/**
 * `defaultSidecarPath()` 的路径解析。
 *
 * 这条判据是被一个真实故障逼出来的：默认路径按**源码树**的深度写死
 * （`src/sheets/sidecar.ts` → 仓库根），而真正跑起来的服务是
 * `dist/web-server/src/sheets/sidecar.js`，深一层，于是同样四跳 `..` 落在
 * `apps/web-server` 上，解析出一个不存在的路径。首次打开表格时报
 * `xlsx-sidecar binary not found at <一个显然不对的路径>`。
 * 生产没暴露是因为镜像用 `ENV XLSX_SIDECAR_PATH` 钉死了，默认分支只在本地被走到。
 *
 * 断言不依赖「二进制是否已编译」：无论走 walk-up 命中还是走兜底，返回值都必须
 * 锚在同一个仓库根上 —— 这正是旧实现破坏的那条不变量（旧路径里 `apps` 会出现两次，
 * 因为它从 `apps/web-server` 又接了一段 `apps/...`）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultSidecarPath } from '../src/sheets/sidecar'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXPECTED = join(REPO_ROOT, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', 'xlsx-sidecar')

describe('defaultSidecarPath', () => {
  it('锚在仓库根上，而不是从本文件深度硬推出来的某个中间目录', () => {
    expect(normalize(defaultSidecarPath())).toBe(normalize(EXPECTED))
  })

  it('路径里 `apps` 只出现一次（旧的四跳写法会拼出 apps/web-server/apps/…）', () => {
    const segments = normalize(defaultSidecarPath()).split(sep)
    expect(segments.filter((s) => s === 'apps').length).toBe(1)
  })

  it('命中已编译的二进制时，返回的就是那个真实文件', () => {
    const resolved = defaultSidecarPath()
    // 本地/CI 常常没编译 Rust 侧车；这一条只在它存在时有意义，不存在时不作要求。
    if (existsSync(resolved)) expect(resolved).toBe(EXPECTED)
  })
})

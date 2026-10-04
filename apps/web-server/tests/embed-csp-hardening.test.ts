/**
 * `hardenRendererCsp` — the embed page must not be silently de-styled (Q).
 *
 * 这条门禁钉的是一段**已经出过一次事故**的逻辑。原实现是一句不带作用域的
 *   `.replace(/\s*'unsafe-inline'/g, '')`
 * 挂在整条 CSP 上，本意是收紧 `script-src`，实际却把 `style-src` 里的
 * `'unsafe-inline'` 一起摘了 —— 于是每次打开任何格式的在线编辑，控制台固定刷
 * 8~16 条 `Applying inline style violates ... 'style-src ''self''`。
 *
 * 更说明问题的是：四个渲染器随包发出来的 `script-src` 本来就只有 `'self'`
 * （slides/pdf 另带 `'wasm-unsafe-eval'`），所以那句 replace **对脚本一条都没收紧**。
 * 零安全收益、纯故障 —— 这类改动不会被任何"看起来在收紧策略"的评审发现。
 *
 * 下面第 5 组断言直接对各渲染器 `out/renderer/index.html` 里的**真实** CSP 字符串
 * 做体检：渲染器哪天改了策略，这条门禁立刻能看出新加的 token 有没有被误伤。
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildEmbedHtml, hardenRendererCsp } from '../src/embed/index'

/** 四个渲染器随包发出来的真实策略（2026-10 快照）。 */
const SHIPPED_CSP: Record<string, string> = {
  docs: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' http://localhost:*",
  sheets: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' http://localhost:*",
  slides:
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' http://localhost:*",
  pdf: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' http://localhost:*",
}

/** 取某条指令的内容，指令缺失时返回 null。 */
function directive(csp: string, name: string): string | null {
  const prefix = name.toLowerCase() + ' '
  const hit = csp.split(';').map((d) => d.trim()).find((d) => d.toLowerCase().startsWith(prefix))
  return hit ?? null
}

describe('hardenRendererCsp', () => {
  it("[1] style-src 的 'unsafe-inline' 必须原样保留（这条曾经被误摘）", () => {
    for (const [app, csp] of Object.entries(SHIPPED_CSP)) {
      const out = hardenRendererCsp(csp)
      const style = directive(out, 'style-src')
      expect(style, `${app} 的 style-src 不应消失`).not.toBeNull()
      expect(style, `${app} 的 style-src 必须保留 'unsafe-inline'`).toContain("'unsafe-inline'")
      // 内联样式就是这套编辑器排版的方式，摘掉等于「在线编辑看起来全乱了」
      expect(style).toBe("style-src 'self' 'unsafe-inline'")
    }
  })

  it("[2] script-src 内的 'unsafe-inline' / 'unsafe-eval' 必须被摘掉", () => {
    const hostile =
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    const out = hardenRendererCsp(hostile)
    const script = directive(out, 'script-src')
    expect(script).toBe("script-src 'self'")
    // 非 script 指令一个都不能被顺手改到
    expect(directive(out, 'style-src')).toBe("style-src 'self' 'unsafe-inline'")
    expect(directive(out, 'default-src')).toBe("default-src 'self'")
    expect(directive(out, 'img-src')).toBe("img-src 'self' data:")
  })

  it("[3] 'wasm-unsafe-eval' 是另一个 token，绝不能被 'unsafe-eval' 的匹配吃掉", () => {
    for (const app of ['slides', 'pdf']) {
      const script = directive(hardenRendererCsp(SHIPPED_CSP[app]!), 'script-src')
      expect(script, `${app} 靠 WASM，改坏它等于整个应用起不来`).toBe("script-src 'self' 'wasm-unsafe-eval'")
    }
  })

  it("[4] 大小写/前后空白不敏感的指令名；无 script-src 时原样返回", () => {
    expect(hardenRendererCsp("DEFAULT-SRC 'self'; SCRIPT-SRC 'self' 'unsafe-inline'")).toContain("SCRIPT-SRC 'self'")
    const noScript = "default-src 'self'; style-src 'self' 'unsafe-inline'"
    expect(hardenRendererCsp(noScript)).toBe(noScript)
  })

  it("[5] 体检渲染器真实产物：若已构建，其 style-src 的 inline 不得在 embed 页被摘", () => {
    for (const app of Object.keys(SHIPPED_CSP)) {
      const indexPath = join(__dirname, '..', '..', app, 'out', 'renderer', 'index.html')
      if (!existsSync(indexPath)) continue
      const html = readFileSync(indexPath, 'utf-8')
      const shipped = /content="([^"]*)"/.exec(html.slice(html.indexOf('Content-Security-Policy'), html.indexOf('Content-Security-Policy') + 4000))?.[1]
      if (!shipped) continue
      const out = directive(hardenRendererCsp(shipped), 'style-src')
      expect(out, `${app} 产物 style-src 应带 'unsafe-inline'，否则这条门禁需要重新评估`).toContain("'unsafe-inline'")
    }
  })
})

describe('buildEmbedHtml — CSP 重写作用域', () => {
  it("[6] 只重写 meta 的 content，标签其余部分与 body 不受影响", () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-csp-'))
    const indexPath = join(dir, 'index.html')
    writeFileSync(
      indexPath,
      `<!doctype html><html><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${SHIPPED_CSP.docs}" /><title>t</title></head><body><div style="left:10px"></div></body></html>`,
    )
    const html = buildEmbedHtml(indexPath, { token: 'tk', app: 'docs' } as never, 'doc_1')
    const csp = /content="([^"]*)"/.exec(html.slice(html.indexOf('Content-Security-Policy'), html.indexOf('Content-Security-Policy') + 4000))![1]
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'")
    expect(html).toContain('<meta charset="utf-8"') // 标签整体没被拆
    expect(html).toContain('<div style="left:10px"></div>') // body 没被碰
  })

  it("[7] 变异验证：把作用域去掉（回到旧的全局 replace）必须变红", () => {
    const legacy = (content: string) => content.replace(/\s*'unsafe-inline'/g, '').replace(/\s*'unsafe-eval'/g, '')
    const out = directive(legacy(SHIPPED_CSP.docs), 'style-src')
    // 这就是线上发生过的那次事故：style-src 被摘成 'self'
    expect(out).toBe("style-src 'self'")
    expect(out).not.toContain("'unsafe-inline'")
  })
})

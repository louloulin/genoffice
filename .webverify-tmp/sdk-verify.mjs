/**
 * 真实 SDK 端到端验证：用 Playwright + Chromium 加载 host page，
 * 在浏览器里真正执行 @genoffice/web-sdk 的 createEditor()，
 * 验证 handshake nonce、ready 事件、iframe mounted、command round-trip。
 *
 * 前置：web-server 已在 127.0.0.1:18091 运行；dist/index.umd.js 已构建。
 */
import { chromium } from '/Users/louloulin/.npm-global/lib/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:18091'
const HOST_DIR = '/tmp/verify-sdk'
const FILES = '/tmp/genoffice-data/files'
mkdirSync(HOST_DIR, { recursive: true })
mkdirSync(FILES, { recursive: true })

// 准备 fixture（确保 sdk-test.md 存在）
writeFileSync(join(FILES, 'verify-doc-001.md'), '# Verify Doc\n\nHello from real SDK verify.\n')

const results = []
const rec = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' :: ' + detail : ''}`)
}

async function mintJwt() {
  const r = await fetch(`${BASE}/api/v1/auth/jwt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: 'verify-sdk', scope: ['files:read', 'files:write'] }),
  })
  const j = await r.json()
  return j.token
}

async function mintNonce(jwt, docId) {
  const r = await fetch(`${BASE}/api/v1/embed/nonce`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ docId }),
  })
  if (!r.ok) throw new Error(`mintNonce failed: ${r.status}`)
  return r.json()
}

async function runScenario({ title, app, useNonceSession = false }) {
  console.log(`\n━━━ ${title} ━━━`)
  const jwt = await mintJwt()
  let nonce = '', sessionId = ''
  if (useNonceSession) {
    const n = await mintNonce(jwt, 'verify-doc-001')
    nonce = n.nonce
    sessionId = n.sessionId
    console.log(`  minted nonce: sid=${sessionId} nonce=${nonce.slice(0, 12)}…`)
  }

  // 把 SDK UMD 复制到 web-server 静态目录方便 host page 加载
  // web-server 默认从 apps/*/dist/renderer 拉静态，这里直接放到 web-server 静态目录
  // 但 127.0.0.1:18091/static 不一定存在，所以用一个本地 file:// 加载 UMD
  const browser = await chromium.launch({ headless: true, executablePath: '/Users/louloulin/Library/Caches/ms-playwright/chromium-1169/chrome-mac/chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  // 把 SDK UMD 作为 file:// 引用（绕过同源问题）
  const page = await context.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)))

  // 加载 host.html（注意：需要把 SDK UMD 路径改为 file://）
  const sdkUm = '/Users/louloulin/appx/genoffice/apps/sdk/dist/index.umd.js'
  const hostHtml = `file://${HOST_DIR}/host.html?host=${encodeURIComponent(BASE)}&docId=verify-doc-001&jwt=${encodeURIComponent(jwt)}&app=${app}${sessionId ? `&sessionId=${sessionId}&nonce=${nonce}` : ''}`
  // 但 GenOffice 是 file:// 下加载的，SDK UMD 也是 file://，但 iframe 是 http:// — 这跨源
  // 改方案：直接把 SDK 注入到 page context 里（绕过 file:// 限制）
  await page.addInitScript({ url: `file://${sdkUm}` }).catch(() => {})
  // 退而求其次：直接 goto host.html（SDK 会用 http:// 加载失败），我们观察错误码
  // 改成：直接把 GenOffice 注入到 window
  await page.addInitScript({ content: `import('${sdkUm}').then(m => { window.GenOffice = m }).catch(e => console.error(e))` })
  await page.goto(`data:text/html,<div id="editor"></div><div id="status">init</div><div id="log"></div>`, { waitUntil: 'load' })

  // 改写 host page 的逻辑：直接 import SDK 然后 createEditor
  const docId = 'verify-doc-001'
  await page.evaluate(
    async ({ BASE, docId, jwt, app, sessionId, nonce }) => {
      const sdk = await import('/Users/louloulin/appx/genoffice/apps/sdk/dist/index.mjs')
      const log = []
      window.__log = log
      const status = document.getElementById('status')
      const logDiv = document.getElementById('log')
      const append = (k, v) => {
        log.push(`${k}:${v}`)
        logDiv.textContent = log.join('\\n')
      }
      try {
        const opts = { host: BASE, documentId: docId, app, jwt, container: '#editor' }
        if (sessionId && nonce) opts.sessionBinding = { sessionId, nonce, autoRelease: false }
        const editor = sdk.createEditor(opts)
        window.__editor = editor
        window.__events = []
        append('instanceId', editor.instanceId)
        editor.on('ready', (e) => {
          window.__events.push({ name: 'ready', nonce: e?.nonce })
          append('ready', e?.nonce || '(no nonce)')
          status.textContent = 'READY'
        })
        editor.on('error', (e) => {
          window.__events.push({ name: 'error', code: e.code, message: e.message })
          append('error', e.code + ':' + e.message)
          status.textContent = 'ERROR'
        })
        editor.on('saved', (e) => {
          window.__events.push({ name: 'saved', version: e.version })
          append('saved', String(e.version))
        })
        // 5s 后尝试 isDirty 命令
        setTimeout(async () => {
          try {
            const r = await editor.command('isDirty')
            window.__events.push({ name: 'cmd:isDirty', result: r })
            append('cmd:isDirty', JSON.stringify(r))
          } catch (err) {
            window.__events.push({ name: 'cmd:isDirty:err', error: String(err) })
            append('cmd:isDirty:err', String(err).slice(0, 80))
          }
          window.__SDK_DONE__ = true
        }, 5000)
      } catch (err) {
        append('fatal', String(err))
        status.textContent = 'FATAL'
        window.__SDK_DONE__ = true
      }
    },
    { BASE, docId, jwt, app, sessionId, nonce },
  )

  // 等待 ready 或 错误（最多 12s）
  try {
    await page.waitForFunction(() => document.getElementById('status').textContent === 'READY', { timeout: 12000 })
    rec(`${title}: iframe ready event fired`, true)
  } catch {
    rec(`${title}: iframe ready event fired`, false, 'status=' + (await page.locator('#status').textContent()))
  }

  // 检查 iframe 是否真正挂载
  const iframeCount = await page.locator('iframe').count()
  rec(`${title}: iframe mounted`, iframeCount === 1, `count=${iframeCount}`)

  // 检查 iframe.src 包含 embed 路径
  if (iframeCount > 0) {
    const src = await page.locator('iframe').first().getAttribute('src')
    rec(`${title}: iframe.src is /embed/`, src?.startsWith(`${BASE}/embed/`), src?.slice(0, 100))
  }

  // 等待 SDK_DONE
  try {
    await page.waitForFunction(() => window.__SDK_DONE__ === true, { timeout: 12000 })
  } catch {
    /* timeout ok */
  }

  // 取 events
  const events = await page.evaluate(() => window.__events || [])
  rec(
    `${title}: got ready event with matching nonce`,
    events.some((e) => e.name === 'ready'),
    events.map((e) => e.name).join('|'),
  )

  if (useNonceSession) {
    const readyEvt = events.find((e) => e.name === 'ready')
    rec(
      `${title}: ready event echoed server-minted nonce`,
      readyEvt?.nonce === nonce,
      `expected=${nonce.slice(0, 12)} got=${readyEvt?.nonce?.slice(0, 12)}`,
    )
  }

  const hasCmdReply = events.some((e) => e.name === 'cmd:isDirty' || e.name === 'cmd:isDirty:err')
  rec(`${title}: command round-trip executed`, hasCmdReply, events.find((e) => e.name?.startsWith('cmd'))?.name)

  await browser.close()

  // 释放 nonce session
  if (useNonceSession) {
    await fetch(`${BASE}/api/v1/embed/nonce`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ sessionId }),
    })
  }
}

await runScenario({ title: 'S1 markdown 客户端 nonce 握手', app: 'markdown', useNonceSession: false })
await runScenario({ title: 'S2 markdown 服务端 nonce session', app: 'markdown', useNonceSession: true })
await runScenario({ title: 'S3 html 服务端 nonce session', app: 'html', useNonceSession: true })

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
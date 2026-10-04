/**
 * A11 — the markdown app's whole-document / selection / bilingual translation, in
 * a REAL browser, driven the way a Dataflare host drives it: a
 * `dataflare:office-command` envelope on `window`.
 *
 * The app runs from the built renderer bundle, served by the real web-server, so
 * this exercises the exact production wiring: the App's host-command effect →
 * `translateMarkdownDocument` → the web-bridge transport → `ai:translate-batch`
 * → the `MdOp` layer (`replaceText` / `insertContent`) → the ProseMirror
 * document. Only the provider call is stubbed (a canned `ai:translate-batch` IPC
 * response); the pipeline it replaces is covered by the unit suite. Everything
 * the write-back touches is real.
 *
 * The markdown editor is block-granular: one unit per top-level block, so the
 * inline run `**bold**` travels inside its paragraph's unit rather than as its
 * own.
 *
 * Fail closed: a missing bundle, a server that never boots or a browser that
 * will not launch are red — never a skip.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { stopServer } from '../apps/web-server/tests/helpers/server-process'

const ROOT = resolve(__dirname, '..')
const SERVER_BUNDLE = join(ROOT, 'apps', 'web-server', 'dist', 'bundle', 'index.js')
const MD_BUNDLE = join(ROOT, 'apps', 'markdown', 'out', 'renderer', 'index.html')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The document the app opens: three top-level blocks, one of them carrying an
 * inline `**bold**` run — enough that a whole-document run touches several
 * blocks, a bilingual run inserts more than one paragraph, and a selection run
 * has a block to isolate.
 */
const SOURCE = `# Title One\n\nFirst paragraph.\n\nInline **bold** tail\n`

/** A translation trivially distinguishable from its source. */
const TRANSLATE = (source: string): string => `[${source}]`

/** Reserve a free loopback port (never a fixed one — CI hosts are shared). */
async function reservePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as import('node:net').AddressInfo).port
      s.close(() => res(port))
    })
  })
}

async function launchBrowser(): Promise<Browser> {
  const errors: string[] = []
  for (const opts of [{ channel: 'chrome' as const }, {}]) {
    try {
      return await chromium.launch(opts)
    } catch (err) {
      errors.push(`  ${JSON.stringify(opts)} → ${String((err as Error)?.message ?? err).split('\n')[0]}`)
    }
  }
  throw new Error(`no launchable browser (run: npx playwright install chromium)\n${errors.join('\n')}`)
}

test.describe.configure({ mode: 'serial' })

test.describe('markdown whole-document translation in a real browser (A11)', () => {
  test.setTimeout(240_000)

  let server: ChildProcess | undefined
  let browser: Browser | undefined
  let dataDir = ''
  let base = ''
  /** the translate-batch calls the app really made */
  let batchCalls = 0

  test.beforeAll(async () => {
    expect(existsSync(SERVER_BUNDLE), `Missing ${SERVER_BUNDLE} — build it: npm run bundle -w @genoffice/web-server`).toBe(true)
    expect(existsSync(MD_BUNDLE), `Missing ${MD_BUNDLE} — build it: npm run build -w @genoffice/markdown`).toBe(true)

    const port = await reservePort()
    base = `http://127.0.0.1:${port}`
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-md-translate-'))
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      // e2e posture: no WEB_TOKEN, open IPC — the same opt-out local dev uses.
      GENOFFICE_ALLOW_OPEN: '1',
    }
    delete env.WEB_TOKEN
    server = spawn(process.execPath, [SERVER_BUNDLE], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    server.stdout?.on('data', (c) => (log += String(c)))
    server.stderr?.on('data', (c) => (log += String(c)))
    const deadline = Date.now() + 30_000
    for (;;) {
      if (server.exitCode !== null) throw new Error(`web-server exited ${server.exitCode}\n${log}`)
      try {
        if ((await fetch(`${base}/health`)).ok) break
      } catch {
        /* keep polling */
      }
      if (Date.now() > deadline) throw new Error(`web-server never healthy\n${log}`)
      await sleep(250)
    }
    browser = await launchBrowser()
  })

  test.afterAll(async () => {
    await browser?.close()
    await stopServer(server, dataDir)
  })

  /**
   * Open the markdown app with the fixture loaded. `markdown:read-file` and
   * `ai:translate-batch` are answered by this stub; every other channel falls
   * through to the real server.
   */
  async function openApp(): Promise<{ page: Page; editor: Locator }> {
    const page = await browser!.newPage()
    await page.route('**/api/ipc/**', async (route) => {
      const channel = decodeURIComponent(new URL(route.request().url()).pathname.split('/api/ipc/')[1] ?? '')
      if (channel === 'markdown:read-file') {
        await route.fulfill({ json: { ok: true, result: SOURCE } })
        return
      }
      if (channel === 'ai:translate-batch') {
        batchCalls++
        const body = route.request().postDataJSON() as {
          args: [{ units: Array<{ unitId: string; sourceText: string }> }]
        }
        const units = body.args[0].units.map((unit) => ({
          unitId: unit.unitId,
          sourceText: unit.sourceText,
          translatedText: TRANSLATE(unit.sourceText),
          status: 'translated' as const,
        }))
        await route.fulfill({ json: { ok: true, result: { ok: true, units } } })
        return
      }
      await route.continue()
    })
    await page.goto(`${base}/markdown/?open=demo.md`, { waitUntil: 'domcontentloaded' })
    // The document loads asynchronously (`consumePending` → `readFile`); wait for
    // the fixture to be rendered before driving the app.
    const editor = page.locator('.doc-editor')
    await expect(editor).toContainText('Title One', { timeout: 60_000 })
    return { page, editor }
  }

  /** Send the host command the Dataflare bridge would dispatch. */
  async function sendCommand(page: Page, detail: Record<string, unknown>): Promise<void> {
    await page.evaluate((d) => {
      window.dispatchEvent(new CustomEvent('dataflare:office-command', { detail: d }))
    }, detail)
  }

  test('whole-document: the host command translates every block in place', async () => {
    const { page, editor } = await openApp()
    try {
      await sendCommand(page, {
        type: 'translate',
        scope: 'document',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        qualityCheck: false,
        memoryEnabled: false,
      })
      await expect(editor).toContainText('[Title One]', { timeout: 60_000 })
      await expect(editor).toContainText('[First paragraph.]')
      await expect(editor).toContainText('[Inline bold tail]')
      // exactly three blocks, each replaced once — no stray or duplicated writes
      expect((await editor.textContent())?.trim()).toBe(
        '[Title One][First paragraph.][Inline bold tail]',
      )
      expect(batchCalls).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })

  test('bilingual: the source is kept and a translation is appended', async () => {
    const { page, editor } = await openApp()
    try {
      await sendCommand(page, {
        type: 'translate',
        scope: 'document',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        bilingual: true,
        qualityCheck: false,
        memoryEnabled: false,
      })
      await expect(editor).toContainText('[First paragraph.]', { timeout: 60_000 })
      // the source blocks are untouched — including the inline markup
      const html = await editor.innerHTML()
      expect(html).toContain('<h1>Title One</h1>')
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('First paragraph.')
      // and each translated block was inserted after its source
      await expect(editor).toContainText('[Title One]')
      await expect(editor).toContainText('[Inline bold tail]')
    } finally {
      await page.close()
    }
  })

  test('selection: only the covered block is translated', async () => {
    const { page, editor } = await openApp()
    try {
      await selectBlock(page, 'First paragraph.')
      await sendCommand(page, {
        type: 'translate',
        scope: 'selection',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        qualityCheck: false,
        memoryEnabled: false,
      })
      await expect(editor).toContainText('[First paragraph.]', { timeout: 60_000 })
      // the other blocks are untouched, and only one block changed
      expect((await editor.textContent())?.trim()).toBe('Title One[First paragraph.]Inline bold tail')
    } finally {
      await page.close()
    }
  })

  /**
   * Select the whole text of the block whose rendered text matches `text`, the
   * way a user drag does: focus the editor, set a DOM range over the block, and
   * let ProseMirror's selection observer pick it up.
   */
  async function selectBlock(page: Page, text: string): Promise<void> {
    await page.locator('.doc-editor').click()
    const found = await page.evaluate((needle: string) => {
      const editor = document.querySelector('.doc-editor')
      if (!editor) return false
      const block = [...editor.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote')].find(
        (el) => el.textContent === needle,
      )
      if (!block) return false
      const range = document.createRange()
      range.selectNodeContents(block)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }, text)
    if (!found) throw new Error(`no block holding ${JSON.stringify(text)}`)
    // ProseMirror's observer syncs the selection asynchronously
    await page.waitForTimeout(300)
  }
})

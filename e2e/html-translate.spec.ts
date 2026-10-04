/**
 * A12 — the html app's whole-document / selection / bilingual translation, in a
 * REAL browser, driven the way a Dataflare host drives it: a
 * `dataflare:office-command` envelope on `window`.
 *
 * The app runs from the built renderer bundle, served by the real web-server,
 * so this exercises the exact production wiring: the App's host-command effect →
 * `translateHtmlDocument` → the web-bridge transport → `ai:translate-batch` →
 * the op compiler → the CodeMirror buffer. Only the provider call is stubbed
 * (a canned `ai:translate-batch` IPC response): a real provider call would make
 * the suite non-deterministic and cost money, and the pipeline it replaces is
 * covered by the unit suite. Everything the write-back touches is real.
 *
 * Fail closed: a missing bundle, a server that never boots or a browser that
 * will not launch are red — never a skip.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { stopServer } from '../apps/web-server/tests/helpers/server-process'

const ROOT = resolve(__dirname, '..')
const SERVER_BUNDLE = join(ROOT, 'apps', 'web-server', 'dist', 'bundle', 'index.js')
const HTML_BUNDLE = join(ROOT, 'apps', 'html', 'out', 'renderer', 'index.html')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The document the app opens. Two prose paragraphs plus a heading, an entity
 * and an inline run — enough that a whole-document run touches several text
 * nodes, an entity round-trips, and a bilingual run has more than one block.
 */
const SOURCE = `<!doctype html>
<html>
<head><title>Translation fixture</title></head>
<body>
<h1 id="title">Hello &amp; welcome</h1>
<p class="lead">First paragraph.</p>
<p>Inline <b>bold</b> tail</p>
</body>
</html>
`

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

test.describe('html whole-document translation in a real browser (A12)', () => {
  test.setTimeout(240_000)

  let server: ChildProcess | undefined
  let browser: Browser | undefined
  let dataDir = ''
  let base = ''
  /** the translate-batch calls the app really made, newest last */
  let batchCalls = 0

  test.beforeAll(async () => {
    expect(existsSync(SERVER_BUNDLE), `Missing ${SERVER_BUNDLE} — build it: npm run bundle -w @genoffice/web-server`).toBe(true)
    expect(existsSync(HTML_BUNDLE), `Missing ${HTML_BUNDLE} — build it: npm run build -w @genoffice/html`).toBe(true)

    const port = await reservePort()
    base = `http://127.0.0.1:${port}`
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-html-translate-'))
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
   * Open the html app with the fixture loaded. `html:read-file` and
   * `ai:translate-batch` are answered by this stub; every other channel falls
   * through to the real server (preview buffers, language, save…).
   */
  async function openApp(): Promise<Page> {
    const page = await browser!.newPage()
    await page.route('**/api/ipc/**', async (route) => {
      const channel = decodeURIComponent(new URL(route.request().url()).pathname.split('/api/ipc/')[1] ?? '')
      if (channel === 'html:read-file') {
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
    await page.goto(`${base}/html/?open=demo.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.ribbon-body')).toBeVisible({ timeout: 60_000 })
    return page
  }

  /** Send the host command the Dataflare bridge would dispatch. */
  async function sendCommand(page: Page, detail: Record<string, unknown>): Promise<void> {
    await page.evaluate((d) => {
      window.dispatchEvent(new CustomEvent('dataflare:office-command', { detail: d }))
    }, detail)
  }

  /**
   * Show the source pane beside the preview (the "Split" view). The app defaults
   * to preview-only; Split keeps the live preview available for the selection
   * test while making the CodeMirror buffer visible to assert on. Selected by
   * position, not label — the app renders in the user's language. The three view
   * toggles are the only `role="tab"` buttons carrying `.rb-view`
   * (`VIEW_MODES = ['preview', 'split', 'source']`); the other `.rb-view`
   * buttons are insert/present actions.
   */
  async function showSource(page: Page) {
    const content = page.locator('.source-editor .cm-content')
    // The document loads asynchronously (`consumePending` → `readFile`), and the
    // pane remount that follows would drop a view toggle clicked mid-load. Wait
    // for the fixture to actually be in the buffer first. `toContainText` does
    // not require visibility, so this works while the pane is still hidden. The
    // source pane shows raw markup, hence the entity.
    await expect(content).toContainText('Hello &amp; welcome', { timeout: 60_000 })
    const viewTabs = page.locator('button.rb-view[role="tab"]')
    await expect(viewTabs).toHaveCount(3)
    await viewTabs.nth(1).click()
    await expect(content).toBeVisible({ timeout: 30_000 })
    return content
  }

  test('whole-document: the host command translates every text node in place', async () => {
    const page = await openApp()
    try {
      await showSource(page)
      await sendCommand(page, {
        type: 'translate',
        scope: 'document',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        qualityCheck: false,
        memoryEnabled: false,
      })
      const content = page.locator('.source-editor .cm-content')
      await expect(content).toContainText('[Hello &amp; welcome]', { timeout: 60_000 })
      await expect(content).toContainText('[First paragraph.]')
      // the inline run and its separator both survived the round-trip
      await expect(content).toContainText('[Inline] ')
      await expect(content).toContainText('[bold]')
      await expect(content).toContainText('[tail]')
      // the markup is untouched: the heading and its id are still there
      await expect(content).toContainText('id="title"')
      expect(batchCalls).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })

  test('bilingual: the source is kept and the translation is appended', async () => {
    const page = await openApp()
    try {
      await showSource(page)
      await sendCommand(page, {
        type: 'translate',
        scope: 'document',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        bilingual: true,
        qualityCheck: false,
        memoryEnabled: false,
      })
      const content = page.locator('.source-editor .cm-content')
      await expect(content).toContainText('[First paragraph.]', { timeout: 60_000 })
      // the source paragraph is still there, and a second one was inserted
      await expect(content).toContainText('First paragraph.')
      await expect(content).toContainText('[Inline] [bold] [tail]')
    } finally {
      await page.close()
    }
  })

  test('selection: only the selected text node is translated', async () => {
    const page = await openApp()
    try {
      await showSource(page)
      // Selection in the html app comes from the *preview*: the inspector posts
      // `gx:textSelect` when a non-collapsed range sits inside one text node.
      const frame = page.frameLocator('.preview-frame')
      const lead = frame.locator('p.lead')
      await expect(lead).toHaveText('First paragraph.', { timeout: 30_000 })
      await selectTextNode(page, 'p.lead')
      await sendCommand(page, {
        type: 'translate',
        scope: 'selection',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        qualityCheck: false,
        memoryEnabled: false,
      })
      const content = page.locator('.source-editor .cm-content')
      await expect(content).toContainText('[First paragraph.]', { timeout: 60_000 })
      // the other prose nodes are untouched
      await expect(content).toContainText('Hello &amp; welcome')
      await expect(content).toContainText('tail')
    } finally {
      await page.close()
    }
  })

  /** Select the whole text node of a preview element, the way a user drag does. */
  async function selectTextNode(page: Page, selector: string): Promise<void> {
    const frame = page.frames().find((f) => f.url().includes('/api/html/preview/'))
    if (!frame) throw new Error('preview frame never loaded')
    await frame.evaluate((sel: string) => {
      const el = document.querySelector(sel)
      const node = el?.firstChild
      if (!node || node.nodeType !== 3) throw new Error(`no text node in ${sel}`)
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, node.textContent?.length ?? 0)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }, selector)
    // the inspector's `selectionchange` listener posts asynchronously
    await page.waitForTimeout(300)
  }
})

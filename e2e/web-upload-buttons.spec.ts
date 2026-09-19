/**
 * Web upload-button regression — three apps, one assertion shape each.
 *
 * Why this exists: commits 784d738 (docs Insert), f71b69c (markdown QAT),
 * e6582f1 (html QAT) added the same Upload button to three different apps.
 * The button funnels through `window.{docs,markdown,html}Api.uploadFile` →
 * `pickFileBytes` → `uploadFileToServer` → `web:save-file` → FILES_DIR +
 * `genoffice:recents-changed`. A regression at any layer silently swallows
 * the upload and the user has no feedback.
 *
 * This spec exercises the real button click + a real file payload, then
 * asserts the side-effects that the user actually cares about:
 *
 *   1. The button is reachable in the renderer (UI doesn't drop it).
 *   2. The file lands in FILES_DIR with byte-identical contents.
 *   3. The recents JSON lists the new file (so the shell home tab shows it
 *      without the user having to refresh).
 *
 * It runs against the deployed web-server: `node apps/web-server/dist/bundle/index.js`
 * (port 18081) or `WEB_BASE_URL=...`. Skipped (never silently passed) when
 * no server answers /health — same convention as web-asset-delivery.spec.ts.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:18081'
const DATA_DIR = resolve(
  process.env.DATA_DIR || process.env.GENOFFICE_DATA_DIR || '/tmp/genoffice-data',
)
const FILES_DIR = join(DATA_DIR, 'files')

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome' })
  } catch {
    return await chromium.launch()
  }
}

async function serverAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}

/** One fresh test file per run, isolated from concurrent tests and prior runs. */
function newFixture(label: string): { path: string; bytes: Buffer; name: string } {
  const name = `e2e-upload-${label}-${Date.now()}-${process.pid}.txt`
  const path = join(tmpdir(), name)
  const bytes = Buffer.from(`upload button regression\nlabel=${label}\nnonce=${Date.now()}\n`)
  return { path, bytes, name }
}

async function readRecents(recentsFile: string): Promise<Array<{ path: string; name: string }>> {
  const file = join(DATA_DIR, recentsFile)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A corrupt recents file is not this test's problem to flag: it is
    // asserted in scripts/smoke-web-server.mjs. Return [] and let the
    // landing-path assertion catch any real failure.
    return []
  }
}

async function findNewestFileInFilesDir(marker: string): Promise<{ path: string; bytes: Buffer } | null> {
  // FILES_DIR is a flat directory of uploaded files. Scan for the most recent
  // mtime matching `marker`. Brute force because the directory is small and
  // this runs only in test mode.
  const { readdirSync } = await import('node:fs')
  let best: { path: string; mtime: number } | null = null
  for (const name of readdirSync(FILES_DIR)) {
    if (!name.includes(marker)) continue
    const full = join(FILES_DIR, name)
    try {
      const mtime = statSync(full).mtimeMs
      if (!best || mtime > best.mtime) best = { path: full, mtime }
    } catch {
      /* file disappeared mid-scan; ignore */
    }
  }
  if (!best) return null
  return { path: best.path, bytes: readFileSync(best.path) }
}

/** Wait for `window.<api>.uploadFile` to exist on the page. */
async function waitForApi(page: Page, apiKey: string): Promise<void> {
  await page.waitForFunction(
    (key) => {
      const api = (window as unknown as Record<string, { uploadFile?: unknown }>)[key]
      return typeof api?.uploadFile === 'function'
    },
    apiKey,
    { timeout: 30_000 },
  )
}

/** Click the app upload button and supply `fixture.bytes` as the chosen file. */
async function clickUploadAndSupply(
  page: Page,
  /** Locator for the upload button — must be the actual button element. */
  button: ReturnType<Page['locator']>,
  fixture: { path: string; bytes: Buffer; name: string },
): Promise<void> {
  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()])
  await fileChooser.setFiles([
    { name: fixture.name, mimeType: 'text/plain', buffer: fixture.bytes },
  ])
}

test.describe('web upload buttons land the file in FILES_DIR and update recents', () => {
  let browser: Browser | undefined
  let available = false

  test.beforeAll(async () => {
    available = await serverAvailable()
    console.log(`[web-upload-buttons] serverAvailable=${available} (BASE=${BASE})`)
    if (!available) return
    browser = await launchBrowser()
  })

  test.afterAll(async () => {
    await browser?.close()
  })

  test('docs: Insert ribbon upload button lands the file', async () => {
    test.skip(!available, `web-server not reachable at ${BASE}`)
    const page = await browser!.newPage()
    try {
      await page.goto(`${BASE}/?app=docs`, { waitUntil: 'domcontentloaded' })
      await waitForApi(page, 'desktop')

      // The Upload button sits at the head of the Illustrations group on the
      // 插入 tab. Switch to that tab first so the group is mounted.
      await page.locator('button, .ribbon-tab').filter({ hasText: /^插入$/ }).first().click()
      await page.waitForSelector('button[data-tip="将文件上传到 Web 服务器"]', { timeout: 15_000 })

      const fixture = newFixture('docs')
      await clickUploadAndSupply(
        page,
        page.locator('button[data-tip="将文件上传到 Web 服务器"]'),
        fixture,
      )

      // The button click does not insert anything into the doc; the side
      // effects are FILES_DIR + recents. Wait for FILES_DIR to see the bytes.
      await expect
        .poll(async () => findNewestFileInFilesDir(fixture.name), {
          timeout: 15_000,
          message: 'web:save-file did not land the file in FILES_DIR',
        })
        .not.toBeNull()
      const landed = await findNewestFileInFilesDir(fixture.name)
      expect(landed!.bytes.equals(fixture.bytes)).toBe(true)

      const recents = await readRecents('docs-recent.json')
      expect(recents.some((e) => e.name === fixture.name)).toBe(true)
    } finally {
      await page.close()
    }
  })

  test('markdown: quick-access toolbar upload button lands the file', async () => {
    test.skip(!available, `web-server not reachable at ${BASE}`)
    const page = await browser!.newPage()
    try {
      await page.goto(`${BASE}/?app=markdown`, { waitUntil: 'domcontentloaded' })
      await waitForApi(page, 'markdownApi')

      await page.waitForSelector('.qa-btn[data-tip="将文件上传到 Web 服务器"]', { timeout: 15_000 })

      const fixture = newFixture('markdown')
      await clickUploadAndSupply(
        page,
        page.locator('.qa-btn[data-tip="将文件上传到 Web 服务器"]'),
        fixture,
      )

      await expect
        .poll(async () => findNewestFileInFilesDir(fixture.name), {
          timeout: 15_000,
          message: 'web:save-file did not land the file in FILES_DIR',
        })
        .not.toBeNull()
      const landed = await findNewestFileInFilesDir(fixture.name)
      expect(landed!.bytes.equals(fixture.bytes)).toBe(true)

      const recents = await readRecents('docs-recent.json')
      expect(recents.some((e) => e.name === fixture.name)).toBe(true)
    } finally {
      await page.close()
    }
  })

  test('html: quick-access toolbar upload button lands the file', async () => {
    test.skip(!available, `web-server not reachable at ${BASE}`)
    const page = await browser!.newPage()
    try {
      await page.goto(`${BASE}/?app=html`, { waitUntil: 'domcontentloaded' })
      await waitForApi(page, 'htmlApi')

      await page.waitForSelector('.qa-btn[data-tip="将文件上传到 Web 服务器"]', { timeout: 15_000 })

      const fixture = newFixture('html')
      await clickUploadAndSupply(
        page,
        page.locator('.qa-btn[data-tip="将文件上传到 Web 服务器"]'),
        fixture,
      )

      await expect
        .poll(async () => findNewestFileInFilesDir(fixture.name), {
          timeout: 15_000,
          message: 'web:save-file did not land the file in FILES_DIR',
        })
        .not.toBeNull()
      const landed = await findNewestFileInFilesDir(fixture.name)
      expect(landed!.bytes.equals(fixture.bytes)).toBe(true)

      const recents = await readRecents('docs-recent.json')
      expect(recents.some((e) => e.name === fixture.name)).toBe(true)
    } finally {
      await page.close()
    }
  })
})

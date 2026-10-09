import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

/**
 * The AI panel docks to the RIGHT by default, and follows `data-ai-placement`
 * for `left` and `floating`. The attribute is the single input every layout
 * rule in packages/ui/src/ai-panel-placement.css keys off, so writing it here
 * exercises the real shipped stylesheet at all three values; who writes it (the
 * prefs store, the embed meta) is covered by packages/ui/tests and the shell
 * settings tests.
 *
 * Two apps are enough because there are only two layout engines: docs is the
 * flex `.app-main` + `.ai-dock` shape shared by slides/html/markdown/pdf, and
 * sheets is the grid `.sheet-body` + `.copilot` shape, which needs both
 * `grid-template-columns` and `order` swapped and therefore cannot pass by
 * sharing the flex assertions.
 */

const ROOT = resolve(__dirname, '..')

interface Case {
  app: string
  slug: string
  file: string
  /** the open panel's dock */
  dock: string
  /** the element the dock must sit beside */
  content: string
  /** ribbon entry that collapses the open panel */
  closeToggle: string
}

const cases: Case[] = [
  {
    app: 'docs',
    slug: '://docs/',
    file: join(ROOT, 'fixtures/generated/simple.docx'),
    dock: '.ai-dock:not(.collapsed)',
    content: '.app-content',
    closeToggle: '.rb-big.ai-entry.active',
  },
  {
    app: 'sheets',
    slug: '://sheets/',
    file: join(ROOT, 'apps/sheets/fixtures/generated/compatibility-basic.xlsx'),
    dock: '.copilot:not(.collapsed)',
    content: '.sheet-main',
    closeToggle: '.ribbon-tool.ai-entry.active',
  },
]

interface Box {
  dockX: number
  dockRight: number
  contentX: number
  contentRight: number
}

async function readGeometry(page: Page, c: Case): Promise<Box> {
  return page.evaluate(
    ({ dock, content }) => {
      const d = document.querySelector(dock)!.getBoundingClientRect()
      const a = document.querySelector(content)!.getBoundingClientRect()
      return { dockX: d.x, dockRight: d.right, contentX: a.x, contentRight: a.right }
    },
    { dock: c.dock, content: c.content },
  )
}

for (const c of cases) {
  test(`${c.app}: AI panel placement is right by default and follows data-ai-placement`, async ({}, testInfo) => {
    testInfo.setTimeout(150_000)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: `ai-placement-${c.app}`,
      openFile: c.file,
    })
    const { app } = launched
    try {
      const page: Page = await waitForPageWithUrl(app, c.slug)
      await expect(page.locator(c.dock)).toBeVisible()

      // default: the new right dock, with no saved preference and no embed meta
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.aiPlacement))
        .toBe('right')
      let geo = await readGeometry(page, c)
      expect(geo.dockX, `${c.app}: dock must start right of the content`).toBeGreaterThanOrEqual(
        geo.contentRight - 1,
      )

      await page.evaluate(() => document.documentElement.setAttribute('data-ai-placement', 'left'))
      geo = await readGeometry(page, c)
      expect(geo.dockRight, `${c.app}: left dock must end left of the content`).toBeLessThanOrEqual(
        geo.contentX + 1,
      )

      await page.evaluate(() =>
        document.documentElement.setAttribute('data-ai-placement', 'floating'),
      )
      geo = await readGeometry(page, c)
      // an overlay card takes no layout width: the content keeps the full
      // window and the card floats over it, pinned to the bottom-right inset
      expect(geo.contentRight - geo.contentX, 'content must keep its full width').toBeGreaterThan(
        geo.dockRight - geo.dockX,
      )
      const anchored = await page.evaluate(
        ({ dock }) => {
          const d = document.querySelector(dock)!.getBoundingClientRect()
          return {
            right: Math.round(window.innerWidth - d.right),
            bottom: Math.round(window.innerHeight - d.bottom),
            fixed: getComputedStyle(document.querySelector(dock)!).position,
          }
        },
        { dock: c.dock },
      )
      expect(anchored.fixed, 'floating card must be out of flow').toBe('fixed')
      expect(anchored.right).toBe(16)
      expect(anchored.bottom).toBe(16)
    } finally {
      await closeAndSaveVideo(launched, `ai-placement-${c.app}`)
    }
  })

  test(`${c.app}: the floating ball reopens the overlay card`, async ({}, testInfo) => {
    testInfo.setTimeout(150_000)
    // Seeded rather than poked: React reads the placement from the prefs store
    // (useAiPanelPlacement), not from the DOM attribute, so only a real
    // preference round-trip puts the app in the ball branch at all.
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-e2e-'))
    await writeFile(
      join(userDataDir, 'app-settings.json'),
      JSON.stringify({ onboardingSeen: true, aiPanelPlacement: 'floating' }),
    )
    const launched = await launchShell({
      userDataDir,
      videoDir: `ai-ball-${c.app}`,
      openFile: c.file,
    })
    const { app } = launched
    try {
      const page: Page = await waitForPageWithUrl(app, c.slug)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.aiPlacement))
        .toBe('floating')
      await expect(page.locator(c.dock)).toBeVisible()

      await page.locator(c.closeToggle).first().click()
      const ball = page.locator('.ai-floating-ball')
      await expect(ball).toBeVisible()
      // the collapsed wrapper must leave the flow, or the ball would be pinned
      // inside a 34px column instead of the viewport
      const wrapper = await page.evaluate(() => {
        const el = document.querySelector('.ai-floating-ball')!.closest('.ai-dock, .copilot')!
        return getComputedStyle(el).display
      })
      expect(wrapper, 'collapsed floating wrapper must not keep a layout box').toBe('contents')

      await ball.click()
      await expect(page.locator(c.dock)).toBeVisible()

      // A drag ends with a pointerup, which still fires `click` on the ball —
      // if the click is not suppressed the drag would pop the panel open.
      await page.locator(c.closeToggle).first().click()
      await expect(ball).toBeVisible()
      const box = (await ball.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 160, {
        steps: 8,
      })
      await page.mouse.up()
      await expect(ball, 'a drag must not open the panel').toBeVisible()
    } finally {
      await closeAndSaveVideo(launched, `ai-ball-${c.app}`)
    }
  })

  test(`${c.app}: the header toggle switches the panel between docked and floating`, async ({}, testInfo) => {
    testInfo.setTimeout(150_000)
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-e2e-'))
    await writeFile(join(userDataDir, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
    const launched = await launchShell({
      userDataDir,
      videoDir: `ai-toggle-${c.app}`,
      openFile: c.file,
    })
    const { app } = launched
    const savedPlacement = async (): Promise<string> =>
      JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8')).aiPanelPlacement
    try {
      const page: Page = await waitForPageWithUrl(app, c.slug)
      await expect(page.locator(c.dock)).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.aiPlacement))
        .toBe('right')

      const toggle = page.locator('.ai-placement-toggle')
      await expect(toggle).toBeVisible()

      await toggle.click()
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.aiPlacement))
        .toBe('floating')
      const anchored = await page.evaluate(
        ({ dock }) => {
          const el = document.querySelector(dock)!
          const d = el.getBoundingClientRect()
          return {
            position: getComputedStyle(el).position,
            right: Math.round(window.innerWidth - d.right),
            bottom: Math.round(window.innerHeight - d.bottom),
          }
        },
        { dock: c.dock },
      )
      expect(anchored).toEqual({ position: 'fixed', right: 16, bottom: 16 })

      // The click has to survive the whole way to disk, not just restyle the
      // page — that is what makes the switch reproducible on the next launch.
      await expect.poll(savedPlacement).toBe('floating')

      await toggle.click()
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.aiPlacement))
        .toBe('right')
      await expect.poll(savedPlacement).toBe('right')
      const geo = await readGeometry(page, c)
      expect(geo.dockX, `${c.app}: toggling back must re-dock beside the content`).toBeGreaterThanOrEqual(
        geo.contentRight - 1,
      )
    } finally {
      await closeAndSaveVideo(launched, `ai-toggle-${c.app}`)
    }
  })
}
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

/**
 * A65 — after the markdown/html panel migration, booting any of the six
 * editors must show the AI panel open (every app defaults it open on fresh
 * localStorage), the entry toggle must close and reopen it, the shared
 * runtime stylesheet must ship in the bundle, and the boot must produce zero
 * console errors and zero uncaught page errors. Serial like the rest of the
 * suite (one Electron at a time).
 */

const ROOT = resolve(__dirname, '..')

/** Minimal one-page PDF (Letter, one text line) — valid header, xref, startxref. */
function tinyPdf(): Buffer {
  const stream = 'BT /F1 24 Tf 72 720 Td (probe) Tj ET'
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefStart = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

interface Case {
  app: string
  slug: string
  file: () => Promise<string>
  /** locator that is visible only while the panel is open */
  panel: string
  /** ribbon entry that closes the open panel; when set, the spec also cycles close→reopen */
  closeToggle?: string
}

const cases: Case[] = [
  {
    app: 'docs',
    slug: '://docs/',
    file: async () => join(ROOT, 'fixtures/generated/simple.docx'),
    panel: '.ai-dock:not(.collapsed)',
    closeToggle: '.rb-big.ai-entry.active',
  },
  {
    app: 'sheets',
    slug: '://sheets/',
    file: async () => join(ROOT, 'apps/sheets/fixtures/generated/compatibility-basic.xlsx'),
    panel: '.copilot:not(.collapsed)',
    closeToggle: '.ribbon-tool.ai-entry.active',
  },
  {
    app: 'slides',
    slug: '://slides/',
    file: async () => join(ROOT, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
    panel: '.ai-dock:not(.collapsed)',
  },
  {
    app: 'pdf',
    slug: '://pdf/',
    file: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'genoffice-console-probe-'))
      const p = join(dir, 'probe.pdf')
      await writeFile(p, tinyPdf())
      return p
    },
    panel: '.ai-dock:not(.collapsed)',
    closeToggle: '.rb-big.ai-entry.active',
  },
  {
    app: 'markdown',
    slug: '://markdown/',
    file: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'genoffice-console-probe-'))
      const p = join(dir, 'note.md')
      await writeFile(p, '# Topic\n\nHello probe.\n')
      return p
    },
    panel: '.ai-dock:not(.collapsed)',
    closeToggle: '.rb-big.ai-entry.active',
  },
  {
    app: 'html',
    slug: '://html/',
    file: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'genoffice-console-probe-'))
      const p = join(dir, 'probe.html')
      await writeFile(p, '<html><body><h1>Topic</h1><p>Body.</p></body></html>\n')
      return p
    },
    panel: '.ai-dock:not(.collapsed)',
  },
]

for (const c of cases) {
  test(`${c.app}: AI panel boots with zero console errors`, async ({ }, testInfo) => {
    testInfo.setTimeout(150_000)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: `ai-console-${c.app}`,
      openFile: await c.file(),
    })
    const { app } = launched
    try {
      const editorPage: Page = await waitForPageWithUrl(app, c.slug)
      const consoleErrors: string[] = []
      const pageErrors: string[] = []
      editorPage.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
      })
      editorPage.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))

      // the panel boots open (fresh localStorage defaults every app to open)
      await expect(editorPage.locator(c.panel)).toBeVisible()
      if (c.closeToggle) {
        // the ribbon entry must collapse and reopen the panel
        await editorPage.locator(c.closeToggle).first().click()
        await expect(editorPage.locator(c.panel)).toBeHidden()
        await editorPage.locator(c.closeToggle.replace('.active', '')).first().click()
        await expect(editorPage.locator(c.panel)).toBeVisible()
      }
      // the shared runtime components must ship with their stylesheet — the
      // header hides itself at idle, so assert the rule, not the box
      const runtimeCssLoaded = await editorPage.evaluate(() => {
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) {
              if (rule instanceof CSSStyleRule && rule.selectorText === '.ai-run-header') return true
            }
          } catch {
            // cross-origin sheet — not ours
          }
        }
        return false
      })
      expect(runtimeCssLoaded, 'ai-runtime.css missing from the bundle').toBe(true)
      // give async boot work (i18n, settings, composer icons) time to flush
      await editorPage.waitForTimeout(3000)

      expect(consoleErrors, `console errors in ${c.app}: ${consoleErrors.join(' | ')}`).toEqual([])
      expect(pageErrors, `page errors in ${c.app}: ${pageErrors.join(' | ')}`).toEqual([])
    } finally {
      await closeAndSaveVideo(launched, `ai-console-${c.app}`)
    }
  })
}

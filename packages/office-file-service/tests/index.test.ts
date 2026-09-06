import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PdfFileService, SlidesFileService } from '../src/index.js'

describe('office file services', () => {
  it('creates and reopens a blank PPTX without Electron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-office-service-'))
    const service = new SlidesFileService({ rootDir: root })
    const opened = await service.open(await service.createBlank())
    expect(opened.deck.slides.length).toBe(1)
  })

  it('creates and validates a blank PDF without Electron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-office-service-'))
    const service = new PdfFileService({ rootDir: root })
    expect(await service.validate(await service.createBlank())).toEqual({ pageCount: 1 })
  })
})

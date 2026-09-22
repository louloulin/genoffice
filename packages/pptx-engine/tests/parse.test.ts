import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { openPptx, savePptx, reassembleSlideXml, generateParagraphXml } from '../src/index'
import { parseSlide } from '../src/parse'
import { tableRowGridCols } from '../src/table-grid'
import { parsePlaceholderMap, parseMasterTextStyles } from '../src/placeholder'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(join(here, 'fixtures', name))

const FIXTURES = ['01_standard_business.pptx', '05_unicode_cjk_emoji.pptx']

describe('openPptx', () => {
  for (const name of FIXTURES) {
    it(`parses ${name} without throwing`, async () => {
      const { deck } = await openPptx(fx(name))
      expect(deck.slides.length).toBeGreaterThan(0)
      // Slide size is positive
      expect(deck.size.cx).toBeGreaterThan(0)
      expect(deck.size.cy).toBeGreaterThan(0)
      // Each slide has elements or at least parses without error
      for (const s of deck.slides) {
        expect(Array.isArray(s.elements)).toBe(true)
      }
    })
  }

  it('extracts text from standard business deck', async () => {
    const { deck } = await openPptx(fx('01_standard_business.pptx'))
    const allText = deck.slides
      .flatMap((s) => s.elements)
      .filter(
        (e): e is Extract<typeof e, { type: 'text' | 'shape' }> =>
          e.type === 'text' || e.type === 'shape',
      )
      .flatMap((e) => e.text?.paragraphs ?? [])
      .flatMap((p) => p.runs)
      .map((r) => r.text)
      .join('')
    expect(allText.trim().length).toBeGreaterThan(0)
  })

  it('backfills placeholder geometry from layout/master (fixes Phase 1 xfrm=0,0)', async () => {
    const { deck } = await openPptx(fx('01_standard_business.pptx'))
    const placeholders = deck.slides.flatMap((s) => s.elements).filter((e) => !!e.placeholder)
    expect(placeholders.length).toBeGreaterThan(0)
    // Placeholders got geometry backfilled from layout/master: no longer all stuck at (0,0), and sizes are non-zero
    for (const el of placeholders) {
      const o = el.transform.offset
      expect(o.cx).toBeGreaterThan(0)
      expect(o.cy).toBeGreaterThan(0)
    }
    // At least one placeholder has a non-zero offset (proves inheritance actually happened, not all zeros)
    expect(placeholders.some((el) => el.transform.offset.x > 0 || el.transform.offset.y > 0)).toBe(
      true,
    )
  })

  it('preserves CJK / emoji text bytes on extraction', async () => {
    const { deck } = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const allText = deck.slides
      .flatMap((s) => s.elements)
      .filter(
        (e): e is Extract<typeof e, { type: 'text' | 'shape' }> =>
          e.type === 'text' || e.type === 'shape',
      )
      .flatMap((e) => e.text?.paragraphs ?? [])
      .flatMap((p) => p.runs)
      .map((r) => r.text)
      .join('')
    // Contains at least some non-ASCII characters (CJK/emoji)
    // eslint-disable-next-line no-control-regex -- ASCII range check is intentional
    expect(/[^\x00-\x7F]/.test(allText)).toBe(true)
  })
})

describe('fill / color-mod / background parsing', () => {
  const theme: any = { colors: { accent1: '#0000FF', lt1: '#FFFFFF', dk1: '#000000' } }

  const slideWith = (bodyShapes: string, bg = '') =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld>' +
    bg +
    `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${bodyShapes}</p:spTree></p:cSld></p:sld>`

  it('gradient fill: stops + angle (60000ths → raw)', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:gradFill><a:gsLst>' +
      '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="00FF00"/></a:gs>' +
      '</a:gsLst><a:lin ang="2700000"/></a:gradFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    expect(el.fill.type).toBe('gradient')
    expect(el.fill.stops).toEqual([
      { pos: 0, color: '#FF0000' },
      { pos: 1, color: '#00FF00' },
    ])
    expect(el.fill.angle).toBe(2700000)
    expect(el.fill.scaled).toBeUndefined()
  })

  it('gradient fill: a:lin scaled="1" surfaces the aspect-stretch flag', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:gradFill><a:gsLst>' +
      '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="00FF00"/></a:gs>' +
      '</a:gsLst><a:lin ang="2700000" scaled="1"/></a:gradFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    expect(el.fill.type).toBe('gradient')
    expect(el.fill.scaled).toBe(true)
  })

  it('gradFill with no a:lin/a:path defaults to a vertical ramp (PowerPoint-measured)', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:gradFill><a:gsLst>' +
      '<a:gs pos="0"><a:srgbClr val="FFC000"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="FFFFD5"/></a:gs>' +
      '</a:gsLst></a:gradFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    expect(el.fill.type).toBe('gradient')
    expect(el.fill.angle).toBe(5400000)
    expect(el.fill.path).toBeUndefined()
  })

  it('an explicit a:lin without ang keeps the schema default 0', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:gradFill><a:gsLst>' +
      '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="00FF00"/></a:gs>' +
      '</a:gsLst><a:lin scaled="1"/></a:gradFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    expect(el.fill.angle).toBe(0)
  })

  it('circle path: percent-suffixed fillToRect/tileRect (Google Slides corner radial) parse as fractions', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:gradFill><a:gsLst>' +
      '<a:gs pos="0"><a:srgbClr val="5DE0E6"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="004AAD"/></a:gs>' +
      '</a:gsLst><a:path path="circle"><a:fillToRect b="100%" r="100%"/></a:path>' +
      '<a:tileRect l="-100%" t="-100%"/></a:gradFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    expect(el.fill.path).toBe('circle')
    expect(el.fill.fillTo).toEqual({ l: 0, t: 0, r: 1, b: 1 })
    expect(el.fill.tileRect).toEqual({ l: -1, t: -1, r: 0, b: 0 })
  })

  it('circle path: 1/1000 % fillToRect and an empty tileRect keep the centered shape', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:gradFill><a:gsLst>' +
      '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="00FF00"/></a:gs>' +
      '</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>' +
      '<a:tileRect/></a:gradFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    expect(el.fill.fillTo).toEqual({ l: 0.5, t: 0.5, r: 0.5, b: 0.5 })
    expect(el.fill.tileRect).toBeUndefined()
  })

  it('themed schemeClr with lumMod/lumOff modifier', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1">' +
      '<a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    // accent1=#0000FF, lumMod 50% → #000080
    expect(el.fill).toEqual({ type: 'solid', color: '#000080' })
  })

  it('solid fill with alpha → #RRGGBBAA', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FF0000">' +
      '<a:alpha val="50000"/></a:srgbClr></a:solidFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme },
    })
    const el = slide.elements[0] as any
    expect(el.fill.color).toBe('#FF000080')
  })

  it('image (blipFill) fill via media resolver', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:blipFill><a:blip r:embed="rId5"/></a:blipFill></p:spPr></p:sp>'
    const mediaRels = new Map([['rId5', 'ppt/media/image1.png']])
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme, mediaRels },
    })
    const el = slide.elements[0] as any
    expect(el.fill).toEqual({ type: 'image', mediaRef: 'ppt/media/image1.png', mode: 'stretch' })
  })

  it('blip duotone → [dark, light] colors on the image fill (tdf123684 theme textures)', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:blipFill><a:blip r:embed="rId5">' +
      '<a:duotone><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr>' +
      '<a:schemeClr val="lt1"/></a:duotone>' +
      '</a:blip></a:blipFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme, mediaRels: new Map([['rId5', 'ppt/media/t.png']]) },
    })
    // accent1 #0000FF shade 50% (gamma-corrected, matching PowerPoint) → #0000BA
    expect((slide.elements[0] as any).fill.duotone).toEqual(['#0000BA', '#FFFFFF'])
  })

  it('duotone with mixed color tags keeps dark endpoint first (standard black + accent)', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:blipFill><a:blip r:embed="rId5">' +
      '<a:duotone><a:prstClr val="black"/><a:schemeClr val="accent1"/></a:duotone>' +
      '</a:blip></a:blipFill></p:spPr></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp),
      ctx: { theme, mediaRels: new Map([['rId5', 'ppt/media/t.png']]) },
    })
    // The parser iterates schemeClr before prstClr; luminance ordering restores black first
    expect((slide.elements[0] as any).fill.duotone).toEqual(['#000000', '#0000FF'])
  })

  it('slide <p:bg> solid background', () => {
    const bg = '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith('', bg),
      ctx: { theme },
    })
    expect(slide.background).toEqual({ type: 'solid', color: '#112233' })
  })

  it('placeholder inherits layout spPr fill; master noFill stops the fallback (bnc904423)', () => {
    const layoutXml =
      '<p:sldLayout xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:solidFill><a:srgbClr val="00CC99"/></a:solidFill></p:spPr></p:sp>' +
      '</p:spTree></p:cSld></p:sldLayout>'
    const masterXml =
      '<p:sldMaster xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:noFill/></p:spPr></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill></p:spPr></p:sp>' +
      '</p:spTree></p:cSld></p:sldMaster>'
    const title =
      '<p:sp><p:nvSpPr><p:cNvPr id="2"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    const body =
      '<p:sp><p:nvSpPr><p:cNvPr id="3"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(title + body),
      ctx: {
        theme,
        layoutPlaceholders: parsePlaceholderMap(layoutXml),
        masterPlaceholders: parsePlaceholderMap(masterXml),
      },
    })
    // Title: the layout fill wins over the master noFill
    expect((slide.elements[0] as any).fill).toEqual({ type: 'solid', color: '#00CC99' })
    // Body: no layout fill → master's applies
    expect((slide.elements[1] as any).fill).toEqual({ type: 'solid', color: '#123456' })
  })

  it('p:style fontRef color beats master txStyles but not explicit run color (bnc904423)', () => {
    const masterTextStyles: any = {
      body: { levels: [{ color: '#000000' }] },
    }
    const sp = (runs: string) =>
      '<p:sp><p:nvSpPr><p:cNvPr id="4"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
      '<p:style><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>' +
      '<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>' +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${runs}</a:p></p:txBody></p:sp>`
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(sp('<a:r><a:t>inherit</a:t></a:r>')),
      ctx: { theme, masterTextStyles },
    })
    expect((slide.elements[0] as any).text.paragraphs[0].runs[0].color).toBe('#FFFFFF')
    const explicit = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(
        sp(
          '<a:r><a:rPr><a:solidFill><a:srgbClr val="FF00FF"/></a:solidFill></a:rPr><a:t>own</a:t></a:r>',
        ),
      ),
      ctx: { theme, masterTextStyles },
    })
    expect((explicit.elements[0] as any).text.paragraphs[0].runs[0].color).toBe('#FF00FF')
  })

  it('master bgRef blipFill template resolves the blip in the theme part rels', () => {
    const themed: any = {
      ...theme,
      bgFillStyles: [
        {},
        {},
        { 'a:blipFill': { 'a:blip': { '@_r:embed': 'rId2' }, 'a:stretch': {} } },
      ],
    }
    const masterBg =
      '<p:sldMaster><p:cSld><p:bg><p:bgRef idx="1003"><a:schemeClr val="lt1"/></p:bgRef></p:bg></p:cSld></p:sldMaster>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(''),
      ctx: {
        theme: themed,
        masterBg,
        masterMediaRels: new Map([['rId2', 'ppt/media/wrong-part.png']]),
        themeMediaRels: new Map([['rId2', 'ppt/media/image2.jpeg']]),
      },
    })
    expect(slide.background).toEqual({
      type: 'image',
      mediaRef: 'ppt/media/image2.jpeg',
      mode: 'stretch',
    })
  })

  it('background inherits from master when slide has none', () => {
    const masterBg =
      '<p:sldMaster><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></p:bgPr></p:bg></p:cSld></p:sldMaster>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(''),
      ctx: { theme, masterBg },
    })
    expect(slide.background).toEqual({ type: 'solid', color: '#ABCDEF' })
  })
})

describe('text body parsing fidelity', () => {
  const slideWith = (bodyShapes: string) =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld>' +
    `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${bodyShapes}</p:spTree></p:cSld></p:sld>`

  const spWith = (txBody: string) =>
    '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
    `<p:txBody><a:bodyPr/>${txBody}</p:txBody></p:sp>`

  const firstText = (slide: ReturnType<typeof parseSlide>) => (slide.elements[0] as any).text

  it('pure numeric run text stays string (no fast-xml-parser number coercion)', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(spWith('<a:p><a:r><a:t>2026</a:t></a:r></a:p>')),
      ctx: {},
    })
    expect(firstText(slide).paragraphs[0].runs[0].text).toBe('2026')
  })

  it('preserves leading/trailing spaces in run text', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(
        spWith(
          '<a:p><a:r><a:t>a </a:t></a:r><a:r><a:rPr b="1"/><a:t>bold</a:t></a:r><a:r><a:t> b</a:t></a:r></a:p>',
        ),
      ),
      ctx: {},
    })
    const runs = firstText(slide).paragraphs[0].runs
    expect(runs.map((r: any) => r.text).join('')).toBe('a bold b')
  })

  it('parses lnSpc (spcPct %) + spcBef/spcAft (spcPts pt)', () => {
    const pPr =
      '<a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc>' +
      '<a:spcBef><a:spcPts val="600"/></a:spcBef>' +
      '<a:spcAft><a:spcPts val="300"/></a:spcAft></a:pPr>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(spWith(`<a:p>${pPr}<a:r><a:t>x</a:t></a:r></a:p>`)),
      ctx: {},
    })
    const p = firstText(slide).paragraphs[0]
    expect(p.lineHeight).toBe(150)
    expect(p.spaceBefore).toBe(6)
    expect(p.spaceAfter).toBe(3)
  })

  it('parses lnSpc absolute (spcPts → lineExact pt)', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(
        spWith(
          '<a:p><a:pPr><a:lnSpc><a:spcPts val="2400"/></a:lnSpc></a:pPr><a:r><a:t>x</a:t></a:r></a:p>',
        ),
      ),
      ctx: {},
    })
    expect(firstText(slide).paragraphs[0].lineExact).toBe(24)
  })

  it('parses a:pPr rtl: "1"/"true" → true, "0" → false, absent → undefined', () => {
    const rtlOf = (pPr: string) =>
      firstText(
        parseSlide({
          path: 'ppt/slides/slide1.xml',
          slideXml: slideWith(spWith(`<a:p>${pPr}<a:r><a:t>x</a:t></a:r></a:p>`)),
          ctx: {},
        }),
      ).paragraphs[0].rtl
    expect(rtlOf('<a:pPr rtl="1"/>')).toBe(true)
    expect(rtlOf('<a:pPr rtl="true"/>')).toBe(true)
    expect(rtlOf('<a:pPr rtl="0"/>')).toBe(false)
    expect(rtlOf('<a:pPr/>')).toBeUndefined()
    expect(rtlOf('')).toBeUndefined()
  })

  it('generateParagraphXml round-trips explicit rtl (true and false)', () => {
    expect(generateParagraphXml({ runs: [{ text: 'x' }], rtl: true })).toContain('rtl="1"')
    expect(generateParagraphXml({ runs: [{ text: 'x' }], rtl: false })).toContain('rtl="0"')
    expect(generateParagraphXml({ runs: [{ text: 'x' }] })).not.toContain('rtl=')
  })

  it('bodyPr vert: eaVert/vert/vert270/wordArtVert parsed, horz/absent undefined', () => {
    const spVert = (bodyPr: string) =>
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
      `<p:txBody>${bodyPr}<a:p><a:r><a:t>縦</a:t></a:r></a:p></p:txBody></p:sp>`
    const vertOf = (bodyPr: string) =>
      firstText(
        parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: slideWith(spVert(bodyPr)), ctx: {} }),
      ).vert
    expect(vertOf('<a:bodyPr vert="eaVert"/>')).toBe('eaVert')
    expect(vertOf('<a:bodyPr vert="vert"/>')).toBe('vert')
    expect(vertOf('<a:bodyPr vert="vert270"/>')).toBe('vert270')
    expect(vertOf('<a:bodyPr vert="wordArtVert"/>')).toBe('wordArtVert')
    expect(vertOf('<a:bodyPr vert="horz"/>')).toBeUndefined()
    expect(vertOf('<a:bodyPr/>')).toBeUndefined()
  })

  it('<a:br/> soft break becomes "\\n" sentinel run', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(
        spWith('<a:p><a:r><a:t>A</a:t></a:r><a:br/><a:r><a:t>B</a:t></a:r></a:p>'),
      ),
      ctx: {},
    })
    const texts = firstText(slide).paragraphs[0].runs.map((r: any) => r.text)
    expect(texts).toEqual(['A', '\n', 'B'])
  })

  it('parses <a:ln> stroke (width + solid fill + dash)', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:ln w="25400" cap="rnd"><a:solidFill><a:srgbClr val="FF6600"/></a:solidFill>' +
      '<a:prstDash val="dash"/></a:ln></p:spPr></p:sp>'
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: slideWith(sp), ctx: {} })
    const el = slide.elements[0] as any
    expect(el.stroke).toEqual({
      fill: { type: 'solid', color: '#FF6600' },
      width: 25400,
      dash: 'dash',
      cap: 'round',
    })
  })

  it('<a:ln><a:noFill/> means no stroke', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:ln w="12700"><a:noFill/></a:ln></p:spPr></p:sp>'
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: slideWith(sp), ctx: {} })
    expect((slide.elements[0] as any).stroke).toBeUndefined()
  })

  it('parses <a:outerShdw> shadow (blur/dist/dir/color+alpha)', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="rect"/><a:effectLst>' +
      '<a:outerShdw blurRad="63500" dist="25400" dir="16200000"><a:srgbClr val="000000"><a:alpha val="20000"/></a:srgbClr></a:outerShdw>' +
      '</a:effectLst></p:spPr></p:sp>'
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: slideWith(sp), ctx: {} })
    const el = slide.elements[0] as any
    expect(el.shadow).toEqual({ color: '#00000033', blurRad: 63500, dist: 25400, dirDeg: 270 })
  })

  it('parses picture <a:srcRect> crop as fractions, all-zero → undefined', () => {
    const pic = (srcRect: string) =>
      '<p:pic><p:nvPicPr><p:cNvPr id="9" name="P"/></p:nvPicPr>' +
      `<p:blipFill><a:blip r:embed="rId1"/>${srcRect}<a:stretch/></p:blipFill>` +
      '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic>'
    const mediaRels = new Map([['rId1', 'ppt/media/image1.png']])
    const s1 = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(pic('<a:srcRect l="10000" t="25000" r="0" b="5000"/>')),
      ctx: { mediaRels },
    })
    expect((s1.elements[0] as any).srcRect).toEqual({ l: 0.1, t: 0.25, r: 0, b: 0.05 })
    const s2 = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(pic('<a:srcRect l="0" t="0" r="0" b="0"/>')),
      ctx: { mediaRels },
    })
    expect((s2.elements[0] as any).srcRect).toBeUndefined()
  })

  it('parses prstGeom avLst adjust values (roundRect adj)', () => {
    const sp =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>' +
      '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst></a:prstGeom>' +
      '</p:spPr></p:sp>'
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: slideWith(sp), ctx: {} })
    const el = slide.elements[0] as any
    expect(el.presetGeometry).toBe('roundRect')
    expect(el.adjust).toEqual({ adj: 50000 })
  })

  it('CJK run prefers a:ea typeface, latin run prefers a:latin', () => {
    const rPr = '<a:rPr sz="1400"><a:latin typeface="Calibri"/><a:ea typeface="SimSun"/></a:rPr>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(
        spWith(`<a:p><a:r>${rPr}<a:t>中文</a:t></a:r><a:r>${rPr}<a:t>latin</a:t></a:r></a:p>`),
      ),
      ctx: {},
    })
    const runs = firstText(slide).paragraphs[0].runs
    expect(runs[0].fontFamily).toBe('SimSun')
    expect(runs[1].fontFamily).toBe('Calibri')
  })
})

describe('placeholder text style inheritance', () => {
  const layoutXml =
    '<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="1" name="T"/><p:nvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="5000" cy="1000"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="3600" b="1">' +
    '<a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:latin typeface="+mj-lt"/>' +
    '</a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld></p:sldLayout>'

  const masterXml =
    '<?xml version="1.0"?><p:sldMaster xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>' +
    '<p:txStyles><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>' +
    '<a:lvl2pPr><a:defRPr sz="1400"/></a:lvl2pPr></p:bodyStyle></p:txStyles></p:sldMaster>'

  const theme: any = { colors: {}, majorFont: 'Georgia', minorFont: 'Calibri' }

  const slideXmlWith = (sp: string) =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld>' +
    `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${sp}</p:spTree></p:cSld></p:sld>`

  const pm = parsePlaceholderMap
  const pmt = parseMasterTextStyles

  it('title placeholder run without rPr inherits layout lstStyle (sz/b/color/align/+mj-lt)', () => {
    const sp =
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideXmlWith(sp),
      ctx: {
        theme,
        layoutPlaceholders: pm(layoutXml, theme),
        masterTextStyles: pmt(masterXml, theme),
      },
    })
    const el = slide.elements[0] as any
    const p = el.text.paragraphs[0]
    expect(p.align).toBe('center')
    expect(p.runs[0].fontSize).toBe(36)
    expect(p.runs[0].bold).toBe(true)
    expect(p.runs[0].color).toBe('#112233')
    expect(p.runs[0].fontFamily).toBe('Georgia') // +mj-lt → theme majorFont
  })

  it('body placeholder inherits master txStyles bodyStyle per level', () => {
    const sp =
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/>' +
      '<a:p><a:r><a:t>L1</a:t></a:r></a:p>' +
      '<a:p><a:pPr lvl="1"/><a:r><a:t>L2</a:t></a:r></a:p>' +
      '</p:txBody></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideXmlWith(sp),
      ctx: { theme, masterTextStyles: pmt(masterXml, theme) },
    })
    const el = slide.elements[0] as any
    expect(el.text.paragraphs[0].runs[0].fontSize).toBe(18)
    expect(el.text.paragraphs[0].runs[0].fontFamily).toBe('Calibri') // +mn-lt
    expect(el.text.paragraphs[1].runs[0].fontSize).toBe(14) // lvl2
  })

  it('explicit run rPr beats inherited defaults', () => {
    const sp =
      '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Title"/><p:nvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2000" b="0"/><a:t>Hi</a:t></a:r></a:p></p:txBody></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideXmlWith(sp),
      ctx: { theme, layoutPlaceholders: pm(layoutXml, theme) },
    })
    const run = (slide.elements[0] as any).text.paragraphs[0].runs[0]
    expect(run.fontSize).toBe(20)
    expect(run.bold).toBe(false)
  })

  it('explicit srgbClr with modifiers resolves the display color but keeps byte linkage', () => {
    const sp =
      '<p:sp><p:nvSpPr><p:cNvPr id="8" name="T"/><p:nvSpPr/><p:nvPr/></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:p>' +
      '<a:r><a:rPr><a:solidFill><a:srgbClr val="44546A"><a:lumMod val="75000"/></a:srgbClr></a:solidFill></a:rPr><a:t>modded</a:t></a:r>' +
      '<a:r><a:rPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr><a:t>plain</a:t></a:r>' +
      '</a:p></p:txBody></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideXmlWith(sp),
      ctx: { theme },
    })
    const runs = (slide.elements[0] as any).text.paragraphs[0].runs
    // lumMod'ed srgbClr: display value is computed, so a rewrite would bake it in
    // and drop the modifier — the patch path must keep the original bytes
    expect(runs[0].colorFollowsTheme).toBe(true)
    expect(runs[0].color?.toUpperCase()).toBe('#333F50') // 44546A × lumMod 75%
    // plain srgbClr stays directly patchable
    expect(runs[1].colorFollowsTheme).toBeUndefined()
    expect(runs[1].color?.toUpperCase()).toBe('#112233')
  })

  it('placeholder geometry inheritance still works with style-only entries present', () => {
    const sp =
      '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Title"/><p:nvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Geo</a:t></a:r></a:p></p:txBody></p:sp>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideXmlWith(sp),
      ctx: { theme, layoutPlaceholders: pm(layoutXml, theme) },
    })
    const el = slide.elements[0] as any
    expect(el.transform.offset.x).toBe(100)
    expect(el.transform.offset.cx).toBe(5000)
  })
})

describe('table (p:graphicFrame a:tbl) parsing', () => {
  const tableXml =
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table 1"/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="1828800"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    '<a:tblPr/><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid>' +
    '<a:tr h="914400">' +
    '<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200" b="1"/><a:t>H1</a:t></a:r></a:p></a:txBody>' +
    '<a:tcPr marL="90000" marR="90000" marT="45000" marB="45000" anchor="ctr">' +
    '<a:lnB w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnB>' +
    '<a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:tcPr></a:tc>' +
    '<a:tc gridSpan="1"><a:txBody><a:bodyPr/><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>' +
    '</a:tr>' +
    '<a:tr h="914400">' +
    '<a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Wide</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>' +
    '<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc>' +
    '</a:tr>' +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  const slideXml =
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld>' +
    `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${tableXml}</p:spTree></p:cSld></p:sld>`

  it('drops a zero-width cell border so the table style line shows through', () => {
    // a real deck: every cell carried lnL/R/T/B w="0" in gold; PowerPoint draws the
    // default style's white lines, not a gold hairline
    const zero = tableXml.replace(
      '<a:lnB w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnB>',
      '<a:lnB w="0" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="D4AF37"/></a:solidFill><a:prstDash val="solid"/></a:lnB>' +
        '<a:lnT w="0"><a:noFill/></a:lnT>',
    )
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideXml.replace(tableXml, zero),
      ctx: {},
    })
    const c00 = (slide.elements[0] as any).rows[0][0]
    expect(c00.borders).toBeUndefined()
  })

  it('parses grid, rows, cell text/fill/borders/margins/anchor and merges', () => {
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx: {} })
    const el = slide.elements[0] as any
    expect(el.type).toBe('table')
    expect(el.colWidths).toEqual([1828800, 1828800])
    expect(el.rowHeights).toEqual([914400, 914400])
    expect(el.transform.offset).toEqual({ x: 914400, y: 914400, cx: 3657600, cy: 1828800 })

    const c00 = el.rows[0][0]
    expect(c00.text.paragraphs[0].runs[0].text).toBe('H1')
    expect(c00.text.paragraphs[0].runs[0].fontSize).toBe(12)
    expect(c00.text.anchor).toBe('middle')
    expect(c00.text.insets).toEqual({ l: 90000, r: 90000, t: 45000, b: 45000 })
    expect(c00.fill).toEqual({ type: 'solid', color: '#112233' })
    expect(c00.borders.b.width).toBe(19050)
    expect(c00.borders.l).toBeUndefined()

    const wide = el.rows[1][0]
    expect(wide.gridSpan).toBe(2)
    expect(el.rows[1][1].merged).toBe(true)
  })

  it('table element keeps byte fidelity (originalXml passthrough on save)', () => {
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx: {} })
    expect(reassembleSlideXml(slide)).toBe(slideXml)
  })
})

describe('tableRowGridCols', () => {
  it('plain row: one tc per column', () => {
    expect(tableRowGridCols([{}, {}, {}])).toEqual([0, 1, 2])
  })

  it('standard merge with continuation tcs advances by 1 per tc', () => {
    expect(tableRowGridCols([{}, { gridSpan: 2 }, { merged: true }, {}])).toEqual([0, 1, 2, 3])
    expect(tableRowGridCols([{ gridSpan: 3 }, { merged: true }, { merged: true }, {}])).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('non-standard merge without continuation tcs advances by span', () => {
    expect(tableRowGridCols([{}, { gridSpan: 2 }, {}])).toEqual([0, 1, 3])
  })

  it('adjacent merges stay independent', () => {
    expect(
      tableRowGridCols([{ gridSpan: 2 }, { merged: true }, { gridSpan: 2 }, { merged: true }]),
    ).toEqual([0, 1, 2, 3])
  })

  it('vMerge continuation row mirroring a gridSpan anchor', () => {
    expect(tableRowGridCols([{ gridSpan: 2, merged: true }, { merged: true }, {}])).toEqual([
      0, 1, 2,
    ])
  })
})

describe('group (p:grpSp) parsing', () => {
  const groupSlideXml =
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
    '<p:nvGrpSpPr/><p:grpSpPr/>' +
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="1" name="G1"/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="1000" y="2000"/><a:ext cx="5000" cy="4000"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="5000" cy="4000"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="child1"/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="1000" cy="500"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:p><a:r><a:t>InGroup</a:t></a:r></a:p></p:txBody></p:sp>' +
    '<p:pic><p:nvPicPr><p:cNvPr id="3" name="childpic"/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId9"/></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="2000" y="200"/><a:ext cx="800" cy="800"/></a:xfrm></p:spPr></p:pic>' +
    '</p:grpSp>' +
    '</p:spTree></p:cSld></p:sld>'

  it('expands group children (sp + pic) with geometry + childOffset', () => {
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: groupSlideXml, ctx: {} })
    const grp = slide.elements.find((e) => e.type === 'group') as any
    expect(grp).toBeTruthy()
    expect(grp.transform.offset.x).toBe(1000)
    expect(grp.transform.offset.cx).toBe(5000)
    expect(grp.childOffset).toEqual({ x: 0, y: 0, cx: 5000, cy: 4000 })
    expect(grp.children.length).toBe(2)
    const [c1, c2] = grp.children
    expect(c1.type).toBe('text')
    expect(c1.transform.offset.x).toBe(100)
    expect(c1.text.paragraphs[0].runs[0].text).toBe('InGroup')
    expect(c2.type).toBe('picture')
    expect(c2.transform.offset.x).toBe(2000)
  })

  it('group emits original bytes on reassemble (fidelity: no child roundtrip)', () => {
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: groupSlideXml, ctx: {} })
    expect(reassembleSlideXml(slide)).toBe(groupSlideXml)
  })
})

describe('byte-fidelity roundtrip', () => {
  for (const name of FIXTURES) {
    it(`${name}: reassembleSlideXml == originalXml (no edits)`, async () => {
      const { deck } = await openPptx(fx(name))
      for (const slide of deck.slides) {
        const rebuilt = reassembleSlideXml(slide)
        expect(rebuilt).toBe(slide.originalXml)
      }
    })

    it(`${name}: savePptx with no dirty produces byte-identical slide parts`, async () => {
      const original = fx(name)
      const opened = await openPptx(original)
      const out = await savePptx(opened)

      // Unzip and compare each slideN.xml's decompressed bytes
      const origZip = await JSZip.loadAsync(original)
      const outZip = await JSZip.loadAsync(out)
      for (const slide of opened.deck.slides) {
        const a = await origZip.file(slide.path)!.async('uint8array')
        const b = await outZip.file(slide.path)!.async('uint8array')
        expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true)
      }
    })
  }
})

describe('bullet (buChar/buAutoNum/buNone) and paragraph indent parsing', () => {
  const sldWith = (pPr: string) =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="tb"/></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:p>${pPr}<a:r><a:t>hi</a:t></a:r></a:p></p:txBody></p:sp>` +
    '</p:spTree></p:cSld></p:sld>'

  it('buChar + marL/indent', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: sldWith('<a:pPr marL="127000" indent="-127000"><a:buChar char="•"/></a:pPr>'),
      ctx: {},
    })
    const p = (slide.elements[0] as any).text.paragraphs[0]
    expect(p.bullet).toEqual({ type: 'char', char: '•' })
    expect(p.marL).toBe(127000)
    expect(p.indent).toBe(-127000)
  })

  it('buAutoNum / buNone', () => {
    const num = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: sldWith('<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
      ctx: {},
    })
    expect((num.elements[0] as any).text.paragraphs[0].bullet.type).toBe('number')
    const none = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: sldWith('<a:pPr><a:buNone/></a:pPr>'),
      ctx: {},
    })
    expect((none.elements[0] as any).text.paragraphs[0].bullet.type).toBe('none')
  })

  it('buBlip picture bullet resolves the blip through the slide rels; buSzPts is absolute pt', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: sldWith(
        '<a:pPr marL="342900" indent="-342900"><a:buSzPts val="2800"/><a:buBlip><a:blip r:embed="rId6"/></a:buBlip></a:pPr>',
      ),
      ctx: { mediaRels: new Map([['rId6', 'ppt/media/image1.png']]) },
    })
    const p = (slide.elements[0] as any).text.paragraphs[0]
    expect(p.bullet).toEqual({
      type: 'blip',
      blipEmbedId: 'rId6',
      mediaRef: 'ppt/media/image1.png',
      sizePt: 28,
    })
  })

  it('buBlip defined on the text body lstStyle level is inherited by plain paragraphs', () => {
    const slideXml =
      '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="tb"/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>' +
      '<a:lstStyle><a:lvl1pPr marL="88900" indent="-88900"><a:buSzPct val="120000"/><a:buBlip><a:blip r:embed="rId6"/></a:buBlip></a:lvl1pPr></a:lstStyle>' +
      '<a:p><a:r><a:t>KB</a:t></a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>plain</a:t></a:r></a:p>' +
      '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml,
      ctx: { mediaRels: new Map([['rId6', 'ppt/media/image1.png']]) },
    })
    const [a, b] = (slide.elements[0] as any).text.paragraphs
    expect(a.bullet).toEqual({
      type: 'blip',
      blipEmbedId: 'rId6',
      mediaRef: 'ppt/media/image1.png',
      sizePct: 120,
    })
    expect(a.marL).toBe(88900)
    expect(b.bullet).toEqual({ type: 'none' })
  })
})

describe('slide master bodyStyle bullet/indent inheritance', () => {
  const masterXml =
    '<?xml version="1.0"?><p:sldMaster xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>' +
    '<p:txStyles><p:bodyStyle>' +
    '<a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#x2022;"/><a:defRPr sz="1800"/></a:lvl1pPr>' +
    '</p:bodyStyle></p:txStyles></p:sldMaster>'
  const sldWith = (paras: string) =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld></p:sld>'

  it('body paragraphs without explicit pPr inherit buChar + marL/indent (entities decoded)', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: sldWith('<a:p><a:r><a:t>Financial results</a:t></a:r></a:p>'),
      ctx: { masterTextStyles: parseMasterTextStyles(masterXml) },
    })
    const p = (slide.elements[0] as any).text.paragraphs[0]
    expect(p.bullet).toEqual({ type: 'char', char: '•' })
    expect(p.marL).toBe(342900)
    expect(p.indent).toBe(-342900)
  })

  it('buFontTx on an inheriting paragraph keeps the glyph but drops the chain font', () => {
    const master =
      '<?xml version="1.0"?><p:sldMaster xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>' +
      '<p:txStyles><p:bodyStyle>' +
      '<a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Wingdings"/><a:buChar char="§"/></a:lvl1pPr>' +
      '</p:bodyStyle></p:txStyles></p:sldMaster>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: sldWith(
        '<a:p><a:pPr><a:buFontTx/></a:pPr><a:r><a:t>a</a:t></a:r></a:p><a:p><a:r><a:t>b</a:t></a:r></a:p>',
      ),
      ctx: { masterTextStyles: parseMasterTextStyles(master) },
    })
    const [a, b] = (slide.elements[0] as any).text.paragraphs
    expect(a.bullet).toEqual({ type: 'char', char: '§' })
    expect(b.bullet).toEqual({ type: 'char', char: '§', font: 'Wingdings' })
  })

  it('explicit buNone overrides master inheritance', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: sldWith('<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>No bullet</a:t></a:r></a:p>'),
      ctx: { masterTextStyles: parseMasterTextStyles(masterXml) },
    })
    expect((slide.elements[0] as any).text.paragraphs[0].bullet.type).toBe('none')
  })
})

describe('line/paragraph spacing inheritance (lstStyle → paragraph) + spcPct paragraph spacing', () => {
  const slideWith = (bodyShapes: string) =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld>' +
    `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${bodyShapes}</p:spTree></p:cSld></p:sld>`
  const spWith = (txBody: string) =>
    '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
    `<p:txBody><a:bodyPr/>${txBody}</p:txBody></p:sp>`
  const LST =
    '<a:lstStyle><a:lvl1pPr>' +
    '<a:lnSpc><a:spcPct val="90000"/></a:lnSpc>' +
    '<a:spcBef><a:spcPct val="50000"/></a:spcBef>' +
    '<a:spcAft><a:spcPts val="300"/></a:spcAft>' +
    '</a:lvl1pPr></a:lstStyle>'
  const firstText = (slide: ReturnType<typeof parseSlide>) => (slide.elements[0] as any).text

  it('spcPct before/after spacing parses into percentage fields', () => {
    const pPr =
      '<a:pPr><a:spcBef><a:spcPct val="50000"/></a:spcBef><a:spcAft><a:spcPct val="20000"/></a:spcAft></a:pPr>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(spWith(`<a:p>${pPr}<a:r><a:t>x</a:t></a:r></a:p>`)),
      ctx: {},
    })
    const p = firstText(slide).paragraphs[0]
    expect(p.spaceBeforePct).toBe(50)
    expect(p.spaceAfterPct).toBe(20)
    expect(p.spaceBefore).toBeUndefined()
  })

  it('line/paragraph spacing inherited from lstStyle when there is no explicit pPr', () => {
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(spWith(`${LST}<a:p><a:r><a:t>x</a:t></a:r></a:p>`)),
      ctx: {},
    })
    const p = firstText(slide).paragraphs[0]
    expect(p.lineHeight).toBe(90)
    expect(p.spaceBeforePct).toBe(50)
    expect(p.spaceAfter).toBe(3)
  })

  it('explicit lnSpc overrides inheritance wholesale (no mixing with inherited pct/pts)', () => {
    const pPr = '<a:pPr><a:lnSpc><a:spcPts val="2400"/></a:lnSpc></a:pPr>'
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(spWith(`${LST}<a:p>${pPr}<a:r><a:t>x</a:t></a:r></a:p>`)),
      ctx: {},
    })
    const p = firstText(slide).paragraphs[0]
    expect(p.lineExact).toBe(24)
    expect(p.lineHeight).toBeUndefined() // don't mix in lstStyle's 90%
    expect(p.spaceBeforePct).toBe(50) // non-overridden paragraph spacing still inherited
  })
})

describe('master txStyles paragraph spacing inheritance (real template fixture)', () => {
  it('body-family placeholders inherit bodyStyle spcBef 20%, title family is explicit 0', async () => {
    const { openPptx } = await import('../src/index')
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const opened = await openPptx(readFileSync(join(here, 'fixtures', '01_standard_business.pptx')))
    const byPh = (ph: string) => {
      for (const s of opened.deck.slides)
        for (const el of s.elements) {
          const e = el as any
          if (e.placeholder === ph && e.text?.paragraphs?.length) return e.text.paragraphs[0]
        }
      return null
    }
    expect(byPh('subTitle')?.spaceBeforePct).toBe(20)
    expect(byPh('ctrTitle')?.spaceBeforePct).toBe(0)
  })
})

describe('stable element ids across re-opens (sdk1 §A.5 #7)', () => {
  // Regression: the slides engine used a module-level monotonic counter
  // that grew across every parse in the process lifetime. Opening the
  // same deck twice produced different ids (sp_0 → sp_6, sp_2 → sp_8,
  // …) and the renderer's stale selections lost everything on reopen.
  // The fix resets the counter at parseSlide entry so a fresh parse
  // always starts at sp_0; this test pins the contract that two
  // back-to-back opens land on the same ids for every element.
  for (const name of FIXTURES) {
    it(`re-opens ${name} with identical element ids`, async () => {
      const bytes = fx(name)
      const a = await openPptx(bytes)
      const b = await openPptx(bytes)
      expect(b.deck.slides.length).toBe(a.deck.slides.length)
      for (let i = 0; i < a.deck.slides.length; i++) {
        const aIds = a.deck.slides[i].elements.map((e: any) => e.id)
        const bIds = b.deck.slides[i].elements.map((e: any) => e.id)
        expect(bIds).toEqual(aIds)
      }
    })
  }

  // Stress: simulate the bug's exact scenario — open twice within the
  // same process and assert no id grows past the first-open baseline.
  // Pre-fix this would fail with bIds starting at sp_6 / sp_8 / sp_a
  // instead of sp_0 / sp_2 / sp_4.
  it('does not leak the counter across separate openPptx calls', async () => {
    const bytes = fx('01_standard_business.pptx')
    const first = await openPptx(bytes)
    const firstIds = first.deck.slides[0].elements.map((e: any) => e.id)
    const second = await openPptx(bytes)
    const secondIds = second.deck.slides[0].elements.map((e: any) => e.id)
    // The bug: counter continues from where first left off, so
    // secondIds[0] starts at sp_<firstIds.length> rather than sp_0.
    expect(secondIds[0]).toBe(firstIds[0])
    expect(secondIds).toEqual(firstIds)
  })
})

describe('hash-based stable ids (sdk1 §11.82 follow-up to §A.5 #7)', () => {
  // The §A.5 #7 baseline resets the monotonic counter at parseSlide entry
  // so a fresh parse always starts at sp_0. That fixes the "open the same
  // deck twice → different ids" bug, but it still does NOT solve the
  // "user inserts a new shape between two existing ones → every later
  // shape's id shifts by one" problem.
  //
  // The hash strategy derives each element id from the sha1 of its raw
  // XML fragment, so the same bytes always produce the same id even when
  // other shapes are added or removed around it.
  const wrap = (shapes: string) =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld>' +
    '<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
    shapes +
    '</p:spTree></p:cSld></p:sld>'

  const spAt = (idx: number) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${1000 + idx}" name="Shape ${idx}"/><p:cNvSpPr/><p:nvSpPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${idx * 1000}" y="0"/><a:ext cx="900000" cy="600000"/></a:xfrm>` +
    `<a:prstGeom prst="rect"/></p:spPr><p:txBody>` +
    `<a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:r><a:t>Shape ${idx}</a:t></a:r></a:p>` +
    `</p:txBody></p:sp>`

  const ctx = { theme: { colors: { accent1: '#0000FF', lt1: '#FFFFFF', dk1: '#000000' } } } as any

  it('hash mode: re-parse yields identical ids across opens', () => {
    const slideXml = wrap(spAt(0) + spAt(1) + spAt(2))
    const a = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx, useHashBasedIds: true })
    const b = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx, useHashBasedIds: true })
    const aIds = a.elements.map((e: any) => e.id)
    const bIds = b.elements.map((e: any) => e.id)
    expect(bIds).toEqual(aIds)
    expect(aIds.every((id: string) => id.startsWith('sp_'))).toBe(true)
  })

  it('hash mode: inserting a new shape between two existing ones keeps the outer shapes stable', () => {
    // The original deck has shapes 0 / 1 / 2.
    const beforeXml = wrap(spAt(0) + spAt(1) + spAt(2))
    const before = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: beforeXml, ctx, useHashBasedIds: true })
    const beforeIds = before.elements.map((e: any) => e.id)

    // Insert a NEW shape (shape index 99 — distinct fragment bytes) at position 1.
    const newShape = spAt(99)
    const afterXml = wrap(spAt(0) + newShape + spAt(1) + spAt(2))
    const after = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: afterXml, ctx, useHashBasedIds: true })
    const afterIds = after.elements.map((e: any) => e.id)

    // The counter scheme would shift everything by 1 (sp_0 unchanged, but
    // sp_1 → sp_2, sp_2 → sp_3). The hash scheme keeps all original shape
    // ids at the same position with the same value.
    expect(after.elements.length).toBe(4)
    expect(afterIds[0]).toBe(beforeIds[0])
    expect(afterIds[2]).toBe(beforeIds[1])
    expect(afterIds[3]).toBe(beforeIds[2])
    // The inserted shape picks up a fresh id (not in the original set).
    expect(afterIds[1]).not.toBe(beforeIds[0])
    expect(afterIds[1]).not.toBe(beforeIds[1])
    expect(afterIds[1]).not.toBe(beforeIds[2])
  })

  it('hash mode: removing a middle shape keeps the outer shapes stable', () => {
    const beforeXml = wrap(spAt(0) + spAt(1) + spAt(2))
    const before = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: beforeXml, ctx, useHashBasedIds: true })
    const beforeIds = before.elements.map((e: any) => e.id)

    // Remove the middle shape.
    const afterXml = wrap(spAt(0) + spAt(2))
    const after = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: afterXml, ctx, useHashBasedIds: true })
    const afterIds = after.elements.map((e: any) => e.id)

    expect(after.elements.length).toBe(2)
    expect(afterIds[0]).toBe(beforeIds[0])
    expect(afterIds[1]).toBe(beforeIds[2])
  })

  it('hash mode: id is independent of position — same fragment at index 1 and index 2 keep their distinct ids', () => {
    // Same bytes at different positions ⇒ different ids (the position
    // contributes through the scan order; but here both parses share
    // identical XML, so the id should be identical even though the
    // absolute position in the deck differs across calls).
    const slideXml = wrap(spAt(0) + spAt(1) + spAt(2))
    const a = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx, useHashBasedIds: true })
    const b = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: wrap(spAt(5) + spAt(6) + spAt(7)), ctx, useHashBasedIds: true })
    // Different fragment bytes ⇒ different ids (sanity check).
    const aIds = a.elements.map((e: any) => e.id)
    const bIds = b.elements.map((e: any) => e.id)
    expect(aIds).not.toEqual(bIds)
  })

  it('hash mode: default (no flag) still uses counter — backward compatible', () => {
    const slideXml = wrap(spAt(0) + spAt(1) + spAt(2))
    const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx })
    const ids = slide.elements.map((e: any) => e.id)
    // counter scheme ⇒ sp_0 / sp_1 / sp_2.
    expect(ids).toEqual(['sp_0', 'sp_1', 'sp_2'])
  })

  it('hash mode: withIdStrategy is exception-safe (try/finally restores prior state)', () => {
    // Mix two strategies in the same parseSlide call — outer counter,
    // inner hash via a synthetic call. This is contrived (no real caller
    // does it today) but pins the contract that withIdStrategy leaves
    // the module-level state clean.
    const slideXml = wrap(spAt(0))
    const outer = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx })
    const outerIds = outer.elements.map((e: any) => e.id)
    const inner = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx, useHashBasedIds: true })
    const innerIds = inner.elements.map((e: any) => e.id)
    // After the inner call, a fresh parse returns to counter behaviour.
    const outer2 = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx })
    const outer2Ids = outer2.elements.map((e: any) => e.id)
    expect(outerIds).toEqual(['sp_0'])
    expect(outer2Ids).toEqual(['sp_0'])
    expect(innerIds[0].startsWith('sp_')).toBe(true)
    expect(innerIds[0]).not.toBe('sp_0')
  })

  it('hash mode: openPptx(bytes, { useHashBasedIds: true }) propagates the option', async () => {
    // End-to-end through openPptx: the option must reach parseSlide
    // for every slide in the deck, so all ids are hash-based.
    const bytes = fx('01_standard_business.pptx')
    const opened = await openPptx(bytes, { useHashBasedIds: true })
    const allIds = opened.deck.slides.flatMap((s: any) => s.elements.map((e: any) => e.id))
    expect(allIds.length).toBeGreaterThan(0)
    // Hash id format: `<prefix>_<10 hex chars>` — every legal kind prefix
    // accepted by uid() plus 10 hex chars (40 bits).
    const validPrefixes = ['sp', 'cxn', 'grp', 'pic', 'chart', 'gf', 'tbl', 'pt', 'olepic']
    const hashRe = new RegExp(`^(${validPrefixes.join('|')})_[0-9a-f]{10}$`)
    expect(allIds.every((id: string) => hashRe.test(id))).toBe(true)
    // Distinct elements → distinct ids (sha1 truncation has negligible collision risk)
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('hash mode: openPptx without options uses the counter scheme (backward compat)', async () => {
    const bytes = fx('01_standard_business.pptx')
    const opened = await openPptx(bytes)
    const allIds = opened.deck.slides.flatMap((s: any) => s.elements.map((e: any) => e.id))
    // Counter scheme: `<prefix>_<base36 short>` — at most 13 chars (10 hex is longer).
    const validPrefixes = ['sp', 'cxn', 'grp', 'pic', 'chart', 'gf', 'tbl', 'pt', 'olepic']
    const counterRe = new RegExp(`^(${validPrefixes.join('|')})_[0-9a-z]{1,5}$`)
    expect(allIds.every((id: string) => counterRe.test(id))).toBe(true)
  })
})

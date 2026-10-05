/**
 * Small self-contained XML fragment builders (TOC / caption / index field,
 * floating line paragraphs) kept out of generate.ts so boot-path consumers
 * (ribbon menus, AI ops) don't pull the whole generation layer into the
 * entry chunk.
 */
import { escapeXmlText } from './xml-utils'

const EMU_PER_PT = 12700

/** Insertable line/connector kinds: stroke-only wps:wsp with optional arrow ends */
export const LINE_KINDS: Record<string, { prst: string; head?: boolean; tail?: boolean }> = {
  line: { prst: 'line' },
  lineArrow: { prst: 'straightConnector1', tail: true },
  lineArrowDouble: { prst: 'straightConnector1', head: true, tail: true },
  lineBent: { prst: 'bentConnector3' },
  lineCurved: { prst: 'curvedConnector3' },
}

/** Insert a floating stroke-only line/connector paragraph (wp:anchor + wps:wsp). */
export function buildLineParagraphXml(opts: {
  kind: string
  widthEmu?: number
  heightEmu?: number
  id?: number
  colorHex?: string
}): string {
  const def = LINE_KINDS[opts.kind] ?? LINE_KINDS.line
  const widthEmu = opts.widthEmu ?? 1800000
  const heightEmu = opts.heightEmu ?? 114300
  const id = opts.id ?? 1
  const colorHex = opts.colorHex ?? '000000'

  const ln =
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill>` +
    (def.head ? '<a:headEnd type="triangle"/>' : '') +
    (def.tail ? '<a:tailEnd type="triangle"/>' : '') +
    `</a:ln>`

  const spPr =
    `<wps:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="${def.prst}"><a:avLst/></a:prstGeom>` +
    `<a:noFill/>` +
    ln +
    `</wps:spPr>`

  const wsp =
    `<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
    `<wps:cNvSpPr/>` +
    spPr +
    `<wps:bodyPr/>` +
    `</wps:wsp>`

  const graphicData =
    `<a:graphicData xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">${wsp}</a:graphicData>`

  const graphic = `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${graphicData}</a:graphic>`

  const anchor =
    `<wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `distT="0" distB="0" distL="114300" distR="114300" simplePos="0" ` +
    `relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="column"><wp:align>center</wp:align></wp:positionH>` +
    `<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapSquare wrapText="bothSides"/>` +
    `<wp:docPr id="${id}" name="${def.prst} ${id}"/>` +
    graphic +
    `</wp:anchor>`

  const mcNs =
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
  const mcChoice = `<mc:Choice Requires="wps"><w:drawing>${anchor}</w:drawing></mc:Choice>`
  const vmlLine =
    `<v:line xmlns:v="urn:schemas-microsoft-com:vml" ` +
    `from="0,0" to="${Math.round(widthEmu / EMU_PER_PT)}pt,${Math.round(heightEmu / EMU_PER_PT)}pt" ` +
    `strokecolor="#${colorHex}"/>`
  const mcFallback = `<mc:Fallback><w:pict>${vmlLine}</w:pict></mc:Fallback>`

  return `<w:p><w:r><mc:AlternateContent ${mcNs}>${mcChoice}${mcFallback}</mc:AlternateContent></w:r></w:p>`
}

/**
 * Caption paragraph: `<label> <SEQ label> <text>`, e.g. "Figure 1 System architecture".
 * The SEQ field is marked dirty so Word renumbers all captions on open; the
 * static number is the visible result until then.
 */
export function generateCaptionXml(label: string, number: number, text: string): string {
  const rPr = '<w:rPr><w:color w:val="44546A"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
  const run = (inner: string) => `<w:r>${rPr}${inner}</w:r>`
  return (
    '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="200"/></w:pPr>' +
    run(`<w:t xml:space="preserve">${escapeXmlText(label)} </w:t>`) +
    run('<w:fldChar w:fldCharType="begin" w:dirty="true"/>') +
    run(
      `<w:instrText xml:space="preserve"> SEQ ${escapeXmlText(label)} \\* ARABIC </w:instrText>`,
    ) +
    run('<w:fldChar w:fldCharType="separate"/>') +
    run(`<w:t>${number}</w:t>`) +
    run('<w:fldChar w:fldCharType="end"/>') +
    (text ? run(`<w:t xml:space="preserve"> ${escapeXmlText(text)}</w:t>`) : '') +
    '</w:p>'
  )
}

/**
 * INDEX field as one w:p per cached entry line, alphabetically sorted. The
 * begin fldChar is dirty so Word rebuilds entries and page numbers on open.
 */
export function generateIndexFieldXml(terms: string[]): string[] {
  const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean))]
  if (unique.length === 0) return []
  unique.sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const begin =
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> INDEX \\c "2" </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  const pPr =
    '<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="4300"/></w:tabs>' +
    '<w:rPr><w:noProof/></w:rPr></w:pPr>'
  return unique.map((term, i) => {
    const first = i === 0 ? begin : ''
    const last = i === unique.length - 1 ? end : ''
    return (
      `<w:p>${pPr}${first}` +
      `<w:r><w:rPr><w:noProof/></w:rPr><w:t xml:space="preserve">${escapeXmlText(term)}</w:t></w:r>` +
      '<w:r><w:rPr><w:noProof/></w:rPr><w:tab/></w:r>' +
      `${last}</w:p>`
    )
  })
}


export interface TocEntry {
  /** heading level 1-9 */
  level: number
  text: string
  /** page number computed by real pagination (cached text; begin is dirty, so Word still recalculates on open) */
  pageNo?: number
}

/**
 * Generate a real TOC field as one w:p fragment per line. The begin fldChar is
 * marked dirty so Word recalculates entries and page numbers on open; the
 * static entry texts serve as the visible result until then.
 */
export function generateTocFieldXml(entries: TocEntry[]): string[] {
  if (entries.length === 0) return []
  const maxLevel = Math.min(Math.max(...entries.map((e) => e.level), 1), 9)
  const pPr = (level: number) =>
    `<w:pPr><w:pStyle w:val="TOC${Math.min(Math.max(level, 1), 9)}"/>` +
    '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs>' +
    '<w:rPr><w:noProof/></w:rPr></w:pPr>'
  const entryRuns = (text: string, pageNo?: number) =>
    `<w:r><w:rPr><w:noProof/></w:rPr><w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>` +
    '<w:r><w:rPr><w:noProof/></w:rPr><w:tab/></w:r>' +
    (pageNo !== undefined ? `<w:r><w:rPr><w:noProof/></w:rPr><w:t>${pageNo}</w:t></w:r>` : '')
  const begin =
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-${maxLevel}" \\h \\z \\u </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'

  return entries.map((entry, i) => {
    const first = i === 0 ? begin : ''
    const last = i === entries.length - 1 ? end : ''
    return `<w:p>${pPr(entry.level)}${first}${entryRuns(entry.text, entry.pageNo)}${last}</w:p>`
  })
}

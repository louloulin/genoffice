export * from './types'
export { deobfuscateOdttf, isSfnt, parseFontTable, readEmbeddedFonts } from './font-table'
export { decodeEntities } from './parse-xml-text'
export { sdtCheckboxGlyphs, sdtCheckboxIsChecked } from './checkbox-control'
export { parseDocx, styleRunFormat, type ParseExtras, type ParseOptions } from './parse'
export { setAltChunkHtmlConverter, type AltChunkHtmlConverter } from './alt-chunk'
export { tocLevelOf } from './parse-fields'
export {
  saveDocx,
  findChartWorkbookPath,
  readDocxPartBase64,
  type SaveBlock,
  type SaveOptions,
  type StyleUpsert,
  type ParsedDocFull,
} from './patch'
export {
  TABLE_HEADER_FILL,
  applyImageWrap,
  applyImageZOrder,
  buildAnchoredTextboxParagraphXml,
  buildShapeParagraphXml,
  buildTextboxParagraphXml,
  buildWordArtParagraphXml,
  type AnchoredTextboxOptions,
  type TextboxContentParagraph,
  generateParagraphXml,
  generateTableModelXml,
  generateTableXml,
  mergePPrFormat,
  setPPrChange,
  stripPPrChange,
  patchFieldParagraphXml,
  patchImageParagraphXml,
  patchMathTokens,
  patchTableCellTexts,
  patchTextboxHeights,
  patchTextboxParas,
  patchTextboxSizes,
  patchShapeStyles,
  type ShapeStylePatch,
  patchDrawingExtent,
  type TextboxSizePatch,
  type CellParaPatch,
  type CellTextsPatch,
  type FieldTextPatch,
  type GenerateContext,
  type ImagePatch,
  type TextboxParaPatch,
  type TextboxParasPatchSet,
  type TableGenOptions,
} from './generate'
export {
  buildLineParagraphXml,
  generateCaptionXml,
  generateIndexFieldXml,
  generateTocFieldXml,
  LINE_KINDS,
  type TocEntry,
} from './fragments'

export {
  buildChartPartXml,
  buildChartWorkbookXlsxBase64,
  patchChartWorkbookXlsxBase64,
  parseChartPartXml,
  patchChartPartXml,
  CHART_WORKBOOK_REL_TYPE,
  type ChartPatch,
  type ChartSeriesPatch,
} from './chart'
export {
  latexToOmml,
  mathParagraphXml,
  mathTokensOf,
  ommlFragmentsOf,
  ommlToLatex,
  ommlToMathML,
} from './math'
export { scanBody, type BodyElement, type BodyScan } from './scan'
export {
  buildBlankDocx,
  type BlankDocxOptions,
  type CustomNumberingLevel,
} from './blank'
export {
  DEFAULT_SECTION,
  applySectionSettings,
  applyPageNumType,
  applySectionStartType,
  readPageColor,
  readSections,
  readSectionSettings,
  sectionSettingsFromXml,
  notePropsFromXml,
} from './section'
export { nextNoteId, parseNotesXml, type NoteKind } from './notes'
export { readWatermarkText } from './watermark'
export {
  INK_NAME_PREFIX,
  anchoredInkRunXml,
  findInkRuns,
  injectInkRunsIntoParagraph,
  stripInkRuns,
} from './ink'
export { bibliographyLine, citationText, parseSourcesXml } from './sources'
export { parseZoteroDocumentDataXml, patchZoteroDocumentDataXml } from './zotero-doc-props'
export { readThemeColors, readThemeFonts, lumHex, shadeHex, tintHex } from './theme'
export { hashProtectionPassword, verifyProtectionPassword } from './protection'
export {
  decodeSymbolChar,
  decodeSymbolText,
  isSymbolFont,
  symbolGlyph,
  symbolPuaChar,
  toSymbolPua,
} from './symbol-fonts'
export {
  bulletMarkerScale,
  computeListMarkerInfos,
  computeListMarkers,
  customEnumItems,
  formatNumber,
  markerTabAdvance,
  type ListItemRef,
  type ListMarkerInfo,
} from './list-markers'

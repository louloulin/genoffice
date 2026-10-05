import type { Editor } from '@tiptap/core'
import {
  buildLineParagraphXml,
  buildShapeParagraphXml,
  buildTextboxParagraphXml,
  buildWordArtParagraphXml,
  LINE_KINDS,
  type TextboxDisplay,
} from '@genoffice/docx-engine'
import { wordArtSolidColor, type WordArtPreset } from '@genoffice/ui'
import { t, type StringKey } from '../i18n/locale'
import { isStraightLineKind } from '../editor/shape-svg'
import { insertTopLevelBlockAtSelection, shapeLabel } from './ribbon-tabs'

// Shape / textbox / WordArt insertion XML builders live in the docx generation
// layer; loading them from the entry chunk cost ~100KB for actions that run
// only on an explicit ribbon click, so this module is imported on demand.
/** 5 cm × 3 cm default textbox size in EMU (1 cm = 360000 EMU) */
const TEXTBOX_WIDTH_EMU = 1800000
const TEXTBOX_HEIGHT_EMU = 1080000

/** Default TextboxDisplay model for a freshly inserted empty textbox */
function emptyTextboxDisplay(): TextboxDisplay {
  return {
    fill: 'FFFFFF',
    borderColor: '000000',
    widthPx: Math.round(TEXTBOX_WIDTH_EMU / 9525),
    heightPx: Math.round(TEXTBOX_HEIGHT_EMU / 9525),
    paras: [{ runs: [{ text: '' }] }],
  }
}

/** Insert a floating text box (wp:anchor + wps:wsp) at the current cursor. */
export function insertTextboxAt(editor: Editor): void {
  const xml = buildTextboxParagraphXml({
    widthEmu: TEXTBOX_WIDTH_EMU,
    heightEmu: TEXTBOX_HEIGHT_EMU,
    id: Math.floor(Math.random() * 900000) + 100000,
  })
  // top-level insert: a plain insertContent would replace a selected floating
  // node and fails silently from inside a table cell
  insertTopLevelBlockAtSelection(editor, {
    type: 'docProtected',
    attrs: {
      docxIndex: null,
      blockType: 'passthrough',
      label: t('ribbonTextBox'),
      genXml: xml,
      textboxes: [emptyTextboxDisplay()],
    },
  })
}

/**
 * Insert a floating preset shape (wps:wsp with prstGeom) at the cursor, or at
 * an explicit top-level doc position with an explicit size (shape draw mode).
 * Returns the position the block was inserted at (null if the insert failed).
 */
export function insertShapeAt(
  editor: Editor,
  prst: string,
  opts?: { widthEmu?: number; heightEmu?: number; atPos?: number },
): number | null {
  if (prst in LINE_KINDS) return insertLineAt(editor, prst, opts)
  const widthEmu = opts?.widthEmu ?? 1800000
  const heightEmu = opts?.heightEmu ?? 1080000
  const xml = buildShapeParagraphXml({
    prst,
    widthEmu,
    heightEmu,
    id: Math.floor(Math.random() * 900000) + 100000,
    // default Office blue fill + slightly darker border
    fillHex: '4472C4',
    borderHex: '2F5496',
    withTextbox: true,
  })
  // mirrors what buildShapeParagraphXml just wrote: centered both ways, and the
  // light text the shape style's a:fontRef resolves to. Without this the shape
  // reads top-left and black until the file is saved and reopened.
  const textbox: TextboxDisplay = {
    fill: '4472C4',
    borderColor: '2F5496',
    widthPx: Math.round(widthEmu / 9525),
    heightPx: Math.round(heightEmu / 9525),
    prst,
    vAlign: 'center',
    textColor: 'FFFFFF',
    paras: [{ runs: [{ text: '' }], align: 'center' }],
  }
  const content = {
    type: 'docProtected',
    attrs: {
      docxIndex: null,
      blockType: 'passthrough',
      label: t('ribbonShapeLabel', { name: shapeLabel(prst) }),
      genXml: xml,
      textboxes: [textbox],
    },
  }
  const { $from } = editor.state.selection
  const position = opts?.atPos ?? ($from.depth > 0 ? $from.after(1) : editor.state.selection.to)
  return editor.chain().focus().insertContentAt(position, content).run() ? position : null
}

/** Word's horizontal-line extent (12 px grab band); straight lines always save this cy. */
const LINE_HEIGHT_EMU = 114300

/**
 * Insert a floating stroke-only line/connector (noFill wps:wsp) at the cursor
 * or an explicit position. Straight kinds ignore the drawn height and land as
 * a level line (the docx model stores Word's zero-ish-height extent); bent and
 * curved connectors keep the drawn box.
 */
function insertLineAt(
  editor: Editor,
  kind: string,
  opts?: { widthEmu?: number; heightEmu?: number; atPos?: number },
): number | null {
  const widthEmu = opts?.widthEmu ?? 1800000
  const heightEmu = isStraightLineKind(kind) ? LINE_HEIGHT_EMU : (opts?.heightEmu ?? 1080000)
  const xml = buildLineParagraphXml({
    kind,
    widthEmu,
    heightEmu,
    id: Math.floor(Math.random() * 900000) + 100000,
    colorHex: '000000',
  })
  // Mirror what parse.ts' lineBoxOf yields on reopen: read-only display box,
  // stroke color on borderColor, zero insets.
  const textbox: TextboxDisplay = {
    borderColor: '000000',
    widthPx: Math.round(widthEmu / 9525),
    heightPx: Math.round(heightEmu / 9525),
    prst: kind,
    paras: [],
    readOnly: true,
    insetTopPx: 0,
    insetRightPx: 0,
    insetBottomPx: 0,
    insetLeftPx: 0,
  }
  const content = {
    type: 'docProtected',
    attrs: {
      docxIndex: null,
      blockType: 'passthrough',
      label: t('ribbonShapeLabel', { name: shapeLabel(kind) }),
      genXml: xml,
      textboxes: [textbox],
    },
  }
  const { $from } = editor.state.selection
  const position = opts?.atPos ?? ($from.depth > 0 ? $from.after(1) : editor.state.selection.to)
  return editor.chain().focus().insertContentAt(position, content).run() ? position : null
}

/** ~7.5 cm × 2 cm default size for WordArt in EMU */
const WORDART_WIDTH_EMU = 2700000
const WORDART_HEIGHT_EMU = 720000

/** Insert a floating WordArt text box at the cursor. */
export function insertWordArtAt(editor: Editor, preset: WordArtPreset): void {
  // The saved run can only carry a solid color; light fills fall back to the
  // outline color so the text stays readable when the file is reopened.
  const solidHex = wordArtSolidColor(preset).replace('#', '')
  const xml = buildWordArtParagraphXml({
    colorHex: solidHex,
    italic: preset.italic,
    widthEmu: WORDART_WIDTH_EMU,
    heightEmu: WORDART_HEIGHT_EMU,
    id: Math.floor(Math.random() * 900000) + 100000,
  })
  const textbox: TextboxDisplay = {
    // no background fill; shape border is also absent (noFill)
    widthPx: Math.round(WORDART_WIDTH_EMU / 9525),
    heightPx: Math.round(WORDART_HEIGHT_EMU / 9525),
    wordArtId: preset.id,
    paras: [
      {
        runs: [
          {
            text: t('ribbonWordArtDefaultText'),
            color: solidHex,
            bold: true,
            italic: preset.italic,
            sizeHalfPoints: 72,
          },
        ],
        align: 'center',
      },
    ],
  }
  // top-level insert: a plain insertContent would replace a selected floating
  // node and fails silently from inside a table cell
  insertTopLevelBlockAtSelection(editor, {
    type: 'docProtected',
    attrs: {
      docxIndex: null,
      blockType: 'passthrough',
      label: t('ribbonWordArtLabel', { name: t(preset.nameKey as StringKey) }),
      genXml: xml,
      textboxes: [textbox],
    },
  })
}

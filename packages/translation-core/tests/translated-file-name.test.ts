/**
 * 翻译副本的文件名规则。
 *
 * 这一组断言是**与服务端对齐的契约测试**：Dataflare
 * `DriveOfficeSessionService.deriveTranslatedName` 是权威实现，浏览器端这份镜像
 * 的唯一职责是「保存前把名字显示给用户看」。两侧一旦分叉，用户看到的名字和云盘
 * 里落盘的名字就对不上，而这种不一致不会报错、不会让任何用例变红 —— 所以规则本身
 * （保留扩展名、截基名不截扩展名、截尾不截头）在这里被逐条钉住。
 */
import { describe, expect, it } from 'vitest'

import {
  BILINGUAL_NAME_SUFFIX,
  DRIVE_NAME_MAX_LENGTH,
  TRANSLATED_NAME_SUFFIX,
  deriveTranslatedName,
  translatedNameSuffixFor,
} from '../src/translated-file-name'

describe('deriveTranslatedName', () => {
  it('inserts the suffix before the extension', () => {
    expect(deriveTranslatedName('报价单.docx', TRANSLATED_NAME_SUFFIX)).toBe('报价单.translated.docx')
    expect(deriveTranslatedName('report.xlsx', TRANSLATED_NAME_SUFFIX)).toBe('report.translated.xlsx')
    expect(deriveTranslatedName('deck.pptx', BILINGUAL_NAME_SUFFIX)).toBe('deck.bilingual.pptx')
    expect(deriveTranslatedName('manual.pdf', TRANSLATED_NAME_SUFFIX)).toBe('manual.translated.pdf')
  })

  // 扩展名是「保原格式」的全部依据：换掉它，云盘下载与知识库解析就对不上号。
  it('keeps the extension untouched for every supported format', () => {
    for (const ext of ['docx', 'xlsx', 'pptx', 'pdf']) {
      expect(deriveTranslatedName(`file.${ext}`, TRANSLATED_NAME_SUFFIX).endsWith(`.${ext}`)).toBe(true)
    }
  })

  it('treats a name without an extension as all base', () => {
    expect(deriveTranslatedName('README', TRANSLATED_NAME_SUFFIX)).toBe('README.translated')
  })

  // 句点在前一位时不是扩展名：`.gitignore` 派生出 `.gitignore.translated`
  // 而不是把「空的基名 + 后缀」拼成一个没有名字的文件。
  it('does not read a leading dot as an extension', () => {
    expect(deriveTranslatedName('.gitignore', TRANSLATED_NAME_SUFFIX)).toBe('.gitignore.translated')
  })

  it('does not read a trailing dot as an extension', () => {
    expect(deriveTranslatedName('name.', TRANSLATED_NAME_SUFFIX)).toBe('name..translated')
  })

  it('falls back to a legal name when the original is missing', () => {
    for (const original of [null, undefined, '', '   ']) {
      expect(deriveTranslatedName(original, TRANSLATED_NAME_SUFFIX)).toBe('untitled.translated')
    }
  })

  // 截的是**基名**而不是整体：整体截会把 `.docx` 截掉，产出一个云盘认不出的文件。
  it('truncates the base, never the suffix or the extension', () => {
    const long = 'x'.repeat(400)
    const derived = deriveTranslatedName(`${long}.docx`, TRANSLATED_NAME_SUFFIX)
    expect(derived.length).toBeLessThanOrEqual(DRIVE_NAME_MAX_LENGTH)
    expect(derived.endsWith('.translated.docx')).toBe(true)
  })

  it('keeps the tail of an over-long base (the part that tells files apart)', () => {
    const tail = 'final'
    const base = `${'a'.repeat(300)}${tail}`
    const derived = deriveTranslatedName(`${base}.docx`, TRANSLATED_NAME_SUFFIX)
    // room = 255 - '.translated.docx'.length; the base is cut to its last `room`
    // characters, so the distinguishing tail survives and only leading filler goes.
    const room = DRIVE_NAME_MAX_LENGTH - '.translated.docx'.length
    expect(derived).toBe(`${'a'.repeat(room - tail.length)}${tail}.translated.docx`)
  })

  // 宁可名字退化，也不能产出服务端 DriveNames.requireValid 会拒绝的文件名。
  it('degrades instead of emitting an over-long name when the suffix eats the budget', () => {
    const derived = deriveTranslatedName('short.docx', 's'.repeat(DRIVE_NAME_MAX_LENGTH))
    expect(derived).toBe('untitled')
  })
})

describe('translatedNameSuffixFor', () => {
  it('picks bilingual only for a bilingual apply', () => {
    expect(translatedNameSuffixFor('bilingual')).toBe(BILINGUAL_NAME_SUFFIX)
    expect(translatedNameSuffixFor('replace')).toBe(TRANSLATED_NAME_SUFFIX)
  })

  // 单段翻译也会走同一个「模式 → 后缀」判断，不写 undefined 分支就是让
  // 选区翻译产出一个没有后缀的文件名。
  it('falls back to translated when the mode is absent', () => {
    expect(translatedNameSuffixFor(undefined)).toBe(TRANSLATED_NAME_SUFFIX)
  })
})

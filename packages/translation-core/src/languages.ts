import type { LanguageCode, LanguageOption } from './types'

/**
 * Languages the AI translation UI offers.
 *
 * Labels are in the option's own language so the picker reads naturally for
 * every user; the English label travels into the prompt as the canonical name
 * the LLM should target. Keep this list in lock-step with the language select
 * in `packages/ui/src/TranslateDialog.tsx`.
 */
export const LANGUAGES: readonly LanguageOption[] = [
  { value: 'auto', label: '自动检测', englishLabel: 'Auto-detect' },
  { value: 'zh-CN', label: '简体中文', englishLabel: 'Simplified Chinese' },
  { value: 'zh-TW', label: '繁體中文', englishLabel: 'Traditional Chinese' },
  { value: 'en-US', label: 'English', englishLabel: 'English' },
  { value: 'ja-JP', label: '日本語', englishLabel: 'Japanese' },
  { value: 'ko-KR', label: '한국어', englishLabel: 'Korean' },
  { value: 'fr-FR', label: 'Français', englishLabel: 'French' },
  { value: 'de-DE', label: 'Deutsch', englishLabel: 'German' },
  { value: 'es-ES', label: 'Español', englishLabel: 'Spanish' },
  { value: 'it-IT', label: 'Italiano', englishLabel: 'Italian' },
  { value: 'pt-PT', label: 'Português', englishLabel: 'Portuguese' },
  { value: 'ru-RU', label: 'Русский', englishLabel: 'Russian' },
  { value: 'ar-SA', label: 'العربية', englishLabel: 'Arabic' },
  { value: 'hi-IN', label: 'हिन्दी', englishLabel: 'Hindi' },
  { value: 'th-TH', label: 'ไทย', englishLabel: 'Thai' },
] as const

const BY_VALUE = new Map<LanguageCode, LanguageOption>(LANGUAGES.map((opt) => [opt.value, opt]))

function familyOf(value: string): string {
  const idx = value.indexOf('-')
  return (idx >= 0 ? value.slice(0, idx) : value).toLowerCase()
}

/** Look up a language by BCP-47 code; falls back to an English-label guess. */
export function getLanguage(value: string | undefined | null): LanguageOption | null {
  if (!value) return null
  const direct = BY_VALUE.get(value as LanguageCode)
  if (direct) return direct
  // tolerate stripped region codes (e.g. 'en' from a foreign UI)
  const family = familyOf(value)
  for (const opt of LANGUAGES) {
    if (opt.value === 'auto') continue
    if (familyOf(opt.value) === family) return opt
  }
  return null
}

/** Canonical name for prompts: prefers the English label, falls back to the code. */
export function englishLabelFor(value: string | undefined | null): string {
  const lang = getLanguage(value)
  if (lang) return lang.englishLabel
  if (!value || value === 'auto') return 'Auto-detect'
  // last resort — pass the code through so the model still gets a target
  return value
}

/**
 * Writing system a piece of text is mostly set in.
 *
 * Only the systems the translation pipeline actually has to tell apart are
 * modelled — the point is not to identify a language, just to answer "is this
 * string already written in the script the target language uses?". A tech
 * pack, a bilingual contract, or a partially-localized brochure mixes scripts
 * inside one file, and the dictionary pass has to leave the already-translated
 * half alone.
 */
export type TextScript =
  | 'han'
  | 'kana'
  | 'hangul'
  | 'latin'
  | 'cyrillic'
  | 'arabic'
  | 'devanagari'
  | 'thai'
  | 'other'

const SCRIPT_PATTERNS: ReadonlyArray<readonly [TextScript, RegExp]> = [
  ['han', /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g],
  ['kana', /[\u3040-\u30ff]/g],
  ['hangul', /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g],
  ['latin', /[A-Za-z\u00c0-\u024f]/g],
  ['cyrillic', /[\u0400-\u04ff]/g],
  ['arabic', /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff]/g],
  ['devanagari', /[\u0900-\u097f]/g],
  ['thai', /[\u0e00-\u0e7f]/g],
]

/**
 * The script that accounts for the most letters in `text`. Returns `'other'`
 * when the string carries no letters at all (pure numbers, punctuation,
 * measurements), which callers should treat as "nothing to translate".
 */
export function dominantScript(text: string): TextScript {
  let best: TextScript = 'other'
  let bestCount = 0
  for (const [script, pattern] of SCRIPT_PATTERNS) {
    const count = (text.match(pattern) ?? []).length
    if (count > bestCount) {
      best = script
      bestCount = count
    }
  }
  return best
}

/**
 * Share (0..1) of `text`'s letters that belong to `script`. Returns 0 for
 * letterless strings, so callers never divide by zero and never treat
 * "16-4408" as being in any language.
 */
export function scriptShare(text: string, script: TextScript): number {
  let total = 0
  let hits = 0
  for (const [name, pattern] of SCRIPT_PATTERNS) {
    const count = (text.match(pattern) ?? []).length
    total += count
    if (name === script) hits = count
  }
  return total === 0 ? 0 : hits / total
}

/** The script a target language is written in; `null` when it cannot be pinned down. */
export function scriptOfLanguage(value: string | undefined | null): TextScript | null {
  const lang = getLanguage(value)
  switch (lang?.value) {
    case 'zh-CN':
    case 'zh-TW':
      return 'han'
    case 'ja-JP':
      return 'kana'
    case 'ko-KR':
      return 'hangul'
    case 'en-US':
      return 'latin'
    case 'fr-FR':
    case 'de-DE':
    case 'es-ES':
    case 'it-IT':
    case 'pt-PT':
      return 'latin'
    case 'ru-RU':
      return 'cyrillic'
    case 'ar-SA':
      return 'arabic'
    case 'hi-IN':
      return 'devanagari'
    case 'th-TH':
      return 'thai'
    default:
      return null
  }
}

/**
 * How much of a line must already be written in the target script before we
 * stop treating it as source text. One third is deliberately well below a
 * majority: a tech pack line like `CAD款号：50466 尺码：XXS-2X` counts six
 * Latin letters (the header word and a size code) against four Chinese ones,
 * and the Chinese half is the half that must not be touched.
 */
const MIN_TARGET_SCRIPT_SHARE = 1 / 3

/**
 * True when `text` is already written in the target language's script, so
 * asking a model to translate it would either be a no-op or — worse — flip it
 * into the *other* language. A zh-CN job handed "花型有方向性。" came back as
 * "The pattern is directional." before this guard existed, which then got
 * written into the dictionary and stamped over the Chinese original.
 *
 * The test is intentionally blunt: it is about scripts, not languages, so it
 * cannot tell Chinese from Japanese kanji, and it says nothing at all about
 * lines with no letters (measurements, colour codes) — those still route to
 * the model, which returns them unchanged and the dictionary records an
 * explicit entry.
 *
 * Japanese is the one language that mixes scripts, so a kana target also
 * accepts han text (kanji). A line that merely *contains* the target script
 * qualifies once that script reaches `MIN_TARGET_SCRIPT_SHARE` of its letters;
 * below that the line is mostly a brand name or a code and goes to the model,
 * which is a wasted call but never a corruption.
 */
export function isAlreadyInLanguage(text: string, targetLang: string | undefined | null): boolean {
  const target = scriptOfLanguage(targetLang)
  if (target === null) return false
  const actual = dominantScript(text)
  if (actual === 'other') return false
  if (actual === target) return true
  const acceptable = target === 'kana' ? (['kana', 'han'] as const) : undefined
  if (acceptable) {
    return acceptable.some((script) => scriptShare(text, script) >= MIN_TARGET_SCRIPT_SHARE)
  }
  return scriptShare(text, target) >= MIN_TARGET_SCRIPT_SHARE
}

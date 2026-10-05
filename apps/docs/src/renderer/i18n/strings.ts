import type { Lang } from '@genoffice/i18n'
import { zh as appZh } from './app/zh'
import { zh as ribbonZh } from './ribbon/zh'
import { zh as aiZh } from './ai/zh'
import { zh as editorZh } from './editor/zh'
import { zh as zoteroZh } from './zotero/zh'
import { tableStrings } from './strings-table'
import type { DomainDicts } from './domains'

/**
 * zh 合并词典 —— 主 bundle 内唯一随包携带的 locale。它拥有 StringKey 键集,
 * 并在其他 locale chunk 加载期间充当同步回退(规格允许「回退键或短暂等待」)。
 * 其余 19 个 locale 各成一个 chunk(langs/<lang>.ts),切换时按需拉取。
 */
export const zhStrings = {
  ...appZh,
  ...ribbonZh,
  ...tableStrings.zh,
  ...editorZh,
  ...aiZh,
  ...zoteroZh,
}

export type StringKey = keyof typeof zhStrings

export type LangStrings = Record<StringKey, string>

// One lazy chunk per locale: langs/<lang>.ts statically pulls that locale's
// five domain shards, so a language switch fetches exactly one file.
const LANG_CHUNKS: Record<Exclude<Lang, 'zh'>, () => Promise<{ langStrings: DomainDicts }>> = {
  en: () => import('./langs/en'),
  ja: () => import('./langs/ja'),
  ko: () => import('./langs/ko'),
  fr: () => import('./langs/fr'),
  de: () => import('./langs/de'),
  es: () => import('./langs/es'),
  th: () => import('./langs/th'),
  id: () => import('./langs/id'),
  ru: () => import('./langs/ru'),
  ar: () => import('./langs/ar'),
  pt: () => import('./langs/pt'),
  it: () => import('./langs/it'),
  pl: () => import('./langs/pl'),
  cs: () => import('./langs/cs'),
  nl: () => import('./langs/nl'),
  ms: () => import('./langs/ms'),
  he: () => import('./langs/he'),
  hi: () => import('./langs/hi'),
  'zh-TW': () => import('./langs/zh-TW'),
}

const loadedLangs = new Map<Exclude<Lang, 'zh'>, LangStrings>()
const inflightLangs = new Map<Exclude<Lang, 'zh'>, Promise<LangStrings>>()

/** Already-loaded dictionary for a locale, or undefined (zh always resolves). */
export function cachedStrings(lang: Lang): LangStrings | undefined {
  return lang === 'zh' ? zhStrings : loadedLangs.get(lang)
}

/** Resolve a locale's merged dictionary; zh is static, others load their chunk (deduped). */
export function loadStrings(lang: Lang): Promise<LangStrings> {
  if (lang === 'zh') return Promise.resolve(zhStrings)
  const cached = loadedLangs.get(lang)
  if (cached) return Promise.resolve(cached)
  const inflight = inflightLangs.get(lang)
  if (inflight) return inflight
  const promise = LANG_CHUNKS[lang]()
    .then((mod) => {
      const d = mod.langStrings
      const merged = { ...d.app, ...d.ribbon, ...d.table, ...d.editor, ...d.ai, ...d.zotero } as LangStrings
      loadedLangs.set(lang, merged)
      inflightLangs.delete(lang)
      return merged
    })
    .catch((err) => {
      inflightLangs.delete(lang)
      throw err
    })
  inflightLangs.set(lang, promise)
  return promise
}

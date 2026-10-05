import { createContext, useContext, useEffect, useReducer, useState } from 'react'
import type { ReactNode } from 'react'
import { format, htmlLang, platformShortcuts, type Lang, type Params } from '@genoffice/i18n'
import { cachedStrings, loadStrings, zhStrings, type LangStrings, type StringKey } from './strings'

export type { StringKey }

// Synchronous dictionary holder: starts as zh (the only locale bundled with
// the app) and is swapped once a locale chunk resolves. Non-React modules and
// React components read through the same holder, so one swap re-arms both;
// LocaleProvider bumps a re-render after the swap.
export type TFunc = (key: StringKey, params?: Params) => string
const translate: TFunc = (key, params) =>
  platformShortcuts(format(current[key] ?? zhStrings[key], params))

// mirror for non-React modules (pagination, editor extensions, AI tools …);
// set before first render and on every language switch
let moduleLang: Lang = 'zh'
export const getLang = (): Lang => moduleLang
export const setModuleLang = (lang: Lang): void => {
  moduleLang = lang
  // zh ships in the bundle; other locales are dynamic chunks — swap the dict
  // only when already loaded (boot guess), otherwise when the chunk resolves
  const cached = cachedStrings(lang)
  if (cached) current = cached
}
/** test/module setup: swap both the lang tag and the dictionary, awaiting the locale chunk */
export const setModuleLangAsync = async (lang: Lang): Promise<void> => {
  moduleLang = lang
  current = await loadStrings(lang)
}
/** module-level translator — components should prefer useI18n().t so they re-render on switch */
export const t: TFunc = (key, params) => translate(key, params)

let current: LangStrings = zhStrings

const AI_LANG_DIRECTIVES: Record<Lang, string> = {
  zh: '\n\n用与用户消息相同的语言回复；无法判断用户消息的语言时，用简体中文回复。',
  en: "\n\nReply in the same language as the user's message; if it cannot be determined, reply in English.",
  ja: '\n\nユーザーのメッセージと同じ言語で返信してください。言語を判別できない場合は日本語で返信してください。',
  ko: '\n\n사용자 메시지와 같은 언어로 답변하세요. 언어를 판단할 수 없으면 한국어로 답변하세요.',
  fr: "\n\nRéponds dans la même langue que le message de l'utilisateur ; si elle ne peut pas être déterminée, réponds en français.",
  de: '\n\nAntworte in derselben Sprache wie die Nachricht des Benutzers; lässt sie sich nicht bestimmen, antworte auf Deutsch.',
  es: '\n\nResponde en el mismo idioma que el mensaje del usuario; si no se puede determinar, responde en español.',
  th: '\n\nตอบเป็นภาษาเดียวกับข้อความของผู้ใช้ หากไม่สามารถระบุได้ ให้ตอบเป็นภาษาไทย',
  id: '\n\nBalas dalam bahasa yang sama dengan pesan pengguna; jika tidak dapat ditentukan, balas dalam bahasa Indonesia.',
  ru: '\n\nОтвечай на том же языке, что и сообщение пользователя; если его невозможно определить, отвечай на русском.',
  ar: '\n\nأجب بنفس لغة رسالة المستخدم؛ وإذا تعذر تحديدها، فأجب باللغة العربية.',
  pt: '\n\nResponda no mesmo idioma da mensagem do usuário; se não for possível determiná-lo, responda em português.',
  it: "\n\nRispondi nella stessa lingua del messaggio dell'utente; se non può essere determinata, rispondi in italiano.",
  pl: '\n\nOdpowiadaj w tym samym języku, co wiadomość użytkownika; jeśli nie da się go ustalić, odpowiadaj po polsku.',
  cs: '\n\nOdpovídej ve stejném jazyce jako zpráva uživatele; pokud ho nelze určit, odpovídej česky.',
  nl: '\n\nAntwoord in dezelfde taal als het bericht van de gebruiker; als die niet te bepalen is, antwoord dan in het Nederlands.',
  ms: '\n\nBalas dalam bahasa yang sama dengan mesej pengguna; jika tidak dapat ditentukan, balas dalam bahasa Melayu.',
  he: '\n\nהשב באותה שפה של הודעת המשתמש; אם לא ניתן לקבוע אותה, השב בעברית.',
  hi: '\n\nउपयोगकर्ता के संदेश की भाषा में ही उत्तर दें; यदि भाषा निर्धारित न हो सके, तो हिंदी में उत्तर दें।',
  'zh-TW': '\n\n用與使用者訊息相同的語言回覆；無法判斷使用者訊息的語言時，用繁體中文回覆。',
}

/** appended to the agent system prompt: replies follow the user's message language, falling back to the UI language */
export function aiLangDirective(): string {
  return AI_LANG_DIRECTIVES[moduleLang]
}

/** BCP-47 locale per UI language, for date/number formatting */
export const DATE_LOCALES: Record<Lang, string> = {
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  th: 'th-TH',
  id: 'id-ID',
  ru: 'ru-RU',
  ar: 'ar-SA',
  pt: 'pt-BR',
  it: 'it-IT',
  pl: 'pl-PL',
  cs: 'cs-CZ',
  nl: 'nl-NL',
  ms: 'ms-MY',
  he: 'he-IL',
  hi: 'hi-IN',
  'zh-TW': 'zh-TW',
}

const LocaleContext = createContext<Lang>('zh')

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initial)
  // dictionaries can swap while `lang` stays the same (boot into a stored
  // non-zh locale renders zh fallback first); bump re-renders on the swap
  const [, bumpDicts] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    let seq = 0
    // Dictionary load and UI-language apply are one atomic step: the switch
    // becomes visible only after the locale chunk resolved. A failed load
    // (offline) keeps the previous dictionary and language; the shell's
    // switch path re-fires this on the next attempt.
    const apply = (next: Lang): void => {
      const mySeq = ++seq
      void loadStrings(next)
        .then((dicts) => {
          if (mySeq !== seq) return
          current = dicts
          setModuleLang(next)
          document.documentElement.lang = htmlLang(next)
          setLang(next)
          bumpDicts()
        })
        .catch(() => {})
    }
    apply(initial)
    const unlisten = window.desktop.onLanguageChanged(apply)
    // Boot-time calibration: the renderer mounts from a synchronous guess
    // (localStorage) without awaiting the getLanguage IPC; when the real
    // value lands and differs, main.tsx fires this event to apply it.
    const calibrate = (event: Event): void => {
      apply((event as CustomEvent<Lang>).detail)
    }
    window.addEventListener('genoffice-language-calibrate', calibrate)
    return () => {
      unlisten()
      window.removeEventListener('genoffice-language-calibrate', calibrate)
    }
  }, [initial])
  return <LocaleContext.Provider value={lang}>{children}</LocaleContext.Provider>
}

export interface I18n {
  lang: Lang
  t: TFunc
  /** BCP-47 locale for date/number formatting */
  dateLocale: string
}

export function useI18n(): I18n {
  const lang = useContext(LocaleContext)
  return {
    lang,
    t: (key, params) => translate(key, params),
    dateLocale: DATE_LOCALES[lang],
  }
}

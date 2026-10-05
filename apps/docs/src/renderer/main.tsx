import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@genoffice/i18n'
import { App } from './App'
import { DATE_LOCALES, LocaleProvider, setModuleLang } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/ai-scope-quote.css'
import '@genoffice/ui/ai-composer.css'
import '@genoffice/ui/ai-runtime.css'
import '@genoffice/ui/ai-edit-queue.css'
import '@genoffice/ui/translation-ribbon.css'
import './styles.css'
import './fonts/fonts.css'
import { applyAiPanelPrefs, installScreenTips } from '@genoffice/ui'
import { setAltChunkHtmlConverter } from '@genoffice/docx-engine'

installScreenTips()
if (window.desktop?.convertAltChunkHtml) {
  setAltChunkHtmlConverter((html) => window.desktop.convertAltChunkHtml(html))
}

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

// Boot must not await IPC: the language/theme round-trips used to delay
// createRoot by their full latency on every open. Initial values come from
// localStorage (written on every calibration and switch below); the real IPC
// values land afterwards and calibrate if they differ.
const LANG_KEY = 'genoffice.lang'
const THEME_KEY = 'genoffice.theme'

function persistBootValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable (private mode) — guess again next boot */
  }
}

function syncLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY)
    if (stored && stored in DATE_LOCALES) return stored as Lang
  } catch {
    /* ignore */
  }
  return 'zh'
}

function syncTheme(): UiTheme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    /* ignore */
  }
  return 'system'
}

const root = createRoot(document.getElementById('root')!)

function bootstrap(): void {
  const lang = syncLang()
  const theme = syncTheme()
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  applyTheme(theme)
  root.render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
  // runtime switches mirror into the boot cache; applyTheme stays the single
  // theme applier (LocaleProvider handles its own language updates)
  window.desktop?.onThemeChanged((next) => {
    persistBootValue(THEME_KEY, next)
    applyTheme(next)
  })
  window.desktop?.onLanguageChanged((next) => persistBootValue(LANG_KEY, next))
  // every startup IPC fires concurrently here — none of them is chained
  // behind another (prefs used to wait for the language/theme round-trips)
  window.desktop?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  void window.desktop?.getAiPanelPrefs?.().then(applyAiPanelPrefs).catch(() => {})
  void calibrate(lang, theme)
}

async function calibrate(bootLang: Lang, bootTheme: UiTheme): Promise<void> {
  // per-promise catch: standalone runs have no app:get-theme handler, and
  // that rejection must not drop a resolved language
  const [lang, theme] = await Promise.all([
    window.desktop?.getLanguage().catch(() => bootLang) ?? Promise.resolve(bootLang),
    window.desktop?.getTheme().catch(() => bootTheme) ?? Promise.resolve(bootTheme),
  ])
  persistBootValue(LANG_KEY, lang)
  persistBootValue(THEME_KEY, theme)
  if (theme !== bootTheme) applyTheme(theme)
  if (lang !== bootLang) {
    window.dispatchEvent(new CustomEvent<Lang>('genoffice-language-calibrate', { detail: lang }))
  }
}

bootstrap()

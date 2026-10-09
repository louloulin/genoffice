import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang, LANGS, type Lang } from '@genoffice/i18n'
import { App } from './App'
import { AudienceView } from './components/AudienceView'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/ai-panel-placement.css'
import '@genoffice/ui/ai-floating-ball.css'
import '@genoffice/ui/ai-scope-quote.css'
import '@genoffice/ui/ai-composer.css'
import '@genoffice/ui/ai-runtime.css'
import '@genoffice/ui/ai-edit-queue.css'
import '@genoffice/ui/translation-ribbon.css'
import './styles.css'
import {
  applyAiPanelPrefs,
  initAiPanelPlacement,
  installScreenTips,
  registerAiPanelPrefsHost,
} from '@genoffice/ui'

installScreenTips()

// Canvas fillText never triggers @font-face downloads, so the bundled document fonts
// (Carlito ↔ Calibri) must be loaded explicitly or Konva silently draws the fallback face.
for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
  document.fonts?.load?.(`${variant}16px Carlito`).catch(() => {})
  document.fonts?.load?.(`${variant}16px 'Carlito GO'`).catch(() => {})
}

// ?mode=audience: the presenter view's external-screen audience show window (created by the main process)
const mode = new URLSearchParams(window.location.search).get('mode')

// macOS windows are created with vibrancy; let the thumbnail pane show it
// (the audience show window stays fully opaque)
if (mode !== 'audience' && navigator.platform.toLowerCase().includes('mac'))
  document.body.classList.add('vib')

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
    if (stored && (LANGS as readonly string[]).includes(stored)) return stored as Lang
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

function bootstrap(): void {
  const lang = syncLang()
  const theme = syncTheme()
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  // the audience show window renders slide content only — it never themes
  if (mode !== 'audience') applyTheme(theme)
  // runtime switches mirror into the boot cache; applyTheme stays the single
  // theme applier (LocaleProvider handles its own language updates)
  window.slidesApi?.onThemeChanged((next) => {
    persistBootValue(THEME_KEY, next)
    applyTheme(next)
  })
  window.slidesApi?.onLanguageChanged((next) => persistBootValue(LANG_KEY, next))
  // every startup IPC fires concurrently here — none of them gates createRoot
  if (mode !== 'audience') {
    // resolves the embed host's aiPanel meta over the shell pref before paint
    initAiPanelPlacement()
    void window.slidesApi?.getAiPanelPrefs?.().then(applyAiPanelPrefs).catch(() => {})
    window.slidesApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
    registerAiPanelPrefsHost(window.slidesApi)
  }
  void calibrate(lang, theme)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        {mode === 'audience' ? <AudienceView /> : <App />}
      </LocaleProvider>
    </React.StrictMode>,
  )
}

async function calibrate(bootLang: Lang, bootTheme: UiTheme): Promise<void> {
  // per-promise catch: standalone runs have no app:get-theme handler, and
  // that rejection must not drop a resolved language
  const [lang, theme] = await Promise.all([
    window.slidesApi?.getLanguage().catch(() => bootLang) ?? Promise.resolve(bootLang),
    window.slidesApi?.getTheme().catch(() => bootTheme) ?? Promise.resolve(bootTheme),
  ])
  persistBootValue(LANG_KEY, lang)
  // the audience show window renders slide content only — it never themes
  if (mode !== 'audience') {
    persistBootValue(THEME_KEY, theme)
    if (theme !== bootTheme) applyTheme(theme)
  }
  if (lang !== bootLang) {
    window.dispatchEvent(new CustomEvent<Lang>('genoffice-language-calibrate', { detail: lang }))
  }
}

bootstrap()

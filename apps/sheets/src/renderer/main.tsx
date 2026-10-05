import ReactDOM from 'react-dom/client'
import { htmlLang, LANGS, type Lang } from '@genoffice/i18n'
import { applyAiPanelPrefs, installScreenTips } from '@genoffice/ui'

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
import '@genoffice/ui/translation-ribbon.css'
import '@univerjs/preset-sheets-core/lib/index.css'

import { App } from './App'
import { installCanvasFontFallback, registerCellFontAliases } from './cell-font-fallback'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import type { UiTheme } from '../shared/desktop-api'
import './styles.css'

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', ({ updates }) => {
    const replacesUniverRuntime = updates.some(
      ({ path }) => path.endsWith('/App.tsx') || path.endsWith('/univer-sync.ts'),
    )
    if (replacesUniverRuntime) window.location.reload()
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing application root.')

installScreenTips()
installCanvasFontFallback()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

// Canvas fillText never triggers @font-face downloads, so the bundled Carlito
// faces (Calibri/Aptos aliases in styles.css) must be loaded before Univer's
// first skeleton — MDW, wrap points, and #### overflow all measure with them.
async function loadCellFonts(): Promise<void> {
  const loads: Promise<unknown>[] = [registerCellFontAliases()]
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
    for (const family of ['Calibri', 'Aptos', "'Aptos Narrow'", 'Carlito']) {
      loads.push(document.fonts?.load?.(`${variant}16px ${family}`)?.catch(() => {}) ?? [])
    }
  }
  // Local assets resolve in milliseconds; the timeout only guards a broken
  // bundle from blanking the app.
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 3000))])
}

// Boot must not await IPC: the language/theme round-trips used to delay
// first paint by their full latency on every open. Initial values come from
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
  applyTheme(theme)
  // runtime switches mirror into the boot cache; applyTheme stays the single
  // theme applier (LocaleProvider handles its own language updates)
  window.desktopApi?.onThemeChanged((next) => {
    persistBootValue(THEME_KEY, next)
    applyTheme(next)
  })
  window.desktopApi?.onLanguageChanged((next) => persistBootValue(LANG_KEY, next))
  // every startup IPC fires concurrently here — none of them gates first paint
  window.desktopApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  void window.desktopApi?.getAiPanelPrefs?.().then(applyAiPanelPrefs).catch(() => {})
  void calibrate(lang, theme)
  // Univer measures with canvas fillText, which never triggers @font-face
  // downloads — fonts still gate Univer's first skeleton, but they now load
  // concurrently with the IPC round-trips instead of after them.
  void loadCellFonts().then(() => {
    ReactDOM.createRoot(root!).render(
      <LocaleProvider initial={lang}>
        <App />
      </LocaleProvider>,
    )
  })
}

async function calibrate(bootLang: Lang, bootTheme: UiTheme): Promise<void> {
  // per-promise catch: standalone runs have no app:get-theme handler, and
  // that rejection must not drop a resolved language
  const [lang, theme] = await Promise.all([
    window.desktopApi?.getLanguage().catch(() => bootLang) ?? Promise.resolve(bootLang),
    window.desktopApi?.getTheme().catch(() => bootTheme) ?? Promise.resolve(bootTheme),
  ])
  persistBootValue(LANG_KEY, lang)
  persistBootValue(THEME_KEY, theme)
  if (theme !== bootTheme) applyTheme(theme)
  if (lang !== bootLang) {
    window.dispatchEvent(new CustomEvent<Lang>('genoffice-language-calibrate', { detail: lang }))
  }
}

void bootstrap()

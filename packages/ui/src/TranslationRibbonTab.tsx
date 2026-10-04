/**
 * Standalone "Translate" ribbon tab body, shared by the editor apps.
 *
 * Why a dedicated tab instead of another button inside the AI panel: every
 * mainstream AI translation product (DeepL, immersive translators, Word's
 * Translate group) puts "language pair + scope + options + primary action +
 * live progress" behind one visible entry point. Buried behind the AI
 * assistant, the user has to open the panel and hunt for a small chip.
 *
 * The component never calls a model and never touches the document: it
 * collects settings, renders status, and hands the actions back to the host
 * (`onStart` / `onCancel` / `onOpenStorage`). The real orchestration stays in
 * each app's existing translate pipeline + TranslateDialog — this is a facade,
 * not a second code path.
 *
 * Every label arrives through `strings` so each app can map the tab onto its
 * own i18n shard. Optional strings that a host cannot localize are simply
 * omitted, and the matching control is not rendered.
 */
import React from 'react'

export interface TranslationLanguageChoice {
  /** BCP-47 code, or `auto` for the source picker. */
  value: string
  /** Display label (already localized by the caller, or the language's own name). */
  label: string
}

export type TranslationScope = 'document' | 'selection'

export interface TranslationTabSettings {
  sourceLanguage: string
  targetLanguage: string
  scope: TranslationScope
  bilingual: boolean
  preserveFormatting: boolean
  memoryEnabled: boolean
  qualityCheck: boolean
}

export type TranslationTabState =
  | 'idle'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TranslationTabStatus {
  state: TranslationTabState
  /** 0..1 */
  progress: number
  completedUnits?: number
  totalUnits?: number
  qualityScore?: number | null
  message?: string | null
}

export interface TranslationTabStrings {
  sourceLanguage: string
  targetLanguage: string
  swap: string
  /** Caption under the language group, e.g. "Language". */
  languageGroup?: string
  /** Caption under the options group, e.g. "Options". */
  optionsGroup?: string
  /** Caption under the action group, e.g. "Translate". */
  actionGroup?: string
  scopeDocument: string
  scopeSelection: string
  bilingual?: string
  preserveFormatting?: string
  memory?: string
  quality?: string
  cancel: string
  openStorage?: string
  /** Shown while idle; the host's one-line hint about what the tab does. */
  stateIdle?: string
  stateRunning: string
  /** Optional; empty means "progress bar + units speak for themselves". */
  stateCompleted?: string
  stateFailed: string
  stateCancelled?: string
  /**
   * `{done}` / `{total}` placeholders, e.g. "Segment {done}/{total}".
   * Optional: without it the meta line shows the language-neutral `4/4`.
   */
  units?: string
  /**
   * `{score}` placeholder for the quality badge. Optional: without it the
   * badge degrades to a language-neutral `◎ 100%`.
   */
  qualityBadge?: string
}

export interface TranslationRibbonTabProps {
  strings: TranslationTabStrings
  /** Target-language choices; `sourceLanguages` additionally carries `auto`. */
  languages: readonly TranslationLanguageChoice[]
  sourceLanguages: readonly TranslationLanguageChoice[]
  settings: TranslationTabSettings
  onSettingsChange: (patch: Partial<TranslationTabSettings>) => void
  status: TranslationTabStatus
  /** No document open / read-only host: everything disabled, nothing hidden. */
  disabled?: boolean
  /** Whole-document-only hosts (a selection run is meaningless there). */
  allowSelection?: boolean
  /** Hide the storage entry on hosts without the Dataflare space bridge. */
  showStorage?: boolean
  onStart: (scope: TranslationScope) => void
  onCancel: () => void
  onOpenStorage?: () => void
}

const pct = (value: number): number => Math.max(0, Math.min(1, value)) * 100

function stateLabel(strings: TranslationTabStrings, status: TranslationTabStatus): string {
  switch (status.state) {
    case 'pending':
    case 'running':
      return strings.stateRunning
    case 'completed':
      return strings.stateCompleted?.trim() || ''
    case 'failed':
      return status.message?.trim() || strings.stateFailed
    case 'cancelled':
      return strings.stateCancelled?.trim() || ''
    default:
      return strings.stateIdle?.trim() || ''
  }
}

export function TranslationRibbonTab({
  strings,
  languages,
  sourceLanguages,
  settings,
  onSettingsChange,
  status,
  disabled = false,
  allowSelection = true,
  showStorage = true,
  onStart,
  onCancel,
  onOpenStorage,
}: TranslationRibbonTabProps) {
  const busy = status.state === 'pending' || status.state === 'running'
  const locked = disabled || busy
  const isIdle = status.state === 'idle'
  const targetIndex = languages.findIndex((l) => l.value === settings.targetLanguage)
  const nextTarget =
    languages.length > 0 ? languages[(targetIndex + 1 + languages.length) % languages.length] : null

  const swap = () => {
    if (!nextTarget) return
    const nextSource = settings.targetLanguage
    const previousSource = settings.sourceLanguage === 'auto' ? 'auto' : settings.sourceLanguage
    onSettingsChange({
      sourceLanguage: nextSource,
      // Round-trip swap: move the old source into the target slot. When the
      // source was `auto` there is nothing to move, so fall through to the
      // next target so the button always has a visible effect.
      targetLanguage: previousSource === 'auto' ? nextTarget.value : previousSource,
    })
  }

  const caption = (text?: string) =>
    text && text.trim() ? <div className="go-translate-tab__caption">{text}</div> : null

  return (
    <div className="go-translate-tab" role="group" aria-label={strings.actionGroup ?? strings.scopeDocument}>
      <div className="go-translate-tab__group">
        <div className="go-translate-tab__row">
          <label className="go-translate-tab__field">
            <span className="go-translate-tab__label">{strings.sourceLanguage}</span>
            <select
              className="go-translate-tab__select"
              aria-label={strings.sourceLanguage}
              value={settings.sourceLanguage}
              disabled={locked}
              onChange={(e) => onSettingsChange({ sourceLanguage: e.target.value })}
            >
              {sourceLanguages.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="go-translate-tab__swap"
            data-tip={strings.swap}
            aria-label={strings.swap}
            disabled={locked}
            onClick={swap}
          >
            ⇄
          </button>
          <label className="go-translate-tab__field">
            <span className="go-translate-tab__label">{strings.targetLanguage}</span>
            <select
              className="go-translate-tab__select"
              aria-label={strings.targetLanguage}
              value={settings.targetLanguage}
              disabled={locked}
              onChange={(e) => onSettingsChange({ targetLanguage: e.target.value })}
            >
              {languages.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {caption(strings.languageGroup)}
      </div>

      <div className="go-translate-tab__sep" aria-hidden />

      <div className="go-translate-tab__group">
        <div className="go-translate-tab__options">
          {strings.bilingual ? (
            <button
              type="button"
              className={`go-translate-tab__toggle${settings.bilingual ? ' is-on' : ''}`}
              aria-pressed={settings.bilingual}
              disabled={locked}
              onClick={() => onSettingsChange({ bilingual: !settings.bilingual })}
            >
              {strings.bilingual}
            </button>
          ) : null}
          {strings.preserveFormatting ? (
            <button
              type="button"
              className={`go-translate-tab__toggle${settings.preserveFormatting ? ' is-on' : ''}`}
              aria-pressed={settings.preserveFormatting}
              disabled={locked}
              onClick={() => onSettingsChange({ preserveFormatting: !settings.preserveFormatting })}
            >
              {strings.preserveFormatting}
            </button>
          ) : null}
          {strings.memory ? (
            <button
              type="button"
              className={`go-translate-tab__toggle${settings.memoryEnabled ? ' is-on' : ''}`}
              aria-pressed={settings.memoryEnabled}
              disabled={locked}
              onClick={() => onSettingsChange({ memoryEnabled: !settings.memoryEnabled })}
            >
              {strings.memory}
            </button>
          ) : null}
          {strings.quality ? (
            <button
              type="button"
              className={`go-translate-tab__toggle${settings.qualityCheck ? ' is-on' : ''}`}
              aria-pressed={settings.qualityCheck}
              disabled={locked}
              onClick={() => onSettingsChange({ qualityCheck: !settings.qualityCheck })}
            >
              {strings.quality}
            </button>
          ) : null}
        </div>
        {caption(strings.optionsGroup)}
      </div>

      <div className="go-translate-tab__sep" aria-hidden />

      <div className="go-translate-tab__group">
        <div className="go-translate-tab__actions">
          {allowSelection ? (
            <button
              type="button"
              className="go-translate-tab__action"
              disabled={locked}
              onClick={() => onStart('selection')}
            >
              {strings.scopeSelection}
            </button>
          ) : null}
          <button
            type="button"
            className="go-translate-tab__action is-primary"
            disabled={locked}
            onClick={() => onStart('document')}
          >
            {strings.scopeDocument}
          </button>
          <button
            type="button"
            className="go-translate-tab__action is-danger"
            hidden={!busy}
            disabled={!busy}
            onClick={onCancel}
          >
            {strings.cancel}
          </button>
          {showStorage && onOpenStorage && strings.openStorage ? (
            <button
              type="button"
              className="go-translate-tab__action is-ghost"
              disabled={busy}
              onClick={onOpenStorage}
            >
              {strings.openStorage}
            </button>
          ) : null}
        </div>
        {caption(strings.actionGroup)}
      </div>

      <div className="go-translate-tab__status" role="status" aria-live="polite">
        <div className="go-translate-tab__status-line">
          <span className={`go-translate-tab__dot is-${status.state}`} aria-hidden />
          <span className="go-translate-tab__status-text">{stateLabel(strings, status)}</span>
        </div>
        <div className="go-translate-tab__bar" aria-hidden>
          <div
            className={`go-translate-tab__bar-fill is-${status.state}`}
            style={{ width: `${isIdle ? 0 : pct(status.progress)}%` }}
          />
        </div>
        <div className="go-translate-tab__meta">
          <span>
            {status.totalUnits
              ? strings.units
                ? strings.units
                    .replace('{done}', String(status.completedUnits ?? 0))
                    .replace('{total}', String(status.totalUnits))
                : `${status.completedUnits ?? 0}/${status.totalUnits}`
              : `${Math.round(isIdle ? 0 : pct(status.progress))}%`}
          </span>
          {typeof status.qualityScore === 'number' ? (
            <span className="go-translate-tab__quality">
              {strings.qualityBadge
                ? strings.qualityBadge.replace(
                    '{score}',
                    String(Math.round(status.qualityScore * 100)),
                  )
                : `◎ ${Math.round(status.qualityScore * 100)}%`}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

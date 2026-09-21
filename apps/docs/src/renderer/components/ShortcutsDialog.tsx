/**
 * Word's keyboard-shortcut reference (File ▸ Options ▸ Customize Keyboard in
 * Word; Help ▸ Keyboard Shortcuts here). Read-only: it renders the registry in
 * shortcuts.ts, so a binding added there shows up without touching this file.
 */
import { useState } from 'react'
import { useI18n } from '../i18n/locale'
import { DOCS_QUICK_ACTIONS, docsSkillOptions } from '../ai/composer-commands'
import { SHORTCUT_GROUPS, SHORTCUTS, shortcutKeys, type ShortcutDef } from '../shortcuts'
import type { StringKey } from '../i18n/locale'
import { useModalKeys } from './modal-keys'

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()
  // Reverse lookup: actions / skills declare which shortcut they bind via
  // `shortcutId`; the shortcut sheet uses that as the join key, so a skill
  // added later (or loaded from the skill market) shows up here automatically
  // without editing shortcuts.ts. The skill table's `imageGenAvailable` flag
  // only affects row availability, not what the chip should be called.
  const hintByShortcutId = new Map<string, { trigger: string; labelKey: string }>()
  for (const action of DOCS_QUICK_ACTIONS) {
    if (action.shortcutId)
      hintByShortcutId.set(action.shortcutId, { trigger: action.trigger, labelKey: action.labelKey })
  }
  for (const skill of docsSkillOptions({ imageGenAvailable: true })) {
    if (skill.shortcutId)
      hintByShortcutId.set(skill.shortcutId, { trigger: skill.trigger, labelKey: skill.labelKey })
  }
  const hintFor = (def: ShortcutDef): { trigger: string; label: string } | null => {
    const entry = hintByShortcutId.get(def.id)
    return entry ? { trigger: entry.trigger, label: t(entry.labelKey) } : null
  }
  const rows = SHORTCUTS.map((def) => ({
    id: def.id,
    group: def.group,
    label: t(def.labelKey) + (def.labelSuffix ?? ''),
    keys: shortcutKeys(def),
    hint: hintFor(def),
  })).filter(
    (row) =>
      !needle ||
      row.label.toLowerCase().includes(needle) ||
      row.keys.toLowerCase().includes(needle) ||
      (row.hint?.trigger.toLowerCase().includes(needle) ?? false) ||
      (row.hint?.label.toLowerCase().includes(needle) ?? false),
  )

  return (
    <div
      className="modal-backdrop"
      ref={modalKeys.ref}
      onKeyDown={modalKeys.onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal modal-shortcuts" role="dialog" aria-label={t('appScTitle')}>
        <h2>{t('appScTitle')}</h2>
        <input
          type="search"
          className="sc-filter"
          placeholder={t('appScFilter')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="sc-list">
          {SHORTCUT_GROUPS.map((group) => {
            const groupRows = rows.filter((row) => row.group === group.id)
            if (groupRows.length === 0) return null
            return (
              <section key={group.id} className="sc-group">
                <h3>{t(group.labelKey)}</h3>
                {groupRows.map((row) => (
                  <div key={row.id} className="sc-row">
                    <span className="sc-label">
                      {row.label}
                      {row.hint && (
                        <span
                          className="sc-ai-hint"
                          title={t('aiCmdGroupActions')}
                          aria-label={t('aiCmdGroupActions')}
                        >
                          <span className="sc-ai-hint-tag">AI</span>
                          <span className="sc-ai-hint-cmd">/{row.hint.trigger}</span>
                          <span className="sc-ai-hint-name">{row.hint.label}</span>
                        </span>
                      )}
                    </span>
                    <kbd className="sc-keys">{row.keys}</kbd>
                  </div>
                ))}
              </section>
            )
          })}
          {rows.length === 0 && <p className="sc-empty">{t('appScNone')}</p>}
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>
            {t('appClose')}
          </button>
        </div>
      </div>
    </div>
  )
}

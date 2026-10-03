/**
 * Translation storage panel — the glossary / memory half of the translation UI.
 *
 * The split of responsibility is the whole point: GenOffice owns the
 * translation interaction, Dataflare owns the storage. This panel is the
 * user-facing side of that contract and it does not know where the terms live
 * — it is handed a {@link TranslationStorageClient}, so the same component
 * serves the embedded (host-proxied) case and any future local one.
 *
 * Three things it deliberately does not do:
 *
 *   - **It does not edit memory rows.** A memory entry is a confirmed
 *     translation pair; letting the user retype it in place would produce a
 *     store whose contents nobody re-translated. Memory is read here and
 *     written from the translation dialog, where the pair still has its
 *     context.
 *   - **It does not fall back to "no terms".** A failed read shows the error.
 *     An empty list and a failed read look identical in the UI otherwise, and
 *     the difference matters: one means "configure nothing", the other means
 *     "the network is down and you are about to translate without terminology".
 *   - **It does not own its strings.** Every label arrives through `strings`,
 *     the same way `TranslateDialog` does it, so each application keeps its
 *     own translations instead of the shared package inventing a locale.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

/*
 * The storage shapes are declared structurally rather than imported from
 * `@genoffice/translation-core`: the core package is the one that depends on
 * this UI package, so importing it back would close the cycle. The application
 * passes the core's real client, and these declarations describe exactly the
 * part of it this panel uses.
 */

export interface PanelGlossaryTerm {
  id?: number
  sourceTerm: string
  targetTerm: string
  category?: string
  spaceId?: number | null
}

export interface PanelMemoryEntry {
  id?: number | null
  sourceText?: string | null
  translatedText?: string | null
  spaceId?: number | null
  createTime?: string | null
}

export interface PanelTranslationStorageClient {
  listGlossary(params?: { targetLanguage?: string; category?: string }): Promise<PanelGlossaryTerm[]>
  upsertGlossary(term: PanelGlossaryTerm): Promise<void>
  deleteGlossary(id: number): Promise<void>
  listMemory(params?: { targetLanguage?: string; sourceLanguage?: string; limit?: number }): Promise<PanelMemoryEntry[]>
}

export interface TranslationStoragePanelStrings {
  title: string
  glossaryTab: string
  memoryTab: string
  sourceTerm: string
  targetTerm: string
  add: string
  remove: string
  close: string
  emptyGlossary: string
  emptyMemory: string
  scopeShared: string
  /** `{space}` is replaced with the drive space id. */
  scopeSpace: string
  loading: string
  retry: string
  /** Shown when the editor is not running inside a Dataflare host. */
  unavailable: string
}

export interface TranslationStoragePanelProps {
  open: boolean
  onClose: () => void
  /** Null when the editor is standalone — the panel explains that instead of failing. */
  client: PanelTranslationStorageClient | null
  /** Space id, used only to label rows; the client scopes the requests itself. */
  spaceId?: string | null
  /** Pre-fills the add-term form, e.g. the term the user just selected. */
  initialTerm?: { sourceTerm: string; targetTerm: string } | null
  strings: TranslationStoragePanelStrings
  /** Target language filter for the glossary read; defaults to the host's. */
  targetLanguage?: string
}

type Tab = 'glossary' | 'memory'

/** Terms created from a document land in the general category. */
const DEFAULT_TERM_CATEGORY = 'general'

export function TranslationStoragePanel(props: TranslationStoragePanelProps): React.JSX.Element | null {
  const { open, onClose, client, spaceId, initialTerm, strings, targetLanguage } = props
  const [tab, setTab] = useState<Tab>('glossary')
  const [terms, setTerms] = useState<PanelGlossaryTerm[]>([])
  const [memories, setMemories] = useState<PanelMemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState({ sourceTerm: '', targetTerm: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!client) return
    setLoading(true)
    setError(null)
    try {
      // Both reads are independent and the panel shows one at a time, but
      // loading the active tab only would make switching tabs show a spinner
      // every time — the lists are small enough to fetch together.
      const [glossary, memory] = await Promise.all([
        client.listGlossary(targetLanguage ? { targetLanguage } : {}),
        client.listMemory(targetLanguage ? { targetLanguage, limit: 50 } : { limit: 50 }),
      ])
      setTerms(glossary)
      setMemories(memory)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [client, targetLanguage])

  useEffect(() => {
    if (!open) return
    if (initialTerm) {
      setDraft({ sourceTerm: initialTerm.sourceTerm, targetTerm: initialTerm.targetTerm })
    }
    void load()
  }, [open, initialTerm, load])

  const addTerm = useCallback(async () => {
    if (!client) return
    const sourceTerm = draft.sourceTerm.trim()
    const targetTerm = draft.targetTerm.trim()
    // An empty half is not a term; posting it would store a row that matches
    // nothing and shows up as a blank entry in the list.
    if (sourceTerm === '' || targetTerm === '') return
    setSaving(true)
    setError(null)
    try {
      // Category is deliberately not offered here: term categories are part of
      // the tenant's terminology programme, and managing that list belongs to
      // the host's glossary administration, not to a per-document dialog.
      await client.upsertGlossary({ sourceTerm, targetTerm, category: DEFAULT_TERM_CATEGORY })
      setDraft({ sourceTerm: '', targetTerm: '' })
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }, [client, draft, load])

  const removeTerm = useCallback(
    async (id: number | undefined) => {
      if (!client || id === undefined) return
      setError(null)
      try {
        await client.deleteGlossary(id)
        await load()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [client, load],
  )

  const scopeLabel = useCallback(
    (rowSpaceId: number | null | undefined) =>
      rowSpaceId === null || rowSpaceId === undefined
        ? strings.scopeShared
        : strings.scopeSpace.replace('{space}', String(rowSpaceId)),
    [strings],
  )

  const body = useMemo(() => {
    if (!client) return <p className="tsp-note">{strings.unavailable}</p>
    if (loading) return <p className="tsp-note">{strings.loading}</p>
    if (error) {
      return (
        <div className="tsp-error">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            {strings.retry}
          </button>
        </div>
      )
    }
    if (tab === 'glossary') {
      if (terms.length === 0) return <p className="tsp-note">{strings.emptyGlossary}</p>
      return (
        <ul className="tsp-list">
          {terms.map((term) => (
            <li key={term.id ?? `${term.sourceTerm}->${term.targetTerm}`} className="tsp-row">
              <span className="tsp-source">{term.sourceTerm}</span>
              <span className="tsp-arrow" aria-hidden="true">
                →
              </span>
              <span className="tsp-target">{term.targetTerm}</span>
              <span className="tsp-meta">
                {term.category ?? 'general'} · {scopeLabel(term.spaceId)}
              </span>
              <button type="button" onClick={() => void removeTerm(term.id)}>
                {strings.remove}
              </button>
            </li>
          ))}
        </ul>
      )
    }
    if (memories.length === 0) return <p className="tsp-note">{strings.emptyMemory}</p>
    return (
      <ul className="tsp-list">
        {memories.map((entry, index) => (
          <li key={entry.id ?? index} className="tsp-row">
            <span className="tsp-source">{entry.sourceText}</span>
            <span className="tsp-arrow" aria-hidden="true">
              →
            </span>
            <span className="tsp-target">{entry.translatedText}</span>
            <span className="tsp-meta">
              {scopeLabel(entry.spaceId)}
              {entry.createTime ? ` · ${entry.createTime}` : ''}
            </span>
          </li>
        ))}
      </ul>
    )
  }, [client, error, load, loading, memories, removeTerm, scopeLabel, strings, tab, terms])

  if (!open) return null

  return (
    <div className="tsp-backdrop" role="dialog" aria-modal="true" aria-label={strings.title}>
      <div className="tsp-panel">
        <header className="tsp-header">
          <h2>{strings.title}</h2>
          <button type="button" onClick={onClose} aria-label={strings.close}>
            ×
          </button>
        </header>
        <nav className="tsp-tabs">
          <button type="button" className={tab === 'glossary' ? 'active' : ''} onClick={() => setTab('glossary')}>
            {strings.glossaryTab}
          </button>
          <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
            {strings.memoryTab}
          </button>
        </nav>
        {tab === 'glossary' && client ? (
          <div className="tsp-form">
            <input
              value={draft.sourceTerm}
              placeholder={strings.sourceTerm}
              onChange={(e) => setDraft((d) => ({ ...d, sourceTerm: e.target.value }))}
            />
            <input
              value={draft.targetTerm}
              placeholder={strings.targetTerm}
              onChange={(e) => setDraft((d) => ({ ...d, targetTerm: e.target.value }))}
            />
            <button type="button" disabled={saving} onClick={() => void addTerm()}>
              {strings.add}
            </button>
          </div>
        ) : null}
        <div className="tsp-body">{body}</div>
        <footer className="tsp-footer">
          <span className="tsp-meta">{spaceId ? strings.scopeSpace.replace('{space}', spaceId) : strings.scopeShared}</span>
          <button type="button" onClick={onClose}>
            {strings.close}
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * Translation Knowledge Base (KB) — 5-schema model with priority resolution.
 *
 * Mirrors the `trade.translation.*` schema set from LumosAI's translate-config
 * skill, so users who already maintain a translation KB in
 * `~/.lumosai/knowledge/translation_kb.json` can import it directly. GenOffice
 * keeps its own copy under `~/.genoffice/translation-kb.json`; the two files
 * stay independent but share shape.
 *
 * Five schemas (see {@link SchemaId}):
 *
 *   - trade.translation.term            — mandatory source -> target mappings
 *   - trade.translation.forbidden       — banned translations + replacements
 *   - trade.translation.brand           — brand policy (neverTranslate / keep / translateAs)
 *   - trade.translation.styleRule       — tone / formality / voice rules
 *   - trade.translation.customerPreference — per-customer overrides
 *
 * Priority resolution (see {@link KnowledgeBase.resolve}):
 *
 *   session > customer > project > company > global
 *
 * A `customer` rule wins over a `company` rule with the same source term. When
 * multiple rules in the same scope match, the higher `priority` value wins
 * (ties broken by lexicographic `id` so the resolver is deterministic).
 *
 * The KB is JSON-backed so it survives process restarts. `load()` reads from
 * disk; `save()` writes atomically via a `.tmp` + rename. Tests inject an
 * in-memory filesystem via {@link KnowledgeBaseOptions.fileSystem}.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

export const SCOPES = ['session', 'customer', 'project', 'company', 'global'] as const
export type Scope = (typeof SCOPES)[number]

export const SCHEMA_IDS = [
  'trade.translation.term',
  'trade.translation.forbidden',
  'trade.translation.brand',
  'trade.translation.styleRule',
  'trade.translation.customerPreference',
] as const
export type SchemaId = (typeof SCHEMA_IDS)[number]

export type SchemaKey = 'term' | 'forbidden' | 'brand' | 'styleRule' | 'customerPreference'

const KEY_TO_SCHEMA: Record<SchemaKey, SchemaId> = {
  term: 'trade.translation.term',
  forbidden: 'trade.translation.forbidden',
  brand: 'trade.translation.brand',
  styleRule: 'trade.translation.styleRule',
  customerPreference: 'trade.translation.customerPreference',
}

const SCHEMA_TO_KEY: Record<SchemaId, SchemaKey> = {
  'trade.translation.term': 'term',
  'trade.translation.forbidden': 'forbidden',
  'trade.translation.brand': 'brand',
  'trade.translation.styleRule': 'styleRule',
  'trade.translation.customerPreference': 'customerPreference',
}

interface LangScoped {
  sourceLang?: string | undefined
  targetLang?: string | undefined
}

export interface TermEntry extends LangScoped {
  id: string
  scope: Scope
  priority: number
  sourceTerm: string
  targetTerm: string
  category?: string | undefined
  /** Customer / brand the term is exclusive to. Mirrors customerName on
   *  CustomerPreferenceEntry so a renderer that passes the customer name as
   *  glossaryCategory can still narrow the term set. */
  customerName?: string | undefined
  notes?: string | undefined
}

export interface ForbiddenEntry extends LangScoped {
  id: string
  scope: Scope
  priority: number
  forbiddenText: string
  replacement?: string | undefined
  reason?: string | undefined
  severity?: 'warning' | 'error' | undefined
}

export interface BrandEntry {
  id: string
  scope: Scope
  priority: number
  word: string
  policy: 'neverTranslate' | 'keep' | 'translateAs'
  translateAs?: string | undefined
}

export interface StyleRuleEntry {
  id: string
  scope: Scope
  priority: number
  name: string
  description: string
}

export interface CustomerPreferenceEntry extends LangScoped {
  id: string
  scope: Scope
  priority: number
  customerName: string
  preferenceType: string
  value: string
}

export type KBEntry =
  | TermEntry
  | ForbiddenEntry
  | BrandEntry
  | StyleRuleEntry
  | CustomerPreferenceEntry

export type KBStore = Partial<Record<SchemaId, KBEntry[]>>

export interface KnowledgeBaseFileSystem {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, contents: string, encoding: 'utf8'): Promise<void>
  rename(from: string, to: string): Promise<void>
}

const defaultFileSystem: KnowledgeBaseFileSystem = {
  mkdir: (p, o) => mkdir(p, o).then(() => undefined),
  readFile: (p, e) => readFile(p, e) as Promise<string>,
  writeFile: (p, c, e) => writeFile(p, c, e),
  rename: (from, to) => rename(from, to).then(() => undefined),
}

export interface KnowledgeBaseOptions {
  /** Override the on-disk path. Defaults to `~/.genoffice/translation-kb.json`. */
  filePath?: string
  /** Inject a custom filesystem implementation (tests). */
  fileSystem?: KnowledgeBaseFileSystem
  /** Pre-seeded entries; useful for tests and one-off constructors. */
  seed?: KBStore
}

export interface ResolvedRules {
  terms: TermEntry[]
  forbidden: ForbiddenEntry[]
  brands: BrandEntry[]
  styleRules: StyleRuleEntry[]
  customerPreferences: CustomerPreferenceEntry[]
  /** Human-readable prompt block; empty string when there are no rules. */
  promptBlock: string
}

export interface KBListFilters {
  schema?: SchemaId | SchemaKey | undefined
  scope?: Scope | undefined
  sourceLang?: string | undefined
  targetLang?: string | undefined
}

/**
 * Default on-disk location. `GENOFFICE_TRANSLATION_KB` overrides it so tests
 * and portable installs can point at a scratch file without touching the
 * user's real KB.
 */
function defaultFilePath(): string {
  // Read at construction time (not module load) so tests can flip the
  // GENOFFICE_TRANSLATION_KB env var in beforeAll() and have the next
  // getKb() pick up the new path.
  return (
    process.env.GENOFFICE_TRANSLATION_KB ??
    path.join(
      process.env.HOME ?? path.join(path.sep, 'tmp'),
      '.genoffice',
      'translation-kb.json',
    )
  )
}

/**
 * Should a term entry survive the caller's bucket filter?
 *
 * Two independent filters are supported and either may be set:
 *
 *   - `category`      — the glossary bucket label (e.g. 'legal', 'apparel').
 *   - `customerName`  — the customer/brand the call is for (e.g. 'KERRITS').
 *
 * The two fields are not the same kind of thing, and the renderer paths blur
 * them (`docs` sends the customer name as `glossaryCategory`, the Settings
 * pane sends a real domain label, `ai:translate-file-auto` sends
 * `customerName`). They are therefore resolved on two different rules:
 *
 *   - `customerName` is a **confidentiality boundary**. An entry that names a
 *     customer belongs to that customer alone and is visible only to a call
 *     that names the same customer (under either field, since callers blur
 *     them). This is what stops KERRITS' branded term from being applied to
 *     an ACME document.
 *   - `category` is a **domain hint**. Branded vocabulary is proprietary;
 *     domain vocabulary is not, so an entry that declares only a category
 *     stays visible to every call. The prompt already asks the model to
 *     prefer the named domain, so narrowing here would only hide terms the
 *     translator still needs.
 *
 * A call that names no customer therefore sees the shared vocabulary and none
 * of the customer-private terms. Before this rule an unscoped document was
 * handed every customer's terms at once — three conflicting mappings for the
 * same source term in one prompt — and which one the model used was luck.
 */
function passesTermFilter(
  entry: TermEntry,
  opts: { category?: string | undefined; customerName?: string | undefined },
): boolean {
  const customer = typeof entry.customerName === 'string' ? entry.customerName.trim() : ''
  // Domain vocabulary (no customer) is shared: always visible.
  if (customer.length === 0) return true
  // Customer-private vocabulary is gated on an explicit match.
  return requestedBuckets(opts).includes(customer)
}

/**
 * Whether an entry's declared language applies to the call in flight.
 *
 * Two normalizations the exact-equality check did not have:
 *
 *   - `auto` is a wildcard. The renderer's source picker defaults to
 *     auto-detect, and `normalizeSourceLang` turns "unknown" into `auto`, so an
 *     entry that declared `sourceLang: 'en-US'` was filtered out of *every*
 *     default call. The KB the user just curated therefore never applied —
 *     file translation, snippet translation and the dictionary builder all ran
 *     without it until the user explicitly picked a source language.
 *   - A missing region matches an explicit one (`en` vs `en-US`). KBs imported
 *     from LumosAI and hand-written entries commonly omit the region, and
 *     dropping them is the same silent no-op. Two explicit regions stay
 *     distinct so `zh-CN` is never confused with `zh-TW`.
 */
function languageMatches(declared: string | undefined, requested: string | undefined): boolean {
  if (!declared || declared.trim().length === 0) return true
  if (!requested || requested.trim().length === 0) return true
  const wanted = requested.trim().toLowerCase()
  if (wanted === 'auto') return true
  const have = declared.trim().toLowerCase()
  if (have === wanted) return true
  const family = (value: string): string => {
    const idx = value.indexOf('-')
    return idx >= 0 ? value.slice(0, idx) : value
  }
  if (family(have) !== family(wanted)) return false
  return have.indexOf('-') < 0 || wanted.indexOf('-') < 0
}

/**
 * The bucket values a caller asked for, in priority order. `category` and
 * `customerName` are the same dimension on the wire (see
 * {@link passesTermFilter}); both count.
 */
function requestedBuckets(opts: {
  category?: string | undefined
  customerName?: string | undefined
}): string[] {
  return [opts.category, opts.customerName].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
}

/**
 * Whether a customer-scoped entry belongs to the call in flight.
 *
 * A `customerPreference` always names its customer, so it can only ever apply
 * when the caller named that same customer (under either bucket field). The
 * previous check (`opts.customerName && …`) skipped the filter entirely when
 * the caller sent no customer name — or sent the customer as
 * `glossaryCategory` — and injected *every* customer's preferences into the
 * prompt. A KERRITS call therefore carried Nike's `fabricUnit=GSM` rule.
 */
function matchesRequestedBucket(
  declared: string | undefined,
  opts: { category?: string | undefined; customerName?: string | undefined },
): boolean {
  const wanted = requestedBuckets(opts)
  if (wanted.length === 0) return false
  return typeof declared === 'string' && wanted.includes(declared)
}

/**
 * How specific a term is for the call in flight, highest first.
 *
 *   2 — customer-private and the caller named that customer
 *   1 — shared domain vocabulary
 *   0 — customer-private but not this customer (already filtered out by
 *       {@link passesTermFilter}; kept so the ranking is total)
 */
function termSpecificity(
  term: TermEntry,
  opts: { category?: string | undefined; customerName?: string | undefined },
): number {
  const customer = typeof term.customerName === 'string' ? term.customerName.trim() : ''
  if (customer.length === 0) return 1
  return requestedBuckets(opts).includes(customer) ? 2 : 0
}

/**
 * Drop a term when a *more specific* term maps the same source string.
 *
 * A KB normally carries a shared term ("fabric weight" -> "克重") plus
 * per-customer overrides of it. Both survive `passesTermFilter` for the
 * customer's own call, and the resolver then handed the model *two* rules for
 * one source string — whichever the model preferred won, and which one
 * `applyTerminology` enforced depended on tie-break ordering. Naming a
 * customer now switches the term over deterministically.
 *
 * Only strictly-less-specific duplicates are removed: two entries at the same
 * specificity (e.g. two company-wide synonyms the user added) are both kept,
 * so this cannot silently drop vocabulary the translator still needs.
 *
 * Identical mappings (`sourceTerm` *and* `targetTerm` equal) are collapsed to
 * one, which is what a KB that was re-imported or re-seeded ends up with. Two
 * rows saying the same thing are pure prompt noise — the model sees the rule
 * twice and the `matchedTerms` badge counts it twice — while two rows at the
 * same specificity saying *different* things are genuine synonyms and are kept.
 *
 * Input order is preserved — the resolver has already sorted by
 * scope/priority.
 */
function shadowTermsBySource(
  terms: TermEntry[],
  opts: { category?: string | undefined; customerName?: string | undefined },
): TermEntry[] {
  const best = new Map<string, number>()
  for (const term of terms) {
    const rank = termSpecificity(term, opts)
    const current = best.get(term.sourceTerm)
    if (current === undefined || rank > current) best.set(term.sourceTerm, rank)
  }
  const seen = new Set<string>()
  return terms.filter((term) => {
    if (termSpecificity(term, opts) < (best.get(term.sourceTerm) ?? 0)) return false
    const key = `${term.sourceTerm}\u0000${term.targetTerm}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export class KnowledgeBase {
  private store: KBStore
  private readonly filePath: string
  private readonly fs: KnowledgeBaseFileSystem
  private dirty = false
  /** Raw text of the last successful load, so {@link refresh} can skip a
   *  re-parse when the file is unchanged. */
  private lastLoadedRaw: string | null = null

  constructor(opts: KnowledgeBaseOptions = {}) {
    this.filePath = opts.filePath ?? defaultFilePath()
    this.fs = opts.fileSystem ?? defaultFileSystem
    this.store = cloneStore(opts.seed ?? {})
  }

  /** Read the on-disk store. Returns an empty store if the file is missing. */
  async load(): Promise<void> {
    try {
      const raw = await this.fs.readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isKBStore(parsed)) throw new Error('translation-kb.json: invalid shape')
      this.store = parsed
      this.dirty = false
      this.lastLoadedRaw = raw
    } catch (error) {
      if (isNotFound(error)) {
        this.store = {}
        this.dirty = false
        this.lastLoadedRaw = null
        return
      }
      throw error
    }
  }

  /**
   * Re-read the file, but only when its bytes changed since the last load.
   *
   * The web-server's translate endpoints hold one long-lived `KnowledgeBase`
   * and the UI mutates the KB through the pi session's separate instance,
   * which writes the same JSON file. Without this the HTTP path answered from
   * the snapshot it took at boot: a term the user had just added was invisible
   * to every HTTP translation until the process restarted, and a term they had
   * just deleted kept being applied. `ai:translation-kb-resolve` worked around
   * it with an unconditional `load()`; this is the same re-read with a
   * cheap unchanged-file short circuit so the per-request cost is one read.
   *
   * Returns true when the store was replaced. Never throws: an unreadable or
   * malformed file leaves the previous store in place, because a translator
   * should degrade to slightly-stale terminology rather than fail outright.
   */
  async refresh(): Promise<boolean> {
    if (this.dirty) return false
    let raw: string
    try {
      raw = await this.fs.readFile(this.filePath, 'utf8')
    } catch {
      // A file that vanished means the store is gone; mirror `load()`.
      if (this.lastLoadedRaw !== null) {
        this.store = {}
        this.lastLoadedRaw = null
        return true
      }
      return false
    }
    if (raw === this.lastLoadedRaw) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return false
    }
    if (!isKBStore(parsed)) return false
    this.store = parsed
    this.lastLoadedRaw = raw
    return true
  }

  /** Write the current store atomically (`.tmp` + rename). */
  async save(): Promise<void> {
    const dir = path.dirname(this.filePath)
    await this.fs.mkdir(dir, { recursive: true })
    const contents = JSON.stringify(this.store, null, 2)
    const tmp = this.filePath + '.tmp'
    await this.fs.writeFile(tmp, contents, 'utf8')
    await this.fs.rename(tmp, this.filePath)
    this.dirty = false
    this.lastLoadedRaw = contents
  }

  /** Whether the in-memory state diverges from disk. */
  isDirty(): boolean {
    return this.dirty
  }

  /** Look up entries in a schema (or across all schemas). */
  list(filters: KBListFilters = {}): KBEntry[] {
    const schemas = filters.schema
      ? [normalizeSchemaId(filters.schema)]
      : (SCHEMA_IDS as readonly SchemaId[])
    const out: KBEntry[] = []
    for (const schema of schemas) {
      const entries = this.store[schema]
      if (!entries) continue
      for (const entry of entries) {
        if (filters.scope && entry.scope !== filters.scope) continue
        if (filters.sourceLang || filters.targetLang) {
          const lang = entry as LangScoped
          if (filters.sourceLang && lang.sourceLang && lang.sourceLang !== filters.sourceLang) continue
          if (filters.targetLang && lang.targetLang && lang.targetLang !== filters.targetLang) continue
        }
        out.push(entry)
      }
    }
    return out
  }

  /**
   * Insert or replace an entry by id. Returns the resolved entry.
   *
   * Throws when the entry cannot be classified: storing it in a guessed bucket
   * would put a row in the user's KB that no resolver ever reads, which reads
   * to the user as "saved" while the terminology silently does not apply.
   */
  upsert(entry: KBEntry): KBEntry {
    const schemaId = schemaForEntry(entry)
    if (schemaId === null) {
      throw new Error(
        `KB entry "${String((entry as { id?: unknown }).id ?? '(no id)')}" has no identifying ` +
          'field for any schema (expected sourceTerm+targetTerm, forbiddenText, word+policy, ' +
          'name+description, or customerName+preference)',
      )
    }
    const bucket = this.store[schemaId] ?? []
    const next = bucket.filter((e) => e.id !== entry.id)
    next.push(entry)
    this.store[schemaId] = next
    this.dirty = true
    return entry
  }

  /** Remove an entry by id. Returns true when something was removed. */
  remove(id: string): boolean {
    let removed = false
    for (const schema of SCHEMA_IDS) {
      const bucket = this.store[schema]
      if (!bucket) continue
      const next = bucket.filter((e) => {
        if (e.id !== id) return true
        removed = true
        return false
      })
      if (removed) this.store[schema] = next
    }
    return removed
  }

  /**
   * Resolve the active rule set for a language pair (and optional customer /
   * glossary category). Returns the rules in priority order and a
   * human-readable prompt block.
   *
   * `customerName` is a confidentiality boundary: term / preference entries
   * that name a customer are visible only when the caller names the same
   * customer. `category` is a domain hint and never hides shared vocabulary.
   * Both fields are accepted for the customer value because the renderer
   * paths blur them; see {@link passesTermFilter}.
   */
  resolve(opts: {
    sourceLang: string
    targetLang: string
    category?: string | undefined
    customerName?: string | undefined
  }): ResolvedRules {
    const terms: TermEntry[] = []
    const forbidden: ForbiddenEntry[] = []
    const brands: BrandEntry[] = []
    const styleRules: StyleRuleEntry[] = []
    const customerPreferences: CustomerPreferenceEntry[] = []

    const passesLang = (entry: LangScoped): boolean => {
      if (!languageMatches(entry.sourceLang, opts.sourceLang)) return false
      if (!languageMatches(entry.targetLang, opts.targetLang)) return false
      return true
    }

    for (const schema of SCHEMA_IDS) {
      const entries = this.store[schema] ?? []
      for (const entry of entries) {
        if (schema === 'trade.translation.term') {
          const e = entry as TermEntry
          if (!passesLang(e)) continue
          if (!passesTermFilter(e, opts)) continue
          terms.push(e)
        } else if (schema === 'trade.translation.forbidden') {
          const e = entry as ForbiddenEntry
          if (!passesLang(e)) continue
          forbidden.push(e)
        } else if (schema === 'trade.translation.brand') {
          brands.push(entry as BrandEntry)
        } else if (schema === 'trade.translation.styleRule') {
          styleRules.push(entry as StyleRuleEntry)
        } else {
          const e = entry as CustomerPreferenceEntry
          if (!passesLang(e)) continue
          if (!matchesRequestedBucket(e.customerName, opts)) continue
          customerPreferences.push(e)
        }
      }
    }

    sortByPriority(terms)
    sortByPriority(forbidden)
    sortByPriority(brands)
    sortByPriority(styleRules)
    sortByPriority(customerPreferences)

    const dedupedTerms = shadowTermsBySource(terms, opts)

    const promptBlock = renderPromptBlock({
      sourceLang: opts.sourceLang,
      targetLang: opts.targetLang,
      terms: dedupedTerms,
      forbidden,
      brands,
      styleRules,
      customerPreferences,
    })

    return {
      terms: dedupedTerms,
      forbidden,
      brands,
      styleRules,
      customerPreferences,
      promptBlock,
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

function cloneStore(store: KBStore): KBStore {
  const out: KBStore = {}
  for (const schema of SCHEMA_IDS) {
    const bucket = store[schema]
    if (bucket && bucket.length > 0) out[schema] = [...bucket]
  }
  return out
}

function normalizeSchemaId(raw: SchemaId | SchemaKey): SchemaId {
  return (KEY_TO_SCHEMA as Record<string, SchemaId>)[raw] ?? (raw as SchemaId)
}

/**
 * Which schema bucket an entry belongs in, or `null` when nothing identifies
 * it.
 *
 * The previous version sniffed fields only and ended with
 * `return 'trade.translation.customerPreference'` as a catch-all. Combined
 * with `upsert` storing whatever it was handed, an entry with no identifying
 * field at all — `{}` from an exploratory call, or `{ id }` from a malformed
 * one — was persisted as a customer preference with no customer and no
 * preference. Three such rows were found in a real KB file, written by channel
 * probes, and they are indistinguishable from user data once written. A
 * fallback bucket can only ever hide a malformed entry, so there is no
 * fallback: an entry the resolver cannot classify is rejected.
 *
 * An explicit `schema` is honoured when present. The UI's entry form and the
 * pi `kb_upsert` shortcut both send one, and ignoring it meant a declared
 * `forbidden` entry with a stray `name` field was filed as a style rule.
 */
function schemaForEntry(entry: KBEntry): SchemaId | null {
  const declared = (entry as { schema?: unknown }).schema
  if (typeof declared === 'string' && declared.length > 0) {
    // Own-property lookup, not `in`: `'constructor' in KEY_TO_SCHEMA` is true
    // through the prototype chain, so a caller sending `schema: 'toString'`
    // would have been handed `Object.prototype.toString` as a schema id.
    const key = Object.prototype.hasOwnProperty.call(KEY_TO_SCHEMA, declared)
      ? KEY_TO_SCHEMA[declared as SchemaKey]
      : undefined
    const id = key ?? ((SCHEMA_IDS as readonly string[]).includes(declared) ? (declared as SchemaId) : undefined)
    if (id === undefined) return null
    return hasIdentifyingField(entry, id) ? id : null
  }
  const sniffed: Array<[SchemaId, boolean]> = [
    ['trade.translation.term', typeof (entry as TermEntry).sourceTerm === 'string'],
    ['trade.translation.forbidden', typeof (entry as ForbiddenEntry).forbiddenText === 'string'],
    [
      'trade.translation.brand',
      typeof (entry as BrandEntry).word === 'string' &&
        typeof (entry as BrandEntry).policy === 'string',
    ],
    [
      'trade.translation.styleRule',
      typeof (entry as StyleRuleEntry).name === 'string' &&
        typeof (entry as StyleRuleEntry).description === 'string',
    ],
    // A customer preference has no field any other schema claims, so it is
    // sniffed last: the old code reached it by falling through every branch,
    // which is why an unclassifiable entry used to land here.
    [
      'trade.translation.customerPreference',
      typeof (entry as CustomerPreferenceEntry).customerName === 'string',
    ],
  ]
  for (const [id, matches] of sniffed) {
    if (matches) return id
  }
  return null
}

/**
 * Whether `entry` carries the field the schema needs to be usable.
 *
 * A term with no `targetTerm` cannot be applied and a preference with no
 * customer applies to nobody; both used to be stored and then silently
 * ignored by `resolve`, so the UI showed a saved row that changed nothing.
 */
function hasIdentifyingField(entry: KBEntry, schema: SchemaId): boolean {
  const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0
  switch (schema) {
    case 'trade.translation.term':
      return nonEmpty((entry as TermEntry).sourceTerm) && nonEmpty((entry as TermEntry).targetTerm)
    case 'trade.translation.forbidden':
      return nonEmpty((entry as ForbiddenEntry).forbiddenText)
    case 'trade.translation.brand':
      return (
        nonEmpty((entry as BrandEntry).word) &&
        typeof (entry as BrandEntry).policy === 'string'
      )
    case 'trade.translation.styleRule':
      return (
        nonEmpty((entry as StyleRuleEntry).name) &&
        nonEmpty((entry as StyleRuleEntry).description)
      )
    case 'trade.translation.customerPreference': {
      const pref = entry as CustomerPreferenceEntry & { preference?: unknown }
      // `value` is the stored field, but rows written by the pi `kb_upsert`
      // shortcut and by older seeds carry a single `preference` string. Those
      // rows are real data a user can see and re-save, so they stay valid;
      // `describePreference` renders either shape. What is rejected is a row
      // with no content at all — the blank rows that used to be persisted.
      return (
        nonEmpty(pref.customerName) &&
        (nonEmpty(pref.value) || nonEmpty(pref.preference))
      )
    }
    default:
      return false
  }
}

function sortByPriority<T extends { scope: Scope; priority: number; id: string }>(entries: T[]): void {
  entries.sort((a, b) => {
    const sa = SCOPES.indexOf(a.scope)
    const sb = SCOPES.indexOf(b.scope)
    if (sa !== sb) return sa - sb
    if (a.priority !== b.priority) return b.priority - a.priority
    return a.id.localeCompare(b.id)
  })
}

interface PromptBlockInput {
  sourceLang: string
  targetLang: string
  terms: TermEntry[]
  forbidden: ForbiddenEntry[]
  brands: BrandEntry[]
  styleRules: StyleRuleEntry[]
  customerPreferences: CustomerPreferenceEntry[]
}

function renderPromptBlock(input: PromptBlockInput): string {
  const sections: string[] = []
  if (input.terms.length > 0) {
    const rows = input.terms
      .slice(0, 30)
      .map((t) => `  - "${t.sourceTerm}" -> "${t.targetTerm}"`)
      .join('\n')
    sections.push(`Mandatory terms:\n${rows}`)
  }
  if (input.forbidden.length > 0) {
    const rows = input.forbidden
      .slice(0, 20)
      .map((f) => {
        const replacement = f.replacement ? ` -> use "${f.replacement}"` : ''
        return `  - never write "${f.forbiddenText}"${replacement}`
      })
      .join('\n')
    sections.push(`Forbidden translations:\n${rows}`)
  }
  if (input.brands.length > 0) {
    const rows = input.brands
      .slice(0, 30)
      .map((b) => {
        if (b.policy === 'neverTranslate') return `  - "${b.word}" must remain untranslated`
        if (b.policy === 'translateAs') return `  - "${b.word}" -> "${b.translateAs ?? ''}"`
        return `  - "${b.word}" - keep as-is`
      })
      .join('\n')
    sections.push(`Brand rules:\n${rows}`)
  }
  if (input.styleRules.length > 0) {
    const rows = input.styleRules
      .slice(0, 10)
      .map((s) => `  - [${s.scope}/${s.priority}] ${s.name}: ${s.description}`)
      .join('\n')
    sections.push(`Style rules:\n${rows}`)
  }
  if (input.customerPreferences.length > 0) {
    const rows = input.customerPreferences
      .slice(0, 10)
      .map((p) => `  - ${p.customerName}: ${describePreference(p)}`)
      .join('\n')
    sections.push(`Customer preferences:\n${rows}`)
  }
  if (sections.length === 0) return ''
  return `Translation rules (${input.sourceLang} -> ${input.targetLang}):\n${sections.join('\n\n')}`
}

/**
 * Render one customer preference as `kind=value`, tolerating the two shapes
 * that exist in the wild.
 *
 * The schema is `{ customerName, preferenceType, value }`, but the pi
 * `kb_upsert` shortcut used to write a single `preference` blob and the shell's
 * KB form has always written `preferenceType` + `value`. Rendering
 * `${preferenceType}=${value}` unconditionally turned the older rows into
 * "KERRITS: undefined=undefined" in the prompt — a line the model could only
 * misread, and no signal to the user that the row was malformed.
 */
function describePreference(p: CustomerPreferenceEntry): string {
  const raw = p as unknown as { preference?: unknown }
  const value =
    typeof p.value === 'string' && p.value.length > 0
      ? p.value
      : typeof raw.preference === 'string'
        ? raw.preference
        : ''
  if (value.length === 0) return '(no value)'
  const kind = typeof p.preferenceType === 'string' && p.preferenceType.length > 0 ? p.preferenceType : 'preference'
  return `${kind}=${value}`
}

function isKBStore(value: unknown): value is KBStore {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!(SCHEMA_IDS as readonly string[]).includes(key)) return false
    const bucket = obj[key]
    if (!Array.isArray(bucket)) return false
  }
  return true
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

export { KEY_TO_SCHEMA as SCHEMA_KEY_TO_ID, SCHEMA_TO_KEY }

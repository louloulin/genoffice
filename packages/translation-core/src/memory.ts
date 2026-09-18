import type { TranslationUnit } from './types'

/**
 * Tiny in-memory translation memory keyed by
 * `${sourceLang}::${targetLang}::${normalizedSource}::${bucket}`.
 *
 * Holds up to `maxEntries` per call site; saves the user a model round-trip
 * when they retranslate the same sentence. The Dataflare bridge (when wired)
 * is the source of truth for cross-device memory; this is a desktop / web
 * fallback that always succeeds and never blocks on the network.
 *
 * The optional `bucket` is the glossary/customer scope the translation was
 * produced under. Without it, a term translated for customer A would be
 * replayed verbatim for customer B — the exact cross-customer leak the KB
 * bucket filter exists to prevent. Callers that omit the bucket keep the
 * legacy behaviour (one shared namespace) so nothing existing regresses.
 */
export interface MemoryEntry {
  sourceLang: string
  targetLang: string
  sourceText: string
  translatedText: string
  /**
   * Glossary / customer scope the entry was produced under. Entries saved
   * with a bucket are only returned for lookups with the same bucket;
   * entries saved without one are only returned for unscoped lookups.
   */
  bucket?: string | undefined
  /** unix millis */
  updatedAt: number
}

export interface MemorySaveRequest {
  scene: string
  sourceLang: string
  targetLang: string
  /** Glossary / customer scope to store the units under (see {@link MemoryEntry.bucket}). */
  bucket?: string | undefined
  units: Array<{ unitId: string; sourceText: string; translatedText: string }>
}

export interface MemorySaveResponse {
  ok: boolean
  savedCount: number
  skippedCount: number
  error?: string
}

export class TranslationMemory {
  private readonly entries = new Map<string, MemoryEntry>()
  private readonly maxEntries: number

  constructor(opts: { maxEntries?: number } = {}) {
    // The caller picks the capacity (tests want 10, production wants 2048);
    // a tiny floor just keeps an accidentally-passed 0 from being a no-op.
    this.maxEntries = Math.max(1, opts.maxEntries ?? 2048)
  }

  private keyOf(
    sourceLang: string,
    targetLang: string,
    sourceText: string,
    bucket?: string | undefined,
  ): string {
    // bucket arrives straight off the wire. A number or object crashed the
    // save with `bucket.trim is not a function` — every caller's `req.bucket`
    // is now run through `bucketFor` upstream, but the public `lookup`/`save`
    // entry points still have to keep their own guard so a typed-by-mistake
    // boolean cannot re-introduce the same fault.
    const scope = typeof bucket === 'string' && bucket.trim() ? `::${normalize(bucket)}` : ''
    return `${sourceLang}::${targetLang}::${normalize(sourceText)}${scope}`
  }

  /**
   * Look up a unit by exact source text + language pair.
   *
   * `bucket` scopes the lookup to a glossary / customer. Pass the same value
   * the entry was saved with; omit it for unscoped (legacy) entries.
   */
  lookup(
    sourceLang: string,
    targetLang: string,
    sourceText: string,
    bucket?: string | undefined,
  ): MemoryEntry | null {
    if (!sourceText || !sourceText.trim()) return null
    const entry = this.entries.get(this.keyOf(sourceLang, targetLang, sourceText, bucket))
    if (!entry) return null
    entry.updatedAt = Date.now() // LRU touch
    return entry
  }

  /** Insert or update a single translation. */
  save(entry: Omit<MemoryEntry, 'updatedAt'>): void {
    const key = this.keyOf(
      entry.sourceLang,
      entry.targetLang,
      entry.sourceText,
      entry.bucket,
    )
    this.entries.set(key, { ...entry, updatedAt: Date.now() })
    this.evictIfNeeded()
  }

  saveMany(req: MemorySaveRequest): MemorySaveResponse {
    // `req.units` arrives straight from IPC, so it can be anything the caller
    // typed. Iterating a non-array threw out of the handler and answered 500;
    // a malformed save is a caller mistake that should be reported as one.
    if (!Array.isArray(req.units)) {
      return { ok: false, savedCount: 0, skippedCount: 0, error: 'units must be an array' }
    }
    let saved = 0
    let skipped = 0
    for (const unit of req.units) {
      if (!unit || typeof unit.sourceText !== 'string' || typeof unit.translatedText !== 'string') {
        skipped++
        continue
      }
      if (!unit.translatedText.trim()) {
        skipped++
        continue
      }
      this.save({
        sourceLang: req.sourceLang,
        targetLang: req.targetLang,
        sourceText: unit.sourceText,
        translatedText: unit.translatedText,
        ...(req.bucket !== undefined ? { bucket: req.bucket } : {}),
      })
      saved++
    }
    return { ok: true, savedCount: saved, skippedCount: skipped }
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return
    // drop the oldest 10% to amortize the cost
    const drop = Math.max(1, Math.ceil(this.maxEntries * 0.1))
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (let i = 0; i < drop && i < sorted.length; i++) {
      const entry = sorted[i]
      if (entry) this.entries.delete(entry[0])
    }
  }
}

/** Trim surrounding whitespace, collapse runs, and NFC-normalize for stable keys. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().normalize('NFC')
}

/** Build a memory key for a single unit. */
export function unitMemoryKey(
  unit: TranslationUnit,
  sourceLang: string,
  targetLang: string,
): string {
  return `${sourceLang}::${targetLang}::${normalize(unit.sourceText)}`
}

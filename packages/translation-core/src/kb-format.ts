/**
 * KB / TM Open Format — sdk1.md §3.3.
 *
 * `.genkb` and `.gentm` are tar-like archives with a JSON manifest and a
 * JSONL payload. The format is intentionally simple so it round-trips
 * between Node, the browser, and external tools (`tar -tf foo.genkb` works).
 *
 * Layout:
 *
 *   <archive>.genkb
 *     manifest.json     # { id, version, lang, embeddingModel, createdAt, ... }
 *     entries.jsonl     # one line per entry: { q, a, source, tags, embedding? }
 *     index.bin         # optional HNSW vector index (provider-specific binary)
 *
 *   <archive>.gentm
 *     manifest.json     # { id, version, srcLang, tgtLang, domain, createdAt }
 *     pairs.jsonl       # { src, tgt, domain, confidence, tags?, createdAt }
 *
 * Stability:
 *   - Manifest schema is v1.x; adding optional fields is allowed at minor
 *     versions. Renaming or removing required fields is a breaking change
 *     (v2 boundary).
 *   - The reader is permissive: unknown manifest fields are preserved on
 *     round-trip but ignored by the loader.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ──────────────────────────────────────────────────────────────────────────────
// KB
// ──────────────────────────────────────────────────────────────────────────────

export interface KbManifest {
  v: 'genoffice.kb.1'
  id: string
  version: string
  /** ISO 639-1 source language (e.g. `en`). */
  lang: string
  /** Embedding model the `embedding` vectors were computed with. e.g.
   *  `text-embedding-3-small`, `bge-large-zh-v1.5`. Empty string means
   *  the KB does not ship embeddings (use BM25 only). */
  embeddingModel: string
  /** Embedding dimension; matches `embeddingModel`. 0 when no embeddings. */
  embeddingDim: number
  createdAt: string
  author?: string
  description?: string
  tags?: string[]
}

export interface KbEntry {
  q: string
  a: string
  /** Source reference (URL, doc path, citation). */
  source?: string
  tags?: string[]
  /** Optional pre-computed embedding vector (length = manifest.embeddingDim). */
  embedding?: number[]
}

export interface KbArchive {
  manifest: KbManifest
  entries: KbEntry[]
}

/** Validate a KB manifest — throws `FormatError` on missing required fields. */
export function validateKbManifest(m: Partial<KbManifest>): KbManifest {
  if (!m || typeof m !== 'object') throw new FormatError('manifest must be an object')
  if (m.v !== 'genoffice.kb.1') throw new FormatError(`unsupported manifest version: ${String(m.v)}`)
  if (typeof m.id !== 'string' || !m.id) throw new FormatError('manifest.id required')
  if (typeof m.version !== 'string' || !m.version) throw new FormatError('manifest.version required')
  if (typeof m.lang !== 'string' || !m.lang) throw new FormatError('manifest.lang required')
  if (typeof m.embeddingModel !== 'string') throw new FormatError('manifest.embeddingModel required')
  if (typeof m.embeddingDim !== 'number' || m.embeddingDim < 0) throw new FormatError('manifest.embeddingDim must be a non-negative number')
  if (typeof m.createdAt !== 'string') throw new FormatError('manifest.createdAt required')
  return m as KbManifest
}

/** Build a KB manifest with sensible defaults. */
export function makeKbManifest(input: { id: string; lang: string; description?: string; tags?: string[]; author?: string; embeddingModel?: string; embeddingDim?: number }): KbManifest {
  return {
    v: 'genoffice.kb.1',
    id: input.id,
    version: '1.0.0',
    lang: input.lang,
    embeddingModel: input.embeddingModel ?? '',
    embeddingDim: input.embeddingDim ?? 0,
    createdAt: new Date().toISOString(),
    ...(input.author ? { author: input.author } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.tags ? { tags: [...input.tags] } : {}),
  }
}

/** Parse a `.genkb` archive from a directory containing manifest.json + entries.jsonl. */
export function readKbArchive(dir: string): KbArchive {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new FormatError(`manifest.json not found at ${manifestPath}`)
  const manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<KbManifest>
  const manifest = validateKbManifest(manifestRaw)
  const entriesPath = join(dir, 'entries.jsonl')
  const entries: KbEntry[] = []
  if (existsSync(entriesPath)) {
    const lines = readFileSync(entriesPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as KbEntry)
      } catch (e) {
        throw new FormatError(`entries.jsonl: invalid JSON line: ${(e as Error).message}`)
      }
    }
  }
  return { manifest, entries }
}

/** Serialise a KB archive to a directory. Does NOT write index.bin — callers
 *  handle vector-index generation separately. */
export function writeKbArchive(dir: string, archive: KbArchive): void {
  const fs = require('node:fs') as typeof import('node:fs')
  if (!existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify(archive.manifest, null, 2), 'utf8')
  fs.writeFileSync(join(dir, 'entries.jsonl'), archive.entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8')
}

// ──────────────────────────────────────────────────────────────────────────────
// TM
// ──────────────────────────────────────────────────────────────────────────────

export interface TmManifest {
  v: 'genoffice.tm.1'
  id: string
  version: string
  /** BCP-47 source language. */
  srcLang: string
  /** BCP-47 target language. */
  tgtLang: string
  domain?: string
  createdAt: string
  author?: string
  description?: string
}

export interface TmPair {
  src: string
  tgt: string
  domain?: string
  /** Translation confidence in [0, 1]; defaults to 1 for human-edited pairs. */
  confidence?: number
  tags?: string[]
  createdAt?: string
}

export interface TmArchive {
  manifest: TmManifest
  pairs: TmPair[]
}

export function validateTmManifest(m: Partial<TmManifest>): TmManifest {
  if (!m || typeof m !== 'object') throw new FormatError('manifest must be an object')
  if (m.v !== 'genoffice.tm.1') throw new FormatError(`unsupported manifest version: ${String(m.v)}`)
  if (typeof m.id !== 'string' || !m.id) throw new FormatError('manifest.id required')
  if (typeof m.version !== 'string' || !m.version) throw new FormatError('manifest.version required')
  if (typeof m.srcLang !== 'string' || !m.srcLang) throw new FormatError('manifest.srcLang required')
  if (typeof m.tgtLang !== 'string' || !m.tgtLang) throw new FormatError('manifest.tgtLang required')
  if (typeof m.createdAt !== 'string') throw new FormatError('manifest.createdAt required')
  return m as TmManifest
}

export function makeTmManifest(input: { id: string; srcLang: string; tgtLang: string; domain?: string; description?: string; author?: string }): TmManifest {
  return {
    v: 'genoffice.tm.1',
    id: input.id,
    version: '1.0.0',
    srcLang: input.srcLang,
    tgtLang: input.tgtLang,
    createdAt: new Date().toISOString(),
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.author ? { author: input.author } : {}),
    ...(input.description ? { description: input.description } : {}),
  }
}

export function readTmArchive(dir: string): TmArchive {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new FormatError(`manifest.json not found at ${manifestPath}`)
  const manifest = validateTmManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<TmManifest>)
  const pairsPath = join(dir, 'pairs.jsonl')
  const pairs: TmPair[] = []
  if (existsSync(pairsPath)) {
    const lines = readFileSync(pairsPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
    for (const line of lines) {
      try {
        pairs.push(JSON.parse(line) as TmPair)
      } catch (e) {
        throw new FormatError(`pairs.jsonl: invalid JSON line: ${(e as Error).message}`)
      }
    }
  }
  return { manifest, pairs }
}

export function writeTmArchive(dir: string, archive: TmArchive): void {
  const fs = require('node:fs') as typeof import('node:fs')
  if (!existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify(archive.manifest, null, 2), 'utf8')
  fs.writeFileSync(join(dir, 'pairs.jsonl'), archive.pairs.map((p) => JSON.stringify(p)).join('\n'), 'utf8')
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class FormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormatError'
  }
}

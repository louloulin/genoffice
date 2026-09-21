/**
 * @genoffice/skill-slides-outline — a standalone Skill that turns long-form
 * text into a structured slide outline.
 *
 * Algorithm:
 *   1. Split the input on sentence boundaries, drop the empty pieces.
 *   2. Group sentences into chunks of approximately `targetWordsPerSlide`
 *      words. A new chunk starts whenever a sentence contains a heading
 *      marker (line starting with `#`, `##`, or numbered `1.` / `1)`).
 *   3. For each chunk, generate a slide title (first sentence, trimmed to
 *      `maxTitleWords`) and up to `bulletsPerSlide` bullets (subsequent
 *      sentences, summarised by stripping stop-words when too long).
 *
 * The output is deterministic given the same input + options, so tests are
 * reliable.
 *
 * Type-only import of SkillContext / SkillDefinition / SkillPackage.
 */

import type { SkillContext, SkillDefinition, SkillPackage } from '@genoffice/agent-skills'

export type SkillErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROVIDER_FAILURE'
  | 'INTERNAL'

export class SkillError extends Error {
  readonly code: SkillErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: SkillErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
    this.name = 'SkillError'
  }
}

export interface OutlineOptions {
  /** Approximate words per slide. Default 60. */
  targetWordsPerSlide?: number
  /** Maximum words in a slide title. Default 8. */
  maxTitleWords?: number
  /** Maximum bullets per slide. Default 5. */
  bulletsPerSlide?: number
}

const DEFAULTS: Required<OutlineOptions> = {
  targetWordsPerSlide: 60,
  maxTitleWords: 8,
  bulletsPerSlide: 5,
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'if', 'then', 'else',
])

export interface SlideOutline {
  title: string
  bullets: string[]
  /** Words consumed by this slide (approximate). */
  words: number
}

export interface OutlineResult {
  slides: SlideOutline[]
  /** Total input words processed. */
  totalWords: number
}

/**
 * Split text into sentences using a minimal but reasonable heuristic:
 * periods / question marks / exclamation marks followed by whitespace and an
 * uppercase letter, OR end-of-input.
 */
export function splitSentences(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    buf += ch
    if (ch === '.' || ch === '?' || ch === '!') {
      const next = text[i + 1]
      // Trim trailing whitespace from the buffer
      const trimmed = buf.replace(/\s+$/, '')
      if (next === undefined || /\s/.test(next ?? '')) {
        out.push(trimmed)
        buf = ''
        // skip leading whitespace of next sentence
        if (next === ' ' || next === '\n' || next === '\t') {
          while (/\s/.test(text[i + 1] ?? '')) i++
        }
      }
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim())
  return out.filter((s) => s.length > 0)
}

function isHeadingStart(sentence: string): boolean {
  const trimmed = sentence.trimStart()
  return trimmed.startsWith('#') || /^\d+[.)] /.test(trimmed)
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length
}

function trimToTitle(sentence: string, maxWords: number): string {
  const words = sentence.replace(/[.?!]+$/, '').split(/\s+/)
  return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '…' : '')
}

function summaryForBullet(sentence: string): string {
  const stripped = sentence.replace(/[.?!]+$/, '')
  const words = stripped.split(/\s+/)
  if (words.length <= 12) return stripped
  // Keep first 8 content words.
  const content: string[] = []
  for (const w of words) {
    if (content.length >= 8) break
    if (STOP_WORDS.has(w.toLowerCase()) && content.length > 0) continue
    content.push(w)
  }
  return content.join(' ') + '…'
}

export function buildOutline(text: string, options: OutlineOptions = {}): OutlineResult {
  if (typeof text !== 'string') {
    throw new SkillError('INVALID_ARGUMENT', 'text must be a string')
  }
  const opts: Required<OutlineOptions> = { ...DEFAULTS, ...options }
  const sentences = splitSentences(text)
  if (sentences.length === 0) {
    return { slides: [], totalWords: 0 }
  }

  const slides: SlideOutline[] = []
  let currentTitle = ''
  let currentBullets: string[] = []
  let currentWords = 0

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].trim()
    if (s.length === 0) continue

    if (isHeadingStart(s)) {
      // Heading begins a new slide. Title is the heading text without the
      // leading `#` / `1.` marker.
      const titleText = s.replace(/^#+\s*/, '').replace(/^\d+[.)]\s*/, '')
      if (currentTitle || currentBullets.length > 0) {
        slides.push({ title: currentTitle, bullets: currentBullets, words: currentWords })
      }
      currentTitle = trimToTitle(titleText, opts.maxTitleWords)
      currentBullets = []
      currentWords = wordCount(titleText)
      continue
    }

    // First non-heading sentence seeds the title if we don't have one.
    if (!currentTitle) {
      currentTitle = trimToTitle(s, opts.maxTitleWords)
      continue
    }

    // Otherwise accumulate as a bullet unless we're past the word budget AND
    // we already have bullets.
    const sentenceWords = wordCount(s)
    if (currentWords + sentenceWords > opts.targetWordsPerSlide && currentBullets.length > 0) {
      slides.push({ title: currentTitle, bullets: currentBullets, words: currentWords })
      currentTitle = trimToTitle(s, opts.maxTitleWords)
      currentBullets = []
      currentWords = sentenceWords
      continue
    }

    currentBullets.push(summaryForBullet(s))
    currentWords += sentenceWords
    if (currentBullets.length >= opts.bulletsPerSlide) {
      slides.push({ title: currentTitle, bullets: currentBullets, words: currentWords })
      currentTitle = ''
      currentBullets = []
      currentWords = 0
    }
  }

  if (currentTitle || currentBullets.length > 0) {
    slides.push({ title: currentTitle, bullets: currentBullets, words: currentWords })
  }

  return { slides, totalWords: sentences.reduce((n, s) => n + wordCount(s), 0) }
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill manifest
// ──────────────────────────────────────────────────────────────────────────────

const skill: SkillDefinition = {
  id: 'genoffice.skill.slides-outline',
  version: '0.1.0',
  name: {
    'en-US': 'Generate Slide Outline',
    'zh-CN': '生成幻灯片大纲',
  },
  description: {
    'en-US': 'Splits long-form text into a structured slide outline (titles + bullets) without invoking an LLM.',
    'zh-CN': '无需调用大模型，将长文本拆分为结构化的幻灯片大纲（标题 + 要点）。',
  },
  triggers: ['slide outline', 'presentation outline', '幻灯片大纲', 'PPT 大纲'],
  inputs: [
    {
      name: 'text',
      schema: { type: 'string', required: true, description: { 'en-US': 'Long-form text', 'zh-CN': '长文本' } } as never,
      required: true,
    },
    {
      name: 'options',
      schema: { type: 'object', properties: {} as Record<string, never>, required: false } as never,
      required: false,
    },
  ],
  outputs: [
    {
      name: 'slides',
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            words: { type: 'number' },
          },
        },
      },
    },
    { name: 'totalWords', schema: { type: 'number' } },
  ],
  tags: ['slides', 'outline', 'presentation'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (typeof rawInputs.text !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'text must be a string')
    }
    const r = buildOutline(rawInputs.text, (rawInputs.options ?? {}) as OutlineOptions)
    return { slides: r.slides, totalWords: r.totalWords }
  },
}

const pkg: SkillPackage = { skill }

export default pkg
export { pkg, skill }

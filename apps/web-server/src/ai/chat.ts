/**
 * Core AI handlers — settings, login, chat, stream.
 *
 * Mirrors the Electron main-process surface so the same renderer code
 * (AgentLoop + createElectronTransport) works against the standalone
 * web-server without code changes. The streaming path now calls
 * `streamForProvider` from `@genoffice/ai-provider` — the same unified
 * entrypoint the Electron docs/sheets/slides apps use — so the web build
 * talks to real providers (MiniMax via OpenAI-compatible, Anthropic,
 * Gemini, etc.) instead of returning canned text.
 *
 * Settings live on disk in DATA_DIR/ai-settings.json so they survive
 * restarts and operator-driven `WEB_STATIC_ROOT` deploys.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR, isManagedPath, registerHandle } from '../common/index'
import {
  AiCreditsError,
  AiTimeoutError,
  type AiChatRequest,
  type AiChatResponse,
  type AiProviderConfig,
  type AiProviderId,
  type AiSettings,
  type AiStreamChunk,
  chatForProvider,
  defaultAiSettings,
  isAiNetworkError,
  listCodexModels,
  isAiOverloadedError,
  isAiQuotaExhaustedError,
  maxOutputTokensOf,
  streamForProvider,
} from '@genoffice/ai-provider'
import { InvalidArgumentError } from './errors'
import { fetchRemoteImage } from '@genoffice/electron-utils/remote-image'
import { gskApiKey, hasGskAuth, gskLoginInfo } from '@genoffice/ai-search'

import { parseDuckDuckGo, parseDuckDuckGoImages } from '@genoffice/agent-skills'
import { callTranslateTool } from '../shell/pi-session'
import {
  assessBatchQuality,
  type BuildDictionaryResult,
  buildTranslationPrompt,
  buildTranslateSystemPrompt,
  defaultOutputPath,
  extractTranslationText,
  isSupportedExtension,
  KnowledgeBase,
  resolveTranslateSkills,
  PersistentTranslationMemory,
  SUPPORTED_EXTENSIONS,
  type TerminologyPair,
} from '@genoffice/translation-core'

// Re-export the shared prompt / text helpers so existing tests and external
// callers don't need to know that the canonical home moved to
// `@genoffice/translation-core`.
export { buildTranslationPrompt, buildTranslateSystemPrompt, extractTranslationText }

// Shared translation knowledge base — mirrors LumosAI's translate-config
// 5-schema KB at ~/.genoffice/translation-kb.json. The load promise is
// memoised so every caller can `await ensureKbLoaded()`; that ordering matters
// because a fire-and-forget load would race a subsequent upsert and clobber
// the in-memory store with the (empty) on-disk state.
export const sharedKnowledgeBase = new KnowledgeBase()
let kbLoadPromise: Promise<void> | null = null
export function ensureKbLoaded(): Promise<void> {
  if (!kbLoadPromise) {
    kbLoadPromise = sharedKnowledgeBase.load().catch((err: unknown) => {
      console.warn('[translation-kb] load failed:', err)
    })
  }
  return kbLoadPromise
}

// Persistent translation memory — the in-memory `sharedMemory` loses everything
// on restart, so any LLM translation the agent makes is wasted work on the next
// run. `translationMemory` writes per-pair JSON under
// `~/.genoffice/translation-memory/` and rehydrates on boot, so sentence-level
// reuse kicks in without the user having to wire anything up.
export const translationMemory = new PersistentTranslationMemory()
let tmLoadPromise: Promise<void> | null = null
function normalizeBucket(
  glossaryCategory: string | undefined,
  customerName: string | undefined,
): string | undefined {
  for (const value of [glossaryCategory, customerName]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function ensureMemoryLoaded(): Promise<void> {
  if (!tmLoadPromise) {
    tmLoadPromise = translationMemory.load().catch((err: unknown) => {
      console.warn('[translation-memory] load failed:', err)
    })
  }
  return tmLoadPromise
}

// Debounce flushes so a burst of translations doesn't hit the disk on every
// call; the underlying `isDirty` already prevents redundant work.
let flushTimer: NodeJS.Timeout | null = null
/**
 * Debounced flush, shared by every surface that writes translation memory.
 *
 * The HTTP translate endpoints write into the same `translationMemory` as the
 * IPC handlers, so they need the same debounce; before this was exported they
 * saved without ever scheduling a write and the HTTP path only ever persisted
 * on a clean shutdown.
 */
export function scheduleMemoryFlush(delayMs = 250): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushTranslationMemory()
  }, delayMs)
}

/**
 * Write every pending translation-memory entry to disk now.
 *
 * `PersistentTranslationMemory.save()` only marks the language pair dirty, so
 * anything translated after the last debounce tick — including a translation
 * made moments before the process is signalled — lives in memory only. The
 * shutdown path calls this so "the cache survives a restart" holds even when
 * the flush timer never fires.
 */
export async function flushTranslationMemory(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await translationMemory.flush().catch((err: unknown) => {
    console.warn('[translation-memory] flush failed:', err)
  })
}

// Most recently generated `--dictionary`.
//
// The Settings pane builds a dictionary for a file, then the user usually wants
// to keep translating short snippets with the terminology they just curated.
// Rather than make them re-paste it, the snippet path reuses the last built
// dictionary (or an explicit `dictionaryPath`). Parsed lazily and cached by
// path so repeated snippet calls are free.
//
// The dictionary is remembered together with the glossary / customer bucket it
// was built for. A dictionary is terminology, not a cache: reusing a KERRITS
// dictionary for an ACME snippet would apply KERRITS' branded wording to
// another customer's document, which is the same leak the KB bucket filter
// exists to prevent. An implicit reuse that crosses buckets is therefore
// refused, and the snippet translates with the caller's own KB instead.
let lastDictionary: { path: string; pairs: TerminologyPair[]; bucket: string } | null = null

interface LoadedDictionary {
  path: string
  /** Terminology pairs, longest source first so multi-word terms win. */
  pairs: TerminologyPair[]
  /** Normalized glossary / customer bucket the dictionary was built for. */
  bucket: string
}

/** Normalize a glossary / customer bucket; `undefined` == unscoped. */
function dictionaryBucket(...candidates: Array<string | undefined>): string {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Read a generated `{ "source": "target" }` dictionary off disk. Returns null
 * when the file is missing or malformed — the caller then translates without
 * the dictionary instead of failing the whole request.
 *
 * `bucket` is the glossary / customer the caller is translating for. When it
 * differs from the bucket the cached entry was loaded for, the on-disk file is
 * re-read: two customers can share a path only by mistake, and silently
 * serving the first one's pairs is exactly the cross-customer leak this cache
 * used to cause.
 */
function loadDictionary(path: string, bucket = ''): LoadedDictionary | null {
  // `dictionaryPath` arrives either from settings or straight from a request
  // body, so it must not become an arbitrary file read: an unmanaged path
  // degrades to "no glossary" instead of parsing someone else's file.
  if (!isManagedPath(path)) return null
  if (lastDictionary?.path === path && lastDictionary.bucket === bucket) return lastDictionary
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const pairs: TerminologyPair[] = []
    for (const [source, target] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof target !== 'string') continue
      if (!source.trim() || !target.trim()) continue
      pairs.push({ source, target })
    }
    if (pairs.length === 0) return null
    pairs.sort((a, b) => b.source.length - a.source.length)
    lastDictionary = { path, pairs, bucket }
    return lastDictionary
  } catch {
    return null
  }
}

/** Remember a freshly written dictionary without a redundant disk read. */
function rememberDictionary(
  path: string,
  pairs: readonly TerminologyPair[],
  bucket = '',
): void {
  if (pairs.length === 0) return
  lastDictionary = {
    path,
    pairs: [...pairs].sort((a, b) => b.source.length - a.source.length),
    bucket,
  }
}

/**
 * Cache the dictionary a builder call just wrote. The builder returns its
 * segments, so we avoid re-reading the file we just wrote; when a builder omits
 * them (older callers) we fall back to reading it back from disk.
 */
function rememberBuiltDictionary(
  result: {
    ok: boolean
    dictionaryPath?: string | undefined
    segments?: Array<{ source: string; target?: string | undefined }> | undefined
  },
  bucket = '',
): void {
  if (!result.ok || !result.dictionaryPath) return
  const pairs = (result.segments ?? [])
    .filter((seg) => seg.target !== undefined && seg.target.trim().length > 0)
    .map((seg) => ({ source: seg.source, target: seg.target as string }))
  if (pairs.length === 0) {
    loadDictionary(result.dictionaryPath, bucket)
    return
  }
  rememberDictionary(result.dictionaryPath, pairs, bucket)
}

// ----- settings persistence --------------------------------------------------

const AI_SETTINGS_FILE = join(DATA_DIR, 'ai-settings.json')

/** Human-readable provider label for error messages ("MiniMax", "OpenAI", …).
 *  Falls back to the raw id if the provider isn't in the registry. */
function providerLabel(id: string): string {
  const known: Record<string, string> = {
    genspark: 'Genspark',
    codex: 'Codex CLI',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    kimi: 'Kimi',
    glm: 'GLM',
    qwen: 'Qwen',
    doubao: 'Doubao',
    minimax: 'MiniMax',
    xai: 'Grok',
    mistral: 'Mistral',
    openrouter: 'OpenRouter',
    requesty: 'Requesty',
    'opencode-zen': 'OpenCode Zen',
    'opencode-go': 'OpenCode Go',
    custom: 'Custom provider',
  }
  return known[id] ?? id
}

/**
 * Resolve the config a provider call should actually use.
 *
 * Genspark authenticates through the shared gsk login (`~/.genoffice/auth.json`
 * or the gsk CLI config), not through a key the user pastes into Settings. The
 * stored config therefore often has an empty `apiKey`, and without this the
 * proxy request reaches genspark.ai's website instead of its LLM endpoint and
 * comes back as an HTML 403. Every call site resolves its config through here so
 * the behaviour cannot drift between the chat / translate / dictionary paths.
 */
export function resolveProviderConfig(
  settings: AiSettings,
  provider: AiProviderId,
): AiProviderConfig | undefined {
  const config = settings.providers?.[provider]
  if (!config) return undefined
  if (provider === 'genspark' && !config.apiKey) {
    const key = gskApiKey()
    if (key) return { ...config, apiKey: key }
  }
  return config
}

function loadSettings(): AiSettings {
  try {
    if (existsSync(AI_SETTINGS_FILE)) {
      const raw = readFileSync(AI_SETTINGS_FILE, 'utf8')
      const parsed = JSON.parse(raw) as AiSettings
      // re-merge on top of defaults so newly added providers appear without a wipe
      const def = defaultAiSettings()
      return {
        ...def,
        ...parsed,
        providers: { ...def.providers, ...(parsed.providers || {}) },
      }
    }
  } catch (err) {
    console.warn('[ai] failed to load ai-settings.json, falling back to defaults:', err)
  }
  // Seed from environment so the obvious deploy (set MINIMAX_API_KEY + start)
  // Just Works without anyone clicking through the settings UI.
  const env: Partial<Record<AiProviderId, string>> = {}
  if (process.env.MINIMAX_API_KEY) env.minimax = process.env.MINIMAX_API_KEY
  if (process.env.OPENAI_API_KEY) env.openai = process.env.OPENAI_API_KEY
  if (process.env.ANTHROPIC_API_KEY) env.anthropic = process.env.ANTHROPIC_API_KEY
  if (process.env.GEMINI_API_KEY) env.gemini = process.env.GEMINI_API_KEY
  if (process.env.DEEPSEEK_API_KEY) env.deepseek = process.env.DEEPSEEK_API_KEY
  if (process.env.KIMI_API_KEY) env.kimi = process.env.KIMI_API_KEY
  if (process.env.QWEN_API_KEY) env.qwen = process.env.QWEN_API_KEY
  if (process.env.DOUBAO_API_KEY) env.doubao = process.env.DOUBAO_API_KEY
  if (process.env.XAI_API_KEY) env.xai = process.env.XAI_API_KEY
  if (process.env.MISTRAL_API_KEY) env.mistral = process.env.MISTRAL_API_KEY
  if (process.env.OPENROUTER_API_KEY) env.openrouter = process.env.OPENROUTER_API_KEY
  const def = defaultAiSettings(env)
  // also pre-select a provider that actually has a key, so the very first
  // /api/ai/stream call hits the real LLM out of the box
  for (const k of Object.keys(env) as AiProviderId[]) {
    if (def.providers[k]?.apiKey) {
      def.provider = k
      break
    }
  }
  return def
}

function saveSettings(settings: AiSettings): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(AI_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
  } catch (err) {
    console.warn('[ai] failed to persist ai-settings.json:', err)
  }
}

export let aiSettings: AiSettings = loadSettings()

/**
 * Lightweight summary of translation knowledge base + memory + provider
 * state for the `/health` endpoint. Every field is best-effort: a
 * KB that has never been loaded (no requests have hit `ai:translate*`
 * yet) reports `loaded: false`, never throws. The numbers are
 * read against the in-memory map; they reflect what the next
 * translate call would use, not what is on disk after a crash.
 */
export function translationStateSummary(): {
  kbLoaded: boolean
  kbTerms: number
  tmLoaded: boolean
  tmPairs: number
  defaultProvider: string | null
} {
  const defaultProvider = aiSettings.provider ?? null
  let kbTerms = 0
  try {
    // KnowledgeBase exposes the resolved schema via its public API.
    // `entries` is the Map<SchemaId, KBEntry[]> we already populate on
    // every load / upsert; counting it is O(1) over the schema map and
    // O(n) over terms.
    kbTerms = (sharedKnowledgeBase as unknown as { entries?: Map<string, unknown[]> }).entries
      ? Array.from(
          (sharedKnowledgeBase as unknown as { entries: Map<string, unknown[]> }).entries.values(),
        ).reduce((sum, list) => sum + list.length, 0)
      : 0
  } catch {
    kbTerms = 0
  }
  let tmPairs = 0
  try {
    const buckets = (translationMemory as unknown as { buckets?: Map<string, unknown> }).buckets
    tmPairs = buckets ? buckets.size : 0
  } catch {
    tmPairs = 0
  }
  return {
    kbLoaded: kbLoadPromise !== null,
    kbTerms,
    tmLoaded: tmLoadPromise !== null,
    tmPairs,
    defaultProvider,
  }
}

// ----- shared streaming core -------------------------------------------------

export interface StreamSession {
  /** AbortController wired to the in-flight streamForProvider call */
  abort: AbortController
  /** how many chunks have been emitted (debug/observability) */
  chunks: number
}

export const AI_STREAM_SESSIONS = new Map<string, StreamSession>()

/**
 * Build the StreamCallbacks shape streamForProvider expects and forward
 * each event as an AiStreamChunk to the sender (IPC `event.sender.send`
 * in the IPC path; an HTTP SSE writer in the /api/ai/stream path).
 */
export interface AiStreamSink {
  send(chunk: AiStreamChunk): void
  onAbort?(controller: AbortController): void
}

export async function runProviderStream(
  settings: AiSettings,
  system: string,
  messages: Parameters<typeof streamForProvider>[3],
  tools: Parameters<typeof streamForProvider>[4],
  maxTokens: number | undefined,
  sink: AiStreamSink,
): Promise<void> {
  const provider = settings.provider
  const config = resolveProviderConfig(settings, provider)
  if (!config) {
    sink.send({
      requestId: '',
      type: 'error',
      error: `AI provider "${provider}" not configured`,
    })
    return
  }
  if (provider !== 'genspark' && provider !== 'codex' && !config.apiKey) {
    sink.send({
      requestId: '',
      type: 'error',
      error: `No API key configured for provider "${provider}". Open Settings → AI to add one.`,
    })
    return
  }
  if (provider !== 'codex' && !config.model) {
    sink.send({ requestId: '', type: 'error', error: `No model selected for "${provider}".` })
    return
  }

  const controller = new AbortController()
  sink.onAbort?.(controller)

  let stopReason: string | undefined
  try {
    await streamForProvider(
      provider,
      config as AiProviderConfig,
      system,
      messages,
      tools,
      maxTokens ?? maxOutputTokensOf(settings),
      {
        signal: controller.signal,
        onDelta: (text) => sink.send({ requestId: '', type: 'delta', text }),
        onReasoningDelta: (text) => sink.send({ requestId: '', type: 'reasoning', text }),
        onToolCall: (toolCall) => sink.send({ requestId: '', type: 'tool-call', toolCall }),
        onStopReason: (reason) => {
          stopReason = reason
        },
        onActivity: () => {
          // wire-level keepalive so the renderer watchdog can tell a live turn
          sink.send({ requestId: '', type: 'ping' })
        },
      },
    )
    sink.send({ requestId: '', type: 'done', ...(stopReason ? { stopReason } : {}) })
  } catch (err) {
    if (controller.signal.aborted) {
      sink.send({ requestId: '', type: 'done' })
      return
    }
    sink.send({
      requestId: '',
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof AiTimeoutError
        ? { errorCode: 'timeout' as const }
        : err instanceof AiCreditsError || isAiQuotaExhaustedError(err)
          ? { errorCode: 'credits' as const }
          : isAiNetworkError(err)
            ? { errorCode: 'network' as const }
            : isAiOverloadedError(err)
              ? { errorCode: 'overloaded' as const }
              : {}),
    })
  }
}

// ----- IPC handlers ----------------------------------------------------------

export function registerAiCoreHandlers(): void {
  registerHandle('ai:get-settings', () => aiSettings)
  registerHandle('ai:set-settings', (_event: unknown, settings: unknown) => {
    const next = settings as AiSettings
    if (!next || typeof next !== 'object') {
      // A malformed request, not a server fault: answered 500 for years and
      // the renderer could not tell that its own payload was the problem.
      throw new InvalidArgumentError('ai:set-settings', 'expected an AiSettings object')
    }
    aiSettings = {
      ...aiSettings,
      ...next,
      providers: { ...aiSettings.providers, ...(next.providers || {}) },
    }
    saveSettings(aiSettings)
    return { ok: true }
  })

  // Genspark sign-in is the shared gsk login, so report the real state rather
  // than a canned "signed in": a stub here made the UI claim the account was
  // connected while every genspark call 403'd.
  registerHandle('ai:gsk-login', async () => {
    const info = await gskLoginInfo().catch(() => null)
    const loggedIn = hasGskAuth() || !!info
    return {
      loggedIn,
      email: info?.email ?? null,
      credits: info?.creditBalance ?? null,
    }
  })

  registerHandle('ai:gsk-status', async (_event: unknown, withEmail?: unknown) => {
    const info = await gskLoginInfo().catch(() => null)
    const loggedIn = hasGskAuth() || !!info
    if (withEmail === false) return { loggedIn }
    return { loggedIn, email: info?.email ?? null }
  })

  registerHandle('ai:log-run-failure', () => ({ ok: true }))

  /**
   * home:ai-capabilities — report per-feature availability so agents and the
   * UI can show an honest picture. Unlike the CLI's `capabilities` command
   * (which only counts keyed providers), this handler includes the zero-
   * config DuckDuckGo fallback for web/image search because the handlers
   * themselves fall back to it without asking the user to set anything up.
   */
  registerHandle('home:ai-capabilities', () => {
    type CapabilityReport = {
      available: boolean
      via: string
      fallback?: string
      configured: boolean
      note?: string
    }
    const report: Record<string, CapabilityReport> = {}

    // 1) web text search — DuckDuckGo's html endpoint is always available
    //    (no key, no rate-limit interaction); a keyed Serper/Tavily provider
    //    upgrades to "configured" once the user supplies a key.
    const searchSettings = aiSettings.search
    const searchProvider = searchSettings?.provider ?? 'genspark'
    const searchKeyed =
      searchProvider !== 'genspark' &&
      !!searchSettings?.providers?.[searchProvider as 'serper' | 'tavily']?.apiKey
    report.search = {
      available: true,
      via: searchKeyed ? searchProvider : 'duckduckgo',
      fallback: searchKeyed ? 'duckduckgo' : undefined,
      configured: searchKeyed || aiSettings.gskToolsEnabled !== false,
      note: searchKeyed
        ? undefined
        : 'DuckDuckGo HTML endpoint works without a key; install a Serper/Tavily key for richer results.',
    }

    // 2) image search — same pattern. DuckDuckGo's /?iax=images endpoint is
    //    wired through ai:image-search and never requires a key.
    report.image_search = {
      available: true,
      via: searchKeyed ? searchProvider : 'duckduckgo',
      fallback: searchKeyed ? 'duckduckgo' : undefined,
      configured: searchKeyed || aiSettings.gskToolsEnabled !== false,
      note: searchKeyed ? undefined : 'DuckDuckGo image endpoint works without a key.',
    }

    // 3) image generation — needs a media provider with a key (or Genspark
    //    credits). DDG does not generate images.
    const mediaSettings = aiSettings.media
    const imageProvider = mediaSettings?.imageProvider ?? 'genspark'
    const imageKeyed =
      imageProvider !== 'genspark' && !!mediaSettings?.providers?.[imageProvider]?.apiKey
    report.image_generation = {
      available: imageKeyed || aiSettings.gskToolsEnabled !== false,
      via: imageKeyed ? imageProvider : aiSettings.gskToolsEnabled === false ? 'none' : 'genspark',
      configured: imageKeyed || aiSettings.gskToolsEnabled !== false,
      note: imageKeyed ? undefined : 'Add a key for OpenAI/Gemini/Doubao/etc. to generate images.',
    }

    // 4) media analysis — same shape as image generation.
    const analysisProvider = mediaSettings?.analysisProvider ?? 'genspark'
    const analysisKeyed =
      analysisProvider !== 'genspark' && !!mediaSettings?.providers?.[analysisProvider]?.apiKey
    report.media_analysis = {
      available: analysisKeyed || aiSettings.gskToolsEnabled !== false,
      via: analysisKeyed
        ? analysisProvider
        : aiSettings.gskToolsEnabled === false
          ? 'none'
          : 'genspark',
      configured: analysisKeyed || aiSettings.gskToolsEnabled !== false,
      note: analysisKeyed
        ? undefined
        : 'Add a key for OpenAI/Gemini/Claude/etc. to analyze images and video.',
    }

    return {
      ok: true,
      capabilities: report,
      provider: aiSettings.provider,
      gskToolsEnabled: aiSettings.gskToolsEnabled !== false,
    }
  })

  registerHandle('ai:codex-models', async () => {
    // Real lookup against the Codex CLI bridge; falls back to an empty
    // catalog when the CLI isn't on PATH (which is normal for the
    // standalone web build — Codex is an opt-in provider).
    try {
      return await listCodexModels(aiSettings.providers.codex?.cliPath)
    } catch (err) {
      return {
        models: [],
        defaultModel: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  /**
   * ai:chat — non-streaming one-shot call. Mirrors the Electron
   * docs-main.ts:2987 handler so the shell's quick-prompt path works
   * identically against the web build. The renderer ships `{settings, system,
   * user}`; we resolve the active provider, gate on API key + model, and
   * route through `chatForProvider` from `@genoffice/ai-provider` (same
   * call the Electron side uses — no duplicate logic).
   */
  registerHandle('ai:chat', async (_event: unknown, request: unknown) => {
    const req = request as AiChatRequest | undefined
    if (!req || typeof req.user !== 'string') {
      throw new InvalidArgumentError('ai:chat', 'expected { settings, system, user }')
    }
    const incoming = req.settings || aiSettings
    const provider = incoming.provider
    const config = resolveProviderConfig(incoming, provider)
    if (!config) {
      return {
        ok: false,
        error: `AI provider "${provider}" not configured`,
      } satisfies AiChatResponse
    }
    if (provider !== 'codex' && !config.apiKey) {
      return {
        ok: false,
        error:
          provider === 'genspark'
            ? 'Genspark account is not signed in. Sign in to use Genspark credits.'
            : `No API key configured for provider "${provider}". Open Settings → AI to add one.`,
      } satisfies AiChatResponse
    }
    if (provider !== 'codex' && !config.model) {
      return { ok: false, error: `No model selected for "${provider}".` } satisfies AiChatResponse
    }
    try {
      const result = await chatForProvider(
        provider,
        config as AiProviderConfig,
        req.system || '',
        req.user,
      )
      // Quota/credit exhaustion first: retrying cannot help, and a 429 whose
      // body also carries a quota notice must not be reported as a transient
      // capacity blip (that message tells the user to do the one thing that
      // will never work).
      if (!result.ok && isAiQuotaExhaustedError(result.error)) {
        return {
          ok: false,
          errorCode: 'credits',
          error: `${providerLabel(provider)} quota exhausted — top up or switch provider in Settings → AI.`,
        } satisfies AiChatResponse
      }
      if (!result.ok && isAiOverloadedError(result.error)) {
        return {
          ok: false,
          errorCode: 'overloaded',
          error: 'The AI service is busy right now. Please retry shortly.',
        } satisfies AiChatResponse
      }
      return result as AiChatResponse
    } catch (err) {
      if (isAiQuotaExhaustedError(err)) {
        return {
          ok: false,
          errorCode: 'credits',
          error: `${providerLabel(provider)} quota exhausted — top up or switch provider in Settings → AI.`,
        } satisfies AiChatResponse
      }
      if (isAiOverloadedError(err)) {
        return {
          ok: false,
          errorCode: 'overloaded',
          error: 'The AI service is busy right now. Please retry shortly.',
        } satisfies AiChatResponse
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies AiChatResponse
    }
  })

  /**
   * ai:translate — one-shot translate via the active provider. Reuses
   * `chatForProvider` with a hardened system prompt that forbids restyling.
   *
   * Input:  { instruction, sourceLang, targetLang, preserveFormat, range? }
   * Output: { ok, translated?, planId?, error? }
   *
   * Unlike the per-app skills (`ai:doc-write-*`, `ai:sheets-*`, `ai:slides-*`)
   * translate is real on the web build — the active LLM does the work.
   *
   * The `range` field is read straight off the request in the handler below;
   * the `castEditorRange` helper that used to sit here was dropped along with
   * the legacy code path when this handler was unified on the pi translate_text
   * tool.
   */
  // UNIFIED ON PI+SKILLS: the agent and the UI hit the same translate_text
  // tool. The pi session owns settings, KB, and memory; we just unwrap the
  // request, call the tool, and re-shape the result so existing callers
  // (chat panels, docs/sheets/slides renderers) keep their existing field
  // names without noticing the swap.
  registerHandle('ai:translate', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      instruction?: string
      sourceLang?: string
      targetLang?: string
      preserveFormat?: boolean
      range?: { from?: number; to?: number; scope?: string } | null
      memoryEnabled?: boolean
      qualityCheck?: boolean
      glossaryCategory?: string
      customerName?: string
      settings?: AiSettings
    }
    if (!req.targetLang) {
      return { ok: false, error: 'ai:translate expected non-empty `targetLang`' }
    }
    if (req.instruction !== undefined && typeof req.instruction !== 'string') {
      return { ok: false, error: 'ai:translate expected `instruction` to be a string' }
    }
    // glossaryCategory / customerName ride into the prompt and into the bucket
    // filter. They are typed as strings but arrive as anything the renderer
    // sent. Guard both here so `buildTranslateSystemPrompt` and `bucketFor`
    // never see a number or array.
    if (req.glossaryCategory !== undefined && typeof req.glossaryCategory !== 'string') {
      return { ok: false, error: 'ai:translate expected `glossaryCategory` to be a string' }
    }
    if (req.customerName !== undefined && typeof req.customerName !== 'string') {
      return { ok: false, error: 'ai:translate expected `customerName` to be a string' }
    }
    const result = (await callTranslateTool('translate_text', {
      text: req.instruction ?? '',
      source_lang: typeof req.sourceLang === 'string' ? req.sourceLang : undefined,
      target_lang: req.targetLang,
      // preserve_format is a boolean, not an instruction string. The
      // previous shape stuffed the literal "preserve_format" into
      // the instruction field, which the translate-skill tool
      // appended as "Style: preserve_format"; the model then echoed
      // it back in its reply and the UI displayed gibberish.
      ...(req.preserveFormat !== undefined ? { preserve_format: req.preserveFormat } : {}),
      ...(req.memoryEnabled !== undefined ? { memory_enabled: req.memoryEnabled } : {}),
      ...(req.qualityCheck !== undefined ? { quality_check: req.qualityCheck } : {}),
      ...(req.glossaryCategory !== undefined ? { glossary_category: req.glossaryCategory } : {}),
      ...(req.customerName !== undefined ? { customer_name: req.customerName } : {}),
    })) as { ok: boolean; details?: Record<string, unknown>; summary?: string; error?: string }
    // The pi tool saved this translation into the persistent TM, which only
    // marks the language pair dirty, so a flush has to be scheduled. It ran
    // only on the success path, which meant a provider failure discarded the
    // memory writes the tool had already made for this call. `scheduleMemoryFlush`
    // is a no-op when nothing is dirty.
    scheduleMemoryFlush()
    if (!result.ok) {
      return { ok: false, error: result.error ?? result.summary ?? 'translate_text failed' }
    }
    const d = result.details ?? {}
    return {
      ok: true,
      translated: (d.translated as string) ?? '',
      status: d.status,
      matchedTerms: (d.matchedTerms as string[]) ?? [],
      warnings: (d.warnings as string[]) ?? [],
      elapsedMs: d.elapsedMs,
    }
  })

  // UNIFIED ON PI+SKILLS: translate_batch has no dedicated pi tool, so we
  // fan the units out through the live translate_text tool. KB + memory +
  // settings stay single-source-of-truth inside the pi session; the loop
  // just unwraps the batch shape and re-wraps the per-unit results.
  registerHandle('ai:translate-batch', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      units?: Array<{
        unitId?: string
        kind?: string
        sourceText?: string
        order?: number
        path?: string
        metadata?: Record<string, unknown>
        range?: { from?: number; to?: number; scope?: string } | null
      }>
      sourceLang?: string
      sourceLanguage?: string
      targetLang?: string
      preserveFormat?: boolean
      scene?: string
      memoryEnabled?: boolean
      qualityCheck?: boolean
      glossaryCategory?: string
      customerName?: string
    }
    // Accept the alias the HTTP transport sends — `sourceLanguage` matches the
    // legacy IPC schema and the docs renderer sends it on the bridge path.
    if (req.sourceLang === undefined && req.sourceLanguage !== undefined) {
      req.sourceLang = req.sourceLanguage
    }
    // `units` is the whole request body, so a caller that sent an object (or a
    // string, or null) used to reach `units.length` and throw a TypeError that
    // the transport reported as a server fault.
    if (req.units !== undefined && !Array.isArray(req.units)) {
      return {
        ok: false,
        error: 'ai:translate-batch expected `units` to be an array',
        units: [],
      }
    }
    // The element-shape guard lives in the core layer (`malformedUnitResult`)
    // so the desktop handler gets it too; the web handler only has to keep the
    // `units` field the renderer iterates present on every failure path.
    const units = req.units ?? []
    const targetLang = req.targetLang ?? ''
    if (!targetLang) {
      return { ok: false, error: 'ai:translate-batch expected non-empty `targetLang`', units: [] }
    }
    // The shape guards below mirror the IPC handler in docs-main.ts. They
    // used to fall through into `buildTranslateSystemPrompt` and answer 500
    // with `(opts.glossaryCategory).trim is not a function` (or the prompt
    // itself was built with `Translation rules (auto -> 5)`).
    if (req.glossaryCategory !== undefined && typeof req.glossaryCategory !== 'string') {
      return {
        ok: false,
        error: 'ai:translate-batch expected `glossaryCategory` to be a string',
        units,
      }
    }
    if (req.customerName !== undefined && typeof req.customerName !== 'string') {
      return {
        ok: false,
        error: 'ai:translate-batch expected `customerName` to be a string',
        units,
      }
    }
    // The translate-skill `translate_text` pi tool is single-text, so this
    // handler fans the units out through it with the same per-unit options the
    // desktop `translateBatchCore` flow uses (preserveFormat / memoryEnabled /
    // qualityCheck / glossaryCategory / scene). Dropping them silently
    // diverged the web build from the desktop build: a renderer that passed
    // `glossaryCategory: 'KERRITS'` had it ignored here, so the customer
    // bucket never narrowed the KB.
    //
    // Concurrency is bounded: a 500-segment document used to open 500
    // simultaneous provider requests from one click, which trips per-minute
    // rate limits and makes every request slower than running them in waves.
    // The desktop core settles batches 25 at a time; match it.
    const CONCURRENCY = 25
    const settled: Array<{
      ok: boolean
      unitId: string
      sourceText: string
      translatedText: string
      status?: 'translated' | 'memory-hit' | 'failed'
      matchedTerms: string[]
      warnings: string[]
      errorMessage?: string
      range: { from?: number; to?: number; scope?: string } | null
    }> = new Array(units.length)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++
        // `units` is untyped JSON off the wire, so an element can be null —
        // and `return`ing on one left a hole in `settled`. Sparse
        // `Array.prototype.every` skips holes (the batch reported `ok: true`
        // over an untranslated segment) and `Array.prototype.find` on one
        // threw "Cannot read properties of undefined (reading 'ok')", which
        // the transport answered as a 500.
        const u = units[index] as (typeof units)[number] | null | undefined
        if (index >= units.length) return
        // `typeof null` is 'object', so a null element needs its own check.
        if (!u || typeof u !== 'object') {
          settled[index] = {
            ok: false,
            unitId: '',
            sourceText: '',
            translatedText: '',
            status: 'failed',
            matchedTerms: [],
            warnings: ['malformed-unit'],
            errorMessage: `ai:translate-batch expected unit ${index} to be an object`,
            range: null,
          }
          continue
        }
        // A unit that already failed shape-wise (no text) is reported rather
        // than sent: the provider cannot translate an empty segment, and one
        // empty unit must not fail the rest of the document.
        const sourceText = typeof u.sourceText === 'string' ? u.sourceText : ''
        if (!sourceText.trim()) {
          settled[index] = {
            ok: false,
            unitId: typeof u.unitId === 'string' ? u.unitId : '',
            sourceText,
            translatedText: '',
            status: 'failed',
            matchedTerms: [],
            warnings: [typeof u.sourceText === 'string' ? 'empty-source' : 'malformed-unit'],
            errorMessage:
              typeof u.sourceText === 'string'
                ? 'empty source text'
                : `ai:translate-batch expected unit ${index} \`sourceText\` to be a string`,
            range: u.range ?? null,
          }
          continue
        }
        // Memory check first: ai:save-translation-memory writes to this very
        // TM instance (chat.ts), so the lookup has to run against the same
        // one. Calling translate_text instead would route through the pi
        // session's own memory — a different object — and a customer save
        // would silently fall through to the model for the next read.
        if (req.memoryEnabled !== false) {
          await ensureMemoryLoaded()
          const batchBucket = normalizeBucket(req.glossaryCategory, req.customerName)
          // `sourceLanguage` is the wire-alias the HTTP transport sends;
          // `sourceLang` is what the IPC schema has always used. The alias
          // gets normalised to `req.sourceLang` earlier, so reading the
          // canonical field is enough here.
          const hit = translationMemory.lookup(
            req.sourceLang ?? 'auto',
            targetLang,
            sourceText,
            batchBucket,
          )
          if (hit) {
            settled[index] = {
              ok: true,
              unitId: typeof u.unitId === 'string' ? u.unitId : '',
              sourceText,
              translatedText: hit.translatedText,
              status: 'memory-hit',
              matchedTerms: [],
              warnings: [],
              range: u.range ?? null,
            }
            continue
          }
        }
        const result = (await callTranslateTool('translate_text', {
          text: sourceText,
          // src/type guards above already narrowed this to a string, but the
          // forward has to keep the `undefined`-when-missing shape so the
          // pi tool falls back to its own `auto` default.
          source_lang: req.sourceLanguage,
          target_lang: targetLang,
          ...(req.preserveFormat !== undefined ? { preserve_format: req.preserveFormat } : {}),
          ...(req.memoryEnabled !== undefined ? { memory_enabled: req.memoryEnabled } : {}),
          ...(req.qualityCheck !== undefined ? { quality_check: req.qualityCheck } : {}),
          // glossaryCategory and customerName are separate concepts on the
          // wire, but the KB terms carry both a `category` and a
          // `customerName`. Forward each under its own name and let the
          // resolver match either; a renderer that only knows the customer
          // name still gets the right narrowing.
          ...(req.glossaryCategory !== undefined ? { glossary_category: req.glossaryCategory } : {}),
          ...(req.glossaryCategory === undefined && req.customerName !== undefined
            ? { glossary_category: req.customerName }
            : {}),
          ...(req.customerName !== undefined ? { customer_name: req.customerName } : {}),
          ...(req.scene !== undefined ? { scene: req.scene } : {}),
        })) as { ok: boolean; details?: Record<string, unknown>; error?: string; summary?: string }
        const d = result.details ?? {}
        const translatedText = (d.translated as string) ?? ''
        const status = (d.status as 'translated' | 'memory-hit' | 'failed' | undefined) ??
          (result.ok ? 'translated' : 'failed')
        // The desktop contract carries `status` / `sourceText` / `range` on
        // every unit, and the docs renderer filters `status === 'translated'
        // || 'memory-hit'` before deciding a document pass produced anything.
        // This handler used to omit all three, so a perfectly translated
        // document was declared "no usable units" and the panel showed an
        // empty result over a working translation.
        settled[index] = {
          ok: result.ok && status !== 'failed',
          unitId: typeof u.unitId === 'string' ? u.unitId : '',
          sourceText,
          translatedText,
          status,
          matchedTerms: (d.matchedTerms as string[]) ?? [],
          warnings: (d.warnings as string[]) ?? [],
          ...(result.ok && status !== 'failed'
            ? {}
            : { errorMessage: result.error ?? result.summary ?? 'translation failed' }),
          range: u.range ?? null,
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(CONCURRENCY, units.length)) }, () => worker()),
    )

    const allOk = settled.every((unit) => unit.ok)
    // A failed batch used to answer `{ ok: false, units: [...] }` with no
    // top-level reason: the per-unit `errorMessage` was the only place the
    // provider message lived, and the docs/sheets bridges that read
    // `response.error` showed an empty failure banner. Mirror the first
    // unit's message so both shapes carry the reason.
    const firstFailure = settled.find((unit) => !unit.ok && unit.errorMessage)
    // Quality is computed here, not asked of the model: the renderer shows the
    // score next to the document and used to receive `quality: undefined` on
    // this path while the desktop build reported a real number.
    const quality =
      req.qualityCheck === false || settled.length === 0
        ? undefined
        : assessBatchQuality(
            settled.map((unit) => ({
              sourceText: unit.sourceText,
              translatedText: unit.translatedText,
              warnings: unit.warnings,
            })),
          )
    scheduleMemoryFlush()
    return {
      ok: allOk,
      units: settled,
      ...(quality ? { quality } : {}),
      ...(firstFailure ? { error: firstFailure.errorMessage } : {}),
    }
  })

  registerHandle('ai:save-translation-memory', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      scene?: string
      sourceLang?: string
      targetLang?: string
      /** Glossary / customer scope the translations were produced under. */
      bucket?: string
      glossaryCategory?: string
      customerName?: string
      units?: Array<{ unitId?: string; sourceText?: string; translatedText?: string }>
    }
    if (req.units !== undefined && !Array.isArray(req.units)) {
      return { ok: false, savedCount: 0, skippedCount: 0, error: 'units must be an array' }
    }
    // A null element used to be dereferenced and threw out of the handler.
    // Elements that survive but carry no usable text are passed through so
    // `saveMany` counts them as skipped — dropping them here would report
    // "saved 1" for a batch of three and hide the two malformed ones.
    const units = (req.units ?? [])
      .filter((u): u is Record<string, unknown> => Boolean(u) && typeof u === 'object')
      .map((u) => ({
        unitId: typeof u.unitId === 'string' ? u.unitId : '',
        sourceText: typeof u.sourceText === 'string' ? u.sourceText : '',
        translatedText: typeof u.translatedText === 'string' ? u.translatedText : '',
      }))
    // Elements rejected before they reached `saveMany` still have to be
    // reported, or the counts silently disagree with what the caller sent.
    const rejected = (req.units?.length ?? 0) - units.length
    // glossaryCategory / customerName become the bucket. All three arrive
    // straight off the wire, but `bucketFor` / `bucket.trim` are not safe on
    // a number or array — guard each before falling through to the next.
    if (req.bucket !== undefined && typeof req.bucket !== 'string') {
      return { ok: false, savedCount: 0, skippedCount: rejected, error: 'bucket must be a string' }
    }
    if (req.glossaryCategory !== undefined && typeof req.glossaryCategory !== 'string') {
      return { ok: false, savedCount: 0, skippedCount: rejected, error: 'glossaryCategory must be a string' }
    }
    if (req.customerName !== undefined && typeof req.customerName !== 'string') {
      return { ok: false, savedCount: 0, skippedCount: rejected, error: 'customerName must be a string' }
    }
    await ensureMemoryLoaded()
    const bucket = req.bucket ?? req.glossaryCategory ?? req.customerName
    const response = translationMemory.saveMany({
      scene: req.scene ?? 'office',
      sourceLang: req.sourceLang ?? 'auto',
      targetLang: req.targetLang ?? 'auto',
      ...(bucket !== undefined ? { bucket } : {}),
      units,
    })
    await translationMemory.flush()
    return rejected > 0
      ? { ...response, skippedCount: response.skippedCount + rejected }
      : response
  })

  // home:translate-snippet — quick text-paste translation for the Settings pane.
  // Wraps translateOne with a string input instead of an editor range, and
  // forwards the customer's translation memory so memory-hit responses are
  // surfaced to the UI for the "saved N ms · cache" badge.
  // UNIFIED ON PI+SKILLS: home:translate-snippet now routes through the
  // live translate_text pi tool. The dictionary-passing semantics are kept:
  // callers can hand us a dictionaryPath and we still honour it (we just
  // cannot pre-load its terms inside the snippet call the way the legacy
  // path did, since the pi tool owns its own memory + KB; for that the
  // caller should rely on KB upserts upstream). The shape is preserved so
  // the UI snippet pane keeps working without changes.
  registerHandle('home:translate-snippet', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      text?: string
      sourceLang?: string
      targetLang?: string
      customerName?: string
      /** Filter KB entries by category; mirrors the desktop app's glossaryCategory handling. */
      glossaryCategory?: string
      dictionaryPath?: string
      useDictionary?: boolean
      settings?: AiSettings
    }
    // Every string-typed field arrives straight off the wire. A number or
    // array on `.trim()`-using paths used to throw out of the handler and
    // answer 500; guard up front so the caller sees the shape error it
    // actually sent.
    if (req.text !== undefined && typeof req.text !== 'string') {
      return { ok: false, error: 'home:translate-snippet expected `text` to be a string' }
    }
    if (req.targetLang !== undefined && typeof req.targetLang !== 'string') {
      return { ok: false, error: 'home:translate-snippet expected `targetLang` to be a string' }
    }
    if (req.sourceLang !== undefined && typeof req.sourceLang !== 'string') {
      return { ok: false, error: 'home:translate-snippet expected `sourceLang` to be a string' }
    }
    if (req.customerName !== undefined && typeof req.customerName !== 'string') {
      return { ok: false, error: 'home:translate-snippet expected `customerName` to be a string' }
    }
    if (req.glossaryCategory !== undefined && typeof req.glossaryCategory !== 'string') {
      return { ok: false, error: 'home:translate-snippet expected `glossaryCategory` to be a string' }
    }
    if (req.dictionaryPath !== undefined && typeof req.dictionaryPath !== 'string') {
      return { ok: false, error: 'home:translate-snippet expected `dictionaryPath` to be a string' }
    }
    const text = (req.text ?? '').trim()
    if (!text) return { ok: false, error: 'home:translate-snippet expected non-empty `text`' }
    if (!req.targetLang) {
      return { ok: false, error: 'home:translate-snippet expected non-empty `targetLang`' }
    }
    // The bucket the caller is translating for. A dictionary is only valid
    // within the bucket it was built for; an implicit reuse across buckets is
    // refused rather than silently applying another customer's wording.
    const snippetBucket = dictionaryBucket(req.glossaryCategory, req.customerName)
    const dictionary =
      req.useDictionary === false
        ? null
        : req.dictionaryPath
          ? loadDictionary(req.dictionaryPath, snippetBucket)
          : lastDictionary && lastDictionary.bucket === snippetBucket
            ? lastDictionary
            : null
    const dictionaryPairs = dictionary?.pairs ?? []
    const dictionarySources = new Set(dictionaryPairs.map((pair) => pair.source))

    const started = Date.now()
    // The dictionary has to reach the model as an instruction, not only as a
    // post-hoc rewrite: a term the model never sees is a term it will happily
    // translate its own way, and the enforcement pass then has to repair the
    // sentence instead of the model getting it right the first time. The pi
    // tool layers these pairs on top of the KB for the prompt, for
    // `matchedTerms`, and for output enforcement.
    // `customerName` is the customer's display name (e.g. "KERRITS"); it maps
    // to the KB's `glossaryCategory` filter so per-customer terminology is
    // applied. The previous web build stuffed it into `instruction`, which
    // the translate-skill tool appended as the literal "Style: customer=KERRITS"
    // to the source — wrong text, and zero KB narrowing. The Electron app
    // already does the right thing; this branch now matches it.
    const result = (await callTranslateTool('translate_text', {
      text,
      source_lang: req.sourceLang,
      target_lang: req.targetLang,
      ...(req.customerName || req.glossaryCategory
        ? { glossary_category: req.glossaryCategory ?? req.customerName }
        : {}),
      ...(req.customerName !== undefined ? { customer_name: req.customerName } : {}),
      ...(dictionaryPairs.length > 0 ? { dictionary: dictionaryPairs } : {}),
    })) as { ok: boolean; details?: Record<string, unknown>; error?: string; summary?: string }
    if (!result.ok) {
      return {
        ok: false,
        translation: '',
        status: 'failed',
        matchedTerms: [],
        dictionaryHits: [],
        dictionary: null,
        sourceLang: req.sourceLang,
        targetLang: req.targetLang,
        elapsedMs: Date.now() - started,
        error: result.error ?? result.summary ?? 'translate_text failed',
      }
    }
    const d = result.details ?? {}
    const allTerms = (d.matchedTerms as string[]) ?? []
    const dictionaryHits = allTerms.filter((term) => dictionarySources.has(term))
    const kbTerms = allTerms.filter((term) => !dictionarySources.has(term))
    return {
      ok: true,
      translation: (d.translated as string) ?? '',
      status: d.status,
      matchedTerms: kbTerms,
      dictionaryHits,
      dictionary: dictionary
        ? { path: dictionary.path, terms: dictionaryPairs.length, hits: dictionaryHits.length }
        : null,
      sourceLang: req.sourceLang,
      targetLang: req.targetLang,
      elapsedMs: Date.now() - started,
    }
  })
  // UNIFIED ON PI+SKILLS: ai:translate-build-dictionary is now a thin
  // passthrough to the build_dictionary pi tool. The KB lives inside the
  // pi session, so we no longer pre-load it here. The tool returns the
  // same shape the legacy handler did (`dictionaryPath`, `kbEntries`,
  // `llmEntries`, etc.) so existing renderer code keeps working.
  registerHandle('ai:translate-build-dictionary', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      inputPath?: string
      sourceLang?: string
      targetLang?: string
      outputPath?: string
      maxSegments?: number
      minChars?: number
      customerName?: string
      glossaryCategory?: string
      useLlm?: boolean
      settings?: AiSettings
    }
    // All string-typed fields arrive straight off the wire; guard each before
    // falling through so `truthy-non-string` values like `42` cannot crash
    // the downstream tool with `.trim is not a function`.
    if (req.inputPath !== undefined && typeof req.inputPath !== 'string') {
      return { ok: false, error: 'ai:translate-build-dictionary expected `inputPath` to be a string' }
    }
    if (req.targetLang !== undefined && typeof req.targetLang !== 'string') {
      return { ok: false, error: 'ai:translate-build-dictionary expected `targetLang` to be a string' }
    }
    if (req.sourceLang !== undefined && typeof req.sourceLang !== 'string') {
      return { ok: false, error: 'ai:translate-build-dictionary expected `sourceLang` to be a string' }
    }
    if (req.outputPath !== undefined && typeof req.outputPath !== 'string') {
      return { ok: false, error: 'ai:translate-build-dictionary expected `outputPath` to be a string' }
    }
    if (req.glossaryCategory !== undefined && typeof req.glossaryCategory !== 'string') {
      return { ok: false, error: 'ai:translate-build-dictionary expected `glossaryCategory` to be a string' }
    }
    if (req.customerName !== undefined && typeof req.customerName !== 'string') {
      return { ok: false, error: 'ai:translate-build-dictionary expected `customerName` to be a string' }
    }
    if (!req.inputPath) {
      return { ok: false, error: 'ai:translate-build-dictionary expected a non-empty `inputPath`' }
    }
    if (!req.targetLang) {
      return { ok: false, error: 'ai:translate-build-dictionary expected a non-empty `targetLang`' }
    }
    const result = (await callTranslateTool('build_dictionary', {
      input_path: req.inputPath,
      ...(req.sourceLang !== undefined ? { source_lang: req.sourceLang } : {}),
      target_lang: req.targetLang,
      ...(req.outputPath !== undefined ? { output_path: req.outputPath } : {}),
      ...(req.maxSegments !== undefined ? { max_pairs: req.maxSegments } : {}),
      ...(req.minChars !== undefined ? { min_chars: req.minChars } : {}),
      ...(req.customerName !== undefined ? { customer_name: req.customerName } : {}),
      ...(req.glossaryCategory !== undefined ? { glossary_category: req.glossaryCategory } : {}),
      ...(req.useLlm !== undefined ? { use_llm: req.useLlm } : {}),
    })) as { ok: boolean; details?: Record<string, unknown>; summary?: string; error?: string }
    if (!result.ok) {
      return { ok: false, error: result.error ?? result.summary ?? 'build_dictionary failed' }
    }
    const d = result.details ?? {}
    // The pi tool runs the same `buildDictionary` the legacy handler did, so it
    // reports the mining + coverage stats verbatim. Re-shape to the legacy
    // BuildDictionaryResult field names the renderer already reads.
    const built = {
      ok: true,
      dictionaryPath: (d.dictionaryPath as string) ?? (d.outputPath as string) ?? '',
      kbEntries: (d.kbEntries as number) ?? 0,
      llmEntries: (d.llmEntries as number) ?? 0,
      missed: (d.missed as string[]) ?? [],
      warnings: (d.warnings as string[]) ?? [],
      totalSegments: (d.totalSegments as number) ?? 0,
      coverage: d.coverage as BuildDictionaryResult['coverage'],
      segments: [] as BuildDictionaryResult['segments'],
    }
    // Cache the pairs so a following snippet / file call reuses the same
    // terminology without a redundant disk read. The bucket travels with it
    // so the snippet path can tell whose dictionary this is.
    rememberBuiltDictionary(built, dictionaryBucket(req.glossaryCategory, req.customerName))
    return built
  })
  // user can review or hand-edit a dictionary before spending the file pass.
  // UNIFIED ON PI+SKILLS: the agent and the UI hit the same translate_file
  // tool. The pi session owns settings, KB, and memory; the tool itself
  // now also handles the buildDictionary / assessFileCoverage flow when
  // the caller did not pass a dictionaryPath. We only need to validate the
  // request shape and re-shape the tool's details back to the legacy
  // TranslateFileAutoResult so existing renderer code keeps working.
  registerHandle('ai:translate-file-auto', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      inputPath?: string
      outputPath?: string
      sourceLang?: string
      targetLang?: string
      customerName?: string
      glossaryCategory?: string
      scale?: number
      timeoutMs?: number
      dictionaryPath?: string
      settings?: AiSettings
    }
    if (!req.inputPath) {
      return { ok: false, error: 'ai:translate-file-auto expected a non-empty `inputPath`' }
    }
    if (!req.targetLang) {
      return { ok: false, error: 'ai:translate-file-auto expected a non-empty `targetLang`' }
    }
    if (!isSupportedExtension(req.inputPath)) {
      return {
        ok: false,
        error: `Unsupported file type; expected one of ${SUPPORTED_EXTENSIONS.join(', ')}`,
      }
    }
    const location = resolveTranslateSkills()
    const result = (await callTranslateTool('translate_file', {
      input_path: req.inputPath,
      ...(req.outputPath !== undefined ? { output_path: req.outputPath } : {}),
      ...(req.sourceLang !== undefined ? { source_lang: req.sourceLang } : {}),
      target_lang: req.targetLang,
      ...(req.dictionaryPath !== undefined ? { dictionary_path: req.dictionaryPath } : {}),
      ...(req.scale !== undefined ? { scale: req.scale } : {}),
      ...(req.timeoutMs !== undefined ? { timeout_ms: req.timeoutMs } : {}),
      // The handler advertised customerName / glossaryCategory but never
      // forwarded them, so `translate_file` built one unscoped dictionary
      // per file and applied every customer's KB terms to it. Forward both;
      // the pi tool unifies them at the resolver.
      ...(req.customerName !== undefined ? { customer_name: req.customerName } : {}),
      ...(req.glossaryCategory !== undefined ? { glossary_category: req.glossaryCategory } : {}),
      python_path: location.pythonPath,
      execute: true,
    })) as {
      ok: boolean
      details?: Record<string, unknown>
      summary?: string
      error?: string
    }
    if (!result.ok) {
      const d = result.details ?? {}
      return {
        ok: false,
        error: (d.error as string) ?? result.error ?? result.summary ?? 'translate_file failed',
        stage: (d.stage as string) ?? 'translate',
        dictionaryPath: (d.dictionaryPath as string) ?? undefined,
        coverage: (d.coverage as Record<string, unknown>) ?? undefined,
      }
    }
    const d = result.details ?? {}
    return {
      ok: true,
      outputPath: (d.outputPath as string) ?? '',
      bytes: d.bytes as number | undefined,
      elapsedMs: d.elapsedMs as number | undefined,
      scriptPath: d.scriptPath as string | undefined,
      stdout: d.stdout as string | undefined,
      stderr: d.stderr as string | undefined,
      stage: (d.stage as string) ?? 'done',
      dictionaryPath: d.dictionaryPath as string | undefined,
      dictionaryReused: d.dictionaryReused as boolean | undefined,
      dictionary: d.dictionary as Record<string, unknown> | undefined,
      coverage: d.coverage as Record<string, unknown> | undefined,
    }
  })

  // ai:translate-fill-gaps — translate whatever the dictionary missed and write
  // an extended dictionary. This is the "fill in the values and re-run" step the
  // format handlers print, done by the model instead of by hand. Only the
  // uncovered segments are sent, so the cost is proportional to the gap.
  // UNIFIED ON PI+SKILLS: ai:translate-fill-gaps now routes through the
  // live fill_dictionary_gaps pi tool. Same shape returned, so the
  // "Fill in the empty values and re-run" UX keeps working.
  registerHandle('ai:translate-fill-gaps', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      inputPath?: string
      sourceLang?: string
      targetLang?: string
      dictionaryPath?: string
      outputPath?: string
      maxSegments?: number
      minChars?: number
      customerName?: string
      glossaryCategory?: string
      settings?: AiSettings
    }
    if (!req.inputPath) {
      return { ok: false, error: 'ai:translate-fill-gaps expected a non-empty `inputPath`' }
    }
    if (!req.targetLang) {
      return { ok: false, error: 'ai:translate-fill-gaps expected a non-empty `targetLang`' }
    }
    const dictionaryPath = req.dictionaryPath ?? lastDictionary?.path
    if (!dictionaryPath) {
      return {
        ok: false,
        error: 'ai:translate-fill-gaps found no dictionary to extend; build one first',
      }
    }
    const result = (await callTranslateTool('fill_dictionary_gaps', {
      input_path: req.inputPath,
      dictionary_path: dictionaryPath,
      target_lang: req.targetLang,
      ...(req.sourceLang !== undefined ? { source_lang: req.sourceLang } : {}),
      ...(req.outputPath !== undefined ? { output_path: req.outputPath } : {}),
      ...(req.maxSegments !== undefined ? { max_pairs: req.maxSegments } : {}),
      ...(req.minChars !== undefined ? { min_chars: req.minChars } : {}),
      ...(req.customerName !== undefined ? { customer_name: req.customerName } : {}),
      ...(req.glossaryCategory !== undefined ? { glossary_category: req.glossaryCategory } : {}),
    })) as { ok: boolean; details?: Record<string, unknown>; error?: string; summary?: string }
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? result.summary ?? 'fill_dictionary_gaps failed',
        dictionaryPath,
      }
    }
    const d = result.details ?? {}
    if (d.dictionaryPath && typeof d.dictionaryPath === 'string') {
      loadDictionary(d.dictionaryPath, dictionaryBucket(req.glossaryCategory, req.customerName))
    }
    return d
  })

  // ----- translation knowledge base CRUD --------------------------------------
  // Mirrors LumosAI's translate-config CLI: list / add / remove / save.
  // The UI (Settings -> AI -> Translation Knowledge) and the agent tools both
  // hit these handlers; the JSON file at ~/.genoffice/translation-kb.json is
  // the single source of truth.
  // ----- translation knowledge base CRUD --------------------------------------
  // UNIFIED ON PI+SKILLS: every KB mutation goes through the translate-skill
  // kb_* tools registered in the live pi session. The pi session is the
  // single source of truth — the agent and the UI hit the same execute()
  // body, the same KnowledgeBase instance, the same JSON file on disk.
  registerHandle('ai:translation-kb-list', async (_event: unknown, filters: unknown) => {
    const f = (filters ?? {}) as { schema?: string; limit?: number }
    const result = (await callTranslateTool('kb_list', {
      schema: f.schema,
      limit: f.limit,
    })) as {
      ok: boolean
      details?: { entries?: unknown[]; count?: number }
      summary?: string
      error?: string
    }
    if (!result.ok) {
      return { ok: false, entries: [], error: result.error ?? result.summary ?? 'kb_list failed' }
    }
    return { ok: true, entries: result.details?.entries ?? [] }
  })

  registerHandle('ai:translation-kb-upsert', async (_event: unknown, entry: unknown) => {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'ai:translation-kb-upsert expected a KB entry object' }
    }
    const candidate = entry as Record<string, unknown>
    if (!candidate.id || typeof candidate.id !== 'string') {
      return { ok: false, error: 'KB entry must include a string `id`' }
    }
    const result = (await callTranslateTool('kb_upsert', { entry: candidate })) as {
      ok: boolean
      details?: { id?: string }
      summary?: string
      error?: string
    }
    if (!result.ok) {
      return { ok: false, error: result.error ?? result.summary ?? 'kb_upsert failed' }
    }
    return { ok: true, entry: candidate, id: result.details?.id }
  })

  registerHandle('ai:translation-kb-remove', async (_event: unknown, id: unknown) => {
    const targetId = String(id ?? '').trim()
    if (!targetId) return { ok: false, error: 'ai:translation-kb-remove expected a non-empty id' }
    const result = (await callTranslateTool('kb_remove', { id: targetId })) as {
      ok: boolean
      details?: { removed?: boolean }
      summary?: string
      error?: string
    }
    if (!result.ok) {
      return {
        ok: false,
        removed: false,
        error: result.error ?? result.summary ?? 'kb_remove failed',
      }
    }
    return { ok: true, removed: result.details?.removed ?? false }
  })

  registerHandle('ai:translation-kb-resolve', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      sourceLang?: string
      targetLang?: string
      category?: string
      customerName?: string
    }
    // A non-string here used to fall through `resolve()` into the rendered
    // prompt block as `Translation rules (auto -> 5)` — a request whose own
    // language field was never a language. Reject the shape.
    if (typeof req.targetLang !== 'string' || !req.targetLang.trim()) {
      return { ok: false, error: 'ai:translation-kb-resolve expected non-empty `targetLang`' }
    }
    // Match the legacy sharedKnowledgeBase.resolve() response shape so the
    // TranslationKbPane (and the existing tests) keep working: {terms,
    // promptBlock, ...stats}.
    //
    // This used to re-implement the filter inline and got it wrong in two
    // ways that the pi session's own resolver does not: an entry declaring
    // no bucket (generic) was dropped as soon as the caller named a
    // category, and an entry that buckets by `customerName` was invisible to
    // a caller that only sent `category`. A caller could therefore preview a
    // term set that did not match what the translator would actually apply.
    // Delegate to the same resolver so both paths agree by construction.
    // Re-read from disk rather than trusting the memoised boot-time load:
    // every mutation goes through the pi session's own KnowledgeBase instance
    // (`kb_upsert` → `kb.save()`), so this instance is stale the moment the
    // user adds a term. Without the reload the pane previews a term set that
    // no longer matches the file.
    await ensureKbLoaded()
    // Re-read rather than trusting the memoised boot-time load: mutations go
    // through the pi session's own `KnowledgeBase` instance (`kb_upsert` →
    // `kb.save()`), so this instance is stale the moment the user adds a term.
    // `refresh()` short-circuits on unchanged bytes and keeps the previous
    // store if the file is unreadable.
    await sharedKnowledgeBase.refresh().catch(() => false)
    const sourceLang = req.sourceLang ?? 'auto'
    const resolved = sharedKnowledgeBase.resolve({
      sourceLang,
      targetLang: req.targetLang,
      ...(req.category !== undefined ? { category: req.category } : {}),
      ...(req.customerName !== undefined ? { customerName: req.customerName } : {}),
    })
    // SAFETY: `resolved.terms` is the knowledge base's domain-typed term list;
    // this cast only widens it to plain JSON records so the IPC transport can
    // serialize it. No field is added or dropped and the value is never written
    // back into the knowledge base.
    const terms = resolved.terms as unknown as Array<Record<string, unknown>>
    const termPairs = resolved.terms
      .filter((e) => e.sourceTerm && e.targetTerm)
      .map((e) => `${e.sourceTerm} → ${e.targetTerm}`)
    const promptBlock =
      resolved.promptBlock ||
      (termPairs.length > 0 ? `Use these preferred terms:\n${termPairs.join('\n')}` : '')
    return {
      ok: true,
      terms,
      promptBlock,
      forbidden: resolved.forbidden,
      brands: resolved.brands,
      styleRules: resolved.styleRules,
      customerPreferences: resolved.customerPreferences,
      total: sharedKnowledgeBase.list().length,
      matched: terms.length,
    }
  })

  registerHandle('ai:translation-kb-stats', async () => {
    // Pull a full inventory from the pi session, then bucket by schema.
    // The pi session's kb_list is the single source of truth — the same
    // store the agent and the UI mutate.
    const result = (await callTranslateTool('kb_list', { limit: 1000 })) as {
      ok: boolean
      details?: { entries?: unknown[]; count?: number }
      error?: string
      summary?: string
    }
    if (!result.ok) {
      return {
        ok: false,
        total: 0,
        bySchema: {},
        error: result.error ?? result.summary ?? 'kb_list failed',
      }
    }
    const all = (result.details?.entries ?? []) as Array<Record<string, unknown>>
    const bySchema: Record<string, number> = {}
    for (const entry of all) {
      const key =
        'sourceTerm' in entry && 'targetTerm' in entry
          ? 'term'
          : 'forbiddenText' in entry
            ? 'forbidden'
            : 'policy' in entry
              ? 'brand'
              : 'description' in entry && 'name' in entry
                ? 'styleRule'
                : 'customerPreference'
      bySchema[key] = (bySchema[key] ?? 0) + 1
    }
    return { ok: true, total: all.length, bySchema }
  })

  // ----- whole-file translation (PDF / XLS(X) / PPTX / DOCX) ----------------
  // Delegates to the upstream LumosAI `translate.py`, which dispatches by
  // extension. The dictionary is built by the caller (typically from the KB +
  // an LLM extraction pass) and passed as a path; without one the script is a
  // no-op reformatter, which is why we surface that in the result rather than
  // pretending the file was translated.
  // UNIFIED ON PI+SKILLS: ai:translate-file is the rerun path — caller
  // already built a dictionary. The new translate_file pi tool handles
  // this case natively (dictionaryReused=true, no second build).
  registerHandle('ai:translate-file', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as {
      inputPath?: string
      outputPath?: string
      dictionaryPath?: string
      scale?: number
      timeoutMs?: number
    }
    if (!req.inputPath) {
      return { ok: false, error: 'ai:translate-file expected a non-empty `inputPath`' }
    }
    if (!isSupportedExtension(req.inputPath)) {
      return {
        ok: false,
        error: `Unsupported file type; expected one of ${SUPPORTED_EXTENSIONS.join(', ')}`,
      }
    }
    if (!req.dictionaryPath) {
      return {
        ok: false,
        error:
          'ai:translate-file needs an existing dictionary (use ai:translate-build-dictionary first)',
      }
    }
    const location2 = resolveTranslateSkills()
    const result = (await callTranslateTool('translate_file', {
      input_path: req.inputPath,
      ...(req.outputPath !== undefined ? { output_path: req.outputPath } : {}),
      dictionary_path: req.dictionaryPath,
      ...(req.scale !== undefined ? { scale: req.scale } : {}),
      // The rerun path takes a `timeoutMs` and never forwarded it, so a large
      // PDF that legitimately needs longer than the tool's default was killed
      // mid-render and reported as a translation failure.
      ...(req.timeoutMs !== undefined ? { timeout_ms: req.timeoutMs } : {}),
      python_path: location2.pythonPath,
      execute: true,
    })) as { ok: boolean; details?: Record<string, unknown>; error?: string }
    if (!result.ok) {
      return {
        ok: false,
        error: (result.details?.error as string) ?? result.error ?? 'translate_file failed',
      }
    }
    return {
      ok: true,
      outputPath: result.details?.outputPath as string | undefined,
      bytes: result.details?.bytes as number | undefined,
      elapsedMs: result.details?.elapsedMs as number | undefined,
      scriptPath: result.details?.scriptPath as string | undefined,
      stdout: result.details?.stdout as string | undefined,
      stderr: result.details?.stderr as string | undefined,
      stage: 'done',
      dictionaryPath: result.details?.dictionaryPath as string | undefined,
      dictionaryReused: true,
      coverage: result.details?.coverage as Record<string, unknown> | undefined,
    }
  })

  // ai:translate-dictionary-status — which dictionary snippet translation will
  // reuse. Without this the pane would show a bare "reuse dictionary" checkbox
  // and the user could not tell which file it refers to.
  registerHandle('ai:translate-dictionary-status', () => ({
    ok: true,
    dictionary: lastDictionary
      ? {
          path: lastDictionary.path,
          terms: lastDictionary.pairs.length,
          // Surface the bucket so the pane can say *whose* terminology the
          // reusable dictionary carries; without it a KERRITS dictionary and
          // an ACME one were indistinguishable.
          ...(lastDictionary.bucket ? { bucket: lastDictionary.bucket } : {}),
        }
      : null,
  }))

  registerHandle('ai:translate-file-status', () => {
    const location = resolveTranslateSkills()
    return {
      ok: true,
      available: location.source !== 'missing',
      source: location.source,
      skillDir: location.skillDir,
      pythonPath: location.pythonPath,
      supportedExtensions: [...SUPPORTED_EXTENSIONS],
    }
  })

  registerHandle('ai:translate-file-output-path', (_event: unknown, inputPath: unknown) => {
    // `String(inputPath)` turned a number into "123" and a boolean into
    // "true", then answered `ok: true` with "123_translated" — a path the
    // caller passes straight to the translator. Only a string names a file.
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
      return { ok: false, error: 'expected a non-empty inputPath' }
    }
    return { ok: true, outputPath: defaultOutputPath(inputPath) }
  })

  registerHandle('ai:web-search', async (_event: unknown, query: unknown) => {
    // Zero-config web search via DuckDuckGo HTML. Same parser the agent uses,
    // so the UI sees the same hits the agent does. If the network is blocked
    // (e.g. inside an air-gapped corp firewall) we surface the error so the
    // UI can show "search unavailable" instead of silently returning nothing.
    const q = String(query ?? '').trim()
    if (q.length < 2) {
      return { query: q, results: [], error: 'query must be at least 2 characters' }
    }
    const started = Date.now()
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=us-en`
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      if (!response.ok) {
        return {
          query: q,
          results: [],
          error: `DuckDuckGo HTTP ${response.status} ${response.statusText}`,
        }
      }
      const html = await response.text()
      const hits = parseDuckDuckGo(html, 8)
      return {
        query: q,
        results: hits,
        source: 'duckduckgo',
        ms: Date.now() - started,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { query: q, results: [], error: `DuckDuckGo unreachable: ${message}` }
    }
  })

  registerHandle('ai:image-search', async (_event: unknown, query: unknown) => {
    // Zero-config image search via DuckDuckGo's image endpoint. Same parser
    // the agent uses; works without any API key.
    const q = String(query ?? '').trim()
    if (q.length < 2) {
      return { query: q, results: [], error: 'query must be at least 2 characters' }
    }
    const started = Date.now()
    try {
      const url = `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
          Accept: 'text/html',
        },
      })
      if (!response.ok) {
        return {
          query: q,
          results: [],
          error: `DuckDuckGo HTTP ${response.status} ${response.statusText}`,
        }
      }
      const html = await response.text()
      const hits = parseDuckDuckGoImages(html, 8)
      return {
        query: q,
        results: hits,
        source: 'duckduckgo',
        ms: Date.now() - started,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { query: q, results: [], error: `DuckDuckGo unreachable: ${message}` }
    }
  })

  registerHandle('ai:fetch-image', async (_event: unknown, url: unknown) => {
    if (typeof url !== 'string' || url.length > 4096) return null
    try {
      const response = await fetchRemoteImage(url)
      if (!response?.ok || !response.body) return null
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > 20 * 1024 * 1024) return null
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        total += part.value.byteLength
        if (total > 20 * 1024 * 1024) {
          await reader.cancel()
          return null
        }
        chunks.push(Buffer.from(part.value))
      }
      const contentType = response.headers.get('content-type') ?? ''
      const mime = contentType.includes('png')
        ? 'image/png'
        : contentType.includes('gif')
          ? 'image/gif'
          : 'image/jpeg'
      return { base64: Buffer.concat(chunks).toString('base64'), mime }
    } catch {
      return null
    }
  })

  /**
   * ai:stream IPC entry — used by the docs/sheets/slides renderers through
   * their web-bridge transport. The request shape matches what Electron's
   * docs-main.ts handler accepts: requestId, settings, system, messages,
   * tools. We use the request's settings (renderer-side override) when
   * present, falling back to the server's persisted settings.
   */
  registerHandle('ai:stream', async (event: unknown, request: unknown) => {
    // `request` is optional on the wire (`{ args = [] }`), so a no-argument
    // call used to throw "Cannot read properties of undefined (reading
    // 'requestId')" as a 500. Read through an empty object so the handler
    // reports the missing fields it actually needs.
    const req = (request ?? {}) as {
      requestId?: string
      sessionId?: string
      settings?: AiSettings
      system?: string
      messages?: Parameters<typeof streamForProvider>[3]
      tools?: Parameters<typeof streamForProvider>[4]
      maxTokens?: number
    }
    const requestId = req.requestId || `s-${Date.now()}`
    const settings = req.settings || aiSettings
    const system = req.system || ''
    const messages = req.messages || []
    const tools = req.tools || []
    const sender = (event as { sender?: { send?: (ch: string, ...args: unknown[]) => void } })
      ?.sender

    if (!sender?.send) {
      throw new Error('ai:stream requires an IPC sender (web bridge should provide one)')
    }

    const session = { abort: new AbortController(), chunks: 0 }
    // `AI_STREAM_SESSIONS` is the only stream registry with a reader (the abort
    // route looks a session up by requestId). The parallel write into the
    // vestigial `AI_STREAMS` map is gone together with its `chunks: string[]`
    // cast, which misdescribed this `chunks` counter as an emitted-chunk buffer.
    AI_STREAM_SESSIONS.set(requestId, session)

    try {
      await runProviderStream(settings, system, messages, tools, req.maxTokens, {
        onAbort: (c) => {
          session.abort = c
        },
        send: (chunk) => {
          session.chunks++
          sender!.send?.('ai:stream-chunk', { ...chunk, requestId })
        },
      })
    } finally {
      AI_STREAM_SESSIONS.delete(requestId)
    }
    return { id: requestId }
  })

  registerHandle('ai:stream-cancel', (_event: unknown, requestId: unknown) => {
    const session = AI_STREAM_SESSIONS.get(String(requestId))
    if (session) {
      session.abort.abort()
      AI_STREAM_SESSIONS.delete(String(requestId))
    }
    return { ok: true }
  })
}

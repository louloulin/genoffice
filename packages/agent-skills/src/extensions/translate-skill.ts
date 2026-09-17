/**
 * translate-skill extension — the single agent-facing entry point for the
 * GenOffice translation pipeline.
 *
 * Why this exists
 * ---------------
 * Pre-W37, every UI-driven translation went through `translate-http.ts` and
 * the IPC handlers in `chat.ts`, completely bypassing the agent loop. The
 * embedded pi AgentSession had no real way to translate — installing
 * `translate-pdf` as a marketplace skill only gave the agent a wrapper
 * around the upstream Python script. By moving the TS path into a real pi
 * extension, translation becomes a first-class agent capability: the same
 * `translate_text` tool is available to the UI (via `/api/ai/pi-prompt`) and
 * to the agent (via the embedded AgentSession). One source of truth, one KB,
 * one set of quality rules.
 *
 * Tools
 * -----
 *   - translate_text   — one-shot text translation with KB rules applied.
 *   - translate_file   — file translation: PDF / DOCX / XLS / XLSX / PPT /
 *                        PPTX routed to the matching LumosAI Python script
 *                        via `bash`. Other formats fall back to text extract
 *                        + LLM.
 *   - build_dictionary — mine a file's strings, ask the LLM for source→target
 *                        pairs, persist as JSON the Python wrappers consume
 *                        via `--dictionary`.
 *   - kb_search / kb_upsert / kb_remove — CRUD over the translation KB
 *                        (5-schema: term / forbidden / brand / styleRule /
 *                        customerPreference).
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import Type from "typebox"
import { basename, extname, join } from "node:path"
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { mkdir, readFile, writeFile } from "node:fs/promises"

import {
  assessFileCoverage,
  buildDictionary,
  buildTranslationPrompt,
  buildTranslateSystemPrompt,
  defaultOutputPath,
  extractTranslationText,
  fillDictionaryGaps,
  isSupportedExtension,
  KnowledgeBase,
  resolveTranslateSkills,
  sharedMemory,
  translateBatch,
  translateFile,
  translateOne,
  type BuildDictionaryRequest,
  type BuildDictionaryResult,
  type CoverageReport,
  type FillGapsRequest,
  type FillGapsResult,
  type TranslateRequest,
  type TranslateResponse,
} from "@genoffice/translation-core"
import {
  chatForProvider,
  type AiSettings,
  type AiProviderId,
  type AiProviderConfig,
} from "@genoffice/ai-provider"

// ============================================================================
// Settings resolution
// ============================================================================
//
// AI settings are read on demand (lazy, 1-second TTL) so a Settings change in
// the host is picked up by the next tool call without rebuilding the agent
// session — the same trick the UI's `ai:get-settings` handler uses.
//
// Where the file lives matters: the host (web-server / Electron shell) writes
// the user's provider + API key to its own DATA_DIR, while the desktop app has
// historically used `~/.genoffice/`. Reading only one of them made the agent
// silently use a different provider than the UI — the exact bug this resolves.
// Precedence:
//   1. GENOFFICE_AI_SETTINGS   — explicit absolute override (tests, custom deploys)
//   2. <DATA_DIR>/ai-settings.json where DATA_DIR is the host's data dir
//   3. ~/.genoffice/ai-settings.json — desktop-app legacy location
// The first existing file wins; if none exist we fall back to defaults.

// Minimal but valid AiSettings used when no settings file is on disk yet. The
// shape mirrors `defaultAiSettings()` in @genoffice/ai-provider so we never
// invent a provider id that isn't real.
import { defaultAiSettings } from "@genoffice/ai-provider"

function makeDefaultSettings(): AiSettings {
  const base = defaultAiSettings()
  return { ...base, provider: "genspark" }
}

let cachedSettings: { value: AiSettings; expiresAt: number } | null = null

/** Tests can swap this to bypass file IO; production keeps the file-backed loader. */
let readSettingsOverride: (() => Promise<AiSettings>) | null = null
export function __setReadSettingsForTests(fn: (() => Promise<AiSettings>) | null): void {
  readSettingsOverride = fn
  cachedSettings = null
}

/**
 * Candidate settings files, most-specific first. Exported so hosts and tests
 * can assert which file the agent will actually read.
 */
export function aiSettingsCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  const explicit = env.GENOFFICE_AI_SETTINGS
  if (explicit && explicit.length > 0) candidates.push(explicit)
  const dataDir = env.DATA_DIR || env.GENOFFICE_DATA_DIR || env.GENOFFICE_WEB_DATA_DIR
  if (dataDir && dataDir.length > 0) candidates.push(join(dataDir, "ai-settings.json"))
  candidates.push(join(homedir(), ".genoffice", "ai-settings.json"))
  return candidates
}

async function readSettings(): Promise<AiSettings> {
  if (readSettingsOverride) return readSettingsOverride()
  if (cachedSettings && cachedSettings.expiresAt > Date.now()) {
    return cachedSettings.value
  }
  let loaded: AiSettings | null = null
  for (const path of aiSettingsCandidates()) {
    try {
      const raw = await readFile(path, "utf-8")
      const parsed = JSON.parse(raw) as Partial<AiSettings>
      if (parsed && typeof parsed === "object") {
        const defaults = makeDefaultSettings()
        loaded = {
          ...defaults,
          ...parsed,
          providers: { ...defaults.providers, ...(parsed.providers ?? {}) },
        }
        break
      }
    } catch {
      /* try the next candidate */
    }
  }
  const value = loaded ?? makeDefaultSettings()
  cachedSettings = { value, expiresAt: Date.now() + 1000 }
  return value
}

/**
 * Resolve the active provider + its per-provider config. Falls back to
 * genspark whenever the stored provider has no usable config (matches the
 * behaviour of `activeProvider()` in @genoffice/ai-provider).
 */
function asProvider(settings: AiSettings): { provider: AiProviderId; config: AiProviderConfig } {
  const requested = settings.provider
  const cfg = settings.providers?.[requested]
  if (requested && cfg) {
    return { provider: requested as AiProviderId, config: cfg }
  }
  const fallback = settings.providers?.genspark
  return {
    provider: "genspark",
    config: fallback ?? { apiKey: "", model: "" },
  }
}

// ============================================================================
// Shared KB instance
// ============================================================================

export type TranslateOneFn = typeof translateOne
let translateOneOverride: TranslateOneFn | null = null
export function __setTranslateOneForTests(fn: TranslateOneFn | null): void {
  translateOneOverride = fn
}

export type ChatForProviderFn = typeof chatForProvider
let chatForProviderOverride: ChatForProviderFn | null = null
export function __setChatForProviderForTests(fn: ChatForProviderFn | null): void {
  chatForProviderOverride = fn
}

/**
 * Injected batch translator. `build_dictionary` and `translate_file` both fan
 * their per-segment work out through {@link translateBatch}; this override lets
 * a unit test drive those paths without a live provider (the same reason
 * {@link translateBatchOverride} exists for the single-snippet path).
 */
export type TranslateBatchFn = typeof translateBatch
let translateBatchOverride: TranslateBatchFn | null = null
export function __setTranslateBatchForTests(fn: TranslateBatchFn | null): void {
  translateBatchOverride = fn
}

/** The batch translator a tool should use: test override first, real one otherwise. */
function batchTranslator(): TranslateBatchFn {
  return translateBatchOverride ?? translateBatch
}

let kbInstance: KnowledgeBase | null = null
export function __resetKbForTests(): void { kbInstance = null }

async function getKb(): Promise<KnowledgeBase> {
  if (!kbInstance) {
    // Respect GENOFFICE_TRANSLATION_KB / DATA_DIR like the rest of the
    // translation stack. The previous hardcoded ~/.genoffice path diverged
    // from chat.ts's sharedKnowledgeBase and made the e2e tests' KB
    // upserts land in a different file than the agent's reads.
    kbInstance = new KnowledgeBase()
  }
  await kbInstance.load()
  return kbInstance
}

/**
 * Build the canonical sibling path under a given parent for one extension.
 *
 * The translate dispatch script resolves its format-specific siblings via
 * `os.path.dirname(SKILL_DIR)`, so every sibling has to live under the same
 * parent. This helper builds the `<parent>/../<sibling>/scripts/...` path
 * the python runtime expects.
 */
function siblingPathFor(ext: string, parent: string): string | null {
  const siblingMap: Record<string, string> = {
    ".pdf": "translate-pdf/scripts/translate_pdf.py",
    ".docx": "translate-docx/scripts/translate_docx.py",
    ".xls": "translate-xls/scripts/translate_xls.py",
    ".xlsx": "translate-xls/scripts/translate_xls.py",
    ".ppt": "translate-ppt/scripts/translate_ppt.py",
    ".pptx": "translate-ppt/scripts/translate_ppt.py",
  }
  const rel = siblingMap[ext.toLowerCase()]
  return rel ? join(parent, "..", rel) : null
}

/**
 * Locate the translate python script for a given file extension.
 *
 * Resolution prefers the canonical "default skills" directory
 * (`$LUMOS_HOME/skills/translate-...`), which `materializeTranslateSuite`
 * mirrors from the hashed bundled location at startup so the runtime
 * path is stable across bundle bumps. The hashed bundled location
 * remains as the fallback for the very first run before the materialize
 * step has had a chance to mirror anything.
 *
 * The single-source-of-truth entry point is the unified
 * `translate/scripts/translate.py`, which dispatches on the extension.
 * When only the format-specific sibling is present we use it directly
 * so newly installed skills still work without the top-level entry.
 */
function lumosScriptPath(ext: string): { script: string; handler: 'lumos-pdf' | 'lumos-docx' | 'lumos-xls' | 'lumos-ppt' } | null {
  const lower = ext.toLowerCase()
  const formatMap: Record<string, { handler: 'lumos-pdf' | 'lumos-docx' | 'lumos-xls' | 'lumos-ppt' }> = {
    ".pdf": { handler: "lumos-pdf" },
    ".docx": { handler: "lumos-docx" },
    ".xls": { handler: "lumos-xls" },
    ".xlsx": { handler: "lumos-xls" },
    ".ppt": { handler: "lumos-ppt" },
    ".pptx": { handler: "lumos-ppt" },
  }
  const meta = formatMap[lower]
  if (!meta) return null

  // Preferred: canonical default-skills location (populated by
  // materializeTranslateSuite at startup).
  const canonical = resolveTranslateSkills()
  if (canonical.source === 'default' || canonical.source === 'override') {
    const unified = join(canonical.skillDir, 'scripts', 'translate.py')
    if (existsSync(unified)) return { script: unified, handler: meta.handler }
    const sibling = siblingPathFor(lower, canonical.skillDir)
    if (sibling && existsSync(sibling)) return { script: sibling, handler: meta.handler }
  }

  // Fallback: hashed bundled location (first run, before the materialize step).
  const root = join(homedir(), ".lumos", "bundled-skills")
  if (!existsSync(root)) return null
  let newest: string | null = null
  let newestMtime = 0
  for (const entry of readdirSync(root)) {
    try {
      const m = statSync(join(root, entry)).mtimeMs
      if (m > newestMtime) {
        newestMtime = m
        newest = entry
      }
    } catch {
      /* ignore */
    }
  }
  if (!newest) return null
  const unified = join(root, newest, "translate", "scripts", "translate.py")
  if (existsSync(unified)) return { script: unified, handler: meta.handler }
  // Format-specific fallback: the PDF sibling is `translate_pdf.py`;
  // xls/ppt/docx use `<format>_translate.py`.
  const siblingMap: Record<string, string> = {
    ".pdf": "translate-pdf/scripts/translate_pdf.py",
    ".docx": "translate-docx/scripts/translate_docx.py",
    ".xls": "translate-xls/scripts/translate_xls.py",
    ".xlsx": "translate-xls/scripts/translate_xls.py",
    ".ppt": "translate-ppt/scripts/translate_ppt.py",
    ".pptx": "translate-ppt/scripts/translate_ppt.py",
  }
  const sibling = siblingMap[lower]
  if (!sibling) return null
  const full = join(root, newest, sibling)
  return existsSync(full) ? { script: full, handler: meta.handler } : null
}

// ============================================================================
// translate_text
// ============================================================================

const TranslateTextParams = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 100_000, description: "Source text to translate." }),
  source_lang: Type.Optional(
    Type.String({ description: "Source language code (e.g. 'zh-CN'). Defaults to 'auto'." }),
  ),
  target_lang: Type.String({ description: "Target language code (e.g. 'en-US')." }),
  instruction: Type.Optional(
    Type.String({ description: "Optional style/voice instruction for the model." }),
  ),
  /**
   * Terminology from a generated `--dictionary` the host already loaded. These
   * are layered on top of the KB: they are rendered into the system prompt for
   * the substrings this text actually contains, matched against the source for
   * `matchedTerms`, and enforced on the model output exactly like KB terms.
   *
   * The host passes pairs (not a path) so this tool stays filesystem-free for
   * the snippet path; `build_dictionary` is what owns reading and writing the
   * JSON file.
   */
  dictionary: Type.Optional(
    Type.Array(
      Type.Object({ source: Type.String(), target: Type.String() }),
      { description: "Extra mandatory source→target pairs from a generated dictionary." },
    ),
  ),
  /** Glossary bucket (e.g. 'legal') forwarded to the KB resolver. */
  glossary_category: Type.Optional(Type.String()),
})

type TranslateTextArgs = {
  text: string
  source_lang?: string
  target_lang: string
  instruction?: string
  dictionary?: Array<{ source: string; target: string }>
  glossary_category?: string
}

interface TranslateTextResult {
  ok: boolean
  translated?: string
  status?: 'translated' | 'memory-hit' | 'failed'
  matchedTerms?: string[]
  warnings?: string[]
  elapsedMs?: number
  error?: string
}

function createTranslateTextTool() {
  return defineTool<typeof TranslateTextParams, TranslateTextResult>({
    name: "translate_text",
    label: "Translate Text",
    description:
      "Translate a single text snippet via the active LLM provider, with the " +
      "translation knowledge base applied (terms / forbidden / brand / style / " +
      "customer preferences). For full file translation use translate_file. " +
      "Returns the translated text, matched terms, and quality warnings.",
    promptSnippet:
      "translate_text(text, target_lang) → { translated, status, matchedTerms, warnings }",
    promptGuidelines: [
      "Always pass target_lang as an explicit IETF tag (e.g. 'en-US', 'zh-CN').",
      "Use source_lang only when known — leaving it unset lets the model detect.",
      "matchedTerms / warnings are advisory; surface them to the user.",
    ],
    parameters: TranslateTextParams,
    async execute(_id, params: TranslateTextArgs, _signal) {
      const start = Date.now()
      try {
        const settings = await readSettings()
        const { provider, config } = asProvider(settings)
        const kb = await getKb()
        const req: TranslateRequest = {
          instruction: params.instruction
            ? `${params.text}\n\nStyle: ${params.instruction}`
            : params.text,
          sourceLang: params.source_lang,
          targetLang: params.target_lang,
          memoryEnabled: true,
          qualityCheck: true,
          ...(params.glossary_category !== undefined ? { glossaryCategory: params.glossary_category } : {}),
        }
        const fn = translateOneOverride ?? translateOne
        const res: TranslateResponse = await fn(req, {
          provider,
          config,
          memory: sharedMemory,
          knowledgeBase: kb,
          fuzzyMemoryEnabled: true,
          ...(params.dictionary && params.dictionary.length > 0
            ? { dictionary: params.dictionary }
            : {}),
        })
        const summary = res.ok
          ? `translate_text → status=${res.status ?? "translated"}, matchedTerms=${(res.matchedTerms ?? []).length}, warnings=${(res.warnings ?? []).length}, elapsedMs=${Date.now() - start}`
          : `translate_text failed: ${res.error ?? "unknown error"}`
        return {
          content: [{ type: "text" as const, text: summary }],
          details: {
            ok: res.ok,
            translated: res.translated,
            status: res.status,
            matchedTerms: res.matchedTerms ?? [],
            warnings: res.warnings ?? [],
            elapsedMs: Date.now() - start,
            error: res.error,
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `translate_text error: ${msg}` }],
          details: { ok: false, error: msg },
        }
      }
    },
  })
}

// ============================================================================
// translate_file
// ============================================================================

const TranslateFileParams = Type.Object({
  input_path: Type.String({ maxLength: 4096, description: "Absolute path to the source file." }),
  output_path: Type.Optional(
    Type.String({ maxLength: 4096, description: "Where to write the translated file. Defaults to <input>.translated.<ext>." }),
  ),
  dictionary_path: Type.Optional(
    Type.String({ maxLength: 4096, description: "Optional --dictionary JSON built by build_dictionary." }),
  ),
  source_lang: Type.Optional(Type.String()),
  target_lang: Type.String(),
  /**
   * Run the Python translator in-process instead of returning a bash command.
   * Defaults to false so the agent loop still gets a `bashCommand` it can
   * audit; UI-driven IPC handlers pass true so the worker's toolbar actually
   * receives the translated file.
   */
  execute: Type.Optional(Type.Boolean({ default: false })),
  /**
   * Override the Python interpreter. Auto-detected from PATH; the host can
   * pin `/opt/homebrew/bin/python3.14` (which has python-docx / python-pptx
   * / PyMuPDF preinstalled) when the system python3 lacks those deps.
   */
  python_path: Type.Optional(Type.String({ maxLength: 4096 })),
})

type TranslateFileArgs = {
  input_path: string
  output_path?: string
  dictionary_path?: string
  source_lang?: string
  target_lang: string
  execute?: boolean
  python_path?: string
}

interface TranslateFileResult {
  ok: boolean
  outputPath?: string
  handler?: 'lumos-pdf' | 'lumos-docx' | 'lumos-xls' | 'lumos-ppt' | 'ts-fallback'
  bashCommand?: string
  bytes?: number
  scriptPath?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  /** 'dictionary' = builder failed; 'translate' = python failed; 'done' = ok */
  stage?: 'dictionary' | 'translate' | 'done'
  dictionaryPath?: string
  /** True when the caller supplied a pre-built dictionary and we reused it */
  dictionaryReused?: boolean
  /** Rich dictionary + coverage payload, same shape as chat.ts ai:translate-file-auto. */
  dictionary?: {
    kbEntries?: number
    llmEntries?: number
    missed?: string[]
    totalSegments?: number
    elapsedMs?: number
    segments?: BuildDictionaryResult["segments"]
    warnings?: BuildDictionaryResult["warnings"]
  }
  coverage?: CoverageReport
  elapsedMs?: number
  error?: string
}

/**
 * Spawn the upstream LumosAI Python translator and wait for it. Used when
 * the caller (UI) does not have the agent loop's `bash` tool available.
 * Mirrors the command shape the agent loop runs.
 */
import { spawn as nodeSpawn, execFileSync } from "node:child_process"

/**
 * Locate a Python interpreter capable of running the upstream LumosAI
 * translator. The scripts depend on PyMuPDF / pypdfium2 / python-docx /
 * python-pptx / openpyxl, which the stock macOS `/usr/bin/python3` does
 * NOT ship with. The Homebrew install at `/opt/homebrew/bin/python3.14`
 * has all of these on developer macs.
 *
 * Resolution order:
 *   1. Explicit caller override (translate_file.python_path)
 *   2. `GENOFFICE_PYTHON` env var
 *   3. Homebrew python3.14 / 3.13 / 3.12 / 3.11 — only accepted if a
 *      probe import of pypdfium2 + fitz + docx + pptx + openpyxl succeeds
 *   4. `python3` from PATH (last-resort fallback)
 */
function resolvePython(explicit?: string): string {
  const tryProbe = (bin: string): string | null => {
    try {
      execFileSync(bin, ["-c", "import pypdfium2,fitz,docx,pptx,openpyxl"], {
        stdio: "ignore",
        timeout: 3000,
      })
      return bin
    } catch {
      return null
    }
  }
  const tryExists = (bin: string): boolean => {
    // Use Node's fs.accessSync instead of shelling out to `/usr/bin/test -x`:
    // the latter is not portable to macOS where `test` is a shell builtin and
    // `/usr/bin/test` does not exist, which silently skipped every Homebrew
    // python and forced the fallback to bare `python3` (often system Python
    // without the docx/pptx/openpyxl wheels).
    try {
      accessSync(bin, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (explicit) return explicit
  const env = process.env.GENOFFICE_PYTHON
  if (env) return env
  const candidates = [
    "/opt/homebrew/bin/python3.14",
    "/opt/homebrew/bin/python3.13",
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3",
    "python3",
  ]
  for (const c of candidates) {
    if (c.startsWith("/") && !tryExists(c)) continue
    const probed = tryProbe(c)
    if (probed) return probed
  }
  return "python3"
}

async function executeFileTranslation(args: {
  script: string
  inputPath: string
  outputPath: string
  dictionaryPath?: string
  pythonPath?: string
}): Promise<{ ok: boolean; stdout: string; stderr: string; code: number; elapsedMs: number; bytes?: number; error?: string }> {
  const start = Date.now()
  const pythonBin = resolvePython(args.pythonPath)
  const dict = args.dictionaryPath ? ` --dictionary "${args.dictionaryPath}"` : ""
  const cmd = `${pythonBin} "${args.script}" "${args.inputPath}" "${args.outputPath}"${dict}`
  return await new Promise((resolve) => {
    try {
      const proc = nodeSpawn(pythonBin, [
        args.script,
        args.inputPath,
        args.outputPath,
        ...(args.dictionaryPath ? ["--dictionary", args.dictionaryPath] : []),
      ], { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8") })
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8") })
      proc.on("error", (err) => {
        resolve({ ok: false, stdout, stderr: stderr + "\n" + err.message, code: -1, elapsedMs: Date.now() - start, error: err.message })
      })
      proc.on("close", (code) => {
        // Best-effort: stat the output file for `bytes`. A real Python
        // translator always writes here on success, but we never want this
        // helper to throw — a stat failure is fine.
        let bytes: number | undefined
        try {
          const { statSync } = require("node:fs")
          bytes = statSync(args.outputPath).size
        } catch {
          bytes = undefined
        }
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          code: code ?? -1,
          elapsedMs: Date.now() - start,
          bytes,
          ...(code !== 0 ? { error: stderr.split("\n").filter(Boolean).pop() || `exit ${code}` } : {}),
        })
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      resolve({ ok: false, stdout: "", stderr: msg, code: -1, elapsedMs: Date.now() - start, error: msg })
    }
  })
}

function createTranslateFileTool() {
  return defineTool<typeof TranslateFileParams, TranslateFileResult>({
    name: "translate_file",
    label: "Translate File",
    description:
      "Translate a document file. PDF / DOCX / XLS / XLSX / PPT / PPTX are " +
      "routed to the upstream LumosAI Python scripts (format-preserving). " +
      "Other formats fall back to text-extract + LLM translation. The tool " +
      "returns the bash command to run for Python handlers; the agent must " +
      "have the `bash` tool available (it does by default).",
    promptSnippet:
      "translate_file(input_path, target_lang[, dictionary_path]) → { bashCommand, handler }",
    promptGuidelines: [
      "After translate_file returns a bashCommand, call the bash tool to execute it.",
      "Provide a --dictionary JSON built by build_dictionary whenever the file has technical terms.",
    ],
    parameters: TranslateFileParams,
    async execute(_id, params: TranslateFileArgs, _signal) {
      const start = Date.now()
      const ext = extname(params.input_path)
      const out = params.output_path ?? `${params.input_path}.translated${ext}`
      try {
        const lumos = lumosScriptPath(ext)
        if (lumos) {
          const dict = params.dictionary_path ? ` --dictionary ${params.dictionary_path}` : ""
          const cmd = `${params.python_path ?? "python3"} ${lumos.script} "${params.input_path}" "${out}"${dict}`
          if (params.execute) {
            // UI / IPC path: actually run the translator end-to-end. The agent
            // loop leaves execute unset and gets back the bash command it can
            // audit through its own bash tool. Mirrors chat.ts ai:translate-file-auto:
            //   1. (rerun only) assess coverage of the supplied dictionary
            //   2. (default) build a KB+LLM dictionary if the caller did not
            //      hand us one
            //   3. spawn the LumosAI Python translator with --dictionary
            //   4. assess coverage so the UI can show the same stats it had
            //      on the legacy path
            let dictionaryPath = params.dictionary_path
            let dictInfo: TranslateFileResult["dictionary"]
            let coverage: CoverageReport | undefined
            let dictionaryReused = false

            if (dictionaryPath) {
              // Re-run path: the caller already paid the dictionary build.
              const scored = await assessFileCoverage({
                inputPath: params.input_path,
                dictionaryPath,
              })
              if (!scored.ok) {
                return {
                  content: [{ type: "text" as const, text: `translate_file(${ext}) failed at dictionary: ${scored.error ?? "unreadable"}` }],
                  details: {
                    ok: false,
                    stage: "dictionary" as const,
                    handler: lumos.handler,
                    bashCommand: cmd,
                    elapsedMs: Date.now() - start,
                    error: scored.error ?? "dictionary unreadable",
                    coverage: scored.coverage,
                  },
                }
              }
              coverage = scored.coverage
              dictionaryReused = true
            } else {
              // Build the dictionary via translation-core. The same call the
              // chat.ts ai:translate-build-dictionary handler makes, just
              // routed through the pi session so KB + memory + settings stay
              // single-source-of-truth.
              const settings = await readSettings()
              const { provider, config: providerConfig } = asProvider(settings)
              if (!providerConfig) {
                return {
                  content: [{ type: "text" as const, text: `translate_file(${ext}) failed: AI provider "${provider}" not configured` }],
                  details: {
                    ok: false,
                    stage: "dictionary" as const,
                    handler: lumos.handler,
                    bashCommand: cmd,
                    elapsedMs: Date.now() - start,
                    error: `AI provider "${provider}" not configured`,
                  },
                }
              }
              const kb = await getKb()
              const dataDir = process.env.DATA_DIR ?? process.env.GENOFFICE_WEB_DATA_DIR ?? process.cwd()
              const built = await buildDictionary(
                {
                  inputPath: params.input_path,
                  sourceLang: params.source_lang ?? "auto",
                  targetLang: params.target_lang,
                  dataDir,
                },
                {
                  translateBatch: async (input) =>
                    batchTranslator()(input, {
                      provider,
                      config: providerConfig,
                      memory: sharedMemory,
                      knowledgeBase: kb,
                    }),
                },
              )
              if (!built.ok || !built.dictionaryPath) {
                return {
                  content: [{ type: "text" as const, text: `translate_file(${ext}) failed at dictionary: ${built.error ?? "build failed"}` }],
                  details: {
                    ok: false,
                    stage: "dictionary" as const,
                    handler: lumos.handler,
                    bashCommand: cmd,
                    elapsedMs: Date.now() - start,
                    error: built.error ?? "dictionary build failed",
                  },
                }
              }
              dictionaryPath = built.dictionaryPath
              dictInfo = {
                kbEntries: built.kbEntries,
                llmEntries: built.llmEntries,
                missed: built.missed,
                totalSegments: built.totalSegments,
                elapsedMs: built.elapsedMs,
                segments: built.segments,
                warnings: built.warnings,
              }
              coverage = built.coverage
            }

            // Now spawn the Python translator with the dictionary we just
            // (re)built or accepted.
            const run = await executeFileTranslation({
              script: lumos.script,
              inputPath: params.input_path,
              outputPath: out,
              ...(dictionaryPath ? { dictionaryPath } : {}),
              ...(params.python_path ? { pythonPath: params.python_path } : {}),
            })

            // Refresh coverage from the just-written dictionary if we did
            // not already compute one in the rerun path.
            if (!coverage && dictionaryPath) {
              const scored = await assessFileCoverage({
                inputPath: params.input_path,
                dictionaryPath,
              })
              if (scored.ok) coverage = scored.coverage
            }

            const tail = run.ok
              ? run.stdout.split("\n").filter(Boolean).slice(-6).join(" | ")
              : run.error ?? `exit ${run.code}`
            return {
              content: [{ type: "text" as const, text: `translate_file(${ext}) → ${run.ok ? "ok" : "failed"}: ${tail}` }],
              details: {
                ok: run.ok,
                outputPath: run.ok ? out : undefined,
                handler: lumos.handler,
                bashCommand: cmd,
                bytes: run.bytes,
                scriptPath: lumos.script,
                stdout: run.stdout,
                stderr: run.stderr,
                exitCode: run.code,
                stage: run.ok ? "done" : "translate",
                dictionaryPath,
                dictionaryReused,
                dictionary: dictInfo,
                coverage,
                elapsedMs: Date.now() - start,
                ...(run.error ? { error: run.error } : {}),
              },
            }
          }
          return {
            content: [
              { type: "text" as const, text: `translate_file(${ext}): run via bash → ${cmd}` },
            ],
            details: {
              ok: true,
              outputPath: out,
              handler: lumos.handler,
              bashCommand: cmd,
              elapsedMs: Date.now() - start,
            },
          }
        }
        return {
          content: [{
            type: "text" as const,
            text: `translate_file: no Python handler for ${ext}; use translate_text on extracted content.`,
          }],
          details: {
            ok: false,
            handler: "ts-fallback" as const,
            error: `no handler for ${ext}`,
            elapsedMs: Date.now() - start,
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `translate_file error: ${msg}` }],
          details: { ok: false, error: msg, elapsedMs: Date.now() - start },
        }
      }
    },
  })
}

// ============================================================================
// build_dictionary
// ============================================================================

const BuildDictParams = Type.Object({
  input_path: Type.String({ maxLength: 4096, description: "Document to mine strings from." }),
  output_path: Type.Optional(Type.String({ maxLength: 4096 })),
  target_lang: Type.String(),
  source_lang: Type.Optional(Type.String()),
  /**
   * Cap on the number of mined segments handed to the model (and therefore the
   * dictionary size). Named `max_pairs` for the agent's vocabulary; it maps to
   * `maxSegments` in translation-core.
   */
  max_pairs: Type.Optional(Type.Integer({ minimum: 8, maximum: 2000, default: 200 })),
  /** Skip segments shorter than this. Defaults to 2. */
  min_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  /** Customer name forwarded to the KB resolver. */
  customer_name: Type.Optional(Type.String()),
  /** Glossary bucket forwarded to the KB resolver. */
  glossary_category: Type.Optional(Type.String()),
  /**
   * When false the dictionary is KB-only and no model call is made. The
   * coverage report still describes what the KB alone reaches.
   */
  use_llm: Type.Optional(Type.Boolean({ default: true })),
})

type BuildDictArgs = {
  input_path: string
  output_path?: string
  target_lang: string
  source_lang?: string
  max_pairs?: number
  min_chars?: number
  customer_name?: string
  glossary_category?: string
  use_llm?: boolean
}

interface BuildDictResult {
  ok: boolean
  outputPath?: string
  dictionaryPath?: string
  pairCount?: number
  kbEntries?: number
  llmEntries?: number
  missed?: string[]
  totalSegments?: number
  warnings?: string[]
  coverage?: CoverageReport
  sourceTerms?: string[]
  error?: string
}

async function callProviderForDict(
  prompt: string,
  provider: AiProviderId,
  config: AiProviderConfig,
): Promise<string> {
  const fn = chatForProviderOverride ?? chatForProvider
  const out = await fn(
    provider,
    config,
    "You are a translation KB builder. Output one `source: target` pair per line, no commentary.",
    prompt,
  )
  return out.content ?? ""
}

function parseDictionaryFromLlm(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:][^:]*?)\s*[:=>]\s*(.+?)\s*$/)
    if (!m) continue
    const src = m[1].trim().replace(/^['"`]+|['"`]+$/g, "")
    const tgt = m[2].trim().replace(/^['"`]+|['"`]+$/g, "")
    if (src && tgt && src !== tgt) out[src] = tgt
  }
  return out
}

function pairCountOf(pairs: Record<string, string>): number {
  return Object.keys(pairs).length
}

function createBuildDictionaryTool() {
  return defineTool<typeof BuildDictParams, BuildDictResult>({
    name: "build_dictionary",
    label: "Build Translation Dictionary",
    description:
      "Mine every translatable string out of a document, seed the result with " +
      "the knowledge base's mandatory terms, translate the rest via the active " +
      "provider, and write the `{ source: target }` JSON the Python translate " +
      "scripts consume via `--dictionary`. Also reports how much of the file " +
      "the dictionary reaches (coverage), which is what tells the user whether " +
      "a file pass is worth running. Use this before translate_file whenever " +
      "the document has technical vocabulary (SKUs, fabric codes, regulatory " +
      "terms). Pass use_llm=false for a KB-only dictionary that makes no model " +
      "call.",
    promptSnippet: "build_dictionary(input_path, target_lang) → { dictionaryPath, totalSegments, coverage }",
    promptGuidelines: [
      "Always pass target_lang as an explicit IETF tag (e.g. 'en-US', 'zh-CN').",
      "Read `coverage.partial` / `coverage.uncovered` to decide whether to hand " +
        "the dictionary to translate_file or fill the gaps first.",
      "max_pairs caps how many mined segments reach the model (default 200).",
    ],
    parameters: BuildDictParams,
    async execute(_id, params: BuildDictArgs, _signal) {
      const dataDir = process.env.DATA_DIR ?? process.env.GENOFFICE_WEB_DATA_DIR ?? process.cwd()
      try {
        const settings = await readSettings()
        const { provider, config } = asProvider(settings)
        const kb = await getKb()
        // A KB-only build (`use_llm: false`) needs no provider — that is what
        // makes the "show me the coverage before spending tokens" path work
        // even with no AI configured.
        const wantsLlm = params.use_llm !== false
        if (wantsLlm && !config) {
          return {
            content: [{ type: "text" as const, text: `build_dictionary: AI provider "${provider}" not configured (pass use_llm=false for a KB-only dictionary)` }],
            details: { ok: false, error: `AI provider "${provider}" not configured` },
          }
        }
        const request: BuildDictionaryRequest = {
          inputPath: params.input_path,
          sourceLang: params.source_lang ?? "auto",
          targetLang: params.target_lang,
          dataDir,
          knowledgeBase: kb,
          useLlm: wantsLlm,
          ...(params.output_path !== undefined ? { outputPath: params.output_path } : {}),
          ...(params.max_pairs !== undefined ? { maxSegments: params.max_pairs } : {}),
          ...(params.min_chars !== undefined ? { minChars: params.min_chars } : {}),
          ...(params.customer_name !== undefined ? { customerName: params.customer_name } : {}),
          ...(params.glossary_category !== undefined ? { glossaryCategory: params.glossary_category } : {}),
        }
        const built = await buildDictionary(request, {
          translateBatch: async (input) => {
            // Reached only when useLlm is on, where `config` is guaranteed:
            // the guard above returns early otherwise.
            if (!config) return { ok: false, error: `AI provider "${provider}" not configured` }
            return batchTranslator()(input, {
              provider,
              config,
              memory: sharedMemory,
              knowledgeBase: kb,
            })
          },
        })
        if (!built.ok) {
          return {
            content: [{ type: "text" as const, text: `build_dictionary failed: ${built.error ?? "unknown error"}` }],
            details: { ok: false, error: built.error ?? "build_dictionary failed" },
          }
        }
        const pairCount = (built.kbEntries ?? 0) + (built.llmEntries ?? 0)
        const coverageNote = built.coverage
          ? `, coverage=${built.coverage.covered}/${built.coverage.total}`
          : ""
        return {
          content: [{
            type: "text" as const,
            text: `build_dictionary → ${pairCount} pairs (kb=${built.kbEntries ?? 0}, llm=${built.llmEntries ?? 0}) from ${built.totalSegments ?? 0} segments at ${built.dictionaryPath}${coverageNote}`,
          }],
          details: {
            ok: true as const,
            outputPath: built.dictionaryPath,
            dictionaryPath: built.dictionaryPath,
            pairCount,
            kbEntries: built.kbEntries,
            llmEntries: built.llmEntries,
            missed: built.missed,
            totalSegments: built.totalSegments,
            warnings: built.warnings,
            coverage: built.coverage,
            sourceTerms: (built.segments ?? []).map((seg) => seg.source),
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `build_dictionary error: ${msg}` }],
          details: { ok: false, error: msg },
        }
      }
    },
  })
}


// ============================================================================
// KB CRUD tools
// ============================================================================

const KbUpsertParams = Type.Object({
  // Either provide a fully-formed entry, or the common shortcut fields below.
  entry: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Full KB entry object." })),
  schema: Type.Optional(Type.Union([
    Type.Literal('term'),
    Type.Literal('forbidden'),
    Type.Literal('brand'),
    Type.Literal('styleRule'),
    Type.Literal('customerPreference'),
  ], { description: "Shortcut: KB schema type." })),
  source: Type.Optional(Type.String({ description: "Shortcut: source text (for schema=term/forbidden)." })),
  target: Type.Optional(Type.String({ description: "Shortcut: target text (for schema=term)." })),
  replacement: Type.Optional(Type.String({ description: "Shortcut: replacement (for schema=forbidden)." })),
  word: Type.Optional(Type.String({ description: "Shortcut: brand word (for schema=brand)." })),
  policy: Type.Optional(Type.String({ description: "Shortcut: brand policy (for schema=brand)." })),
  name: Type.Optional(Type.String({ description: "Shortcut: style rule name (for schema=styleRule)." })),
  description: Type.Optional(Type.String({ description: "Shortcut: style rule description (for schema=styleRule)." })),
  customerName: Type.Optional(Type.String({ description: "Shortcut: customer name (for schema=customerPreference)." })),
  preference: Type.Optional(Type.String({ description: "Shortcut: customer preference text (for schema=customerPreference)." })),
  priority: Type.Optional(Type.Number({ description: "Priority (higher = earlier). Defaults to 50." })),
  sourceLang: Type.Optional(Type.String({ description: "Source language code." })),
  targetLang: Type.Optional(Type.String({ description: "Target language code." })),
})

type KbUpsertArgs = {
  entry?: Record<string, unknown>
  schema?: 'term' | 'forbidden' | 'brand' | 'styleRule' | 'customerPreference'
  source?: string
  target?: string
  replacement?: string
  word?: string
  policy?: string
  name?: string
  description?: string
  customerName?: string
  preference?: string
  priority?: number
  sourceLang?: string
  targetLang?: string
}

function createKbUpsertTool() {
  return defineTool<typeof KbUpsertParams, { ok: boolean; id?: string; error?: string }>({
    name: "kb_upsert",
    label: "KB Upsert",
    description:
      "Insert or update a translation knowledge base entry. The KB has 5 " +
      "schemas: term (source/target), forbidden (forbidden text / replacement), " +
      "brand (word + policy), styleRule (name + description), " +
      "customer (customerName + preference). Existing entries with the same " +
      "id are replaced.",
    promptSnippet: "kb_upsert(entry) → { ok, id }",
    promptGuidelines: ["See Settings → AI → 翻译知识库 for the editable schema."],
    parameters: KbUpsertParams,
    async execute(_id, params: KbUpsertArgs, _signal) {
      try {
        const kb = await getKb()
        // Allow callers to pass shortcuts (schema/source/target/...) directly
        // OR a pre-built entry object. Build the entry when shortcuts are used.
        const entry: Record<string, unknown> = params.entry
          ? { ...params.entry }
          : { schema: params.schema }
        if (!entry.schema && params.schema) entry.schema = params.schema
        if (params.schema === 'term') {
          entry.sourceTerm = params.source ?? entry.sourceTerm
          entry.targetTerm = params.target ?? entry.targetTerm
        } else if (params.schema === 'forbidden') {
          entry.forbiddenText = params.source ?? entry.forbiddenText
          entry.replacement = params.replacement ?? entry.replacement
        } else if (params.schema === 'brand') {
          entry.word = params.word ?? entry.word
          entry.policy = params.policy ?? entry.policy
        } else if (params.schema === 'styleRule') {
          entry.name = params.name ?? entry.name
          entry.description = params.description ?? entry.description
        } else if (params.schema === 'customerPreference') {
          entry.customerName = params.customerName ?? entry.customerName
          entry.preference = params.preference ?? entry.preference
        }
        if (params.priority !== undefined) entry.priority = params.priority
        if (params.sourceLang) entry.sourceLang = params.sourceLang
        if (params.targetLang) entry.targetLang = params.targetLang
        // Auto-generate a stable id when the caller did not provide one.
        if (!entry.id) {
          const seed =
            (entry.sourceTerm ?? entry.forbiddenText ?? entry.word ?? entry.name ?? entry.customerName ?? "").toString()
          entry.id = `${entry.schema ?? "entry"}-${seed.replace(/\s+/g, "-").toLowerCase() || Date.now().toString(36)}`
        }
        const saved = await kb.upsert(entry as never)
        await kb.save().catch(() => undefined) // best-effort persistence; tolerate read-only mounts
        const id = (saved as { id?: string }).id ?? null
        return {
          content: [{ type: "text" as const, text: `kb_upsert → ${id ?? "(no id)"}` }],
          details: { ok: true, id: id ?? undefined },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `kb_upsert error: ${msg}` }],
          details: { ok: false, error: msg },
        }
      }
    },
  })
}

const KbRemoveParams = Type.Object({ id: Type.String({ description: "KB entry id to remove." }) })

function createKbRemoveTool() {
  return defineTool<typeof KbRemoveParams, { ok: boolean; removed?: boolean; error?: string }>({
    name: "kb_remove",
    label: "KB Remove",
    description: "Remove a knowledge base entry by id.",
    promptSnippet: "kb_remove(id) → { ok, removed }",
    promptGuidelines: ["Use kb_search to find the id before removing."],
    parameters: KbRemoveParams,
    async execute(_id, params: { id: string }, _signal) {
      try {
        const kb = await getKb()
        const removed = await kb.remove(params.id)
        // Persist the removal so the next getKb() call (which reloads
        // from disk) sees the same state. Without this, a remove-then-
        // list round-trip resurrects the entry from the JSON file.
        await kb.save().catch(() => undefined)
        return {
          content: [{ type: "text" as const, text: `kb_remove(${params.id}) → ${removed}` }],
          details: { ok: true, removed },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `kb_remove error: ${msg}` }],
          details: { ok: false, error: msg },
        }
      }
    },
  })
}

const KbSearchParams = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
})

function createKbSearchTool() {
  return defineTool<typeof KbSearchParams, { ok: boolean; entries?: unknown[]; count?: number; error?: string }>({
    name: "kb_search",
    label: "KB Search",
    description:
      "Search the translation knowledge base for entries matching the query. " +
      "Returns a flat list of entries (across all 5 schemas) whose JSON " +
      "representation contains the query string.",
    promptSnippet: "kb_search(query[, limit]) → entries[]",
    promptGuidelines: ["Use kb_upsert to add new entries discovered during translation."],
    parameters: KbSearchParams,
    async execute(_id, params: { query: string; limit?: number }, _signal) {
      try {
        const kb = await getKb()
        const entries = await kb.list({})
        const q = params.query.toLowerCase()
        const filtered = entries
          .filter((e) => JSON.stringify(e).toLowerCase().includes(q))
          .slice(0, params.limit ?? 20)
        return {
          content: [{ type: "text" as const, text: `kb_search("${params.query}") → ${filtered.length} hits` }],
          details: { ok: true, entries: filtered, count: filtered.length },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `kb_search error: ${msg}` }],
          details: { ok: false, error: msg },
        }
      }
    },
  })
}

const KbListParams = Type.Object({
  schema: Type.Optional(
    Type.Union(
      [
        Type.Literal("term"),
        Type.Literal("forbidden"),
        Type.Literal("brand"),
        Type.Literal("styleRule"),
        Type.Literal("customerPreference"),
      ],
      { description: "Optional filter to a single KB schema." },
    ),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 500 })),
})

function createKbListTool() {
  return defineTool<typeof KbListParams, { ok: boolean; entries?: unknown[]; count?: number; schema?: string; error?: string }>({
    name: "kb_list",
    label: "KB List",
    description:
      "List every entry in the translation knowledge base, optionally filtered " +
      "by schema. Use this to enumerate the KB before deciding what to upsert " +
      "or remove. The companion to kb_search (which does substring matching).",
    promptSnippet: "kb_list([schema][, limit]) → entries[]",
    promptGuidelines: ["Prefer kb_search for targeted lookups; kb_list for full inventories."],
    parameters: KbListParams,
    async execute(_id, rawParams: unknown, _signal) {
      try {
        const params = (rawParams ?? {}) as { schema?: string; limit?: number }
        const kb = await getKb()
        const filter: { schema?: string } = {}
        if (params.schema) filter.schema = params.schema
        const entries = await kb.list(filter as never)
        const sliced = entries.slice(0, params.limit ?? 500)
        return {
          content: [{ type: "text" as const, text: `kb_list → ${sliced.length}/${entries.length} entries` }],
          details: {
            ok: true,
            entries: sliced,
            count: sliced.length,
            schema: params.schema,
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `kb_list error: ${msg}` }],
          details: { ok: false, error: msg },
        }
      }
    },
  })
}

// ============================================================================
// fill_dictionary_gaps
// ============================================================================

const FillDictParams = Type.Object({
  input_path: Type.String({ maxLength: 4096, description: "Document whose dictionary needs extending." }),
  dictionary_path: Type.String({ maxLength: 4096, description: "Path to the existing JSON dictionary to extend." }),
  target_lang: Type.String(),
  source_lang: Type.Optional(Type.String()),
  output_path: Type.Optional(Type.String({ maxLength: 4096 })),
  max_pairs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, default: 200 })),
  customer_name: Type.Optional(Type.String()),
  glossary_category: Type.Optional(Type.String()),
})

type FillDictArgs = {
  input_path: string
  dictionary_path: string
  target_lang: string
  source_lang?: string
  output_path?: string
  max_pairs?: number
  customer_name?: string
  glossary_category?: string
}

function createFillDictionaryGapsTool() {
  return defineTool<typeof FillDictParams, FillGapsResult>({
    name: "fill_dictionary_gaps",
    label: "Fill Dictionary Gaps",
    description:
      "Re-read an existing dictionary, ask the LLM to translate every " +
      "segment it missed, and write an extended JSON dictionary the user " +
      "can hand-edit and re-pass to translate_file. Mirrors the " +
      "ai:translate-fill-gaps chat.ts handler — same dataDir resolution, " +
      "same KB+LLM flow, but executed through the pi session so the agent " +
      "and the UI hit one source of truth.",
    parameters: FillDictParams,
    async execute(_id, params: FillDictArgs, _signal) {
      const out = params.output_path ?? `${params.dictionary_path}.filled.json`
      await mkdir(join(out, ".."), { recursive: true }).catch(() => undefined)
      try {
        const settings = await readSettings()
        const { provider, config: providerConfig } = asProvider(settings)
        if (!providerConfig) {
          return {
            content: [{ type: "text" as const, text: `fill_dictionary_gaps: provider "${provider}" not configured` }],
            details: { ok: false, error: `AI provider "${provider}" not configured` },
          }
        }
        const dataDir = process.env.DATA_DIR ?? process.env.GENOFFICE_WEB_DATA_DIR ?? process.cwd()
        const req: FillGapsRequest = {
          inputPath: params.input_path,
          sourceLang: params.source_lang ?? "auto",
          dictionaryPath: params.dictionary_path,
          targetLang: params.target_lang,
          dataDir,
          ...(params.output_path !== undefined ? { outputPath: params.output_path } : {}),
          ...(params.customer_name !== undefined ? { customerName: params.customer_name } : {}),
          ...(params.glossary_category !== undefined ? { glossaryCategory: params.glossary_category } : {}),
        }
        const kb = await getKb()
        const result = await fillDictionaryGaps(req, {
          translateBatch: async (input) =>
            batchTranslator()(input, {
              provider,
              config: providerConfig,
              memory: sharedMemory,
              knowledgeBase: kb,
            }),
        })
        return {
          content: [{ type: "text" as const, text: `fill_dictionary_gaps → ok=${result.ok}, added=${result.added ?? 0}, dictionaryPath=${result.dictionaryPath ?? "(none)"}` }],
          details: result as unknown as FillGapsResult,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `fill_dictionary_gaps error: ${msg}` }],
          details: { ok: false, error: msg },
        }
      }
    },
  })
}

// ============================================================================
// Extension factory
// ============================================================================

export interface TranslateSkillOptions {
  /** Override settings resolution (tests). */
  readSettings?: () => Promise<AiSettings>
}

export const ALL_TRANSLATE_TOOL_NAMES = [
  "translate_text",
  "translate_file",
  "build_dictionary",
  "fill_dictionary_gaps",
  "kb_list",
  "kb_search",
  "kb_upsert",
  "kb_remove",
] as const

export type TranslateToolName = (typeof ALL_TRANSLATE_TOOL_NAMES)[number]

export function createTranslateSkillExtension(
  options: TranslateSkillOptions = {},
): (pi: ExtensionAPI) => void {
  const resolveSettings = options.readSettings ?? readSettings
  // Touch the overrides so unused-import lint stays happy in tests.
  void resolveSettings
  return (pi: ExtensionAPI) => {
    pi.registerTool(createTranslateTextTool())
    pi.registerTool(createTranslateFileTool())
    pi.registerTool(createBuildDictionaryTool())
    pi.registerTool(createFillDictionaryGapsTool())
    pi.registerTool(createKbUpsertTool())
    pi.registerTool(createKbRemoveTool())
    pi.registerTool(createKbSearchTool())
    pi.registerTool(createKbListTool())
  }
}

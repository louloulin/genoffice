import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { homedir } from "node:os"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  createTranslateSkillExtension,
  ALL_TRANSLATE_TOOL_NAMES,
  __setReadSettingsForTests,
  __setTranslateOneForTests,
  __setTranslateBatchForTests,
  aiSettingsCandidates,
  __setChatForProviderForTests,
  __resetKbForTests,
} from "../src/extensions/translate-skill"
import type { AiSettings } from "@genoffice/ai-provider"

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

function makeFakePi() {
  const tools = new Map<string, RegisteredTool>()
  return {
    tools,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool)
    },
  }
}

function fakeSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: "genspark",
    providers: {
      genspark: { apiKey: "test-key", model: "gpt-4o-mini" },
    } as AiSettings["providers"],
    ...overrides,
  } as AiSettings
}

describe("translate-skill", () => {
  beforeAll(() => {
    // Isolated KB so tests do not read the user's real ~/.genoffice/translation-kb.json.
    // The KnowledgeBase honors GENOFFICE_TRANSLATION_KB before falling back to the default path.
    const tmp = join(process.env.TMPDIR ?? '/tmp', `agent-skills-test-kb-${process.pid}.json`)
    process.env.GENOFFICE_TRANSLATION_KB = tmp
    require('node:fs').writeFileSync(tmp, JSON.stringify({
      'trade.translation.term': [],
      'trade.translation.forbidden': [],
      'trade.translation.brand': [],
      'trade.translation.styleRule': [],
      'trade.translation.customerPreference': [],
    }))
  })

  afterEach(() => {
    __setReadSettingsForTests(null)
    __setTranslateOneForTests(null)
    __setChatForProviderForTests(null)
    __setTranslateBatchForTests(null)
    __resetKbForTests()
  })

  it("exposes the 8-tool surface in ALL_TRANSLATE_TOOL_NAMES", () => {
    expect(ALL_TRANSLATE_TOOL_NAMES).toEqual([
      "translate_text",
      "translate_file",
      "build_dictionary",
      "fill_dictionary_gaps",
      "kb_list",
      "kb_search",
      "kb_upsert",
      "kb_remove",
    ])
  })

  it("registers all 8 tools on the pi extension", () => {
    const pi = makeFakePi()
    createTranslateSkillExtension()(pi as never)
    for (const name of ALL_TRANSLATE_TOOL_NAMES) {
      expect(pi.tools.has(name), `missing tool ${name}`).toBe(true)
    }
  })

  it("translate_text returns the upstream TranslateResponse verbatim", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    __setTranslateOneForTests(async () => ({
      ok: true,
      translated: "你好,世界",
      status: "translated",
      matchedTerms: ["hello"],
      warnings: [],
    }) as never)

    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("translate_text")!
    const out = await tool.execute("c1", {
      text: "hello world",
      target_lang: "zh-CN",
    }, undefined)

    expect(out.details).toMatchObject({
      ok: true,
      translated: "你好,世界",
      status: "translated",
      matchedTerms: ["hello"],
    })
    expect(out.content[0].text).toContain("translate_text → status=translated")
  })

  it("translate_text surfaces failures with a stable error envelope", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    __setTranslateOneForTests(async () => ({ ok: false, error: "no api key" }) as never)

    createTranslateSkillExtension()(pi as never)
    const out = await pi.tools.get("translate_text")!.execute(
      "c1",
      { text: "hello", target_lang: "zh-CN" },
      undefined,
    )
    expect(out.details).toMatchObject({ ok: false, error: "no api key" })
    expect(out.content[0].text).toMatch(/failed/i)
  })

  /**
   * `build_dictionary` is the segment miner, not a term guesser. The regression
   * this guards against: it was briefly rewritten to ask the model for a list of
   * terms from a filename, which produced a dictionary with no relationship to
   * the document (totalSegments 0, coverage missing) and made every file pass
   * translate nothing. The dictionary must come from the file's own strings.
   */
  it("build_dictionary mines the file's own segments and writes them as a JSON dictionary", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    const seen: string[] = []
    __setTranslateBatchForTests(async (input) => {
      seen.push(...input.units.map((u) => u.sourceText))
      return {
        ok: true,
        units: input.units.map((u) => ({
          unitId: u.unitId,
          sourceText: u.sourceText,
          translatedText: `EN: ${u.sourceText}`,
          status: "translated" as const,
        })),
      }
    })

    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "transdict-"))
    const inputPath = join(dir, "supplier.md")
    writeFileSync(inputPath, "产品验收报告已提交。\n请在一周内完成复核。\n", "utf8")
    const outPath = join(dir, "out.dictionary.json")

    createTranslateSkillExtension()(pi as never)
    const out = await pi.tools.get("build_dictionary")!.execute(
      "c1",
      { input_path: inputPath, source_lang: "zh-CN", target_lang: "en-US", output_path: outPath },
      undefined,
    )
    const details = out.details as {
      ok: boolean
      pairCount: number
      totalSegments: number
      llmEntries: number
      coverage?: { total: number; covered: number }
      outputPath: string
    }
    expect(details.ok).toBe(true)
    // Both lines were mined from the file itself and sent to the model.
    expect(details.totalSegments).toBe(2)
    expect(seen).toEqual(["产品验收报告已提交。", "请在一周内完成复核。"])
    expect(details.llmEntries).toBe(2)
    expect(details.pairCount).toBe(2)
    // A dictionary that reaches both segments reports full coverage.
    expect(details.coverage?.total).toBe(2)
    expect(details.coverage?.covered).toBe(2)
    // And the file on disk is the { source: target } map the Python handler reads.
    // Every mined segment is present verbatim; the writer also emits spelling
    // variants so a handler that reports a de-punctuated region still matches.
    const written = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, string>
    expect(written["产品验收报告已提交。"]).toBe("EN: 产品验收报告已提交。")
    expect(written["请在一周内完成复核。"]).toBe("EN: 请在一周内完成复核。")
  })

  it("build_dictionary with use_llm=false stays KB-only and makes no model call", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    let calls = 0
    __setTranslateBatchForTests(async () => {
      calls++
      return { ok: true, units: [] }
    })

    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "transdict-kbonly-"))
    const inputPath = join(dir, "notes.md")
    writeFileSync(inputPath, "请在一周内完成复核。\n", "utf8")

    createTranslateSkillExtension()(pi as never)
    const out = await pi.tools.get("build_dictionary")!.execute(
      "c1",
      { input_path: inputPath, source_lang: "zh-CN", target_lang: "en-US", use_llm: false },
      undefined,
    )
    const details = out.details as { ok: boolean; llmEntries: number; totalSegments: number; pairCount: number }
    expect(details.ok).toBe(true)
    expect(details.totalSegments).toBe(1)
    expect(details.llmEntries).toBe(0)
    expect(details.pairCount).toBe(0)
    // The whole point of the KB-only path: it is free.
    expect(calls).toBe(0)
  })

  it("build_dictionary reports the failure instead of writing a bogus dictionary", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())

    createTranslateSkillExtension()(pi as never)
    const out = await pi.tools.get("build_dictionary")!.execute(
      "c1",
      { input_path: "/tmp/definitely-missing-file-xyz.md", target_lang: "en-US" },
      undefined,
    )
    expect((out.details as { ok: boolean }).ok).toBe(false)
    expect(out.content[0].text).toMatch(/failed|error/i)
  })
})

describe("kb_upsert shortcut fields", () => {
  afterEach(() => {
    __setReadSettingsForTests(null)
    __setTranslateOneForTests(null)
    __setChatForProviderForTests(null)
    __setTranslateBatchForTests(null)
    __resetKbForTests()
  })

  it("accepts schema/source/target shortcut and persists a term entry", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_upsert")!
    const out = await tool.execute(
      "c1",
      { schema: "term", source: "fabric code", target: "面料编号", priority: 80 },
      undefined,
    )
    const details = out.details as { ok: boolean; id?: string; error?: string }
    expect(details.ok).toBe(true)
    expect(typeof details.id).toBe("string")
    expect(details.id).toBeTruthy()

    // Round-trip: search should find it
    const search = pi.tools.get("kb_search")!
    const sOut = await search.execute("c2", { query: "fabric", limit: 5 }, undefined)
    const sDetails = sOut.details as { ok: boolean; entries?: Array<{ sourceTerm?: string; targetTerm?: string }> }
    expect(sDetails.ok).toBe(true)
    const hit = (sDetails.entries ?? []).find((e) => e.sourceTerm === "fabric code" && e.targetTerm === "面料编号")
    expect(hit, "kb_upsert shortcut should land a searchable term entry").toBeTruthy()
  })
})

describe("aiSettingsCandidates", () => {
  // The agent and the host (web-server / Electron shell) must read the SAME
  // settings file. Hardcoding ~/.genoffice/ai-settings.json made the agent
  // silently use a different provider than the UI, which surfaced as
  // "provider X not configured" while the UI showed a working account.
  it("prefers an explicit GENOFFICE_AI_SETTINGS override", () => {
    const out = aiSettingsCandidates({
      GENOFFICE_AI_SETTINGS: "/explicit/ai-settings.json",
      DATA_DIR: "/data",
    } as NodeJS.ProcessEnv)
    expect(out[0]).toBe("/explicit/ai-settings.json")
  })

  it("falls back to the host DATA_DIR before the legacy home path", () => {
    const out = aiSettingsCandidates({ DATA_DIR: "/data" } as NodeJS.ProcessEnv)
    expect(out).toEqual([
      join("/data", "ai-settings.json"),
      join(homedir(), ".genoffice", "ai-settings.json"),
    ])
  })

  it("honours the GENOFFICE_DATA_DIR / GENOFFICE_WEB_DATA_DIR aliases", () => {
    expect(aiSettingsCandidates({ GENOFFICE_DATA_DIR: "/d1" } as NodeJS.ProcessEnv)[0]).toBe(
      join("/d1", "ai-settings.json"),
    )
    expect(aiSettingsCandidates({ GENOFFICE_WEB_DATA_DIR: "/d2" } as NodeJS.ProcessEnv)[0]).toBe(
      join("/d2", "ai-settings.json"),
    )
  })

  it("always ends at the legacy home path so a bare env still resolves", () => {
    const out = aiSettingsCandidates({} as NodeJS.ProcessEnv)
    expect(out).toEqual([join(homedir(), ".genoffice", "ai-settings.json")])
  })
})

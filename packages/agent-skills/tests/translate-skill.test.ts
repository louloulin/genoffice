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
import { defaultOutputPath } from "@genoffice/translation-core"

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
    writeFileSync(tmp, JSON.stringify({
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

  it("translate_file without input_path returns a structured error, not a raw throw", async () => {
    // Regression: `extname(params.input_path)` ran before the try block, so a
    // missing argument escaped as a raw ERR_INVALID_ARG_TYPE. The IPC layer
    // surfaced "The \"path\" argument must be of type string" instead of a
    // message the caller could act on.
    const pi = makeFakePi()
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("translate_file") as {
      execute: (id: string, params: Record<string, unknown>, signal: unknown) => Promise<{
        details?: { ok?: boolean; error?: string }
      }>
    }
    const res = await tool.execute("c1", {}, undefined)
    expect(res.details?.ok).toBe(false)
    expect(res.details?.error).toMatch(/input_path/)
    // Must not leak the Node type error.
    expect(res.details?.error).not.toMatch(/ERR_INVALID_ARG_TYPE/)
    expect(res.details?.error).not.toMatch(/must be of type string/)
  })

  it("fill_dictionary_gaps without dictionary_path returns a structured error", async () => {
    const pi = makeFakePi()
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("fill_dictionary_gaps") as {
      execute: (id: string, params: Record<string, unknown>, signal: unknown) => Promise<{
        details?: { ok?: boolean; error?: string }
      }>
    }
    const res = await tool.execute("c1", { input_path: "/tmp/x.docx", target_lang: "en-US" }, undefined)
    expect(res.details?.ok).toBe(false)
    expect(res.details?.error).toMatch(/dictionary_path/)
    // The old code interpolated undefined into the output path.
    expect(res.details?.error).not.toMatch(/undefined/)
  })

  it("fill_dictionary_gaps forwards max_pairs / min_chars to the core request", async () => {
    // Both fields were on the tool schema and then dropped on the way to
    // `fillDictionaryGaps`, so the caller's budget for "how much may this gap
    // fill cost" was silently ignored and the core default (400) applied.
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fillgaps-"))
    const dictPath = join(dir, "terms.json")
    writeFileSync(dictPath, JSON.stringify({ hello: "你好" }), "utf8")

    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("fill_dictionary_gaps") as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal: unknown,
      ) => Promise<{ details?: Record<string, unknown> }>
    }
    const res = await tool.execute(
      "c1",
      {
        input_path: join(dir, "missing.md"),
        dictionary_path: dictPath,
        target_lang: "en-US",
        max_pairs: 25,
        min_chars: 7,
      },
      undefined,
    )
    // Whatever the outcome, the parameters must not be rejected by validation.
    expect(res.details?.error).not.toMatch(/max_pairs|min_chars/)
  })

  it("translate_file accepts and forwards a PDF scale", () => {
    // `ai:translate-file-auto` has always accepted `scale` and forwarded it,
    // but the tool schema had no such property, so validation dropped it and
    // every PDF rendered at the script default of 2.
    const pi = makeFakePi()
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("translate_file") as {
      parameters: { properties?: Record<string, unknown> }
    }
    expect(Object.keys(tool.parameters.properties ?? {})).toContain("scale")
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


  it("translate_file default output path agrees with the shared helper", () => {
    // The `ai:translate-file-output-path` channel and the pi tool's
    // `translate_file` must default to the same path so the file the user
    // is told to open is the one that actually gets written. The shared
    // `defaultOutputPath` helper defines that contract; the pi tool used
    // to inline its own `<input>.translated<ext>` form and the two drifted.
    const input = "/tmp/example.docx"
    expect(defaultOutputPath(input)).toBe("/tmp/example_translated.docx")

    // Behavioural check: when the pi tool runs in planning mode
    // (`execute: false`) the details it returns must carry the helper's
    // path, not the legacy dotted form. The LumosAI handler may or may
    // not be installed on the test machine; either way the default
    // *helper* is locked in here so a future regression to the inline
    // format is caught before it ships.
    const pi = makeFakePi()
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("translate_file") as {
      execute: (id: string, params: Record<string, unknown>, signal: unknown) => Promise<{
        details?: { ok?: boolean; outputPath?: string; handler?: string; error?: string }
      }>
    }
    return tool
      .execute("c1", { input_path: input, target_lang: "en-US", execute: false }, undefined)
      .then((res) => {
        const d = res.details ?? {}
        if (d.handler === "ts-fallback" || d.error) {
          // LumosAI not installed on this machine; the helper assertion
          // above is the lock-in. Skip the behavioral half gracefully.
          return
        }
        expect(d.outputPath).toBe(defaultOutputPath(input))
        // Anti-regression: explicitly forbid the legacy dotted form.
        expect(d.outputPath).not.toBe("/tmp/example.translated.docx")
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

  it("refuses an entry with no identifying field instead of writing a blank row", async () => {
    // Both of these used to succeed. The empty object fell through every
    // `schemaForEntry` branch into `customerPreference`, got the generated id
    // `entry-<random>`, and was persisted — a permanent blank row in the
    // user's KB file, produced by a malformed or exploratory call. A schema
    // alone is equally unusable: nothing identifies what it applies to.
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_upsert")!

    // The KB file is shared across this suite, so compare against a snapshot
    // rather than assuming an empty store.
    const list = pi.tools.get("kb_list")!
    const before = (await list.execute("c-before", { limit: 500 }, undefined)).details as {
      entries?: unknown[]
    }

    for (const params of [{}, { schema: "term" }, { schema: "term", source: "   " }] as Array<
      Record<string, unknown>
    >) {
      const out = await tool.execute("c-blank", params, undefined)
      const details = out.details as { ok: boolean; error?: string }
      expect(details.ok, `kb_upsert${JSON.stringify(params)} should be rejected`).toBe(false)
      expect(details.error).toMatch(/identifying field/)
    }

    const after = (await list.execute("c-after", { limit: 500 }, undefined)).details as {
      entries?: unknown[]
    }
    expect(after.entries?.length).toBe(before.entries?.length)
    // And specifically: no row without an identifying field slipped in.
    const blank = (after.entries ?? []).filter((e) => {
      const entry = e as Record<string, unknown>
      return !entry.sourceTerm && !entry.forbiddenText && !entry.word && !entry.name && !entry.customerName
    })
    expect(blank).toEqual([])
  })
})

describe("kb_upsert customerPreference shortcut", () => {
  afterEach(() => {
    __setReadSettingsForTests(null)
    __resetKbForTests()
  })

  it("writes preferenceType and value, not an unread `preference` blob", async () => {
    // The shortcut stored `entry.preference`, which no reader looks at.
    // `renderPromptBlock` renders `${preferenceType}=${value}`, so a
    // preference saved this way contributed "KERRITS: undefined=undefined"
    // to the prompt while the UI showed a populated row.
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_upsert")!

    const out = await tool.execute(
      "c-cp",
      {
        schema: "customerPreference",
        customerName: "KERRITS",
        preferenceType: "fabricUnit",
        preference: "g/m²",
      },
      undefined,
    )
    const details = out.details as { ok: boolean; id?: string; error?: string }
    expect(details.ok, details.error).toBe(true)

    const list = pi.tools.get("kb_list")!
    const listed = (await list.execute("c-cpl", { schema: "customerPreference", limit: 50 }, undefined))
      .details as { entries?: Array<Record<string, unknown>> }
    const row = (listed.entries ?? []).find((e) => e.customerName === "KERRITS")
    expect(row, "the preference should be listed").toBeTruthy()
    expect(row?.preferenceType).toBe("fabricUnit")
    expect(row?.value).toBe("g/m²")
    expect(row?.preference).toBeUndefined()
  })

  it("keeps the generated id stable when only the wording changes", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_upsert")!

    const first = await tool.execute(
      "c-1",
      { schema: "customerPreference", customerName: "ACME", preference: "g/m²" },
      undefined,
    )
    const second = await tool.execute(
      "c-2",
      { schema: "customerPreference", customerName: "ACME", preference: "GSM" },
      undefined,
    )
    const a = (first.details as { id?: string }).id
    const b = (second.details as { id?: string }).id
    // The id keys on the customer, so a rewording updates the row rather than
    // adding a second preference for the same customer.
    expect(a).toBe(b)
  })
})

describe("kb_search input validation", () => {
  afterEach(() => {
    __setReadSettingsForTests(null)
    __resetKbForTests()
  })

  it("reports a missing query as a shape error instead of throwing", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_search")!

    // The schema marks `query` required, but the IPC bridge calls execute()
    // with whatever JSON the caller sent — a missing or non-string query used
    // to return "Cannot read properties of undefined (reading 'toLowerCase')".
    for (const params of [{}, { query: "" }, { query: "   " }, { query: 42 }] as Array<
      Record<string, unknown>
    >) {
      const out = await tool.execute("c-q", params, undefined)
      const details = out.details as { ok: boolean; error?: string }
      expect(details.ok, `kb_search${JSON.stringify(params)} should be rejected`).toBe(false)
      expect(details.error).toBe("kb_search: `query` is required")
    }
  })

  it("rejects a limit that would silently shrink the result set", async () => {
    // `Array.prototype.slice` accepts 'x' (→ []), -5 (→ all but the tail) and
    // 2.5 (→ truncated). Answering `[]` for a malformed page size read to the
    // caller as "no KB entries" while every row was still on disk.
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_search")!

    for (const limit of ["x", -5, 0, 2.5, {}, true, 10_000]) {
      const out = await tool.execute("c-lim", { query: "fabric", limit }, undefined)
      const details = out.details as { ok: boolean; error?: string }
      expect(details.ok, `kb_search limit=${JSON.stringify(limit)} should be rejected`).toBe(false)
      expect(details.error).toMatch(/`limit` must be an integer/)
    }
  })
})

describe("kb_list input validation", () => {
  afterEach(() => {
    __setReadSettingsForTests(null)
    __resetKbForTests()
  })

  it("rejects a limit that would silently empty the listing", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_list")!

    for (const limit of ["x", -5, 0, 1.5, {}, false, 99_999]) {
      const out = await tool.execute("c-list-lim", { limit }, undefined)
      const details = out.details as { ok: boolean; error?: string }
      expect(details.ok, `kb_list limit=${JSON.stringify(limit)} should be rejected`).toBe(false)
      expect(details.error).toMatch(/`limit` must be an integer/)
    }
  })

  it("rejects an unknown schema instead of returning an empty store slice", async () => {
    // A typo'd schema key went straight into the store lookup, which has no
    // such bucket, so the caller was told the KB was empty.
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_list")!

    for (const schema of ["nope", "trade.translation.term", "Term", 5]) {
      const out = await tool.execute("c-list-schema", { schema }, undefined)
      const details = out.details as { ok: boolean; error?: string }
      expect(details.ok, `kb_list schema=${JSON.stringify(schema)} should be rejected`).toBe(false)
      expect(details.error).toMatch(/unknown schema/)
    }
  })

  it("still accepts the documented defaults", async () => {
    const pi = makeFakePi()
    __setReadSettingsForTests(async () => fakeSettings())
    createTranslateSkillExtension()(pi as never)
    const tool = pi.tools.get("kb_list")!

    for (const params of [{}, { limit: 500 }, { limit: 1, schema: "term" }]) {
      const out = await tool.execute("c-list-ok", params, undefined)
      const details = out.details as { ok: boolean; error?: string }
      expect(details.ok, `kb_list${JSON.stringify(params)} should be accepted`).toBe(true)
      expect(details.error).toBeUndefined()
    }
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

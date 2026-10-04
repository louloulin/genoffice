import type {
  SkillContext,
  SkillDefinition,
  SkillInputSlot,
  SkillPackage,
  SkillSchema,
} from '@genoffice/agent-skills/skill-protocol'
import type { AgentToolCall, AgentToolDef, ToolExecution } from './types'

/** One tool call actually executed during a run, as seen by verifyResponse. */
export interface ExecutedToolCall {
  name: string
  /** false when the execution returned an error result */
  ok: boolean
}

/**
 * A skill packages one capability domain for the agent loop: its system
 * prompt section, its tools, per-turn context, and the tool executor.
 * AI Docs ships a docx skill; Excel / PPT skills plug in the same way.
 */
export interface AgentSkill {
  id: string
  /** system prompt section describing this skill's rules and tools */
  systemPrompt: string
  tools: AgentToolDef[]
  /**
   * Fresh context sections attached to every user turn (e.g. document
   * skeleton + selection). Return '' when there is nothing to attach.
   */
  buildContext?(): string
  /**
   * signal: aborted when the user hits stop. Long-running tools (e.g.
   * generate_deck with internal LLM calls) should check signal.aborted in
   * their loops and stop promptly.
   */
  executeTool(call: AgentToolCall, signal?: AbortSignal): ToolExecution | Promise<ToolExecution>
  /**
   * Claimed-action guard: inspect the run's final assistant text against the
   * tools that actually executed during the run. Return a corrective
   * instruction to force one more model turn (e.g. the text claims "I
   * selected/located ..." but no matching tool call succeeded), or null to
   * accept the reply. The loop applies the correction at most once per run,
   * so a detector false-positive costs one extra turn and cannot loop.
   */
  verifyResponse?(finalText: string, executed: readonly ExecutedToolCall[]): string | null
}

/**
 * Merge several skills into one (tool names must be globally unique).
 * `intro` becomes the shared preamble of the combined system prompt.
 */
export function composeSkills(id: string, intro: string, skills: AgentSkill[]): AgentSkill {
  // Recomputed per access: a sub-skill may expose `tools` through a getter
  // keyed on runtime capability (e.g. gsk login/toggle), and the loop reads
  // the composed skill's tools before every model request.
  const ownerOf = (name: string): AgentSkill | undefined =>
    skills.find((skill) => skill.tools.some((tool) => tool.name === name))
  return {
    id,
    // live like tools: a sub-skill's prompt may vary with the same capability its tools key on
    get systemPrompt() {
      return [intro, ...skills.map((s) => s.systemPrompt)].filter(Boolean).join('\n\n')
    },
    get tools() {
      const all = skills.flatMap((s) => s.tools)
      const seen = new Set<string>()
      for (const tool of all) {
        if (seen.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`)
        seen.add(tool.name)
      }
      return all
    },
    buildContext: () =>
      skills
        .map((s) => s.buildContext?.() ?? '')
        .filter(Boolean)
        .join('\n\n'),
    executeTool: (call, signal) => {
      const skill = ownerOf(call.name)
      if (!skill) {
        return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      return skill.executeTool(call, signal)
    },
    verifyResponse: (finalText, executed) => {
      for (const skill of skills) {
        const correction = skill.verifyResponse?.(finalText, executed)
        if (correction) return correction
      }
      return null
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace SkillPackage → AgentLoop adapter
//
// The suite carries two otherwise-unconnected "skill" systems:
//   - the marketplace / platform SkillPackage protocol (a SkillDefinition with
//     typed inputs/outputs and an `execute(ctx, inputs)` entry point), and
//   - the AgentLoop tool contract (AgentSkill: AgentToolDef[] + executeTool).
//
// The projection below lets AgentLoop consume a marketplace skill as an
// ordinary tool. The protocol types are imported (type-only) from
// `@genoffice/agent-skills/skill-protocol` rather than re-declared, so the
// mapping stays pinned to the real shapes.
// ─────────────────────────────────────────────────────────────────────────────

/** A marketplace skill projected onto the AgentLoop contract: one tool + its executor. */
export interface AdaptedSkillTool {
  /** Tool definition handed to the model (name / description / JSON Schema). */
  tool: AgentToolDef
  /**
   * Runs the skill for one model tool call: builds the host SkillContext via
   * `options.createContext`, invokes `skill.execute`, and maps the returned
   * output record to a ToolExecution. Never throws — failures become an
   * isError result so the loop can feed the message back to the model.
   */
  executeTool(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution>
}

export interface SkillPackageAdapterOptions {
  /**
   * Host bridge: builds the SkillContext (LLM, workspace, KV storage, progress
   * emitter) for a single invocation. Called once per tool call. The host is
   * expected to wire `signal` to `ctx.cancel()` so a user stop aborts the skill.
   */
  createContext(call: AgentToolCall, signal?: AbortSignal): SkillContext
  /**
   * BCP-47 locale used to resolve the skill's i18n name/description/labels.
   * Falls back to the base language, then to the first declared locale.
   */
  locale?: string
  /** Tool name override. Default: the skill id's last dot-segment, sanitized to [A-Za-z0-9_]. */
  toolName?: string
  /** Mark executions as artifact-mutating (drives the loop's rollback snapshot). Default false. */
  mutated?: boolean
  /** Custom serializer from the skill's output record to the tool-result text. */
  formatOutput?(result: Record<string, unknown>, definition: SkillDefinition): string
}

/** Resolve an i18n string table for the requested locale (exact, then base language, then first entry). */
function resolveI18nText(value: Record<string, string> | undefined, locale?: string): string | undefined {
  if (!value) return undefined
  if (locale) {
    if (value[locale]) return value[locale]
    const base = locale.split('-')[0]
    if (base && value[base]) return value[base]
  }
  return Object.values(value)[0]
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Derive an AgentLoop-safe tool name from a skill id. Provider function names
 * are the strictest constraint (Gemini accepts only `[A-Za-z_][A-Za-z0-9_]*`),
 * so everything outside `[A-Za-z0-9_]` becomes `_` and a leading digit is
 * prefixed: `genoffice.skill.text-summarize` -> `text_summarize`.
 */
export function defaultSkillToolName(id: string): string {
  const tail = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id
  const sanitized = tail.replace(/[^A-Za-z0-9_]/g, '_')
  if (!sanitized) return 'skill'
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized
}

/** Map one SkillSchema onto a JSON Schema fragment (the model-facing shape). */
function skillSchemaToJsonSchema(schema: SkillSchema, locale?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  switch (schema.type) {
    case 'string':
      out.type = 'string'
      if (schema.minLength !== undefined) out.minLength = schema.minLength
      if (schema.maxLength !== undefined) out.maxLength = schema.maxLength
      if (schema.pattern !== undefined) out.pattern = schema.pattern
      break
    case 'number':
      out.type = schema.integer ? 'integer' : 'number'
      if (schema.min !== undefined) out.minimum = schema.min
      if (schema.max !== undefined) out.maximum = schema.max
      break
    case 'boolean':
      out.type = 'boolean'
      break
    case 'array':
      out.type = 'array'
      out.items = skillSchemaToJsonSchema(schema.items, locale)
      if (schema.minItems !== undefined) out.minItems = schema.minItems
      if (schema.maxItems !== undefined) out.maxItems = schema.maxItems
      break
    case 'object': {
      out.type = 'object'
      const properties: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(schema.properties)) {
        properties[key] = skillSchemaToJsonSchema(child, locale)
      }
      out.properties = properties
      if (schema.additionalProperties !== undefined) out.additionalProperties = schema.additionalProperties
      break
    }
    case 'file': {
      // A model cannot upload bytes; expose the file as a workspace reference id
      // that the host resolves inside the SkillContext.
      out.type = 'string'
      const description = resolveI18nText(schema.description, locale)
      out.description = description
        ? `${description} (workspace file reference id)`
        : 'workspace file reference id'
      if (schema.mimeType) {
        out.contentMediaType = Array.isArray(schema.mimeType) ? schema.mimeType[0] : schema.mimeType
      }
      break
    }
    case 'enum':
      out.type = 'string'
      out.enum = schema.values.map((v) => v.value)
      break
  }
  if (schema.type !== 'file') {
    const description = resolveI18nText(schema.description, locale)
    if (description) out.description = description
  }
  if (schema.default !== undefined) out.default = schema.default
  return out
}

/** Build the tool's top-level JSON Schema (object) from the skill's declared input slots. */
export function skillInputsToJsonSchema(
  inputs: readonly SkillInputSlot[],
  locale?: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const slot of inputs) {
    const property = skillSchemaToJsonSchema(slot.schema, locale)
    const slotDescription = resolveI18nText(slot.description, locale)
    if (slotDescription) property.description = slotDescription
    properties[slot.name] = property
    if (slot.required ?? slot.schema.required) required.push(slot.name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

/** Human-readable tool description combining the skill name, prose, and its triggers. */
function buildSkillToolDescription(def: SkillDefinition, locale?: string): string {
  const name = resolveI18nText(def.name, locale) ?? def.id
  const description = resolveI18nText(def.description, locale)
  const triggers = def.triggers?.length ? ` Triggers: ${def.triggers.join(', ')}.` : ''
  return `${name}${description ? `: ${description}` : ''}.${triggers}`.trim()
}

/** Default result serializer, driven by the skill's declared outputs. */
function defaultSkillOutputText(result: Record<string, unknown>, def: SkillDefinition): string {
  const declared = def.outputs?.map((o) => o.name) ?? []
  const present = declared.filter((name) => Object.prototype.hasOwnProperty.call(result, name))
  // A declared string output is the skill's primary result (e.g. a summary);
  // prefer it over companion metadata outputs like a token count.
  const primary = present.find((name) => typeof result[name] === 'string')
  if (primary !== undefined) return result[primary] as string
  if (present.length) {
    return present.map((name) => `${name}: ${valueToText(result[name])}`).join('\n')
  }
  return JSON.stringify(result, null, 2)
}

/**
 * Project one `SkillDefinition` onto an AgentLoop tool: its id becomes the tool
 * name, its input slots become the tool JSON Schema, and `execute` becomes the
 * executor. This is the lower-level half of `adaptSkillPackage`.
 */
export function skillDefinitionToTool(
  def: SkillDefinition,
  options: SkillPackageAdapterOptions,
): AdaptedSkillTool {
  const { locale } = options
  const toolName = options.toolName ?? defaultSkillToolName(def.id)
  const tool: AgentToolDef = {
    name: toolName,
    description: buildSkillToolDescription(def, locale),
    inputSchema: skillInputsToJsonSchema(def.inputs, locale),
  }
  const summary = resolveI18nText(def.name, locale) ?? toolName
  const formatOutput = options.formatOutput ?? defaultSkillOutputText
  const mutated = options.mutated ?? false

  const executeTool = async (call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution> => {
    if (signal?.aborted) {
      return { output: 'the run was cancelled before the skill started', summary, isError: true }
    }
    try {
      const context = options.createContext(call, signal)
      const result = await def.execute(context, call.input ?? {})
      return {
        output: formatOutput(result, def),
        summary,
        ...(mutated ? { mutated: true } : {}),
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        summary,
        isError: true,
      }
    }
  }

  return { tool, executeTool }
}

/**
 * Wrap a marketplace `SkillPackage` as an `AgentSkill` AgentLoop can consume.
 * One package (a single `SkillDefinition`) becomes a one-tool skill whose system
 * prompt names and targets that tool.
 */
export function adaptSkillPackage(
  pkg: SkillPackage,
  options: SkillPackageAdapterOptions,
): AgentSkill {
  const def = pkg.skill
  const { tool, executeTool } = skillDefinitionToTool(def, options)
  const name = resolveI18nText(def.name, options.locale) ?? def.id
  const description = resolveI18nText(def.description, options.locale)
  const triggers = def.triggers?.length ? `Triggers: ${def.triggers.join(', ')}.` : ''
  const systemPrompt = [
    `Marketplace skill "${name}" (${def.id}).`,
    description,
    triggers,
    `Call the \`${tool.name}\` tool when the request matches this skill.`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
  return {
    id: def.id,
    systemPrompt,
    tools: [tool],
    executeTool,
  }
}

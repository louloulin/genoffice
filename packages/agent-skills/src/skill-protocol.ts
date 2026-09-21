/**
 * Skill Protocol — sdk1.md §3.2.
 *
 * A Skill is a self-contained AI capability published by GenOffice or by
 * third parties. Skills are versioned, multi-locale, typed (input /
 * output schemas), and discoverable through triggers.
 *
 * Two ways to ship a Skill:
 *
 *   1. **In-repo**: as a folder under `packages/agent-skills/src/skills/`
 *      exporting a `SkillDefinition` from a typed manifest.
 *
 *   2. **Marketplace**: as an npm package
 *      (`@genoffice/skill-legal-contract-review`) implementing the
 *      `SkillPackage` shape. The skill market loader picks them up via
 *      `genoffice.skills.json` at boot.
 *
 * Stability:
 *   - `SkillDefinition` fields are frozen at v1.x. Adding optional fields
 *     is allowed; renaming or removing required fields is a breaking change.
 *   - `SkillContext` is the bridge between the Skill and the host runtime
 *     (LLM, KV storage, progress emitter). New optional methods may be
 *     added at minor versions.
 */

import type { AgentMessage } from '@genoffice/ai-provider'

// ──────────────────────────────────────────────────────────────────────────────
// I18n strings
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Localised string table. Keys are BCP-47 tags; values are plain strings
 * (markdown allowed). The loader resolves the best match against the
 * user's locale at execute time.
 */
export type I18nString = Record<string, string>

// ──────────────────────────────────────────────────────────────────────────────
// Schema types
// ──────────────────────────────────────────────────────────────────────────────

export type SkillSchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'file' | 'enum'

export interface SkillSchemaBase {
  type: SkillSchemaType
  /** Human-readable label in the user's locale (fallback to name). */
  label?: I18nString
  description?: I18nString
  required?: boolean
  /** Default value when the user omits the input. */
  default?: unknown
}

export interface SkillStringSchema extends SkillSchemaBase { type: 'string'; minLength?: number; maxLength?: number; pattern?: string }
export interface SkillNumberSchema extends SkillSchemaBase { type: 'number'; min?: number; max?: number; integer?: boolean }
export interface SkillBooleanSchema extends SkillSchemaBase { type: 'boolean' }
export interface SkillArraySchema extends SkillSchemaBase { type: 'array'; items: SkillSchema; minItems?: number; maxItems?: number }
export interface SkillObjectSchema extends SkillSchemaBase { type: 'object'; properties: Record<string, SkillSchema>; additionalProperties?: boolean }
export interface SkillFileSchema extends SkillSchemaBase { type: 'file'; mimeType?: string | string[]; maxSize?: number }
export interface SkillEnumSchema extends SkillSchemaBase { type: 'enum'; values: Array<{ value: string; label?: I18nString }> }

export type SkillSchema =
  | SkillStringSchema
  | SkillNumberSchema
  | SkillBooleanSchema
  | SkillArraySchema
  | SkillObjectSchema
  | SkillFileSchema
  | SkillEnumSchema

// ──────────────────────────────────────────────────────────────────────────────
// Outputs
// ──────────────────────────────────────────────────────────────────────────────

export interface SkillOutput {
  name: string
  schema: SkillSchema
  /** When true the output is rendered as a downloadable file (rather than inline). */
  downloadable?: boolean
}

// ──────────────────────────────────────────────────────────────────────────────
// File reference (the workspace layer hands these to skills)
// ──────────────────────────────────────────────────────────────────────────────

export interface FileRef {
  /** Stable id in the workspace; resolvable via `ctx.workspace.open(id)`. */
  id: string
  /** Human-readable filename. */
  name: string
  mimeType: string
  /** Bytes (small files only; large files are streamed via `open()`). */
  bytes?: Uint8Array
  /** Hint about the file's purpose: `source`, `attachment`, `output`, `template`. */
  role?: string
}

// ──────────────────────────────────────────────────────────────────────────────
// KV storage
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight key-value storage scoped to the current Skill invocation.
 * Skills use this for scratch state (cache, intermediate results, undo
 * stacks). The runtime persists the KV between calls when `persistent: true`.
 */
export interface SkillKVStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  has(key: string): Promise<boolean>
  /** Clear every key in the current namespace. */
  clear(): Promise<void>
}

// ──────────────────────────────────────────────────────────────────────────────
// Progress events
// ──────────────────────────────────────────────────────────────────────────────

export type ProgressPhase = 'queued' | 'started' | 'progress' | 'log' | 'completed' | 'failed'

export interface ProgressEvent {
  phase: ProgressPhase
  /** 0..1 completion ratio; `undefined` means indeterminate. */
  progress?: number
  /** Free-form status message in the user's locale. */
  message?: string
  /** When `phase === 'log'`, the log line text. */
  log?: string
  /** When `phase === 'failed'`, the structured error. */
  error?: { code: string; message: string }
  /** Wall-clock timestamp (ms). */
  ts?: number
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill context (the bridge between the skill and the host runtime)
// ──────────────────────────────────────────────────────────────────────────────

export interface SkillUser {
  id: string
  locale: string
  /** Capability strings the user has granted (e.g. `files:read`, `kb:search`). */
  permissions: string[]
}

export interface SkillWorkspace {
  files: FileRef[]
  currentFile?: FileRef
  /** Read a file by id; throws `SkillError` with code `NOT_FOUND` when missing. */
  open(id: string): Promise<FileRef>
}

export interface SkillLlm {
  /** One-shot chat. */
  chat(messages: AgentMessage[], options?: { model?: string; temperature?: number }): Promise<{ content: string }>
  /** Token-by-token streaming. */
  streamChat(messages: AgentMessage[], options?: { model?: string; temperature?: number }): AsyncIterable<{ delta: string; type: 'delta' | 'done' | 'error' }>
}

export interface SkillContext {
  /** Stable per-invocation id (UUID). */
  invocationId: string
  user: SkillUser
  workspace: SkillWorkspace
  llm: SkillLlm
  storage: SkillKVStore
  emitProgress: (event: ProgressEvent) => void
  /** Cancel the current invocation; future progress events are dropped. */
  cancel(): void
  /** Whether a cancel has been requested. */
  readonly cancelled: boolean
}

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// Input slot
// ──────────────────────────────────────────────────────────────────────────────

export interface SkillInputSlot {
  name: string
  schema: SkillSchema
  required?: boolean
  description?: I18nString
}

// ──────────────────────────────────────────────────────────────────────────────
// SkillDefinition — the manifest
// ──────────────────────────────────────────────────────────────────────────────

export interface SkillDefinition<I extends Record<string, SkillSchema> = Record<string, SkillSchema>, O extends Record<string, SkillSchema> = Record<string, SkillSchema>> {
  /** Reverse-DNS id, e.g. `genoffice.skill.doc-format`. */
  id: string
  /** Semver; v1.x.x is current. */
  version: string
  name: I18nString
  description: I18nString
  /** Trigger phrases that activate the skill. Matched against the user's
   *  utterance (case-insensitive substring); at least one is required. */
  triggers: string[]
  /** Inputs the Skill accepts. Each entry is `{ name, schema, required?, description? }`. */
  inputs: SkillInputSlot[]
  outputs: SkillOutput[]
  /** Other skills this skill depends on. */
  tools?: string[]
  /** Permissions the skill requests from the user. */
  requiredPermissions?: string[]
  /** Tags for marketplace search (`legal`, `formatting`, …). */
  tags?: string[]
  /** Markdown readme shown on the marketplace card. */
  readme?: string
  /**
   * The Skill implementation. Receives validated inputs and returns outputs
   * matching the declared output schemas.
   */
  execute: (ctx: SkillContext, inputs: Record<string, unknown>) => Promise<Record<string, unknown>>
}

// ──────────────────────────────────────────────────────────────────────────────
// SkillPackage — what npm-published skills export
// ──────────────────────────────────────────────────────────────────────────────

/** An npm-published Skill package exports this shape as its default. */
export interface SkillPackage {
  /** Single Skill per package; multi-Skill packages should be split. */
  skill: SkillDefinition
  /** Optional registration hook (analytics, license check, …). */
  onInstall?(): Promise<void>
  /** Optional teardown hook. */
  onUninstall?(): Promise<void>
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill registry
// ──────────────────────────────────────────────────────────────────────────────

export interface SkillRegistry {
  register(def: SkillDefinition): void
  unregister(id: string): boolean
  list(): SkillDefinition[]
  get(id: string): SkillDefinition | undefined
  /** Look up Skills by trigger substring (case-insensitive). */
  match(trigger: string): SkillDefinition | undefined
  /** Look up Skills by tag. */
  byTag(tag: string): SkillDefinition[]
}

export function createSkillRegistry(): SkillRegistry {
  const byId = new Map<string, SkillDefinition>()
  return {
    register(def) {
      if (!def || typeof def.id !== 'string' || !def.id) throw new Error('SkillDefinition: id required')
      if (typeof def.execute !== 'function') throw new Error(`SkillDefinition "${def.id}": execute must be a function`)
      if (!Array.isArray(def.triggers) || def.triggers.length === 0) {
        throw new Error(`SkillDefinition "${def.id}": triggers must be a non-empty array`)
      }
      byId.set(def.id, def)
    },
    unregister(id) { return byId.delete(id) },
    list() { return [...byId.values()] },
    get(id) { return byId.get(id) },
    match(trigger) {
      const needle = trigger.toLowerCase()
      for (const def of byId.values()) {
        if (def.triggers.some((t) => needle.includes(t.toLowerCase()))) return def
      }
      return undefined
    },
    byTag(tag) {
      return [...byId.values()].filter((d) => Array.isArray(d.tags) && d.tags.includes(tag))
    },
  }
}

/**
 * The default shared registry — same singleton pattern as
 * `getDefaultProviderRegistry` from `@genoffice/ai-provider`.
 */
let defaultRegistry: SkillRegistry | null = null

export function getDefaultSkillRegistry(): SkillRegistry {
  if (!defaultRegistry) defaultRegistry = createSkillRegistry()
  return defaultRegistry
}

/** For tests: reset the default registry to a fresh empty one. */
export function resetDefaultSkillRegistry(): void {
  defaultRegistry = null
}

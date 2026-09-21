/**
 * Marketplace loader — reads `genoffice.providers.json` and
 * `genoffice.skills.json` at boot and dynamically imports each listed
 * module, registering its default export into the appropriate plugin
 * registry (`AiProviderPlugin` for providers, `SkillPackage` for skills).
 *
 * Config file locations (first match wins):
 *   1. `$GENOFFICE_PROVIDERS_CONFIG` / `$GENOFFICE_SKILLS_CONFIG`
 *   2. `<DATA_DIR>/genoffice.providers.json` / `genoffice.skills.json`
 *   3. `<cwd>/genoffice.providers.json` / `genoffice.skills.json`
 *   4. `<repo>/genoffice.providers.json` / `genoffice.skills.json`
 *
 * Config shape:
 *   {
 *     "providers": [
 *       { "name": "@scope/my-plugin", "version": "^1.0.0" }
 *     ]
 *   }
 *
 * The loader calls `import(name)` which works for:
 *   - npm packages with a `main` / `exports.default` entry
 *   - relative file paths starting with `./` or `../`
 *   - absolute file paths
 *
 * Failed imports are logged as warnings but do NOT abort boot — the
 * built-in providers / skills continue to work, the operator just doesn't
 * get the third-party extension.
 *
 * Stability:
 *   The marketplace loader is v1-stable: its public surface
 *   (loadMarketplace / listLoadedProviders / listLoadedSkills) is part of
 *   the SDK / API contract for third-party plugin authors.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AiProviderPlugin, ProviderRegistry, MediaRegistry, SearchRegistry } from '@genoffice/ai-provider'
import type { SkillDefinition, SkillPackage, SkillRegistry } from '@genoffice/agent-skills'

export interface MarketplaceEntry {
  /** npm package name (`@scope/plugin`), relative path (`./plugin.js`), or absolute path. */
  name: string
  /** Semver range; informational only — the loader uses `import(name)` which picks the resolved version. */
  version?: string
  /** Optional override for the registered plugin id (e.g. register the same compatible-provider under multiple ids). */
  overrideId?: string
  /** Extra fields merged into the spread of the plugin (only used when the module exports a single AiProviderPlugin). */
  pluginOverrides?: Partial<AiProviderPlugin>
}

export interface MarketplaceConfig {
  providers?: MarketplaceEntry[]
  skills?: MarketplaceEntry[]
}

export interface LoadedProvider {
  entry: MarketplaceEntry
  plugin: AiProviderPlugin
  /** Resolved module specifier for diagnostics. */
  resolvedAs: string
}

export interface LoadedSkill {
  entry: MarketplaceEntry
  definition: SkillDefinition
  resolvedAs: string
}

export interface MarketplaceLoadResult {
  providers: LoadedProvider[]
  skills: LoadedSkill[]
  errors: Array<{ entry: MarketplaceEntry; error: string }>
}

interface LoaderOptions {
  providersRegistry?: ProviderRegistry
  mediaRegistry?: MediaRegistry
  searchRegistry?: SearchRegistry
  skillRegistry?: SkillRegistry
  /** Override the search root (used by tests). */
  searchRoots?: string[]
  /** Override the env-var keys (used by tests). */
  envProviderKey?: string
  envSkillKey?: string
}

const DEFAULT_ENV_PROVIDER_KEY = 'GENOFFICE_PROVIDERS_CONFIG'
const DEFAULT_ENV_SKILL_KEY = 'GENOFFICE_SKILLS_CONFIG'

function deriveRepoRoot(): string {
  try {
    const url = fileURLToPath(import.meta.url)
    return resolve(dirname(url), '..', '..', '..', '..')
  } catch {
    return process.cwd()
  }
}

function defaultSearchRoots(): string[] {
  const roots: string[] = []
  if (process.env.DATA_DIR) roots.push(process.env.DATA_DIR)
  roots.push(process.cwd())
  roots.push(deriveRepoRoot())
  return roots
}

function readConfig(path: string): MarketplaceConfig | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = JSON.parse(text) as MarketplaceConfig
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch (err) {
    console.warn(`[marketplace] failed to parse ${path}:`, (err as Error).message)
    return null
  }
}

/** Resolve a marketplace config file by trying env var first, then the supplied roots. */
export function resolveMarketplaceConfig(
  filename: 'genoffice.providers.json' | 'genoffice.skills.json',
  roots: string[],
  envKey: string,
): { path: string; config: MarketplaceConfig } | null {
  const envPath = process.env[envKey]
  if (envPath) {
    const config = readConfig(envPath)
    if (config) return { path: envPath, config }
  }
  for (const root of roots) {
    const p = join(root, filename)
    const config = readConfig(p)
    if (config) return { path: p, config }
  }
  return null
}

async function importEntry(entry: MarketplaceEntry): Promise<unknown> {
  if (entry.name.startsWith('./') || entry.name.startsWith('../') || isAbsolute(entry.name)) {
    return import(/* @vite-ignore */ entry.name)
  }
  // Bare specifier (`@scope/pkg`) — let Node resolve via node_modules.
  return import(entry.name)
}

function asAiProvider(value: unknown): AiProviderPlugin | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (
    typeof obj.id === 'string' &&
    typeof obj.label === 'string' &&
    Array.isArray(obj.models) &&
    typeof obj.defaultModel === 'string' &&
    typeof obj.chat === 'function' &&
    typeof obj.streamChat === 'function'
  ) {
    return value as AiProviderPlugin
  }
  return null
}

function asSkillPackage(value: unknown): SkillPackage | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const skill = obj.skill as SkillDefinition | undefined
  if (
    skill &&
    typeof skill.id === 'string' &&
    typeof skill.execute === 'function' &&
    Array.isArray(skill.inputs) &&
    Array.isArray(skill.outputs)
  ) {
    return value as SkillPackage
  }
  return null
}

export async function loadMarketplace(opts: LoaderOptions = {}): Promise<MarketplaceLoadResult> {
  const roots = opts.searchRoots ?? defaultSearchRoots()
  const envProviderKey = opts.envProviderKey ?? DEFAULT_ENV_PROVIDER_KEY
  const envSkillKey = opts.envSkillKey ?? DEFAULT_ENV_SKILL_KEY

  const result: MarketplaceLoadResult = { providers: [], skills: [], errors: [] }

  const providersConfig = resolveMarketplaceConfig('genoffice.providers.json', roots, envProviderKey)
  if (providersConfig) {
    for (const entry of providersConfig.config.providers ?? []) {
      try {
        const mod = await importEntry(entry)
        const candidates = [
          asAiProvider((mod as { default?: unknown })?.default),
          asAiProvider(mod),
        ].filter((c): c is AiProviderPlugin => c !== null)
        const plugin = candidates[0]
        if (!plugin) {
          result.errors.push({
            entry,
            error: 'module did not export an AiProviderPlugin (default or named)',
          })
          continue
        }
        // Apply overrides
        const finalPlugin: AiProviderPlugin = {
          ...plugin,
          ...(entry.pluginOverrides ?? {}),
          ...(entry.overrideId ? { id: entry.overrideId } : {}),
        }
        opts.providersRegistry?.register(finalPlugin)
        result.providers.push({ entry, plugin: finalPlugin, resolvedAs: entry.name })
      } catch (err) {
        result.errors.push({ entry, error: (err as Error).message })
      }
    }
  }

  const skillsConfig = resolveMarketplaceConfig('genoffice.skills.json', roots, envSkillKey)
  if (skillsConfig) {
    for (const entry of skillsConfig.config.skills ?? []) {
      try {
        const mod = await importEntry(entry)
        const candidates = [
          asSkillPackage((mod as { default?: unknown })?.default),
          asSkillPackage(mod),
        ].filter((c): c is SkillPackage => c !== null)
        const pkg = candidates[0]
        if (!pkg) {
          result.errors.push({
            entry,
            error: 'module did not export a SkillPackage (default or named)',
          })
          continue
        }
        opts.skillRegistry?.register(pkg.skill)
        result.skills.push({ entry, definition: pkg.skill, resolvedAs: entry.name })
      } catch (err) {
        result.errors.push({ entry, error: (err as Error).message })
      }
    }
  }

  return result
}

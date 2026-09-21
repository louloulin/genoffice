import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadMarketplace,
  resolveMarketplaceConfig,
  type MarketplaceLoadResult,
} from '../src/common/marketplace-loader'

const TMP = mkdtempSync(join(tmpdir(), 'marketplace-'))

beforeEach(() => {
  // Each test gets its own subdir under TMP
})

afterEach(() => {
  vi.restoreAllMocks()
  // Reset env vars we may have set
  delete process.env.GENOFFICE_PROVIDERS_CONFIG
  delete process.env.GENOFFICE_SKILLS_CONFIG
})

describe('marketplace-loader', () => {
  it('returns empty result when no config files exist', async () => {
    const r = await loadMarketplace({ searchRoots: [TMP] })
    expect(r.providers).toEqual([])
    expect(r.skills).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('loads providers from a JSON config file', async () => {
    const dir = join(TMP, 'p1')
    mkdirSync(dir, { recursive: true })
    const cfg = {
      providers: [{ name: '@genoffice/provider-anthropic' }],
    }
    writeFileSync(join(dir, 'genoffice.providers.json'), JSON.stringify(cfg))

    const providers: Array<{ id: string; label: string }> = []
    const r = await loadMarketplace({
      searchRoots: [dir],
      providersRegistry: { register: (p) => providers.push({ id: p.id, label: p.label }) },
    } as never)
    expect(r.providers.length).toBe(1)
    expect(providers[0].id).toBe('anthropic')
    expect(providers[0].label).toBe('Anthropic (Claude)')
    expect(r.errors).toEqual([])
  })

  it('loads skills from a JSON config file', async () => {
    const dir = join(TMP, 's1')
    mkdirSync(dir, { recursive: true })
    const cfg = {
      skills: [{ name: '@genoffice/skill-markdown-format' }],
    }
    writeFileSync(join(dir, 'genoffice.skills.json'), JSON.stringify(cfg))

    const skills: Array<{ id: string }> = []
    const r = await loadMarketplace({
      searchRoots: [dir],
      skillRegistry: { register: (def) => skills.push({ id: def.id }) },
    } as never)
    expect(r.skills.length).toBe(1)
    expect(skills[0].id).toBe('genoffice.skill.markdown-format')
    expect(r.errors).toEqual([])
  })

  it('collects errors instead of throwing for missing packages', async () => {
    const dir = join(TMP, 'p2')
    mkdirSync(dir, { recursive: true })
    const cfg = {
      providers: [{ name: '@scope/does-not-exist' }],
    }
    writeFileSync(join(dir, 'genoffice.providers.json'), JSON.stringify(cfg))

    const r = await loadMarketplace({ searchRoots: [dir] })
    expect(r.providers).toEqual([])
    expect(r.errors.length).toBe(1)
    expect(r.errors[0].entry.name).toBe('@scope/does-not-exist')
  })

  it('reads env var override for providers config', async () => {
    const customPath = join(TMP, 'env-provider.json')
    writeFileSync(customPath, JSON.stringify({ providers: [{ name: '@genoffice/provider-anthropic' }] }))
    process.env.GENOFFICE_PROVIDERS_CONFIG = customPath

    const seen: string[] = []
    const r = await loadMarketplace({
      searchRoots: [TMP],
      providersRegistry: { register: (p) => seen.push(p.id) },
    } as never)
    expect(r.providers.length).toBe(1)
    expect(seen).toEqual(['anthropic'])
  })

  it('applies overrideId to the registered plugin id', async () => {
    const dir = join(TMP, 'p3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'genoffice.providers.json'),
      JSON.stringify({
        providers: [
          {
            name: '@genoffice/provider-openai-compatible',
            overrideId: 'together',
          },
        ],
      }),
    )
    const seen: Array<{ id: string; models: string[] }> = []
    const r = await loadMarketplace({
      searchRoots: [dir],
      providersRegistry: {
        register: (p) => seen.push({ id: p.id, models: [...p.models] }),
      },
    } as never)
    // The compatible plugin ships empty models; the override should apply the new id.
    expect(r.providers.length).toBe(1)
    expect(seen[0].id).toBe('together')
  })

  it('resolveMarketplaceConfig returns null when no file exists', () => {
    expect(resolveMarketplaceConfig('genoffice.providers.json', [TMP], 'X')).toBeNull()
  })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

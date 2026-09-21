# Third-Party Marketplace

The GenOffice web-server loads third-party LLM providers and Skills at boot
via two JSON config files. Both files are optional — the server ships with
first-party providers (Anthropic, OpenAI, Gemini, OpenAI-compatible, Ollama)
and Skills out of the box.

## Config locations

The loader searches in this order:

1. `$GENOFFICE_PROVIDERS_CONFIG` / `$GENOFFICE_SKILLS_CONFIG` (env var, full path)
2. `$DATA_DIR/genoffice.providers.json` / `genoffice.skills.json`
3. `<cwd>/genoffice.providers.json` / `genoffice.skills.json`
4. `<repo>/genoffice.providers.json` / `genoffice.skills.json`

First match wins.

## Provider config

`genoffice.providers.json`:

```json
{
  "providers": [
    {
      "name": "@scope/my-provider",
      "version": "^1.0.0"
    },
    {
      "name": "@genoffice/provider-openai-compatible",
      "overrideId": "together",
      "pluginOverrides": {
        "label": "Together.ai",
        "models": ["meta-llama/Llama-3.1-70B-Instruct-Turbo"],
        "defaultModel": "meta-llama/Llama-3.1-70B-Instruct-Turbo"
      }
    }
  ]
}
```

The `name` field is anything Node can `import()`:

- npm package name (`@genoffice/provider-…` / `@scope/plugin` / `lodash`)
- relative path (`./plugin.js` / `../packages/local`)
- absolute path (`/opt/genoffice-plugins/prod.js`)

`overrideId` lets a single package register multiple vendors (e.g. the
generic OpenAI-compatible plugin becomes `together`, `groq`, `fireworks`,
etc.).

`pluginOverrides` spreads into the plugin's identity, useful for
multi-vendor registration.

## Skill config

`genoffice.skills.json`:

```json
{
  "skills": [
    { "name": "@genoffice/skill-markdown-format" },
    { "name": "@genoffice/skill-text-translate-pairs" },
    { "name": "@scope/legal-custom-skill", "version": "^1.0.0" }
  ]
}
```

## Boot logs

Successful loads are logged at boot:

```
[marketplace] loaded 2 provider(s): anthropic, together
[marketplace] loaded 2 skill(s): genoffice.skill.markdown-format, genoffice.skill.text-translate-pairs
```

Failures are logged as warnings but do not abort boot:

```
[marketplace] 1 failed to load:
[marketplace]   - @scope/missing: Cannot find package '@scope/missing'
```

## Programmatic loader

The same loader is exported for tests and embedded use:

```ts
import { loadMarketplace } from '@genoffice/web-server/common/marketplace-loader'
import { getDefaultProviderRegistry, getDefaultSkillRegistry } from '@genoffice/ai-provider'

const result = await loadMarketplace({
  providersRegistry: getDefaultProviderRegistry(),
  skillRegistry: getDefaultSkillRegistry(),
  searchRoots: ['/etc/genoffice'],
})

console.log(result.providers.map((p) => p.plugin.id))
console.log(result.skills.map((s) => s.definition.id))
console.log(result.errors)
```

## See also

- [Provider Plugins](/api/provider-plugins) — the `AiProviderPlugin` contract
- [AI & Skills Protocol](/api/ai-skills-protocol) — the `SkillPackage` contract
- [Authoring Guide](/skills/authoring) — how to ship your own Skill

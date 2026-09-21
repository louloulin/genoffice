# 第三方市场

GenOffice web-server 在启动时通过两份 JSON 配置文件加载第三方 LLM provider 与 Skill。两份文件都是可选的——服务端默认带了一方 provider（Anthropic、OpenAI、Gemini、OpenAI-compatible、Ollama）和 Skill。

## 配置文件位置

加载器按以下顺序查找：

1. `$GENOFFICE_PROVIDERS_CONFIG` / `$GENOFFICE_SKILLS_CONFIG`（环境变量，完整路径）
2. `$DATA_DIR/genoffice.providers.json` / `genoffice.skills.json`
3. `<cwd>/genoffice.providers.json` / `genoffice.skills.json`
4. `<repo>/genoffice.providers.json` / `genoffice.skills.json`

首个命中的文件生效。

## Provider 配置

`genoffice.providers.json`：

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

`name` 字段是 Node 可以 `import()` 的任何东西：

- npm 包名（`@genoffice/provider-…` / `@scope/plugin` / `lodash`）
- 相对路径（`./plugin.js` / `../packages/local`）
- 绝对路径（`/opt/genoffice-plugins/prod.js`）

`overrideId` 让单个包能注册多个供应商（例如通用的 OpenAI-compatible 插件分别变成 `together` / `groq` / `fireworks` 等）。

`pluginOverrides` 会展开到插件身份字段，便于多供应商注册。

## Skill 配置

`genoffice.skills.json`：

```json
{
  "skills": [
    { "name": "@genoffice/skill-markdown-format" },
    { "name": "@genoffice/skill-text-translate-pairs" },
    { "name": "@scope/legal-custom-skill", "version": "^1.0.0" }
  ]
}
```

## 启动日志

加载成功会在启动日志输出：

```
[marketplace] loaded 2 provider(s): anthropic, together
[marketplace] loaded 2 skill(s): genoffice.skill.markdown-format, genoffice.skill.text-translate-pairs
```

加载失败会以警告形式输出，但**不会**中断启动：

```
[marketplace] 1 failed to load:
[marketplace]   - @scope/missing: Cannot find package '@scope/missing'
```

## 程序化加载器

同一加载器也导出供测试与嵌入式使用：

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

## 延伸阅读

- [Provider 插件](/zh/api/provider-plugins) — `AiProviderPlugin` 契约
- [AI & Skills 协议](/zh/api/ai-skills-protocol) — `SkillPackage` 契约
- [Skill 编写指南](/zh/skills/authoring) — 如何发布你自己的 Skill

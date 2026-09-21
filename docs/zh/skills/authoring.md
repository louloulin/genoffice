# 编写 Skill

Skill 是 GenOffice 中 AI 扩展的最小单元。每个 Skill 是一项单一、有类型的能⼒——摘要、翻译、校验 YAML 等等。Skill 存在于两类位置：

1. **内置** —— 在 `packages/agent-skills/src/extensions/` 下（传统的 pi-runtime 扩展，仅限 monorepo 内）。
2. **市场** —— 实现 `@genoffice/agent-skills` 中 `SkillPackage` 的独立 npm 包。宿主通过 `genoffice.skills.json` 在启动时加载。

本指南聚焦市场路径。

## `SkillDefinition` 契约

```ts
import type { SkillContext, SkillDefinition, SkillPackage } from '@genoffice/agent-skills'

const skill: SkillDefinition = {
  id: 'genoffice.skill.my-skill',
  version: '0.1.0',
  name: { 'en-US': 'My Skill', 'zh-CN': '我的技能' },
  description: { 'en-US': '…', 'zh-CN': '…' },
  triggers: ['do thing', '做某事'],
  inputs: [
    { name: 'text', schema: { type: 'string', required: true }, required: true },
  ],
  outputs: [
    { name: 'result', schema: { type: 'string' } },
  ],
  execute: async (ctx, inputs) => {
    const text = inputs.text as string
    const res = await ctx.llm.chat([{ role: 'user', text }])
    return { result: res.content ?? '' }
  },
}

const pkg: SkillPackage = { skill }
export default pkg
```

`execute` 收到的 `SkillContext` 包含：

- `ctx.llm.chat(messages, opts)` —— 单次聊天补全
- `ctx.llm.streamChat(messages, opts)` —— token 流
- `ctx.storage` —— 限定本次调用的 KV 存储
- `ctx.workspace` —— 用户授权的文件引用
- `ctx.user.permissions` —— 授予用户的权限串
- `ctx.emitProgress(event)` —— 向 UI 抛进度事件
- `ctx.cancel()` —— 中止正在执行的调用

## 用 `SkillError` 表达结构化错误

对任何失败抛 `SkillError(code, message, details?)`。web-server 会把它们映射到结构化 REST 错误：

```ts
throw new SkillError('INVALID_ARGUMENT', 'text must be non-empty')
throw new SkillError('PROVIDER_FAILURE', 'openai rate-limited')
```

错误码：`INVALID_ARGUMENT` / `PERMISSION_DENIED` / `NOT_FOUND` / `TIMEOUT` / `CANCELLED` / `PROVIDER_FAILURE` / `INTERNAL`。

## 包结构

```
my-skill/
├── package.json          # peerDeps: { "@genoffice/agent-skills": "*" }
├── tsconfig.json
├── vitest.config.ts
├── scripts/build.mjs     # tsc + esbuild
├── README.md
├── src/
│   └── index.ts          # 导出 SkillPackage
└── tests/
    └── skill.test.ts
```

用 `tsc && node scripts/build.mjs` 构建。包同时发 ESM + CJS + `.d.ts`，可工作于 Node、浏览器打包器、TS 工程。

## 通过市场加载

把 `genoffice.skills.json` 放在工程根、`$DATA_DIR` 下，或设置 `GENOFFICE_SKILLS_CONFIG=/path/to/config.json`：

```json
{
  "skills": [
    { "name": "@genoffice/skill-markdown-format" },
    { "name": "@scope/my-private-skill", "version": "^1.0.0" }
  ]
}
```

web-server 在启动时解析每条记录，动态 `import()` 模块，并把默认导出的 `skill` 属性注册进 `POST /api/v1/ai/skill/:name` 暴露的 `SkillRegistry`。加载失败只记日志，从不阻塞启动。

## 程序化加载

```ts
import { createSkillRegistry } from '@genoffice/agent-skills'
import { skill as markdownFormat } from '@genoffice/skill-markdown-format'

const registry = createSkillRegistry()
registry.register(markdownFormat)
```

## 测试 Skill

`SkillContext` 很容易 mock —— 见 `packages/skill-*/tests/` 里标准模式。

## 延伸阅读

- [协议参考](/zh/api/ai-skills-protocol)
- [官方 Skill 市场](/zh/skills/official)
- [编写示例](https://github.com/genspark-ai/genoffice/tree/main/examples/custom-skill)

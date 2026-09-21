# FAQ

## What's the difference between GenOffice and Google Docs / WPS / OnlyOffice?

| | GenOffice | Google Docs | WPS | OnlyOffice |
|---|---|---|---|---|
| Open-source core | ✅ Apache-2.0 | ❌ | ❌ (AI closed) | ✅ AGPL |
| iframe Embed | ✅ | ❌ | ❌ enterprise only | ⚠️ Enterprise |
| AI in core | ✅ 12 providers | ⚠️ Gemini only | ⚠️ WPS AI only | ⚠️ plugin |
| Self-hostable | ✅ single binary | ❌ | ❌ | ✅ Docker |
| Provider plugins | ✅ | ❌ | ❌ | ❌ |
| Skill ecosystem | ✅ | ❌ | ❌ | ❌ |

## How do I migrate from OnlyOffice?

1. Export your OnlyOffice documents (DOCX/XLSX/PPTX round-trip).
2. Start a GenOffice web-server (Docker image or `npx`).
3. Upload through `POST /api/v1/files`.
4. Embed via `GET /embed/:docId?token=…` or call the SDK.

## Can I run GenOffice without internet?

Yes. The bundled web-server has zero outbound dependencies. AI
providers do require outbound access (or a self-hosted LLM endpoint).

## What's the licence?

Apache-2.0 for the core monorepo, the Web SDK, the REST API, and
every documented public surface. The Docker image and npm packages
ship under the same licence.

## How do I report a security bug?

Email **security@genoffice.app** — see
[`SECURITY.md`](https://github.com/genspark-ai/genoffice/blob/main/SECURITY.md).

## How do I add a new LLM provider?

Implement `AiProviderPlugin` and publish an npm package under
`@genoffice/provider-<name>`. See
[Provider Plugins](/api/provider-plugins).

## How do I add a new AI Skill?

Implement `SkillDefinition` and publish an npm package under
`@genoffice/skill-<name>`. See
[AI Skills Protocol](/api/ai-skills-protocol).

## What's the storage format?

`.docx`, `.xlsx`, `.pptx`, `.pdf`, `.md`, `.html` are the open
formats GenOffice produces. KB / TM use the open `.genkb` and
`.gentm` archives (see [KB / TM Format](/api/kb-tm-format)).

## Is there a hosted version?

A hosted version is on the roadmap (M3). Until then, GenOffice is
self-hosted.

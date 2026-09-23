# Changelog

All notable changes to GenOffice are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Releases are tagged in git; the most recent tag is also the current
`@genoffice/*` package version on npm.

## [Unreleased]

### Fixed

- **comments `:id/comments` POST** — `parentId` must point to an existing
  comment on the same file; orphan replies are now rejected (400 / 404)
  instead of silently creating dangling pointers. (sdk1 §11.97)
- **webhooks `POST /api/v1/callbacks` (admin fire)** — failed deliveries
  are now pushed to the DLQ, mirroring the save-path behaviour.
  Previously admin-fired callbacks with 5xx receivers disappeared
  silently. (sdk1 §11.98)
- **KB `GET /api/v1/kb/search` / `/kb/entries`** — REST shim was
  dispatching to the wrong IPC handlers with mismatched field names
  (`{ term }` vs `{ query }`, `{ lang, domain }` vs `{ schema }`); every
  search returned `{ ok:false, error:"expected non-empty 'targetLang'" }`
  and `/entries` was silently no-op filtering. Now routed through
  `home:translate-kb-search` / `ai:translation-kb-list` with matching
  shapes and proper `limit` validation (1..1000 clamp + non-numeric 400).
  (sdk1 §11.100)
- **files `POST /api/v1/files/:id/callback`** — was silently registering
  per-file webhooks for nonexistent fileIds (returned `201 ok:true` even
  for `"nonexistent"`), creating dangling subscriptions that never fire.
  Now 404 NOT_FOUND on unknown fileId, mirroring the contract of
  `/files/:id/jwt`. (sdk1 §11.101)

### Added

- **Test infrastructure** — `ServerHarness` picks a randomised
  ephemeral port (20000..50000) so 4+ bundle e2e can run in parallel
  without collision. (sdk1 §11.97)
- **e2e lifecycle coverage** — 3 new bundle-bootstrapping e2e files
  exercise the full v1 happy path + negative branches:
  - `tests/files-comments-versions-lifecycle-e2e.test.ts` (23
    assertions) — files / comments / versions full CRUD + scope gates
    + cleanup. (sdk1 §11.96)
  - `tests/webhooks-lifecycle-e2e.test.ts` (14 assertions) — webhook
    subscribe / fire / DLQ-on-failure / unsubscribe / idempotent
    re-delete, with in-test HTTP receiver. (sdk1 §11.98)
  - `tests/embed-nonce-lifecycle-e2e.test.ts` (13 assertions) — embed
    nonce mint / verify / release / verify-after-release / TTL clamp
    / scope gates. (sdk1 §11.99)
  - `tests/comments-parent-id-validation-e2e.test.ts` (6 assertions)
    — pins the orphan-reply boundary added by §11.97 fix above.
  - `tests/kb-search-lifecycle-e2e.test.ts` (11 assertions) — pins
    the search / entries contract added by §11.100 fix above.
  - `tests/files-callback-404-e2e.test.ts` (4 assertions) — pins
    the unknown-fileId boundary added by §11.101 fix above.
  - `tests/public-meta-lifecycle-e2e.test.ts` (5 assertions) —
    locks the content-type + body-shape contract of the public
    health / meta / changelog / metrics endpoints (§2.1.A).
    (sdk1 §11.102)

### Changed

- **Public open release.** Apache-2.0 across the entire monorepo.
- **REST API v1** (`@genoffice/web-server`)
  - `POST /api/v1/auth/jwt` · `POST /api/v1/auth/oauth/token`
  - `GET` / `POST` / `DELETE` `/api/v1/files[/:id]`
  - `POST /api/v1/files/:id/jwt` · `POST /api/v1/files/:id/callback`
  - `GET /api/v1/ai/capabilities` · `POST /api/v1/ai/{chat,translate,image,skill/:name}`
  - `GET /api/v1/kb/search` · `GET /api/v1/kb/entries`
  - `POST /api/v1/webhooks` · `DELETE /api/v1/webhooks`
  - Stable v1 contract; backward-compatible inside v1.x.
- **`@genoffice/web-sdk`** — iframe Embed SDK with ESM / CJS / UMD
  bundles, typed events (`ready` / `saved` / `dirtyChanged` /
  `selectionChange` / `error` / `closed`) and commands
  (`setTheme` / `setContent` / `getContent` / `insertImage` /
  `insertText` / `print` / `focus` / `aiRewrite` / `aiTranslate` /
  `aiSummarize`).
- **iframe Embed endpoint** at `GET /embed/:docId?token=…` with a
  v1.0 `postMessage` bridge to the host page.
- **Webhook firing on every save.** `notifyFileSaved(path, { size,
  format })` is called by `docs:save`, `web:save-file`,
  `markdown:save`, `html:save`, `html:save-file`, `workbook:save`,
  `slides:save` (bytes branch), and `pdf:save` (final path from
  `publishPdfAfterSave`).
- **Provider plugin interface** (`@genoffice/ai-provider/src/provider-plugin.ts`).
  - `AiProviderPlugin` · `AiMediaPlugin` · `AiSearchPlugin`
  - `ProviderRegistry` · `MediaRegistry` · `SearchRegistry`
  - Third-party providers ship as `@genoffice/provider-<name>` npm
    packages.
- **Skill protocol** (`@genoffice/agent-skills/src/skill-protocol.ts`).
  - `SkillDefinition` · `SkillPackage` · `SkillContext`
  - JSON-schema-ish input / output types
  - `SkillError` with structured codes
  - Registry with trigger / tag matching
- **KB / TM open format** (`@genoffice/translation-core/src/kb-format.ts`).
  - `.genkb` archive (manifest + entries.jsonl + optional index.bin)
  - `.gentm` archive (manifest + pairs.jsonl)
  - Validators with `FormatError` surface
- **Agent protocol v1** (`@genoffice/agent-core/src/agent-protocol.ts`).
  - `genoffice.agent.v1` envelope
  - `AgentRunner` interface for third-party agent loops
  - `validateAgentRequest` for fail-fast parsing
- **IPC channel reference generator** — `tools/gen-ipc-docs.mjs`
  scans every `registerHandle` call and emits
  `apps/web-server/IPC_CHANNELS.md` (514 channels at HEAD).
- **Documentation site** — VitePress site at `docs/` with `guide/`,
  `api/`, `skills/`, `about/` sections.
- **Examples** — `examples/embed-basic/`, `embed-react/`,
  `embed-vue/`, `custom-provider/`, `custom-skill/`.
- **Community files** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`.
- **GitHub Actions** — `release.yml` (npm + Docker publish),
  `docs.yml` (Pages deploy), `security.yml` (CodeQL + npm audit +
  gitleaks).
- **Governance** — `GOVERNANCE.md` (Steering Committee + 5 WGs +
  RFC flow), `ROADMAP.md` (M0–M3 milestones).

### Changed

- **v1 dispatcher fix.** `apps/web-server/src/api/v1/index.ts`
  properly routes `/api/v1/files/:id/jwt` and
  `/api/v1/files/:id/callback` (previously fell through to the
  SPA fallback).
- **`<meta name="genoffice-token">` injection** in
  `apps/web-server/src/index.ts` is now case-insensitive
  (`<HEAD>` vs `</head>`).
- **`@genoffice/provider-anthropic`** — Claude provider plugin
  (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`).
- **`@genoffice/provider-openai`** — OpenAI provider plugin
  (`gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`).
- **`@genoffice/provider-gemini`** — Google Gemini provider plugin
  (`gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`).
- **`@genoffice/skill-markdown-format`** — Skill that normalises
  Markdown (headings, bullets, code fences, links, whitespace).
- **`@genoffice/skill-yaml-validate`** — Skill that validates YAML
  against a small JSON-schema-style rule set.
- **`AiProviderPlugin` / `SkillDefinition` / `SkillPackage` interfaces**
  in `@genoffice/ai-provider` and `@genoffice/agent-skills` for
  shipping third-party provider plugins and Skills as npm packages.
- **`AiMediaPlugin` / `AiSearchPlugin`** interfaces for image generation,
  media analysis, and web/image search backends.
- **Docker image** (`Dockerfile`, multi-stage Node 22, non-root `node`
  user, `/health` healthcheck, `/data` persistent volume).
- **GitHub community files** — `ROADMAP.md`, `GOVERNANCE.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `.github/CODEOWNERS`, `.github/dependabot.yml`, `.gitleaks.toml`.
- **GitHub Actions** — `release.yml`, `docs.yml`, `security.yml`.
- **VitePress docs site** under `docs/` with guide / api / skills
  sections, EN + ZH content.

## [0.8.0] — internal preview

- Six editors (docs, sheets, slides, pdf, markdown, html) shipped as
  Electron shell + standalone web-server.
- 546 IPC channels.
- 12 LLM providers wired via `@genoffice/ai-provider`.
- Apache-2.0 declared across the monorepo.


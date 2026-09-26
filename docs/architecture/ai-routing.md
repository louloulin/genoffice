# AI Routing

Every LLM call in web-server goes through `chatForProvider` from
`@genoffice/ai-provider`. This page documents how a provider is chosen, the
one path where environment variables can influence it, and what is (and is
not) recorded about a call.

> **Status note.** Two things the integration plan intended here are **not
> implemented** in the current tree: a per-call audit record for AI traffic,
> and an `effectiveProviderUrl` / `effectiveProviderId` / `effectiveModelId`
> triple on the response envelope. Nothing in this document should be read as
> a compliance guarantee until those land. See [Not yet
> implemented](#not-yet-implemented).

## How a provider is chosen

The provider for an `ai:chat` / `ai:translate` / `ai:translate-batch` call is
resolved in this order:

1. **Request body `settings`** — if present, it *entirely replaces* the
   in-memory settings for that call. It is not merged.
2. **`aiSettings`** — the in-process module value in `src/ai/chat.ts`. It
   starts from `loadSettings()` at module init and is replaced wholesale by
   `ai:set-settings`.
3. **`defaultAiSettings()`** — the SDK's built-in defaults, used for any
   provider key the loaded settings don't define.

`resolveProviderConfig(settings, provider)` then reads
`settings.providers[provider]`. If that key is absent the call fails with
`AI provider "<id>" not configured` — there is no silent substitution of a
different provider.

The one special case is `genspark`, whose key can be supplied at runtime by
the GSK login flow rather than from the settings file.

## Where the environment *does* matter

This is the part worth reading carefully.

`loadSettings()` reads these variables **only when `DATA_DIR/ai-settings.json`
does not exist**:

```
MINIMAX_API_KEY   OPENAI_API_KEY   ANTHROPIC_API_KEY   GEMINI_API_KEY
DEEPSEEK_API_KEY  KIMI_API_KEY     QWEN_API_KEY        DOUBAO_API_KEY
XAI_API_KEY       MISTRAL_API_KEY  OPENROUTER_API_KEY
```

They are used to *seed* the default settings, so the obvious deploy
("set `OPENAI_API_KEY`, start the container") works without anyone opening the
settings UI. On top of seeding the keys, the loader also **auto-selects the
first provider that has a key** as the active `provider`, so the very first
request hits a real LLM rather than an unconfigured default.

Two consequences:

- **Once `ai-settings.json` exists, it wins.** The env values are not read
  again, not merged, and not consulted. Changing an env var on a running
  deployment that already has a settings file will have no effect.
- **Before it exists, AI routing is env-driven.** A container that inherits
  `OPENAI_API_KEY` from its parent shell *will* send tenant prompts to OpenAI.
  If your threat model includes a parent shell that sets these variables for
  its own reasons, create `ai-settings.json` explicitly (even an empty PUT via
  `ai:set-settings` is enough) so the seed path is never taken.

`process.env.AI_PROVIDER` and `process.env.WEKNORA_*` are **not** read by the
web-server under any circumstance.

## Reading and writing the settings

There is no `/api/v1/settings/ai` REST endpoint. Settings are read and written
through IPC:

| Channel | Effect |
|---|---|
| `ai:get-settings` | returns the current in-memory `AiSettings` |
| `ai:set-settings` | replaces the in-memory settings and persists to `DATA_DIR/ai-settings.json` |

Over HTTP these are `POST /api/ipc/ai:get-settings` and
`POST /api/ipc/ai:set-settings`.

The file shape:

```json
{
  "provider": "openai",
  "providers": {
    "openai":    { "apiKey": "sk-…",    "model": "gpt-5",                  "baseUrl": "https://api.openai.com" },
    "anthropic": { "apiKey": "sk-ant-…", "model": "claude-opus-4-20250514", "baseUrl": "https://api.anthropic.com" },
    "minimax":   { "apiKey": "sk-…",    "model": "MiniMax-Text-01",       "baseUrl": "https://api.minimax.chat/v1" },
    "codex":     { "cliPath": "/usr/local/bin/codex" },
    "azure":     { "apiKey": "…", "endpoint": "https://…", "deployment": "gpt-5" }
  }
}
```

On load the file is re-merged on top of `defaultAiSettings()`, so a newly
added provider appears without wiping the file. That merge is read-side only —
the merged result is **not** written back. Persist it by writing the settings
once through `ai:set-settings`.

## The audit log

`DATA_DIR/audit-log.jsonl` is an append-only JSONL file of `AuditRecord`
objects. The record shape is generic; there are no AI-specific fields:

```ts
interface AuditRecord {
  id: string
  tenantId: string
  userId: string
  action: string
  resource: string
  resourceId: string
  details: Record<string, unknown>
  ip: string
  userAgent: string
  timestamp: number
  status: 'success' | 'failure'
}
```

**`recordAudit()` currently has exactly one caller**: the `audit:log` IPC
channel in `src/enterprise/auth-audit.ts`. AI calls do **not** write audit
records — `src/ai/chat.ts` contains no `recordAudit` call. So the log answers
"who invoked `audit:log`", not "which upstream handled this prompt".

Query it through the `audit:query` IPC channel (`POST /api/ipc/audit:query`),
with `audit:export` for a bulk dump. There is no `/api/v1/audit` REST route.
`auditMetrics()` exposes in-memory ring fill, on-disk size, and cumulative
written/dropped counters through `/api/v1/metrics`; a non-zero
`totalDropped` is the signal that the 10 000-record ring overflowed.

Retention is handled by `rotateAuditLog()` and an optional background worker
(`startAuditRotateWorker()`), configured through `retentionDaysFromEnv()`.
`GENOFFICE_AUDIT_PERSIST=0` disables persistence entirely (tests use this).

## Not yet implemented

Both of these are promised by the integration plan and unbuilt. Don't rely on
them:

- **Per-AI-call audit.** Recording `{ provider, model, baseUrl, tokensIn,
  tokensOut, durationMs }` for every `ai:chat` / `ai:translate` call needs a
  shared wrapper around the provider call sites — today they reach
  `chatForProvider` and `runProviderStream` through separate paths with no
  common choke point.
- **`effectiveProviderUrl` / `effectiveProviderId` / `effectiveModelId`.**
  These field names do not appear anywhere in the tree. To learn which
  provider and model are configured, read `ai:get-settings`; the resolved
  `baseUrl` for a provider is `settings.providers[id].baseUrl`.

A related open item: the env-seed path above means AI routing *is*
environment-driven on a deployment that has no `ai-settings.json`. If the goal
is "never route implicitly", that path needs to be gated by an explicit opt-in.

## Code map

| Layer | File |
|---|---|
| Provider registry / dispatch | `packages/ai-provider/src/registry.ts` |
| Type definitions | `packages/ai-provider/src/types.ts` (`AiSettings`, `AiProviderConfig`) |
| Settings loader / resolver | `apps/web-server/src/ai/chat.ts` (`loadSettings`, `resolveProviderConfig`) |
| Core AI + translation handlers | `apps/web-server/src/ai/chat.ts` (`registerAiCoreHandlers`) |
| HTTP translate + SSE | `apps/web-server/src/ai/translate-http.ts` |
| Language list endpoint | `apps/web-server/src/ai/languages-http.ts` |
| Audit log writer | `apps/web-server/src/common/audit-log.ts` |
| Only audit caller today | `apps/web-server/src/enterprise/auth-audit.ts` |

## Common pitfalls

1. **"`baseUrl` is the wrong host"** — there is no audit record to check, so
   read `settings.providers[id].baseUrl` from `ai:get-settings`. If your proxy
   strips a path prefix, set `baseUrl` to the prefix the proxy expects
   (`https://gateway.internal/llm`), not the upstream's canonical URL.
2. **"I set `MINIMAX_API_KEY` but it's not used"** — a settings file already
   exists, so the seed path was never taken. Either add the key via
   `ai:set-settings`, or delete `ai-settings.json` and restart.
3. **Mixing per-request `settings` with operator config** — the request's
   `settings` argument **replaces** the operator config entirely. If it
   provides `{ provider: 'openai', providers: { openai: {...} } }`, the
   anthropic key from `ai-settings.json` is *not* inherited, and any call that
   needs anthropic will fail with "not configured".
4. **`ai:agent` does not exist.** There is no agent channel and no
   `src/ai/agent.ts`. Agent-shaped work goes through `ai:chat` with a
   skill-specific system prompt (`doc-skill.ts`, `sheet-skill.ts`,
   `slide-skill.ts`, `media-skill.ts`).

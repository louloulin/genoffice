/**
 * Sanitize renderer-supplied `AiSettings` overrides before they reach a
 * provider call (A2 / plan task 1-2).
 *
 * # The hole this closes
 *
 * `ai:chat`, `ai:stream`, and `POST /api/ai/stream` historically used the
 * request body's `settings` wholesale (`req.settings || aiSettings`). A
 * caller — including an untrusted embed guest — could set
 * `providers.<id>.baseUrl` and make the server issue its next AI call to any
 * URL of their choosing: an SSRF against whatever network position the
 * web-server holds (cloud metadata endpoints, internal admin panels). The
 * body could equally carry an `apiKey`, letting a guest substitute their own
 * credential *or* spend against someone else's account.
 *
 * # The two modes (brief D3)
 *
 * **Embed / JWT caller** (`embedCaller: true` — the request presented a
 * verifying JWT): every `apiKey` / `baseUrl` in the request settings is
 * dropped and backfilled from the server's persisted settings. Guests keep
 * their non-network choices — provider selection, model, maxOutputTokens —
 * but the network endpoint and the credential are always the tenant's.
 *
 * **Local / operator** (no JWT — the developer renderer or an operator
 * request): BYOK stays intact, but a `baseUrl` override may only point at an
 * allowlisted host. The default allowlist is loopback only (a local Ollama /
 * llama.cpp is the real use case); operators extend it with
 * `GENOFFICE_BASEURL_ALLOWLIST` (comma-separated hostnames). A miss is a
 * structured rejection *before* any upstream request is made — never a
 * silently ignored override, which would turn a typo into a request to the
 * vendor default endpoint.
 */
import type { AiSettings } from '@genoffice/ai-provider'
import { isLoopbackHost } from '../common/startup-checks'

export type SanitizedRequestSettings =
  | { ok: true; settings: AiSettings }
  | { ok: false; reason: string }

/** True when the IPC event was synthesized for a JWT-authenticated caller (see the dispatcher in `src/index.ts`). */
export function isEmbedCaller(event: unknown): boolean {
  const userId = (event as { userId?: unknown } | null | undefined)?.userId
  return typeof userId === 'string' && userId.length > 0
}

function baseUrlAllowlist(): string[] {
  const raw = process.env.GENOFFICE_BASEURL_ALLOWLIST
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

/** `null` when the override may proceed; otherwise the reason, ready to surface. */
function checkBaseUrl(label: string, url: string): string | null {
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${label}: protocol must be http(s), got "${parsed.protocol}"`
    }
    host = parsed.hostname.toLowerCase()
  } catch {
    return `${label}: not a valid URL`
  }
  if (isLoopbackHost(host)) return null
  if (baseUrlAllowlist().includes(host)) return null
  return `${label}: host "${host}" is not on the baseUrl allowlist (loopback by default; add entries with GENOFFICE_BASEURL_ALLOWLIST)`
}

type NetworkFields = { apiKey?: unknown; baseUrl?: unknown }

/** Drop every credential / endpoint override. Mutates the (cloned) settings. */
function stripNetworkFields(settings: AiSettings): void {
  // Wire data is unvalidated, so per-provider configs are only ever *assumed*
  // complete; stripping deliberately produces partials, which backfill restores
  // where the server holds a real value. Search providers have no baseUrl —
  // deleting an absent property is a no-op.
  const groups = [
    settings.providers as unknown as Record<string, NetworkFields> | undefined,
    settings.media?.providers as unknown as Record<string, NetworkFields> | undefined,
    settings.search?.providers as unknown as Record<string, NetworkFields> | undefined,
  ]
  for (const group of groups) {
    if (!group) continue
    for (const config of Object.values(group)) {
      delete config.apiKey
      delete config.baseUrl
    }
  }
}

/**
 * Backfill what was just stripped from the server's persisted settings, so an
 * embed request that names a provider the tenant configured keeps working
 * instead of failing with "No API key configured". Only providers present in
 * *both* objects are touched — a request cannot conjure configuration for a
 * provider the server never set up.
 */
function backfillFromServer(settings: AiSettings, server: AiSettings): void {
  for (const [id, config] of Object.entries(settings.providers ?? {})) {
    const src = server.providers?.[id as keyof AiSettings['providers']]
    if (!src) continue
    if (!config.apiKey && src.apiKey) config.apiKey = src.apiKey
    if (!config.baseUrl && src.baseUrl) config.baseUrl = src.baseUrl
  }
  for (const [id, config] of Object.entries(settings.media?.providers ?? {})) {
    const src = server.media?.providers?.[id as keyof NonNullable<AiSettings['media']>['providers']]
    if (!src) continue
    if (!config.apiKey && src.apiKey) config.apiKey = src.apiKey
    if (!config.baseUrl && src.baseUrl) config.baseUrl = src.baseUrl
  }
  for (const [id, config] of Object.entries(settings.search?.providers ?? {})) {
    const src = server.search?.providers?.[id as keyof NonNullable<AiSettings['search']>['providers']]
    if (!src) continue
    if (!config.apiKey && src.apiKey) config.apiKey = src.apiKey
  }
}

/**
 * Resolve the settings a provider call should actually use.
 *
 * `requestSettings` absent → the server settings, untouched. Present → a
 * sanitized *clone* (the request object and the server copy are never
 * mutated, and the caller may freely mutate what it gets back).
 */
export function sanitizeRequestSettings(opts: {
  embedCaller: boolean
  requestSettings: AiSettings | undefined
  serverSettings: AiSettings
}): SanitizedRequestSettings {
  const { embedCaller, requestSettings, serverSettings } = opts
  if (!requestSettings || typeof requestSettings !== 'object') {
    return { ok: true, settings: serverSettings }
  }

  const clone = structuredClone(requestSettings) as AiSettings

  if (embedCaller) {
    stripNetworkFields(clone)
    backfillFromServer(clone, serverSettings)
    return { ok: true, settings: clone }
  }

  // Local / operator: BYOK stays; endpoint overrides are confined to the allowlist.
  const violations: string[] = []
  for (const [id, config] of Object.entries(clone.providers ?? {})) {
    if (config.baseUrl) {
      const reason = checkBaseUrl(`providers.${id}.baseUrl`, config.baseUrl)
      if (reason) violations.push(reason)
    }
  }
  for (const [id, config] of Object.entries(clone.media?.providers ?? {})) {
    if (config.baseUrl) {
      const reason = checkBaseUrl(`media.providers.${id}.baseUrl`, config.baseUrl)
      if (reason) violations.push(reason)
    }
  }
  if (violations.length > 0) return { ok: false, reason: violations.join('; ') }
  return { ok: true, settings: clone }
}

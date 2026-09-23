/**
 * SSO/OIDC auth + audit log channels.
 *
 * The auth side (`auth:sso-login` / `auth:sso-callback` / `auth:logout`)
 * is still a placeholder — a real implementation needs a state-vs-code
 * CSRF check and an exchange against the IdP's token endpoint (M5
 * backlog). The audit side, however, used to live in a process-local
 * `AUDIT_LOGS` Map that vanished on every restart — disastrous for
 * compliance data. As of sdk1.md §M5 / §11.36 the audit log is
 * disk-backed (`apps/web-server/src/common/audit-log.ts`) and survives
 * restarts, so this file now just wires the IPC handlers through to
 * that store.
 */
import { registerHandle } from '../common/index'
import { exportAudit, queryAudit, recordAudit } from '../common/audit-log'
import { InvalidArgumentError } from '../ai/errors'

export function registerAuthHandlers(): void {
  registerHandle('auth:sso-login', (_event: unknown, args: unknown) => {
    const { provider, redirectUri } = (args || {}) as {
      provider: string
      redirectUri?: string
    }
    return {
      authUrl: `https://sso.genoffice.ai/authorize?provider=${provider}&redirect_uri=${redirectUri || ''}`,
      state: `state-${Date.now()}`,
    }
  }, { scope: 'soft:auth:write' })

  registerHandle('auth:sso-callback', async (_event: unknown, args: unknown) => {
    // NOTE (placeholder): a real OIDC implementation must validate `state`
    // against the value minted by `auth:sso-login` (CSRF protection) and
    // exchange `code` at the provider's token endpoint. This stub does neither —
    // it hands back a fixed bearer token — so both fields stay deliberately
    // unused rather than read and quietly ignored.
    const { code: _code, state: _state } = (args || {}) as { code: string; state: string }
    return {
      ok: true,
      accessToken: `token-${Date.now()}`,
      refreshToken: `refresh-${Date.now()}`,
      expiresIn: 3600,
      user: {
        id: `user-${Date.now()}`,
        email: 'user@example.com',
        name: 'SSO User',
      },
    }
  }, { scope: 'soft:auth:write' })

  registerHandle('auth:logout', (_event: unknown) => ({
    ok: true,
    redirectUrl: '/',
  }), { scope: 'soft:auth:write' })
}

export function registerAuditHandlers(): void {
  // Tenant-aware audit logging (sdk1 §11.56): the underlying store
  // has always carried tenantId (the disk schema includes it on every
  // record + the JSONL export header). What's been missing is the
  // surface: handlers accepted userId / resourceId but never let
  // callers pin a tenant. This adds optional tenantId to both log
  // and query, and validates the type defensively so a non-string
  // tenantId (a common refactor mistake) fails loudly instead of
  // being silently coerced to 'default' downstream.
  // sdk1 §11.92 — audit:log author comes from the JWT subject by default.
  // The IPC dispatcher now stamps `event.userId` with the verified JWT sub
  // (apps/web-server/src/index.ts) so an authenticated renderer call
  // doesn't have to repeat its identity on every audit record. The
  // precedence is: explicit args.userId > event.userId (JWT sub) >
  // recordAudit()'s 'system' default. This closes §11.37.6 #4 — every
  // audit record now carries a real caller id instead of 'system',
  // and callers can still override by passing args.userId for the
  // rare case where the acting principal differs from the JWT holder
  // (impersonation, server-side batch).
  registerHandle('audit:log', (event: unknown, args: unknown) => {
    const eventUserId = (event as { userId?: string } | null)?.userId
    const { action, resource, resourceId, details, status, userId, tenantId } = (args || {}) as {
      action: string
      resource: string
      resourceId?: string
      details?: Record<string, unknown>
      status?: 'success' | 'failure'
      userId?: string
      tenantId?: string
    }
    if (tenantId !== undefined && typeof tenantId !== 'string') {
      throw new InvalidArgumentError('audit:log', 'tenantId must be a string when provided')
    }
    if (action !== undefined && typeof action !== 'string') {
      throw new InvalidArgumentError('audit:log', 'action must be a string')
    }
    if (resource !== undefined && typeof resource !== 'string') {
      throw new InvalidArgumentError('audit:log', 'resource must be a string')
    }
    // Precedence: args.userId (caller override) > event.userId (JWT sub).
    // recordAudit itself defaults to 'system' when neither is supplied,
    // matching the legacy behaviour for tests / unauthenticated dev mode.
    const resolvedUserId = userId ?? eventUserId
    const id = recordAudit({
      action,
      resource,
      ...(resourceId ? { resourceId } : {}),
      ...(details ? { details } : {}),
      ...(status ? { status } : {}),
      ...(resolvedUserId ? { userId: resolvedUserId } : {}),
      ...(tenantId ? { tenantId } : {}),
    })
    return { ok: true, id }
  },
    { scope: 'audit:write' },
  )

  registerHandle('audit:query', (_event: unknown, args: unknown) => {
    const { userId, action, resource, startDate, endDate, limit, offset, tenantId } = (args || {}) as {
      userId?: string
      action?: string
      resource?: string
      startDate?: number
      endDate?: number
      limit?: number
      offset?: number
      tenantId?: string
    }
    if (tenantId !== undefined && typeof tenantId !== 'string') {
      throw new InvalidArgumentError('audit:query', 'tenantId must be a string when provided')
    }
    return queryAudit({
      ...(userId ? { userId } : {}),
      ...(action ? { action } : {}),
      ...(resource ? { resource } : {}),
      ...(typeof startDate === 'number' ? { startDate } : {}),
      ...(typeof endDate === 'number' ? { endDate } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
      ...(typeof offset === 'number' ? { offset } : {}),
      ...(tenantId ? { tenantId } : {}),
    })
  },
    { scope: 'audit:read' },
  )

  registerHandle('audit:export', async (_event: unknown, args: unknown) => {
    const { format, startDate, endDate, tenantId } = (args || {}) as {
      format?: 'csv' | 'json' | 'xlsx'
      startDate?: number
      endDate?: number
      tenantId?: string
    }
    if (tenantId !== undefined && typeof tenantId !== 'string') {
      throw new InvalidArgumentError('audit:export', 'tenantId must be a string when provided')
    }
    // exportAudit is async since §11.58 — the xlsx branch routes through
    // @genoffice/xlsx-gateway's csvToXlsxBuffer (same helper used by
    // workbook:save). Pre-§11.58 the handler returned a fake downloadUrl
    // that had no server handler; the body now ships inline (utf-8 for
    // json/csv, base64 for xlsx) just like the other audit IPC envelopes.
    return await exportAudit({
      ...(format ? { format } : {}),
      ...(typeof startDate === 'number' ? { startDate } : {}),
      ...(typeof endDate === 'number' ? { endDate } : {}),
      ...(tenantId ? { tenantId } : {}),
    })
  },
    { scope: 'audit:read' },
  )
}

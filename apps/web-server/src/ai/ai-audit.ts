/**
 * Uniform audit trail for AI calls (A43).
 *
 * Every AI surface (chat, stream, translate, translate-batch, image) writes
 * one `ai.call` record per provider attempt with the same field set: tenant,
 * endpoint, provider, model, token usage, duration, result status. The token
 * fields are `null` when the call path cannot surface them (translate runs
 * inside the pi session, image fetch is not a model turn) — the fields stay
 * present so consumers can rely on the shape.
 */
import { recordAudit } from '../common/audit-log'

export interface AiCallAuditInput {
  /** route or IPC channel that carried the call ('/api/v1/ai/chat', 'ai:translate', …) */
  endpoint: string
  /** resolved tenant; undefined/empty → 'default' with tenantSource 'fallback' */
  tenantId?: string
  userId?: string
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  durationMs?: number
  ok: boolean
  errorCode?: string
  ip?: string
  userAgent?: string
}

export function auditAiCall(input: AiCallAuditInput): void {
  recordAudit({
    tenantId: input.tenantId?.trim() || 'default',
    ...(input.userId ? { userId: input.userId } : {}),
    action: 'ai.call',
    resource: input.endpoint,
    details: {
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      durationMs: input.durationMs ?? null,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      // A42: 'default' without a JWT is a provenance mark, not a real tenant —
      // consumers can tell an unauthenticated/operator call from a tenant's.
      tenantSource: input.tenantId?.trim() ? 'jwt' : 'fallback',
    },
    status: input.ok ? 'success' : 'failure',
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
  })
}

/**
 * The tenant context an IPC handler runs in. `tenantId` comes from the
 * synthesized event (JWT claim via invokeIpc / the /api/ipc dispatcher);
 * absent on fallback. Pass it straight into `auditAiCall` — the helper
 * deliberately returns `undefined` rather than 'default' so `auditAiCall`
 * stays the single place that stamps 'default' + provenance.
 */
export function tenantContextFromEvent(event: unknown): { tenantId?: string } {
  const tenantId = (event as { tenantId?: unknown } | null | undefined)?.tenantId
  if (typeof tenantId === 'string' && tenantId.trim()) {
    return { tenantId: tenantId.trim() }
  }
  return {}
}

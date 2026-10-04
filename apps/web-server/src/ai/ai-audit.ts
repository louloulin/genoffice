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
import { recordUsage } from '../common/usage-meter'

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
  const tenantId = input.tenantId?.trim() || 'default'
  recordAudit({
    tenantId,
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
  // A18/A22/A62/A63: meter the same call for per-tenant usage reporting. This
  // is the single choke point every AI surface (chat, stream, translate,
  // image, skill) already funnels through, so recording here keeps the audit
  // trail and the usage meter from drifting apart. Only the fields the call
  // path genuinely surfaced are passed on; unknown tokens stay absent (the
  // meter never invents counts — see common/usage-meter.ts).
  recordUsage({
    tenantId,
    endpoint: input.endpoint,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(typeof input.promptTokens === 'number' ? { promptTokens: input.promptTokens } : {}),
    ...(typeof input.completionTokens === 'number' ? { completionTokens: input.completionTokens } : {}),
    ...(typeof input.totalTokens === 'number' ? { totalTokens: input.totalTokens } : {}),
    ...(typeof input.durationMs === 'number' ? { latencyMs: input.durationMs } : {}),
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

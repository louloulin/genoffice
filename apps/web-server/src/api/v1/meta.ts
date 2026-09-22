/**
 * /api/v1/meta — health and changelog endpoints.
 *
 * Public (no auth required). The same `/health` body the existing
 * `/health` route returns is exposed here for clients that prefer
 * the v1 path. The changelog endpoint reads `apps/web-server/CHANGELOG.md`
 * if present and returns the most recent entries.
 * @public
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendJson, sendError } from './http-utils'
import { handlerCount, listChannels, auditMetrics } from '../../common/index'
import { getDeadLetterMetrics } from '../../common/webhooks-dlq'
import { getUsageTotals } from '../../embed/sdk-commands'

// ESM builds don't expose __dirname; derive it from import.meta.url. The
// fallback handles the CommonJS case (when bundled by esbuild as a single
// script without import.meta available).
//
// Two layout modes the function reconciles:
//
//   - bundle:    apps/web-server/dist/bundle/index.js           (4 levels up)
//   - source:    apps/web-server/src/api/v1/meta.ts            (5 levels up)
//
// We probe for the apps/web-server/CHANGELOG.md marker (a stable file
// that lives next to the bundle) and walk the dirname until the parent
// holds the file. This makes /api/v1/changelog resolve correctly both
// for the production bundle and for `npx tsx src/index.ts` development
// runs, where the previous hard-coded 4-up walk landed in apps/ and the
// endpoint answered 404.
function getPkgRoot(): string {
  try {
    const url = fileURLToPath(import.meta.url)
    const start = dirname(url)
    // Walk up at most 6 levels looking for the apps/web-server marker.
    // The marker file is the changelog itself, which lives directly
    // inside apps/web-server/. From any source/bundle path nested inside
    // the web-server tree we walk until the *current dir* is the
    // apps/web-server/ directory; one more step up is the monorepo root.
    let dir = start
    for (let i = 0; i < 6; i++) {
      // Check if `dir` is the apps/web-server/ directory itself.
      const markerHere = join(dir, 'CHANGELOG.md')
      const pkgJsonHere = join(dir, 'package.json')
      if (existsSync(markerHere) && existsSync(pkgJsonHere)) {
        // `dir` = apps/web-server/. The monorepo root is two levels up
        // (apps/web-server → apps → repo).
        return join(dir, '..', '..')
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // Fallback: assume 4-up (bundle layout). The previous behaviour; left
    // in place so an unexpected tree (e.g. tests stubbing the FS) still
    // gets a sensible default.
    return join(start, '..', '..', '..', '..')
  } catch {
    return process.cwd()
  }
}

const PKG_ROOT = getPkgRoot()

/**
 * Public health check — returns implementation metadata.
 *
 * @route GET /api/v1/health
 * @summary (see above)
 * @scope —
 * @errors —
 * @public
 */
export function handleHealth(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  sendJson(ctx.response, 200, {
    status: 'ok',
    apiVersion: 'v1',
    implementedChannels: handlerCount(),
    channels: listChannels(),
    auth: process.env.GENOFFICE_JWT_SECRET ? 'jwt' : 'open',
    timestamp: new Date().toISOString(),
  })
  return true
}

/**
 * Prometheus-format metrics endpoint (sdk1.md §11.35).
 *
 * Public (no auth) — Prometheus convention is scrape-only, and the
 * `/metrics` path should be reachable from inside the cluster without
 * token plumbing. For multi-tenant deployments the host can put a
 * reverse proxy in front that adds the same JWT gate as other v1
 * routes; that's a deployment concern, not an endpoint one.
 *
 * Currently exposes:
 *   - `genoffice_dlq_size`                 current ring-buffer fill
 *   - `genoffice_dlq_total_dropped`        cumulative since start
 *   - `genoffice_dlq_total_replayed`       cumulative successful replays
 *   - `genoffice_dlq_dropped_by_reason`     labelled by reason
 *   - `genoffice_dlq_oldest_dropped_at_ms` epoch ms of oldest (or NaN)
 *   - `genoffice_dlq_newest_dropped_at_ms` epoch ms of newest (or NaN)
 *   - `genoffice_ipc_channels_implemented` total registered handlers
 *   - `genoffice_uptime_seconds`           seconds since process start
 *   - `genoffice_sdk_usage_samples_total`  SDK `reportUsage` samples received
 *   - `genoffice_sdk_*`                    aggregated SDK usage counters
 *
 * Hosts that prefer JSON can still hit `GET /api/v1/webhooks/dlq`
 * which includes a structured `metrics` field.
 *
 * @route GET /api/v1/metrics
 * @summary (see above)
 * @scope —
 * @errors —
 * @public
 */
const PROCESS_START_MS = Date.now()
export function handleMetrics(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  const m = getDeadLetterMetrics()
  const usage = getUsageTotals()
  const audit = auditMetrics()
  const uptimeSec = (Date.now() - PROCESS_START_MS) / 1000
  const lines: string[] = [
    '# HELP genoffice_dlq_size Current webhook dead-letter queue size',
    '# TYPE genoffice_dlq_size gauge',
    `genoffice_dlq_size ${m.size}`,
    '# HELP genoffice_dlq_total_dropped Cumulative webhook deliveries dropped since process start',
    '# TYPE genoffice_dlq_total_dropped counter',
    `genoffice_dlq_total_dropped ${m.totalDropped}`,
    '# HELP genoffice_dlq_total_replayed Cumulative successful webhook replays since process start',
    '# TYPE genoffice_dlq_total_replayed counter',
    `genoffice_dlq_total_replayed ${m.totalReplayed}`,
    '# HELP genoffice_dlq_dropped_by_reason Webhook deliveries dropped, labelled by reason',
    '# TYPE genoffice_dlq_dropped_by_reason counter',
    `genoffice_dlq_dropped_by_reason{reason="max_attempts"} ${m.byReason.max_attempts}`,
    `genoffice_dlq_dropped_by_reason{reason="non_retryable_4xx"} ${m.byReason.non_retryable_4xx}`,
    '# HELP genoffice_dlq_oldest_dropped_at_ms Epoch ms of the oldest DLQ entry (NaN if empty)',
    '# TYPE genoffice_dlq_oldest_dropped_at_ms gauge',
    `genoffice_dlq_oldest_dropped_at_ms ${m.oldestDroppedAt ?? 'NaN'}`,
    '# HELP genoffice_dlq_newest_dropped_at_ms Epoch ms of the newest DLQ entry (NaN if empty)',
    '# TYPE genoffice_dlq_newest_dropped_at_ms gauge',
    `genoffice_dlq_newest_dropped_at_ms ${m.newestDroppedAt ?? 'NaN'}`,
    '# HELP genoffice_ipc_channels_implemented Number of IPC handlers registered',
    '# TYPE genoffice_ipc_channels_implemented gauge',
    `genoffice_ipc_channels_implemented ${handlerCount()}`,
    '# HELP genoffice_audit_log_records Current audit-log records held in memory (bounded at 10000)',
    '# TYPE genoffice_audit_log_records gauge',
    `genoffice_audit_log_records ${audit.records}`,
    '# HELP genoffice_audit_log_persisted_bytes Bytes currently on disk in the JSONL audit log (NaN when persistence is disabled or no record has been recorded yet)',
    '# TYPE genoffice_audit_log_persisted_bytes gauge',
    `genoffice_audit_log_persisted_bytes ${audit.persistedBytes ?? 'NaN'}`,
    '# HELP genoffice_audit_log_recorded_total Cumulative audit records recorded since process start',
    '# TYPE genoffice_audit_log_recorded_total counter',
    `genoffice_audit_log_recorded_total ${audit.totalRecorded}`,
    '# HELP genoffice_audit_log_dropped_total Cumulative audit records evicted because the in-memory ring overflowed the 10000 cap',
    '# TYPE genoffice_audit_log_dropped_total counter',
    `genoffice_audit_log_dropped_total ${audit.totalDropped}`,
    '# HELP genoffice_audit_log_records_by_tenant Audit-log records currently in memory, labelled by tenant id',
    '# TYPE genoffice_audit_log_records_by_tenant gauge',
    // Emit one sample per tenant seen in the current ring; empty ring = no
    // samples. Tenant ids are validated as strings at recordAudit(), so
    // escaping is for the {label="..."} form only (quotes + backslash).
    ...Object.entries(audit.byTenant).map(
      ([t, n]) => `genoffice_audit_log_records_by_tenant{tenant="${t.replace(/["\\]/g, '_')}"}${ ' ' }${n}`,
    ),
    '# HELP genoffice_uptime_seconds Seconds since the web-server process started',
    '# TYPE genoffice_uptime_seconds gauge',
    `genoffice_uptime_seconds ${uptimeSec.toFixed(3)}`,
    '# HELP genoffice_sdk_usage_samples_total SDK reportUsage samples received since process start',
    '# TYPE genoffice_sdk_usage_samples_total counter',
    `genoffice_sdk_usage_samples_total ${usage.samples}`,
    '# HELP genoffice_sdk_usage_instances Distinct SDK instanceIds seen since process start',
    '# TYPE genoffice_sdk_usage_instances gauge',
    `genoffice_sdk_usage_instances ${usage.instances}`,
    '# HELP genoffice_sdk_doc_bytes_written_total Bytes the host pushed into editors (setContent / insertText / insertImage)',
    '# TYPE genoffice_sdk_doc_bytes_written_total counter',
    `genoffice_sdk_doc_bytes_written_total ${usage.docBytesWritten}`,
    '# HELP genoffice_sdk_ai_calls_total Host-triggered AI calls (aiRewrite / aiTranslate / aiSummarize)',
    '# TYPE genoffice_sdk_ai_calls_total counter',
    `genoffice_sdk_ai_calls_total ${usage.aiCalls}`,
    '# HELP genoffice_sdk_ai_prompt_chars_total Host-side prompt character estimate (in)',
    '# TYPE genoffice_sdk_ai_prompt_chars_total counter',
    `genoffice_sdk_ai_prompt_chars_total ${usage.aiTokensIn}`,
    '# HELP genoffice_sdk_ai_response_chars_total Host-side response character estimate (out)',
    '# TYPE genoffice_sdk_ai_response_chars_total counter',
    `genoffice_sdk_ai_response_chars_total ${usage.aiTokensOut}`,
    '# HELP genoffice_sdk_session_ms_total Summed editor session durations in ms',
    '# TYPE genoffice_sdk_session_ms_total counter',
    `genoffice_sdk_session_ms_total ${usage.sessionDurationMs}`,
  ]
  const body = lines.join('\n') + '\n'
  ctx.response.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  })
  ctx.response.end(body)
  return true
}

/**
 * Public changelog endpoint.
 *
 * @route GET /api/v1/changelog
 * @summary (see above)
 * @scope —
 * @errors —
 * @public
 */
export function handleChangelog(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  const candidates = [
    join(PKG_ROOT, 'CHANGELOG.md'),
    join(PKG_ROOT, 'apps', 'web-server', 'CHANGELOG.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, 'utf8')
        sendJson(ctx.response, 200, { format: 'markdown', content: text })
        return true
      } catch {
        /* fall through */
      }
    }
  }
  sendError(ctx.response, 404, 'changelog not found', 'NOT_FOUND', 'meta:changelog')
  return true
}


/**
 * Public metadata endpoint — surfaces the implementation + protocol
 * fingerprint so an integrator can probe a server before picking an
 * SDK version to bundle. Public (no auth). Faster than /api/v1/health
 * for clients that already know the API is reachable and only want the
 * version + capability matrix.
 *
 * The body is intentionally small (no channel list — that lives at
 * /api/v1/health). Used by the SDK smoke script to skip a stale-cache
 * check before instantiating `createEditor()`.
 *
 * @route GET /api/v1/meta
 * @summary Server metadata
 * @scope —
 * @errors —
 * @public
 */
export function handleMeta(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  const usage = getUsageTotals()
  const uptimeSec = (Date.now() - PROCESS_START_MS) / 1000
  sendJson(ctx.response, 200, {
    apiVersion: 'v1',
    serverVersion: '0.8.0',
    protocolVersion: 1,
    minClientVersion: 1,
    sdkVersion: '0.9.0-beta.1',
    capabilities: [
      'docs',
      'sheets',
      'slides',
      'pdf',
      'markdown',
      'html',
    ],
    integrations: {
      ai: true,
      collab: true,
      webhooks: true,
      embed: true,
      marketplace: true,
    },
    storage: {
      backend: process.env.GENOFFICE_STORAGE ?? 'local',
    },
    sdk: {
      usageSamples: usage.samples,
      instances: usage.instances,
      uptimeSeconds: Number(uptimeSec.toFixed(3)),
    },
    timestamp: new Date().toISOString(),
  })
  return true
}

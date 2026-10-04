/**
 * AI main-path tracing (A23 / A69 / A70).
 *
 * Wraps `@genoffice/agent-telemetry` with the web-server's environment policy:
 * a request-path span tree (`entry → provider call → write-back`) is recorded
 * for every `/api/ai/stream` and translation call and shipped to whatever
 * collector the deployment points at.
 *
 * Transport is selected by environment so the same build serves dev, CI and
 * production:
 *
 *   - `GENOFFICE_OTLP_ENDPOINT` set  → OTLP/HTTP+JSON export (`…/v1/traces`)
 *     · `GENOFFICE_OTLP_SERVICE_NAME` overrides the `service.name`
 *     · `GENOFFICE_OTLP_HEADERS` adds request headers (`k=v,k2=v2`)
 *     · `GENOFFICE_OTLP_FLUSH_MS` shortens the batch flush interval
 *   - `GENOFFICE_TRACE_FILE` set     → local JSONL trace store
 *   - neither                        → no-op (telemetry is opt-in; a missing
 *     collector must never make the AI path emit or retain data)
 *
 * Export is best-effort and off the response path: the exporting context
 * batches and the OTLP exporter swallows transport errors, so a collector
 * outage degrades observability, never an AI request.
 */

import {
  JsonlFileExporter,
  OtlpHttpExporter,
  createExportingTelemetry,
  noopTelemetry,
  startSpan,
  type SpanExporter,
  type TelemetryContext,
  type TelemetrySpan,
} from '@genoffice/agent-telemetry'

export type SpanAttributes = Record<string, string | number | boolean | readonly string[] | undefined>

interface Tracing {
  context: TelemetryContext
  exporter: SpanExporter | null
  flush: () => Promise<void>
}

let cached: Tracing | undefined

/** Build the exporter the current environment asks for, or `null` for no-op. */
export function resolveSpanExporter(env: NodeJS.ProcessEnv = process.env): SpanExporter | null {
  const endpoint = env.GENOFFICE_OTLP_ENDPOINT?.trim()
  if (endpoint) {
    const flushMs = Number(env.GENOFFICE_OTLP_FLUSH_MS ?? '')
    return new OtlpHttpExporter({
      endpoint,
      serviceName: env.GENOFFICE_OTLP_SERVICE_NAME?.trim() || 'genoffice-web-server',
      ...(Number.isFinite(flushMs) && flushMs > 0 ? { flushIntervalMs: flushMs } : {}),
      ...(env.GENOFFICE_OTLP_HEADERS ? { headers: parseHeaderList(env.GENOFFICE_OTLP_HEADERS) } : {}),
      onError: (error) => {
        // A collector outage is an observability problem, not an AI problem.
        console.warn(`[ai-tracing] OTLP export failed: ${(error as Error)?.message ?? error}`)
      },
    })
  }
  const file = env.GENOFFICE_TRACE_FILE?.trim()
  if (file) return new JsonlFileExporter({ filePath: file })
  return null
}

/** The process-wide tracing context (memoised; env is read once). */
export function tracing(): Tracing {
  if (!cached) {
    const exporter = resolveSpanExporter()
    if (!exporter) {
      cached = { context: noopTelemetry, exporter: null, flush: async () => {} }
    } else {
      const context = createExportingTelemetry(exporter)
      cached = { context, exporter, flush: () => context.flush() }
    }
  }
  return cached
}

/** Run `fn` inside a span, attached to the current request's span tree. */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
  return startSpan(tracing().context, { name, attributes }, fn)
}

/** Flush any buffered spans. Called at shutdown and by tests. */
export async function flushTraces(): Promise<void> {
  await tracing().flush()
}

/** Drop the memoised exporter (tests only: lets a fresh env take effect). */
export function resetTracing(): void {
  const exporter = cached?.exporter as { shutdown?: () => void } | null | undefined
  cached = undefined
  exporter?.shutdown?.()
}

function parseHeaderList(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=')
    if (index <= 0) continue
    headers[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
  }
  return headers
}

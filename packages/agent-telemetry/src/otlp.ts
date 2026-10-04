import { randomBytes } from "node:crypto";

import type { RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";

import type { SpanExporter } from "./exporter";

/**
 * OTLP/HTTP+JSON span exporter.
 *
 * Serialises {@link RecordedTelemetrySpan} snapshots into the OpenTelemetry
 * `ExportTraceServiceRequest` wire shape and POSTs them to a collector's
 * `/v1/traces` endpoint. Spans are buffered and sent in batches so a hot
 * request path never pays one HTTP round-trip per span.
 *
 * Only HTTP+JSON is implemented on purpose: it needs no protobuf toolchain and
 * every OTel collector accepts it. A protobuf/gRPC transport can be added
 * behind the same {@link SpanExporter} interface without touching callers.
 */

export interface OtlpHttpExporterOptions {
	/**
	 * Collector base URL (must be an absolute URL). `/v1/traces` is appended
	 * unless the value already carries a path — e.g. an OTLP HTTP receiver on
	 * `http://collector:4318` becomes `http://collector:4318/v1/traces`, while
	 * `…/v1/traces` is used verbatim.
	 */
	endpoint: string;
	/** `service.name` reported as a resource attribute. Defaults to `genoffice`. */
	serviceName?: string;
	/** Extra resource attributes merged over the defaults. */
	resourceAttributes?: Record<string, string | number | boolean>;
	/** Spans buffered before an automatic flush. Defaults to 64. */
	maxBatchSize?: number;
	/** Milliseconds a batch may sit before it is flushed. Defaults to 5000. 0 disables the timer. */
	flushIntervalMs?: number;
	/** Request headers (e.g. an auth token). */
	headers?: Record<string, string>;
	/** Injected for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injected clock (ms since epoch); defaults to `Date.now`. */
	now?: () => number;
	/** Called with any transport/serialisation failure. Defaults to a no-op (telemetry must never break the host). */
	onError?: (error: unknown) => void;
}

/** Serialisable OTLP/JSON payload (the subset GenOffice produces). */
export interface OtlpTracePayload {
	readonly resourceSpans: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> };
		readonly scopeSpans: ReadonlyArray<{
			readonly scope: { readonly name: string; readonly version: string };
			readonly spans: ReadonlyArray<OtlpSpan>;
		}>;
	}>;
}

interface OtlpKeyValue {
	readonly key: string;
	readonly value: OtlpAnyValue;
}

type OtlpAnyValue =
	| { readonly stringValue: string }
	| { readonly boolValue: boolean }
	| { readonly intValue: string }
	| { readonly doubleValue: number }
	| { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } };

interface OtlpSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: number;
	readonly startTimeUnixNano: string;
	readonly endTimeUnixNano: string;
	readonly attributes: readonly OtlpKeyValue[];
	readonly events: ReadonlyArray<{
		readonly name: string;
		readonly timeUnixNano: string;
		readonly attributes: readonly OtlpKeyValue[];
	}>;
	readonly status: { readonly code: number; readonly message?: string };
}

const SCOPE_NAME = "@genoffice/agent-telemetry";
const SCOPE_VERSION = "0.1.0";
const SPAN_KIND_INTERNAL = 1;
const STATUS_CODE_OK = 1;
const STATUS_CODE_ERROR = 2;

export class OtlpHttpExporter implements SpanExporter {
	readonly name = "otlp-http";
	readonly traceUrl: string;

	private readonly serviceName: string;
	private readonly resourceAttributes: Record<string, string | number | boolean>;
	private readonly maxBatchSize: number;
	private readonly flushIntervalMs: number;
	private readonly headers: Record<string, string>;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly onError: (error: unknown) => void;

	/** One trace id per exporter: every span exported here belongs to one session trace. */
	private readonly traceId: string;
	private buffer: RecordedTelemetrySpan[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: OtlpHttpExporterOptions) {
		this.traceUrl = resolveTracesUrl(options.endpoint);
		this.serviceName = options.serviceName ?? "genoffice";
		this.resourceAttributes = options.resourceAttributes ?? {};
		this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 64);
		this.flushIntervalMs = options.flushIntervalMs ?? 5000;
		this.headers = { "content-type": "application/json", ...options.headers };
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.onError = options.onError ?? (() => {});
		this.traceId = randomHex(16);
		if (this.flushIntervalMs > 0) {
			this.timer = setInterval(() => {
				void this.flush();
			}, this.flushIntervalMs);
			// Never keep the process alive just to ship telemetry.
			this.timer.unref?.();
		}
	}

	async exportSpan(span: RecordedTelemetrySpan): Promise<void> {
		this.buffer.push(span);
		if (this.buffer.length >= this.maxBatchSize) await this.flush();
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;
		const batch = this.buffer;
		this.buffer = [];
		try {
			await this.send(this.buildPayload(batch));
		} catch (error) {
			this.onError(error);
		}
	}

	/** Stop the flush timer. Safe to call more than once. */
	shutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Build the OTLP payload for a batch of recorded spans (exposed for tests). */
	buildPayload(spans: readonly RecordedTelemetrySpan[]): OtlpTracePayload {
		const end = nanoIso(this.now());
		const attrs = [
			kv("service.name", this.serviceName),
			...Object.entries(this.resourceAttributes).map(([key, value]) => kv(key, value)),
		];
		return {
			resourceSpans: [
				{
					resource: { attributes: attrs },
					scopeSpans: [
						{
							scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
							spans: spans.map((span) => this.toOtlpSpan(span, end)),
						},
					],
				},
			],
		};
	}

	private toOtlpSpan(span: RecordedTelemetrySpan, endNano: string): OtlpSpan {
		const attributes = Object.entries(span.attributes)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => kv(key, value as string | number | boolean | readonly string[]));
		return {
			traceId: this.traceId,
			spanId: padHex(span.id, 16),
			...(span.parentId !== null ? { parentSpanId: padHex(span.parentId, 16) } : {}),
			name: span.name,
			kind: SPAN_KIND_INTERNAL,
			// Recorded spans carry no wall-clock timestamps, so both ends are
			// stamped at export time; ordering comes from parentSpanId, not time.
			startTimeUnixNano: endNano,
			endTimeUnixNano: endNano,
			attributes,
			events: span.events.map((event) => ({
				name: event.name,
				timeUnixNano: endNano,
				attributes: Object.entries(event.attributes)
					.filter(([, value]) => value !== undefined)
					.map(([key, value]) => kv(key, value as string | number | boolean | readonly string[])),
			})),
			status:
				span.status.status === "error"
					? { code: STATUS_CODE_ERROR, message: span.status.error?.message }
					: { code: STATUS_CODE_OK },
		};
	}

	private async send(payload: OtlpTracePayload): Promise<void> {
		const response = await this.fetchImpl(this.traceUrl, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			throw new Error(`OTLP export failed: HTTP ${response.status} ${response.statusText}`);
		}
	}
}

/** Append `/v1/traces` unless the endpoint already points at a traces path. */
export function resolveTracesUrl(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, "");
	return /\/v1\/traces$/.test(trimmed) ? trimmed : `${trimmed}/v1/traces`;
}

function kv(key: string, value: string | number | boolean | readonly string[] | readonly number[] | readonly boolean[]): OtlpKeyValue {
	return { key, value: anyValue(value) };
}

function anyValue(value: string | number | boolean | readonly (string | number | boolean)[]): OtlpAnyValue {
	if (Array.isArray(value)) {
		return { arrayValue: { values: (value as readonly (string | number | boolean)[]).map(anyValue) } };
	}
	if (typeof value === "boolean") return { boolValue: value };
	if (typeof value === "number") {
		return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
	}
	return { stringValue: String(value) };
}

function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

/** Left-pad a numeric id into an OTLP hex span id of `width` characters. */
function padHex(id: number, width: number): string {
	return (id >>> 0).toString(16).padStart(width, "0");
}

/** Nanosecond timestamp as an OTLP string (OTLP/JSON encodes uint64 as string). */
function nanoIso(millis: number): string {
	return String(Math.floor(millis) * 1_000_000);
}

import { InMemoryTelemetryContext, type SpanOptions, type TelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";

import type { SpanExporter } from "./exporter";

/**
 * A {@link TelemetryContext} that records spans in memory and ships them to a
 * {@link SpanExporter} once the outermost span of each request completes.
 *
 * pi-telemetry's recording context deliberately does not talk to exporters, so
 * hosts that want a live collector need this bridge. Draining only at depth 0
 * means every exported payload holds a *complete*, settled span chain in
 * start order — a collector never sees a parent before its children, and never
 * sees a half-finished span.
 */
export class ExportingTelemetryContext implements TelemetryContext {
	private readonly recorder = new InMemoryTelemetryContext();
	private depth = 0;
	private exported = 0;

	constructor(private readonly exporter: SpanExporter) {}

	async startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		this.depth += 1;
		try {
			return await this.recorder.startSpan(options, callback);
		} finally {
			this.depth -= 1;
			if (this.depth === 0) await this.drain();
		}
	}

	/** Export every span recorded since the last drain. */
	async drain(): Promise<void> {
		const spans = this.recorder.getSpans();
		for (let index = this.exported; index < spans.length; index += 1) {
			await this.exporter.exportSpan(spans[index]);
		}
		this.exported = spans.length;
	}

	/** Drain and flush the underlying exporter. */
	async flush(): Promise<void> {
		await this.drain();
		await this.exporter.flush?.();
	}
}

/** Create an exporting context backed by `exporter`. */
export function createExportingTelemetry(exporter: SpanExporter): ExportingTelemetryContext {
	return new ExportingTelemetryContext(exporter);
}

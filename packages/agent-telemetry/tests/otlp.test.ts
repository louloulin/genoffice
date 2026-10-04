import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	InMemoryTelemetryContext,
	OtlpHttpExporter,
	createExportingTelemetry,
	resolveTracesUrl,
	type RecordedTelemetrySpan,
} from "../src/index";

/**
 * A minimal OTLP/HTTP collector: accepts `POST /v1/traces`, parses the JSON
 * body and records every exported payload so the test can assert the chain.
 */
interface CollectingServer {
	readonly server: Server;
	readonly url: string;
	readonly payloads: unknown[];
	readonly requests: Array<{ path: string; contentType: string | undefined }>;
	close(): Promise<void>;
}

async function startCollector(status = 200): Promise<CollectingServer> {
	const payloads: unknown[] = [];
	const requests: Array<{ path: string; contentType: string | undefined }> = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			requests.push({ path: req.url ?? "", contentType: req.headers["content-type"] as string | undefined });
			try {
				payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				payloads.push(undefined);
			}
			res.statusCode = status;
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		server,
		url: `http://127.0.0.1:${port}`,
		payloads,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** Read the flat span list out of an OTLP payload, or [] if the shape is off. */
function spansOf(payload: any): any[] {
	return payload?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
}

let collector: CollectingServer | undefined;

afterEach(async () => {
	await collector?.close();
	collector = undefined;
});

describe("resolveTracesUrl", () => {
	it("appends /v1/traces to a bare collector origin", () => {
		expect(resolveTracesUrl("http://collector:4318")).toBe("http://collector:4318/v1/traces");
		expect(resolveTracesUrl("http://collector:4318/")).toBe("http://collector:4318/v1/traces");
	});

	it("keeps an explicit traces path", () => {
		expect(resolveTracesUrl("https://otel.example.com/v1/traces")).toBe("https://otel.example.com/v1/traces");
	});
});

describe("OtlpHttpExporter", () => {
	it("POSTs the OTLP/JSON envelope to /v1/traces", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, flushIntervalMs: 0 });
		await exporter.exportSpan(recordedSpan({ id: 1, parentId: null, name: "ai.stream" }));
		await exporter.flush();

		expect(collector.requests).toEqual([{ path: "/v1/traces", contentType: "application/json" }]);
		expect(collector.payloads).toHaveLength(1);
		const payload: any = collector.payloads[0];
		expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
			key: "service.name",
			value: { stringValue: "genoffice" },
		});
		const [span] = spansOf(payload);
		expect(span.name).toBe("ai.stream");
		expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(span.status.code).toBe(1);
	});

	it("batches spans and flushes once the batch is full", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, maxBatchSize: 2, flushIntervalMs: 0 });
		await exporter.exportSpan(recordedSpan({ id: 1, parentId: null, name: "a" }));
		await exporter.exportSpan(recordedSpan({ id: 2, parentId: 1, name: "b" }));
		expect(collector.payloads).toHaveLength(1);
		expect(spansOf(collector.payloads[0])).toHaveLength(2);

		await exporter.exportSpan(recordedSpan({ id: 3, parentId: 1, name: "c" }));
		await exporter.flush();
		expect(collector.payloads).toHaveLength(2);
	});

	it("carries the parent/child chain and attributes the collector can rebuild", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, flushIntervalMs: 0 });
		// entry -> provider call -> write-back, the shape used on the AI main path.
		const spans: RecordedTelemetrySpan[] = [
			recordedSpan({ id: 10, parentId: null, name: "ai.stream", attributes: { route: "/api/ai/stream" } }),
			recordedSpan({ id: 11, parentId: 10, name: "ai.provider.call", attributes: { provider: "openai" } }),
			recordedSpan({ id: 12, parentId: 11, name: "ai.stream.write-back", attributes: { chunks: 42 } }),
		];
		for (const span of spans) await exporter.exportSpan(span);
		await exporter.flush();

		const exported = spansOf(collector.payloads[0]);
		expect(exported.map((s) => s.name)).toEqual(["ai.stream", "ai.provider.call", "ai.stream.write-back"]);
		const byName = new Map(exported.map((s) => [s.name, s]));
		expect(byName.get("ai.stream")?.parentSpanId).toBeUndefined();
		expect(byName.get("ai.provider.call")?.parentSpanId).toBe(byName.get("ai.stream")?.spanId);
		expect(byName.get("ai.stream.write-back")?.parentSpanId).toBe(byName.get("ai.provider.call")?.spanId);
		// One trace id for the whole batch — the chain is joinable downstream.
		expect(new Set(exported.map((s) => s.traceId)).size).toBe(1);
		expect(byName.get("ai.provider.call")?.attributes).toContainEqual({
			key: "provider",
			value: { stringValue: "openai" },
		});
	});

	it("maps an error span to STATUS_CODE_ERROR with the message", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, flushIntervalMs: 0 });
		await exporter.exportSpan(
			recordedSpan({
				id: 1,
				parentId: null,
				name: "ai.provider.call",
				status: { status: "error", error: { name: "TimeoutError", message: "upstream timed out" } },
			}),
		);
		await exporter.flush();
		const [span] = spansOf(collector.payloads[0]);
		expect(span.status).toEqual({ code: 2, message: "upstream timed out" });
	});

	it("serialises typed attributes into OTLP AnyValue form", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, flushIntervalMs: 0 });
		await exporter.exportSpan(
			recordedSpan({
				id: 1,
				parentId: null,
				name: "typed",
				attributes: { count: 3, ratio: 0.5, ok: true, tags: ["a", "b"] },
			}),
		);
		await exporter.flush();
		const attrs = Object.fromEntries(spansOf(collector.payloads[0])[0].attributes.map((a: any) => [a.key, a.value]));
		expect(attrs.count).toEqual({ intValue: "3" });
		expect(attrs.ratio).toEqual({ doubleValue: 0.5 });
		expect(attrs.ok).toEqual({ boolValue: true });
		expect(attrs.tags).toEqual({ arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } });
	});

	it("routes transport failures to onError instead of throwing", async () => {
		const errors: unknown[] = [];
		const exporter = new OtlpHttpExporter({
			endpoint: "http://127.0.0.1:1",
			flushIntervalMs: 0,
			onError: (error) => errors.push(error),
		});
		await exporter.exportSpan(recordedSpan({ id: 1, parentId: null, name: "x" }));
		await expect(exporter.flush()).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
	});

	it("reports a non-2xx collector response as an error", async () => {
		collector = await startCollector(503);
		const errors: unknown[] = [];
		const exporter = new OtlpHttpExporter({
			endpoint: collector.url,
			flushIntervalMs: 0,
			onError: (error) => errors.push(error),
		});
		await exporter.exportSpan(recordedSpan({ id: 1, parentId: null, name: "x" }));
		await exporter.flush();
		expect(String(errors[0])).toContain("503");
	});
});

describe("OTLP exporter over a recording context", () => {
	it("exports the full span chain produced by nested startSpan calls", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, flushIntervalMs: 0 });
		const context = new InMemoryTelemetryContext();

		await context.startSpan({ name: "ai.stream", attributes: { route: "/api/ai/stream" } }, async (span) => {
			await span.startSpan({ name: "ai.provider.call", attributes: { provider: "openai" } }, async (inner) => {
				inner.addEvent("first-byte", { ms: 120 });
				await inner.startSpan({ name: "ai.stream.write-back", attributes: { chunks: 7 } }, async () => {});
			});
		});

		for (const span of context.getSpans()) await exporter.exportSpan(span);
		await exporter.flush();

		const exported = spansOf(collector.payloads[0]);
		expect(exported.map((s) => s.name)).toEqual(["ai.stream", "ai.provider.call", "ai.stream.write-back"]);
		const byName = new Map(exported.map((s) => [s.name, s]));
		expect(byName.get("ai.provider.call")?.parentSpanId).toBe(byName.get("ai.stream")?.spanId);
		expect(byName.get("ai.stream.write-back")?.parentSpanId).toBe(byName.get("ai.provider.call")?.spanId);
		expect(byName.get("ai.provider.call")?.events.map((e: any) => e.name)).toEqual(["first-byte"]);
	});
});

describe("createExportingTelemetry", () => {
	it("exports a settled chain in start order once the outermost span completes", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, flushIntervalMs: 0 });
		const context = createExportingTelemetry(exporter);

		await context.startSpan({ name: "ai.stream" }, async (span) => {
			await span.startSpan({ name: "ai.provider.call" }, async (inner) => {
				await inner.startSpan({ name: "ai.stream.write-back" }, async () => {});
			});
		});
		await context.flush();

		expect(collector.payloads).toHaveLength(1);
		const exported = spansOf(collector.payloads[0]);
		expect(exported.map((s) => s.name)).toEqual(["ai.stream", "ai.provider.call", "ai.stream.write-back"]);
		// Every span in the payload was settled before it left the process.
		const byName = new Map(exported.map((s) => [s.name, s]));
		expect(byName.get("ai.provider.call")?.parentSpanId).toBe(byName.get("ai.stream")?.spanId);
	});

	it("batches consecutive requests into one payload, preserving start order", async () => {
		collector = await startCollector();
		const exporter = new OtlpHttpExporter({ endpoint: collector.url, flushIntervalMs: 0 });
		const context = createExportingTelemetry(exporter);

		await context.startSpan({ name: "req-1" }, async () => {});
		await context.startSpan({ name: "req-2" }, async () => {});
		await context.flush();

		expect(collector.payloads).toHaveLength(1);
		expect(spansOf(collector.payloads[0]).map((s) => s.name)).toEqual(["req-1", "req-2"]);
	});
});

function recordedSpan(partial: Partial<RecordedTelemetrySpan> & { id: number; name: string }): RecordedTelemetrySpan {
	return {
		parentId: null,
		attributes: {},
		events: [],
		status: { status: "ok" },
		settled: true,
		...partial,
	};
}

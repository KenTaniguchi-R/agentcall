import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  AggregationTemporality, AggregationType, InMemoryMetricExporter, MeterProvider,
  PeriodicExportingMetricReader, createAllowListAttributesProcessor,
  type PushMetricExporter, type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler, BasicTracerProvider, InMemorySpanExporter, SamplingDecision,
  SimpleSpanProcessor, type ReadableSpan, type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentCallTelemetry, BoundedRemoteSampler, HealthBatchSpanProcessor,
  INVOCATION_DURATION_BUCKETS, ObservedMetricExporter,
  configuredSamplingRatio, getTelemetry, resetTelemetryForTest, shutdownTelemetry,
  telemetrySafely,
} from "../src/telemetry.js";
import { TelemetryHealthReporter } from "../src/telemetry-health.js";
import { tempDir } from "./helpers.js";

const encryptedRequest = {
  v: 1 as const, direction: "request" as const, relay_origin: "relay.example",
  from: "caller@relay.example", to: "callee@relay.example", key_id: "a".repeat(32),
  epoch: 1, enc: "A", ct: "B",
};

function remoteParent(index: number, sampled = true) {
  const traceId = index.toString(16).padStart(32, "0").replace(/^0+$/, "1".repeat(32));
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: "2".repeat(16),
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}

describe("BoundedRemoteSampler", () => {
  it("maps supported standard sampler configuration without broadening malformed input", () => {
    expect(configuredSamplingRatio({})).toBe(1);
    expect(configuredSamplingRatio({ OTEL_TRACES_SAMPLER: "always_off" })).toBe(0);
    expect(configuredSamplingRatio({ OTEL_TRACES_SAMPLER: "parentbased_always_on" })).toBe(1);
    expect(configuredSamplingRatio({
      OTEL_TRACES_SAMPLER: "traceidratio", OTEL_TRACES_SAMPLER_ARG: "0.25",
    })).toBe(0.25);
    expect(configuredSamplingRatio({ OTEL_TRACES_SAMPLER: "traceidratio" })).toBe(0);
    expect(configuredSamplingRatio({ OTEL_TRACES_SAMPLER: "surprise" })).toBe(0);
  });

  it("cannot exceed the local ratio quota at any prefix or time boundary", () => {
    let now = 59_999;
    const sampler = new BoundedRemoteSampler(0.1, 100, () => now);
    let sampled = 0;
    for (let index = 1; index <= 100; index++) {
      if (index === 10) now = 60_000;
      if (sampler.shouldSample(remoteParent(index)).decision === SamplingDecision.RECORD_AND_SAMPLED) sampled++;
      expect(sampled).toBeLessThanOrEqual(Math.floor(index * 0.1));
    }
    expect(sampled).toBe(10);
  });

  it("retains fractional quota surplus for non-reciprocal high ratios", () => {
    const sampler = new BoundedRemoteSampler(0.9, 100, () => 1_000);
    let sampled = 0;
    for (let index = 1; index <= 10; index++) {
      if (sampler.shouldSample(remoteParent(index)).decision === SamplingDecision.RECORD_AND_SAMPLED) sampled++;
      expect(sampled).toBeLessThanOrEqual(Math.floor(index * 0.9));
    }
    expect(sampled).toBe(9);
  });

  it("does not round a near-one ratio above the first-prefix ceiling", () => {
    const ratio = 0.999999999999999;
    const sampler = new BoundedRemoteSampler(ratio, 100, () => 1_000);
    let sampled = 0;
    for (let index = 1; index <= 10; index++) {
      if (sampler.shouldSample(remoteParent(index)).decision === SamplingDecision.RECORD_AND_SAMPLED) sampled++;
      expect(sampled).toBeLessThanOrEqual(Math.floor(index * ratio));
    }
    expect(sampled).toBe(9);
  });

  it("cannot exceed the absolute root-span token bucket", () => {
    const sampler = new BoundedRemoteSampler(1, 5, () => 1_000);
    let sampled = 0;
    for (let index = 1; index <= 100; index++) {
      if (sampler.shouldSample(remoteParent(index)).decision === SamplingDecision.RECORD_AND_SAMPLED) sampled++;
    }
    expect(sampled).toBe(5);
  });

  it("treats remote sampled=false as ineligible and inherits trusted local parents", () => {
    const sampler = new BoundedRemoteSampler(1, 1, () => 1_000);
    expect(sampler.shouldSample(remoteParent(1, false)).decision).toBe(SamplingDecision.NOT_RECORD);
    const local = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "3".repeat(32), spanId: "4".repeat(16), traceFlags: TraceFlags.SAMPLED,
    });
    expect(sampler.shouldSample(local).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});

describe("AgentCallTelemetry", () => {
  it("persists trace-export and queue degradation without exposing exporter errors", async () => {
    const warnings: string[] = [];
    const health = new TelemetryHealthReporter(
      join(tempDir("agentcall-otel-health-"), "health.json"),
      (warning) => warnings.push(warning),
    );
    const exporter: SpanExporter = {
      export(_spans: ReadableSpan[], callback) {
        callback({ code: ExportResultCode.FAILED, error: new Error("authorization=collector-secret") });
      },
      shutdown: async () => {},
    };
    const processor = new HealthBatchSpanProcessor(exporter, health, 1, {
      maxQueueSize: 1, maxExportBatchSize: 1, scheduledDelayMillis: 5_000,
    });
    const provider = new BasicTracerProvider({
      sampler: new AlwaysOnSampler(), spanProcessors: [processor],
    });
    provider.getTracer("test").startSpan("first").end();
    await vi.waitFor(() => expect(health.snapshot().failures.trace_export).toBe(1));

    const blockedExporter: SpanExporter = {
      export() {},
      shutdown: async () => {},
    };
    const queueHealth = new TelemetryHealthReporter(
      join(tempDir("agentcall-otel-queue-"), "health.json"),
      (warning) => warnings.push(warning),
    );
    const queueProcessor = new HealthBatchSpanProcessor(blockedExporter, queueHealth, 1, {
      maxQueueSize: 1, maxExportBatchSize: 1, scheduledDelayMillis: 5_000,
    });
    const queueProvider = new BasicTracerProvider({
      sampler: new AlwaysOnSampler(), spanProcessors: [queueProcessor],
    });
    queueProvider.getTracer("test").startSpan("queued").end();
    queueProvider.getTracer("test").startSpan("dropped").end();
    expect(queueHealth.snapshot()).toMatchObject({
      status: "degraded", failures: { span_queue: 1 }, degraded: { span_queue: true },
    });
    expect(warnings.join("\n")).not.toContain("collector-secret");
  });

  it("persists metric exporter failure and recovery independently", () => {
    const health = new TelemetryHealthReporter(
      join(tempDir("agentcall-otel-metric-"), "health.json"),
      () => {},
    );
    let fail = true;
    const delegate: PushMetricExporter = {
      export(_metrics, callback) {
        callback({ code: fail ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const exporter = new ObservedMetricExporter(delegate, health);
    exporter.export({} as ResourceMetrics, () => {});
    expect(health.snapshot().degraded.metric_export).toBe(true);
    fail = false;
    exporter.export({} as ResourceMetrics, () => {});
    expect(health.snapshot()).toMatchObject({
      status: "ok", failures: { metric_export: 1 }, degraded: { metric_export: false },
    });
  });

  it("caps oversized queue/timeout configuration and initializes without auto-instrumentations", async () => {
    resetTelemetryForTest();
    const telemetry = getTelemetry({
      AGENTCALL_OTEL: "1",
      OTEL_TRACES_SAMPLER: "always_off",
      OTEL_BSP_MAX_QUEUE_SIZE: "1",
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "999999999",
      OTEL_EXPORTER_OTLP_TIMEOUT: "999999999",
      OTEL_METRIC_EXPORT_INTERVAL: "100",
    });
    expect(telemetry).toBeInstanceOf(AgentCallTelemetry);
    await shutdownTelemetry(10);
  });

  it("contains instrumentation failures without logging their possibly-secret detail", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
    try {
      expect(telemetrySafely(() => { throw new Error("authorization=collector-secret"); })).toBeUndefined();
      expect(errors.join("\n")).toContain("local instrumentation failed");
      expect(errors.join("\n")).not.toContain("collector-secret");
    } finally {
      spy.mockRestore();
    }
  });

  it("emits the exact caller, consumer, and internal span tree without content", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const meterProvider = new MeterProvider();
    const telemetry = new AgentCallTelemetry(
      provider.getTracer("test"), meterProvider.getMeter("test"),
    );

    const caller = telemetry.startCaller({ task: "ask", relay: "https://relay.example" });
    const incoming = {
      type: "incoming_call" as const,
      call_id: "call-1", correlation_id: caller.correlationId, traceparent: caller.traceparent,
      from: "private-handle", groups: [], envelope: encryptedRequest,
    };
    const inbound = telemetry.startInbound(incoming);
    inbound.endAdmission("accepted");
    const invocation = inbound.startInvocation({
      task: "ask", runtime: "claude", callId: "call-1", correlationId: caller.correlationId,
    });
    invocation.recordTool({
      callId: "call-1", toolCallId: "tool-1", toolName: "Bash", outcome: "success",
      startedAtMs: 1_000, endedAtMs: 1_025, durationMs: 25,
    });
    invocation.end("success", "ctx_AAAAAAAAAAAAAAAAAAAAAA");
    caller.endSuccess("call-1");

    const spans = exporter.getFinishedSpans();
    const client = spans.find((span) => span.kind === 2)!;
    const consumer = spans.find((span) => span.name === "agentcall.call.process")!;
    const internal = spans.find((span) => span.kind === 0 && span.name === "invoke_agent ask")!;
    expect(client.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent", "gen_ai.provider.name": "agentcall",
      "gen_ai.agent.name": "ask", "agentcall.call.id": "call-1",
    });
    expect(consumer.parentSpanContext?.spanId).toBe(client.spanContext().spanId);
    expect(internal.parentSpanContext?.spanId).toBe(consumer.spanContext().spanId);
    expect(internal.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "ask",
      "gen_ai.conversation.id": "ctx_AAAAAAAAAAAAAAAAAAAAAA",
      "agentcall.runtime.name": "claude",
    });
    const tool = spans.find((span) => span.name === "execute_tool Bash")!;
    expect(tool.parentSpanContext?.spanId).toBe(internal.spanContext().spanId);
    expect(tool.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "Bash",
      "gen_ai.tool.call.id": "tool-1", "agentcall.runtime.name": "claude",
      "agentcall.call.id": "call-1",
    });
    const serialized = JSON.stringify(spans.map((span) => span.attributes));
    for (const secret of ["private-handle", "private prompt", "authorization", "session_id"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("exports the exact invocation and tool metric shapes with bounded attributes", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const meterProvider = new MeterProvider({
      readers: [reader],
      views: [{
        instrumentName: "agentcall.invoke_agent.duration",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [...INVOCATION_DURATION_BUCKETS], recordMinMax: true },
        },
        attributesProcessors: [createAllowListAttributesProcessor([
          "agentcall.runtime.name", "agentcall.call.outcome", "error.type",
        ])],
      }],
    });
    const provider = new BasicTracerProvider({ sampler: new AlwaysOnSampler() });
    const telemetry = new AgentCallTelemetry(provider.getTracer("test"), meterProvider.getMeter("test"));
    const caller = telemetry.startCaller({ relay: "https://relay.example" });
    const inbound = telemetry.startInbound({
      type: "incoming_call", call_id: "call-1", correlation_id: caller.correlationId,
      traceparent: caller.traceparent, from: "hidden", groups: [], envelope: encryptedRequest,
    });
    const invocation = inbound.startInvocation({
      task: "owner-task-with-unbounded-name", runtime: "codex", callId: "call-1",
      correlationId: caller.correlationId,
    });
    invocation.recordTool({
      callId: "call-1", toolCallId: "unbounded-tool-call-id", toolName: "Bash", outcome: "error",
      startedAtMs: 1_000, endedAtMs: 1_100, durationMs: 100,
    });
    invocation.end("timeout");
    await meterProvider.forceFlush();

    const metrics = exporter.getMetrics().flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) => scope.metrics));
    expect(metrics.map((metric) => [metric.descriptor.name, metric.descriptor.unit])).toEqual([
      ["agentcall.invoke_agent.duration", "s"],
      ["agentcall.invoke_agent.calls", "{call}"],
      ["gen_ai.execute_tool.duration", "s"],
    ]);
    const serialized = JSON.stringify(metrics);
    expect(serialized).toContain("agentcall.runtime.name");
    expect(serialized).toContain("timeout");
    expect(serialized).toContain("gen_ai.tool.name");
    expect(serialized).toContain("tool_error");
    expect(serialized).not.toContain("owner-task-with-unbounded-name");
    expect(serialized).not.toContain("call-1");
    expect(serialized).not.toContain(caller.correlationId);
    expect(serialized).not.toContain("unbounded-tool-call-id");
    await meterProvider.shutdown();
  });
});

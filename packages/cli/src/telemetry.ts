import {
  ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace,
  type Attributes, type Context, type Meter, type Tracer,
} from "@opentelemetry/api";
import {
  ExportResultCode, W3CTraceContextPropagator, type ExportResult,
} from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  AggregationType, MeterProvider, PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
  type AggregationOption, type AggregationTemporality, type InstrumentType,
  type PushMetricExporter, type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider, BatchSpanProcessor, SamplingDecision,
  type BufferConfig, type ReadableSpan, type Sampler, type SamplingResult,
  type Span, type SpanExporter, type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { normalizeTraceparent, type AgentKind, type EncryptedIncomingCallType } from "@benree/agentcall-shared";
import { TelemetryHealthReporter } from "./telemetry-health.js";
import type { ToolLifecycle } from "./tool-telemetry-spool.js";

const INSTRUMENTATION = "@benree/agentcall";
export const INVOCATION_DURATION_BUCKETS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600,
] as const;
const TOOL_DURATION_BUCKETS = [
  0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
] as const;
const METRIC_ATTRIBUTES = ["agentcall.runtime.name", "agentcall.call.outcome", "error.type"];
const TOOL_METRIC_ATTRIBUTES = ["gen_ai.operation.name", "gen_ai.tool.name", "error.type"];
const TOKEN_REFILL_MS = 60_000;
const DEFAULT_MAX_ROOT_SPANS_PER_MINUTE = 60;
const MAX_EXPORT_TIMEOUT_MS = 2_000;
const MAX_SPAN_QUEUE_SIZE = 2_048;

type InvocationOutcome = "success" | "timeout" | "canceled" | "agent_error";

class ObservedSpanExporter implements SpanExporter {
  constructor(
    private readonly delegate: SpanExporter,
    private readonly health: TelemetryHealthReporter,
    private readonly completed: (count: number) => void,
  ) {}

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    let settled = false;
    const finish = (result: ExportResult) => {
      if (settled) return;
      settled = true;
      this.completed(spans.length);
      if (result.code === ExportResultCode.SUCCESS) this.health.recordSuccess("trace_export");
      else this.health.recordFailure("trace_export");
      callback(result);
    };
    try {
      this.delegate.export(spans, finish);
    } catch {
      finish({ code: ExportResultCode.FAILED });
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

/** Batch processor with an explicit queue-loss signal instead of SDK debug logs. */
export class HealthBatchSpanProcessor implements SpanProcessor {
  private readonly delegate: BatchSpanProcessor;
  private pending = 0;

  constructor(
    exporter: SpanExporter,
    private readonly health: TelemetryHealthReporter,
    private readonly maxQueueSize: number,
    config: BufferConfig,
  ) {
    this.delegate = new BatchSpanProcessor(
      new ObservedSpanExporter(exporter, health, (count) => {
        this.pending = Math.max(0, this.pending - count);
        if (this.pending < this.maxQueueSize) this.health.recordSuccess("span_queue");
      }),
      config,
    );
  }

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (this.pending >= this.maxQueueSize) {
      this.health.recordFailure("span_queue");
      return;
    }
    this.pending++;
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

export class ObservedMetricExporter implements PushMetricExporter {
  readonly selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
  readonly selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;

  constructor(
    private readonly delegate: PushMetricExporter,
    private readonly health: TelemetryHealthReporter,
  ) {
    if (delegate.selectAggregationTemporality) {
      this.selectAggregationTemporality = delegate.selectAggregationTemporality.bind(delegate);
    }
    if (delegate.selectAggregation) this.selectAggregation = delegate.selectAggregation.bind(delegate);
  }

  export(metrics: ResourceMetrics, callback: (result: ExportResult) => void): void {
    let settled = false;
    const finish = (result: ExportResult) => {
      if (settled) return;
      settled = true;
      if (result.code === ExportResultCode.SUCCESS) this.health.recordSuccess("metric_export");
      else this.health.recordFailure("metric_export");
      callback(result);
    };
    try {
      this.delegate.export(metrics, finish);
    } catch {
      finish({ code: ExportResultCode.FAILED });
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

function boundedRatio(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
}

export function configuredSamplingRatio(env: NodeJS.ProcessEnv): number {
  const sampler = env.OTEL_TRACES_SAMPLER?.toLowerCase();
  if (sampler === undefined || sampler === "") return 1;
  if (sampler === "always_off" || sampler === "parentbased_always_off") return 0;
  if (sampler === "always_on" || sampler === "parentbased_always_on") return 1;
  if (sampler === "traceidratio" || sampler === "parentbased_traceidratio") {
    return env.OTEL_TRACES_SAMPLER_ARG === undefined
      ? 0
      : boundedRatio(env.OTEL_TRACES_SAMPLER_ARG);
  }
  // An unknown/malformed sampler must not silently broaden export.
  return 0;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  return Math.min(positiveInteger(value, fallback), maximum);
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText ?? "0");
  const fractionDigits = mantissa!.includes(".") ? mantissa!.length - mantissa!.indexOf(".") - 1 : 0;
  const digits = mantissa!.replace(".", "");
  let numerator = BigInt(digits);
  let denominator = 10n ** BigInt(fractionDigits);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  return { numerator, denominator };
}

/**
 * A remote sampled bit is only eligibility. Root/remote decisions accrue a
 * bounded local ratio quota plus an absolute token bucket; caller-chosen trace
 * ids and parent decisions never participate in selection.
 */
export class BoundedRemoteSampler implements Sampler {
  private ratioCredit = 0n;
  private readonly ratioNumerator: bigint;
  private readonly ratioDenominator: bigint;
  private tokens: number;
  private refilledAt: number;

  constructor(
    private readonly ratio: number,
    private readonly maxPerWindow: number,
    private readonly now: () => number = Date.now,
  ) {
    const fraction = decimalFraction(ratio);
    this.ratioNumerator = fraction.numerator;
    this.ratioDenominator = fraction.denominator;
    this.refilledAt = now();
    this.tokens = maxPerWindow;
  }

  shouldSample(parentContext: Context): SamplingResult {
    const parent = trace.getSpanContext(parentContext);
    if (parent?.isRemote !== true && parent !== undefined) {
      return {
        decision: (parent.traceFlags & TraceFlags.SAMPLED) !== 0
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD,
      };
    }
    if (parent?.isRemote === true && (parent.traceFlags & TraceFlags.SAMPLED) === 0) {
      return { decision: SamplingDecision.NOT_RECORD };
    }

    const now = this.now();
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(
      this.maxPerWindow,
      this.tokens + (elapsed * this.maxPerWindow) / TOKEN_REFILL_MS,
    );
    this.refilledAt = now;
    this.ratioCredit += this.ratioNumerator;
    if (this.ratioCredit < this.ratioDenominator) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    if (this.tokens < 1) {
      // Retain at most one earned sample while the absolute limiter is empty;
      // otherwise a long outage could build an unbounded ratio-credit burst.
      this.ratioCredit = this.ratioDenominator;
      return { decision: SamplingDecision.NOT_RECORD };
    }
    this.ratioCredit -= this.ratioDenominator;
    this.tokens--;
    return { decision: SamplingDecision.RECORD_AND_SAMPLED };
  }

  toString(): string {
    return `AgentCallBoundedRemoteSampler{ratio=${this.ratio},maxPerMinute=${this.maxPerWindow}}`;
  }
}

interface CallerSpanHandle {
  correlationId: string;
  traceparent: string;
  setCallId(callId: string | undefined): void;
  endSuccess(callId: string): void;
  endError(errorType: string, callId?: string): void;
}

interface InvocationSpanHandle {
  recordTool(input: ToolLifecycle & { contextId?: string }): void;
  end(outcome: InvocationOutcome, contextId?: string): void;
}

interface InboundSpanHandle {
  context: Context;
  endAdmission(outcome: string): void;
  startInvocation(input: {
    task: string;
    runtime: AgentKind;
    callId: string;
    correlationId?: string;
    contextId?: string;
  }): InvocationSpanHandle;
}

export class AgentCallTelemetry {
  private readonly duration;
  private readonly calls;
  private readonly toolDuration;

  constructor(
    private readonly tracer: Tracer,
    meter: Meter,
    private readonly propagator = new W3CTraceContextPropagator(),
  ) {
    this.duration = meter.createHistogram("agentcall.invoke_agent.duration", { unit: "s" });
    this.calls = meter.createCounter("agentcall.invoke_agent.calls", { unit: "{call}" });
    this.toolDuration = meter.createHistogram("gen_ai.execute_tool.duration", { unit: "s" });
  }

  startCaller(input: { task?: string; relay: string }): CallerSpanHandle {
    const server = safeServer(input.relay);
    const attributes: Attributes = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "agentcall",
      "server.address": server.address,
    };
    if (server.port !== undefined) attributes["server.port"] = server.port;
    if (input.task !== undefined) attributes["gen_ai.agent.name"] = input.task;
    const span = this.tracer.startSpan(
      input.task ? `invoke_agent ${input.task}` : "invoke_agent",
      { kind: SpanKind.CLIENT, attributes },
      ROOT_CONTEXT,
    );
    const spanContext = span.spanContext();
    span.setAttribute("agentcall.correlation.id", spanContext.traceId);
    const carrier: Record<string, string> = {};
    this.propagator.inject(trace.setSpan(ROOT_CONTEXT, span), carrier, {
      set(target, key, value) { target[key] = value; },
    });
    let ended = false;
    const setCallId = (callId: string | undefined) => {
      if (callId) span.setAttribute("agentcall.call.id", callId);
    };
    const finish = (errorType?: string, callId?: string) => {
      if (ended) return;
      ended = true;
      setCallId(callId);
      if (errorType) {
        span.setAttribute("error.type", errorType);
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    };
    return {
      correlationId: spanContext.traceId,
      traceparent: carrier.traceparent!,
      setCallId,
      endSuccess: (callId) => finish(undefined, callId),
      endError: (errorType, callId) => finish(errorType, callId),
    };
  }

  startInbound(frame: EncryptedIncomingCallType): InboundSpanHandle {
    const traceparent = normalizeTraceparent(frame.correlation_id, frame.traceparent);
    const parent = traceparent
      ? this.propagator.extract(ROOT_CONTEXT, { traceparent }, {
          keys: (carrier) => Object.keys(carrier),
          get: (carrier, key) => carrier[key],
        })
      : ROOT_CONTEXT;
    const attributes: Attributes = { "agentcall.call.id": frame.call_id };
    if (frame.correlation_id) attributes["agentcall.correlation.id"] = frame.correlation_id;
    const admission = this.tracer.startSpan(
      "agentcall.call.process", { kind: SpanKind.CONSUMER, attributes }, parent,
    );
    const admissionContext = trace.setSpan(parent, admission);
    let admissionEnded = false;
    return {
      context: admissionContext,
      endAdmission: (outcome) => {
        if (admissionEnded) return;
        admissionEnded = true;
        admission.setAttribute("agentcall.admission.outcome", outcome);
        if (outcome !== "accepted") {
          admission.setAttribute("error.type", outcome);
          admission.setStatus({ code: SpanStatusCode.ERROR });
        }
        admission.end();
      },
      startInvocation: (input) => this.startInvocation(admissionContext, input),
    };
  }

  private startInvocation(parent: Context, input: {
    task: string;
    runtime: AgentKind;
    callId: string;
    correlationId?: string;
    contextId?: string;
  }): InvocationSpanHandle {
    const attributes: Attributes = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": input.task,
      "agentcall.runtime.name": input.runtime,
      "agentcall.call.id": input.callId,
    };
    if (input.correlationId) attributes["agentcall.correlation.id"] = input.correlationId;
    if (input.contextId) attributes["gen_ai.conversation.id"] = input.contextId;
    const span = this.tracer.startSpan(
      `invoke_agent ${input.task}`, { kind: SpanKind.INTERNAL, attributes }, parent,
    );
    const invocationContext = trace.setSpan(parent, span);
    const started = performance.now();
    let ended = false;
    return {
      recordTool: (tool) => {
        if (ended || tool.callId !== input.callId) return;
        const toolAttributes: Attributes = {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool.toolName,
          "gen_ai.tool.call.id": tool.toolCallId,
          "agentcall.runtime.name": input.runtime,
          "agentcall.call.id": input.callId,
        };
        if (input.correlationId) toolAttributes["agentcall.correlation.id"] = input.correlationId;
        const conversationId = tool.contextId ?? input.contextId;
        if (conversationId) toolAttributes["gen_ai.conversation.id"] = conversationId;
        const metricAttributes: Attributes = {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool.toolName,
        };
        if (tool.outcome !== "success") {
          const errorType = tool.outcome === "interrupted" ? "interrupted" : "tool_error";
          toolAttributes["error.type"] = errorType;
          metricAttributes["error.type"] = errorType;
        }
        const toolSpan = this.tracer.startSpan(
          `execute_tool ${tool.toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: toolAttributes,
            startTime: new Date(tool.startedAtMs),
          },
          invocationContext,
        );
        if (tool.outcome !== "success") toolSpan.setStatus({ code: SpanStatusCode.ERROR });
        this.toolDuration.record(tool.durationMs / 1_000, metricAttributes);
        toolSpan.end(new Date(tool.endedAtMs));
      },
      end: (outcome, contextId) => {
        if (ended) return;
        ended = true;
        if (contextId) span.setAttribute("gen_ai.conversation.id", contextId);
        const metricAttributes: Attributes = {
          "agentcall.runtime.name": input.runtime,
          "agentcall.call.outcome": outcome,
        };
        if (outcome !== "success") {
          metricAttributes["error.type"] = outcome;
          span.setAttribute("error.type", outcome);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        this.duration.record((performance.now() - started) / 1000, metricAttributes);
        this.calls.add(1, metricAttributes);
        span.end();
      },
    };
  }
}

function safeServer(relay: string): { address: string; port?: number } {
  try {
    const url = new URL(relay);
    return {
      address: url.hostname,
      port: url.port ? Number(url.port) : undefined,
    };
  } catch {
    return { address: "invalid" };
  }
}

let singleton: {
  telemetry: AgentCallTelemetry;
  tracerProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
  health?: TelemetryHealthReporter;
} | null | undefined;
let lastWarningAt = 0;

function warnTelemetry(message: string): void {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  console.error(`agentcall: telemetry warning: ${message}`);
}

export function telemetrySafely<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    warnTelemetry("local instrumentation failed");
    return undefined;
  }
}

export function getTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  options: { healthFile?: string } = {},
): AgentCallTelemetry | undefined {
  if (env.AGENTCALL_OTEL !== "1") return undefined;
  if (singleton !== undefined) return singleton?.telemetry;
  try {
    const propagator = new W3CTraceContextPropagator();
    const commonTimeout = boundedInteger(
      env.OTEL_EXPORTER_OTLP_TIMEOUT, MAX_EXPORT_TIMEOUT_MS, MAX_EXPORT_TIMEOUT_MS,
    );
    const traceTimeout = boundedInteger(
      env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT, commonTimeout, MAX_EXPORT_TIMEOUT_MS,
    );
    const metricInterval = boundedInteger(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000, 60_000);
    const metricTimeout = Math.min(
      boundedInteger(env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT, commonTimeout, MAX_EXPORT_TIMEOUT_MS),
      metricInterval,
    );
    const health = options.healthFile
      ? new TelemetryHealthReporter(options.healthFile, warnTelemetry)
      : undefined;
    const traceExporter = new OTLPTraceExporter({ timeoutMillis: traceTimeout });
    const metricExporter = new OTLPMetricExporter({ timeoutMillis: metricTimeout });
    const maxSpanQueueSize = boundedInteger(
      env.OTEL_BSP_MAX_QUEUE_SIZE, MAX_SPAN_QUEUE_SIZE, MAX_SPAN_QUEUE_SIZE,
    );
    const maxExportBatchSize = Math.min(
      boundedInteger(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 512, 512),
      maxSpanQueueSize,
    );
    const resource = defaultResource().merge(resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME || "agentcall",
    }));
    const tracerProvider = new BasicTracerProvider({
      resource,
      sampler: new BoundedRemoteSampler(
        configuredSamplingRatio(env),
        positiveInteger(env.AGENTCALL_OTEL_MAX_ROOT_SPANS_PER_MINUTE, DEFAULT_MAX_ROOT_SPANS_PER_MINUTE),
      ),
      spanProcessors: [health ? new HealthBatchSpanProcessor(traceExporter, health, maxSpanQueueSize, {
        maxQueueSize: maxSpanQueueSize,
        maxExportBatchSize,
        scheduledDelayMillis: boundedInteger(env.OTEL_BSP_SCHEDULE_DELAY, 5_000, 5_000),
        exportTimeoutMillis: traceTimeout,
      }) : new BatchSpanProcessor(traceExporter, {
        maxQueueSize: maxSpanQueueSize,
        maxExportBatchSize,
        scheduledDelayMillis: boundedInteger(env.OTEL_BSP_SCHEDULE_DELAY, 5_000, 5_000),
        exportTimeoutMillis: traceTimeout,
      })],
    });
    const meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({
        exporter: health ? new ObservedMetricExporter(metricExporter, health) : metricExporter,
        exportIntervalMillis: metricInterval,
        exportTimeoutMillis: metricTimeout,
      })],
      views: [{
        instrumentName: "agentcall.invoke_agent.duration",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [...INVOCATION_DURATION_BUCKETS], recordMinMax: true },
        },
        attributesProcessors: [createAllowListAttributesProcessor(METRIC_ATTRIBUTES)],
        aggregationCardinalityLimit: 16,
      }, {
        instrumentName: "agentcall.invoke_agent.calls",
        attributesProcessors: [createAllowListAttributesProcessor(METRIC_ATTRIBUTES)],
        aggregationCardinalityLimit: 16,
      }, {
        instrumentName: "gen_ai.execute_tool.duration",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [...TOOL_DURATION_BUCKETS], recordMinMax: true },
        },
        attributesProcessors: [createAllowListAttributesProcessor(TOOL_METRIC_ATTRIBUTES)],
        aggregationCardinalityLimit: 64,
      }],
    });
    singleton = {
      tracerProvider,
      meterProvider,
      health,
      telemetry: new AgentCallTelemetry(tracerProvider.getTracer(INSTRUMENTATION), meterProvider.getMeter(INSTRUMENTATION), propagator),
    };
    return singleton.telemetry;
  } catch {
    singleton = null;
    warnTelemetry("configuration could not be initialized");
    return undefined;
  }
}

export async function shutdownTelemetry(timeoutMs = 2_000): Promise<void> {
  const active = singleton;
  singleton = undefined;
  if (!active) return;
  try {
    await Promise.race([
      Promise.all([active.tracerProvider.shutdown(), active.meterProvider.shutdown()]).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    warnTelemetry("export shutdown failed");
  } finally {
    active.health?.flush();
  }
}

// Tests use this to isolate singleton/global provider state without exporting
// production reset controls from the public CLI surface.
export function resetTelemetryForTest(): void {
  singleton = undefined;
  lastWarningAt = 0;
}

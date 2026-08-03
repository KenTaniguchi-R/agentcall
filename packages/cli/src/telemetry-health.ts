import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeJsonAtomic } from "./json-store.js";

const FailureKind = z.enum(["trace_export", "metric_export", "span_queue"]);
export type TelemetryFailureKind = z.infer<typeof FailureKind>;

const TelemetryHealthSchema = z.object({
  version: z.literal(1),
  status: z.enum(["ok", "degraded"]),
  updated_at: z.string(),
  last_success_at: z.string().optional(),
  last_failure_at: z.string().optional(),
  failures: z.object({
    trace_export: z.number().int().nonnegative(),
    metric_export: z.number().int().nonnegative(),
    span_queue: z.number().int().nonnegative(),
  }),
  degraded: z.object({
    trace_export: z.boolean(),
    metric_export: z.boolean(),
    span_queue: z.boolean(),
  }),
});
export type TelemetryHealth = z.infer<typeof TelemetryHealthSchema>;

const initialState = (now: number): TelemetryHealth => ({
  version: 1,
  status: "ok",
  updated_at: new Date(now).toISOString(),
  failures: { trace_export: 0, metric_export: 0, span_queue: 0 },
  degraded: { trace_export: false, metric_export: false, span_queue: false },
});

export class TelemetryHealthReporter {
  private state: TelemetryHealth;
  private lastPersistedAt = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly file: string,
    private readonly warn: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.state = readTelemetryHealth(file) ?? initialState(now());
    this.persist(true);
  }

  recordFailure(kind: TelemetryFailureKind): void {
    const wasHealthy = this.state.status === "ok";
    const timestamp = new Date(this.now()).toISOString();
    this.state.status = "degraded";
    this.state.updated_at = timestamp;
    this.state.last_failure_at = timestamp;
    this.state.degraded[kind] = true;
    this.state.failures[kind] = Math.min(Number.MAX_SAFE_INTEGER, this.state.failures[kind] + 1);
    this.persist(wasHealthy);
    this.warn(`telemetry ${kind.replaceAll("_", " ")} degraded`);
  }

  recordSuccess(kind: TelemetryFailureKind): void {
    const changed = this.state.degraded[kind];
    const timestamp = new Date(this.now()).toISOString();
    this.state.degraded[kind] = false;
    this.state.status = Object.values(this.state.degraded).some(Boolean) ? "degraded" : "ok";
    this.state.updated_at = timestamp;
    this.state.last_success_at = timestamp;
    this.persist(changed);
  }

  snapshot(): TelemetryHealth {
    return structuredClone(this.state);
  }

  flush(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persist(true);
  }

  private persist(force: boolean): void {
    const now = this.now();
    if (!force && now - this.lastPersistedAt < 1_000) {
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = undefined;
          this.persist(true);
        }, Math.max(1, 1_000 - (now - this.lastPersistedAt)));
        this.persistTimer.unref?.();
      }
      return;
    }
    try {
      writeJsonAtomic(this.file, this.state);
      this.lastPersistedAt = now;
    } catch {
      // Health persistence is itself observability and must never affect calls.
    }
  }
}

export function readTelemetryHealth(file: string): TelemetryHealth | undefined {
  try {
    return TelemetryHealthSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

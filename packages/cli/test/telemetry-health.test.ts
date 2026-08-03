import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTelemetryHealth, TelemetryHealthReporter } from "../src/telemetry-health.js";

describe("TelemetryHealthReporter", () => {
  it("does not clear one degraded signal when another exporter recovers", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agentcall-telemetry-health-")), "health.json");
    const reporter = new TelemetryHealthReporter(file, () => {});
    reporter.recordFailure("trace_export");
    reporter.recordFailure("metric_export");
    reporter.recordSuccess("metric_export");
    reporter.flush();

    expect(readTelemetryHealth(file)).toMatchObject({
      version: 1,
      status: "degraded",
      failures: { trace_export: 1, metric_export: 1, span_queue: 0 },
      degraded: { trace_export: true, metric_export: false, span_queue: false },
    });
  });
});

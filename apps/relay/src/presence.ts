import type { Context, Hono } from "hono";
import { HANDLE_RE } from "@benree/agentcall-shared";
import { NATIVE_READ } from "./ratelimit/index.js";
import { identityObjectName } from "./tenant.js";
import { resolveAgentId } from "./identity.js";
import { rateLimit, type RelayAppEnv } from "./middleware.js";

type PresenceOutcome = "allowed" | "denied";

// Analytics Engine is statistical product telemetry, never an access ledger.
// Keep direct identity and network dimensions out so its sampled, non-deletable
// three-month window cannot strand a stable subject or network identifier:
//   index[0]  allowed | denied (sampling and grouping boundary)
//   double[0] event timestamp in epoch milliseconds
async function recordStatusRead(c: Context<RelayAppEnv>, outcome: PresenceOutcome): Promise<void> {
  try {
    c.env.STATUS_READS.writeDataPoint({
      indexes: [outcome],
      doubles: [Date.now()],
    });
  } catch (error) {
    // This catches only a locally observable binding-call failure. Analytics
    // Engine writes are otherwise asynchronous and sampled, so neither this
    // counter nor a successful call proves ingestion or per-event completeness.
    let counterRecorded = false;
    try {
      const now = Date.now();
      await c.env.DB.prepare(
        "INSERT INTO telemetry_health (sink, failure_count, first_failure_at, last_failure_at) " +
          "VALUES ('agentcall_status_reads', 1, ?, ?) " +
          "ON CONFLICT(sink) DO UPDATE SET " +
          "failure_count = CASE WHEN telemetry_health.failure_count < 9223372036854775807 " +
          "THEN telemetry_health.failure_count + 1 ELSE telemetry_health.failure_count END, " +
          "last_failure_at = MAX(telemetry_health.last_failure_at, excluded.last_failure_at)",
      ).bind(now, now).run();
      counterRecorded = true;
    } catch {
      // Telemetry and its health signal must not become a presence dependency.
      // The short-lived generic log remains the last-resort operator signal.
    }
    // Do not log tenant, subject, outcome, or raw errors: logs are a separate
    // retention surface and binding wrappers may expose request metadata.
    console.error("status read analytics failure", {
      name: error instanceof Error ? error.name : "UnknownError",
      counter_recorded: counterRecorded,
    });
  }
}

export function mountPresence(app: Hono<RelayAppEnv>): void {
  // Presence is private operational metadata. With relationship groups gone,
  // only the authenticated identity may inspect its own listener status.
  app.get("/v1/status/:handle", rateLimit(NATIVE_READ, "ip"), async (c) => {
    const identity = c.var.identity as import("./tenant.js").Identity;
    const { org, handle: viewer } = identity;

    const target = c.req.param("handle");
    const validTarget = HANDLE_RE.test(target);
    const allowed = validTarget && viewer === target;
    const targetAgentId = allowed ? await resolveAgentId(c.env.DB, org, target) : null;
    await recordStatusRead(c, allowed ? "allowed" : "denied");
    if (!allowed || !targetAgentId) return c.json({ error: "not found" }, 404);
    const stub = c.env.HANDLE_DO.get(
      c.env.HANDLE_DO.idFromName(identityObjectName({ org, agentId: targetAgentId })),
    );
    return stub.fetch("https://do/status");
  });
}

import type { Context, Hono } from "hono";
import { HANDLE_RE } from "@benree/agentcall-shared";
import type { Env } from "./index.js";
import { sharedRosterIds } from "./groups.js";
import { checkLimit, NATIVE_READ } from "./ratelimit/index.js";
import { authenticateRequest, identityKey } from "./tenant.js";

type PresenceOutcome = "allowed" | "denied";

// Analytics Engine fields are positional and must remain stable:
//   index[0]  org (sampling/query boundary; ORG_RE caps it below 96 bytes)
//   blob[0]   viewer handle
//   blob[1]   target handle
//   blob[2]   allowed | denied
//   blob[3]   source IP, when Cloudflare supplies one
//   blob[4]   source country, when Cloudflare supplies one
//   double[0] event timestamp in epoch milliseconds
function recordStatusRead(
  c: Context<{ Bindings: Env }>, org: string, viewer: string, target: string, outcome: PresenceOutcome,
): void {
  try {
    c.env.STATUS_READS.writeDataPoint({
      indexes: [org],
      blobs: [
        viewer,
        target,
        outcome,
        c.req.header("cf-connecting-ip") ?? "",
        typeof c.req.raw.cf?.country === "string" ? c.req.raw.cf.country : "",
      ],
      doubles: [Date.now()],
    });
  } catch (error) {
    // Read telemetry must not become an availability dependency. Do not log
    // viewer, target, or the raw error: bindings can expose request metadata.
    console.error("status read analytics failure", {
      org,
      outcome,
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export function mountPresence(app: Hono<{ Bindings: Env }>): void {
  // Presence is relationship-scoped metadata, not public card content. Auth
  // runs before any lookup so anonymous probes cannot enumerate handles; the
  // shared-roster check then prevents one freely registered peer from polling
  // every other handle's working pattern.
  app.get("/v1/status/:handle", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const { org, handle: viewer } = identity;
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await checkLimit(c.env, ip, NATIVE_READ))) return c.json({ error: "rate limited" }, 429);

    const target = c.req.param("handle");
    // Authentication proves a self-target exists. For peers, the relay-owned
    // shared-membership query proves both existence and authorization in one
    // step. An unrelated existing target and an unknown target therefore take
    // the same branch and return the same response shape.
    const validTarget = HANDLE_RE.test(target);
    const allowed = validTarget && (
      viewer === target || (await sharedRosterIds(c.env.DB, org, viewer, target)).length > 0
    );
    // A route parameter is not schema-bounded. Cap malformed probe text before
    // sending it to Analytics Engine's 16 KiB blob budget; valid handles are
    // already much shorter and are recorded exactly.
    const auditTarget = validTarget ? target : target.slice(0, 256);
    recordStatusRead(c, org, viewer, auditTarget, allowed ? "allowed" : "denied");
    if (!allowed) return c.json({ error: "not found" }, 404);

    const stub = c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(identityKey(org, target)));
    return stub.fetch("https://do/status");
  });
}

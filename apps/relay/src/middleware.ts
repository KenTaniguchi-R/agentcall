import { createMiddleware } from "hono/factory";
import type { Env } from "./index.js";
import { authenticateRequest, type Identity } from "./tenant.js";
import { checkLimit, type RateLimitPolicy } from "./ratelimit/index.js";

export type RelayAppEnv = { Bindings: Env };

// These endpoints authenticate with their own credential or capability. Keep
// the list explicit: a newly added /v1 route is authenticated by default.
const PUBLIC_V1_PATHS = new Set([
  "/v1/register",
  "/v1/admin/invite",
  "/v1/recovery/redeem",
  "/v1/rooms",
  "/v1/rooms/join",
  "/v1/room",
  "/v1/room/ws",
]);

function isPublicV1Path(path: string): boolean {
  // A2A owns its version negotiation and application/a2a+json error contract;
  // its handlers retain the same authentication boundary until migration.
  return PUBLIC_V1_PATHS.has(path) || path.startsWith("/v1/room/") || path.startsWith("/v1/a2a/");
}

export const requireIdentity = createMiddleware<RelayAppEnv>(async (c, next) => {
  if (isPublicV1Path(c.req.path)) return next();
  const identity = await authenticateRequest(c.env, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  (c as any).set("identity", identity);
  await next();
});

export function rateLimit(policy: RateLimitPolicy, keyBy: "ip" | "identity") {
  return createMiddleware<RelayAppEnv>(async (c, next) => {
    const key = keyBy === "ip"
      ? c.req.header("cf-connecting-ip") ?? "unknown"
      : (() => {
          const identity = (c as any).get("identity") as Identity;
          return `${identity.org}:${identity.handle}`;
        })();
    if (!(await checkLimit(c.env, key, policy))) return c.json({ error: "rate limited" }, 429);
    await next();
  });
}
